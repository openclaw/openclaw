import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { verifyDijieExecutionToken } from "@openclaw/gateway-protocol";
import {
  jsonResult,
  type AnyAgentTool,
  type OpenClawConfig,
  type PluginRuntime,
} from "openclaw/plugin-sdk/core";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";

type AicsConfig = {
  repoRoot: string;
  pythonBinary: string;
  rolePackageOutputRoot: string;
  allowWrites: boolean;
  maxOutputChars: number;
  executionTokenPublicKeyPem?: string;
  localExecutorCommand?: string;
  localExecutorArgs?: string[];
  localExecutorModel?: string;
  localExecutorProfile?: string;
  localExecutorMode: "auto" | "native" | "subprocess";
  useLegacyCodexCliArgs: boolean;
  cloudExecutionTokenUrl?: string;
  cloudExecutionReadUrl?: string;
  cloudMarketplaceInstalledRolesUrl?: string;
  cloudAuditUrl?: string;
  cloudAuditUploadEnabled: boolean;
  cloudAuditUploadRequired: boolean;
};

type CommandResult = {
  command: string[];
  cwd: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  modelProxyUsage?: DijieModelProxyUsage;
};

type DijieExecutionStatus = "completed" | "failed" | "cancelled" | "timed_out";

type DijieRoleTokenPricing = {
  inputTokenCentsPerMillion: number;
  outputTokenCentsPerMillion: number;
  currency: string;
  developerReceivableBps: number;
  platformFeeBps: number;
};

type DijieModelProxyUsage = {
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
};

type RolePackageFile = {
  relativePath: string;
  absolutePath: string;
  sizeBytes: number;
  sha256: string;
};

const DEFAULT_REPO_ROOT = "/Users/weizuo/Desktop/ai_gongsi_kekong_xitong";
const DEFAULT_ROLE_PACKAGE_OUTPUT_ROOT =
  "/Users/weizuo/Documents/ai公司/openclaw-workspace/aics-role-packages";
const DEFAULT_MAX_OUTPUT_CHARS = 12000;
const DEFAULT_CLOUD_EXECUTION_TOKEN_PATH = "/dijie/execution-token";
const DEFAULT_CLOUD_EXECUTION_READ_PATH = "/dijie/executions";
const DEFAULT_CLOUD_MARKETPLACE_INSTALLED_ROLES_PATH = "/dijie/my-roles";
const DEFAULT_CLOUD_AUDIT_PATH = "/dijie/audit";

const DEVELOPER_MODE_GUIDE_PROMPT = [
  "开发者模式内置指南：",
  "- 你是迭界AI主系统里的岗位开发专属助手，不是普通使用者模式助手。",
  "- 开发者只需要用自然语言讲业务逻辑和业务流程；输入、输出、规则、验收标准、岗位包结构、协议映射、验证材料和上传标准都是平台职责，已经内置在你的资料包里。",
  "- 不要让开发者定义、填写或逐项确认输入、输出、规则、验收标准这些平台标准；只有业务逻辑本身不清楚时，才用业务语言追问。",
  "- 不要要求开发者理解 execution token、Gateway、AuditSummary、RoleResult、entitlement、审计上传、结算协议或平台接口。",
  "- 平台接口、协议、鉴权、审计、计费、开发者中心上传要求和 role_package 目录规范都已经内置在你的资料包里。",
  "- 不要为了凑包而伪造需求、输入输出、规则或验收标准。",
  "- 生成岗位包时，把业务需求翻译成完整可审核的程序包，而不是只写商品介绍。",
].join("\n");

const ROLE_PACKAGE_BUILT_IN_MATERIALS = [
  "内置资料包：",
  "- package contract: 岗位包必须输出到 role_package/。",
  "- required files: role_package/manifest.json, role_package/listing.md, role_package/README.md。",
  "- integration example: 至少提供一个 wrapper、adapter 或接入示例文件。",
  "- validation material: 至少提供一个 validation 或 smoke test 说明/脚本。",
  "- platform handles: execution token、Gateway 调用、AuditSummary、RoleResult、审计上传、Token 计费和开发者结算由平台桥处理。",
  "- forbidden content: 不写 provider key 名称或值、secret/token 字段、cloud bearer、raw execution token、本地绝对路径、用户主对话完整历史或使用者模式私有记忆。",
  "- developer-center handoff: 包生成后交付可下载的 role_package/，由开发者中心负责上传、价格、Token 单价、审核和发布。",
].join("\n");

export const AICS_DEVELOPER_MODE_CONTEXT_ALLOWLIST = [
  "natural-language business logic",
  "developer-provided business materials",
  "built-in developer-mode material pack",
  "public role_package contract, protocol templates, and upload standards",
  "isolated local workspace with relative role_package/ paths",
] as const;

export const AICS_DEVELOPER_MODE_CONTEXT_DENYLIST = [
  "executionId",
  "actorId",
  "entitlementId",
  "order or wallet state",
  "pricing snapshots",
  "cloud bearer tokens",
  "raw execution tokens",
  "provider key names or values",
  "review or settlement state",
  "ordinary user conversation history",
  "private memories",
] as const;

const FORBIDDEN_DEVELOPER_MODE_CONTEXT_KEYS = new Set([
  "executionid",
  "execution_id",
  "actorid",
  "actor_id",
  "rolelistingid",
  "role_listing_id",
  "entitlementid",
  "entitlement_id",
  "order",
  "ordergroup",
  "order_group",
  "ordergroupid",
  "order_group_id",
  "orderid",
  "order_id",
  "orderref",
  "order_ref",
  "wallet",
  "walletid",
  "wallet_id",
  "walletstate",
  "wallet_state",
  "pricing",
  "pricingsnapshot",
  "pricing_snapshot",
  "roletokenpricing",
  "role_token_pricing",
  "cloudbearer",
  "cloud_bearer",
  "cloudaccesstoken",
  "cloud_access_token",
  "bearertoken",
  "bearer_token",
  "executiontoken",
  "execution_token",
  "rawtoken",
  "raw_token",
  "providerkey",
  "provider_key",
  "providerapikey",
  "provider_api_key",
  "apikey",
  "api_key",
  "secret",
  "secretkey",
  "secret_key",
  "reviewstate",
  "review_state",
  "settlementstate",
  "settlement_state",
  "conversationhistory",
  "conversation_history",
  "privatememory",
  "private_memory",
]);

const BACKEND_ONLY_ARTIFACT_KEYS = new Set([
  ...FORBIDDEN_DEVELOPER_MODE_CONTEXT_KEYS,
  "deviceref",
  "device_ref",
  "deviceid",
  "device_id",
  "workspaceref",
  "workspace_ref",
  "localgatewayid",
  "local_gateway_id",
]);

const PROVIDER_KEY_NAME_PATTERN =
  /\b(?:OPENAI|ANTHROPIC|GOOGLE|GEMINI|AZURE|DEEPSEEK|DASHSCOPE|QWEN|OPENROUTER|MISTRAL|TOGETHER|COHERE|GROQ|XAI|PERPLEXITY|HUGGINGFACE|HF)_[A-Z0-9_]*(?:API_)?(?:KEY|TOKEN|SECRET)\b/iu;
const PROVIDER_KEY_VALUE_PATTERN =
  /\b(?:sk-[A-Za-z0-9][A-Za-z0-9_-]{12,}|sk-ant-[A-Za-z0-9_-]{12,}|AIza[0-9A-Za-z_-]{20,})\b/u;
const CLOUD_BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=_-]{12,}\b/iu;
const SECRET_FIELD_PATTERN =
  /["']?[A-Za-z0-9_-]*(?:secret|api[_-]?key|provider[_-]?key|bearer[_-]?token|access[_-]?token|execution[_-]?token)[A-Za-z0-9_-]*["']?\s*[:=]/iu;
const LOCAL_ABSOLUTE_PATH_PATTERN =
  /(?:^|[\s"'(=:[,])(?:\/(?:Users|private|tmp|var|home|opt)\/[^\s"',)]+|[A-Za-z]:\\[^\s"',)]+)/u;

const DijieExecutionPreflightParamsSchema = Type.Object(
  {
    executionToken: Type.String({ minLength: 1 }),
    roleListingId: Type.String({ minLength: 1 }),
    entitlementId: Type.String({ minLength: 1 }),
    deviceId: Type.String({ minLength: 1 }),
    workspaceRef: Type.String({ minLength: 1 }),
    localGatewayId: Type.String({ minLength: 1 }),
    nowMs: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

const RoleBuilderParamsSchema = Type.Object(
  {
    request_zh: Type.String({
      minLength: 1,
      description: "Chinese natural-language role-builder request.",
    }),
    confirm_brief: Type.Optional(
      Type.Boolean({
        description:
          "When true, asks 迭界AI to confirm the brief and write the local role package. Requires allowWrites=true.",
      }),
    ),
    role_build_brief_json: Type.Optional(
      Type.String({
        minLength: 2,
        description:
          "Confirmed RoleBuildBrief JSON. Required when confirm_brief=true so the local executor receives the approved brief instead of an informal request.",
      }),
    ),
    execution_token: Type.Optional(
      Type.String({
        minLength: 1,
        description: "Short-lived cloud execution token. Required when confirm_brief=true.",
      }),
    ),
    role_listing_id: Type.Optional(Type.String({ minLength: 1 })),
    entitlement_id: Type.Optional(Type.String({ minLength: 1 })),
    device_id: Type.Optional(Type.String({ minLength: 1 })),
    workspace_ref: Type.Optional(Type.String({ minLength: 1 })),
    local_gateway_id: Type.Optional(Type.String({ minLength: 1 })),
    developer_id: Type.Optional(Type.String({ minLength: 1 })),
    output_root: Type.Optional(Type.String({ minLength: 1 })),
    timeout_ms: Type.Optional(Type.Integer({ minimum: 1000, maximum: 300000 })),
  },
  { additionalProperties: false },
);

const ExecutionTokenRequestParamsSchema = Type.Object(
  {
    cloud_access_token: Type.String({
      minLength: 1,
      description:
        "Transient Dijie cloud customer bearer token. Used only for this request and never persisted.",
    }),
    role_listing_id: Type.String({ minLength: 1 }),
    entitlement_id: Type.String({ minLength: 1 }),
    device_id: Type.String({ minLength: 1 }),
    workspace_ref: Type.String({ minLength: 1 }),
    local_gateway_id: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

const ExecutionAuditReadParamsSchema = Type.Object(
  {
    cloud_access_token: Type.String({
      minLength: 1,
      description:
        "Transient Dijie cloud customer bearer token. Used only for this audit read request and never persisted.",
    }),
    execution_id: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

const MarketplaceInstalledRolesParamsSchema = Type.Object(
  {
    cloud_access_token: Type.String({
      minLength: 1,
      description:
        "Transient Dijie cloud customer bearer token. Used only for this installed-role read request and never persisted.",
    }),
    workspace_ref: Type.Optional(Type.String({ minLength: 1 })),
    device_id: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function isOneTimeAuthorizationPricing(value: unknown): boolean {
  const pricing = asRecord(value);
  return (
    pricing.kind === "one_time_authorization" &&
    isNonNegativeInteger(pricing.authorizationFeeCents) &&
    isNonEmptyString(pricing.currency) &&
    pricing.platformFeeBps === 0 &&
    isNonNegativeInteger(pricing.developerReceivableCents) &&
    pricing.developerReceivableCents === pricing.authorizationFeeCents
  );
}

function isRoleTokenPricing(value: unknown): value is DijieRoleTokenPricing {
  const pricing = asRecord(value);
  return (
    isNonNegativeInteger(pricing.inputTokenCentsPerMillion) &&
    isNonNegativeInteger(pricing.outputTokenCentsPerMillion) &&
    isNonEmptyString(pricing.currency) &&
    pricing.developerReceivableBps === 10000 &&
    pricing.platformFeeBps === 0
  );
}

function readPluginConfig(raw: unknown): AicsConfig {
  const record = asRecord(raw);
  const repoRoot =
    typeof record.repoRoot === "string" && record.repoRoot.trim()
      ? record.repoRoot
      : DEFAULT_REPO_ROOT;
  const pythonBinary =
    typeof record.pythonBinary === "string" && record.pythonBinary.trim()
      ? record.pythonBinary
      : "python3";
  const rolePackageOutputRoot =
    typeof record.rolePackageOutputRoot === "string" && record.rolePackageOutputRoot.trim()
      ? record.rolePackageOutputRoot
      : DEFAULT_ROLE_PACKAGE_OUTPUT_ROOT;
  const allowWrites = record.allowWrites === true;
  const maxOutputChars =
    typeof record.maxOutputChars === "number" && Number.isFinite(record.maxOutputChars)
      ? Math.max(1000, Math.trunc(record.maxOutputChars))
      : DEFAULT_MAX_OUTPUT_CHARS;
  const executionTokenPublicKeyPem =
    typeof record.executionTokenPublicKeyPem === "string" &&
    record.executionTokenPublicKeyPem.trim()
      ? record.executionTokenPublicKeyPem
      : undefined;
  const explicitLocalExecutorCommand =
    typeof record.localExecutorCommand === "string" && record.localExecutorCommand.trim()
      ? record.localExecutorCommand.trim()
      : undefined;
  // Legacy only: older local configs used Codex CLI field names. Product-facing
  // config must use localExecutor* until this subprocess adapter is replaced by
  // OpenClaw-native workspace/session execution.
  const legacyCodexBinary =
    typeof record.codexBinary === "string" && record.codexBinary.trim()
      ? record.codexBinary.trim()
      : undefined;
  const localExecutorCommand = explicitLocalExecutorCommand ?? legacyCodexBinary;
  const localExecutorArgs = Array.isArray(record.localExecutorArgs)
    ? record.localExecutorArgs.filter((arg): arg is string => typeof arg === "string")
    : undefined;
  const localExecutorModel =
    typeof record.localExecutorModel === "string" && record.localExecutorModel.trim()
      ? record.localExecutorModel.trim()
      : typeof record.codexModel === "string" && record.codexModel.trim()
        ? record.codexModel.trim()
        : undefined;
  const localExecutorProfile =
    typeof record.localExecutorProfile === "string" && record.localExecutorProfile.trim()
      ? record.localExecutorProfile.trim()
      : typeof record.codexProfile === "string" && record.codexProfile.trim()
        ? record.codexProfile.trim()
        : undefined;
  const localExecutorMode =
    record.localExecutorMode === "native" ||
    record.localExecutorMode === "subprocess" ||
    record.localExecutorMode === "auto"
      ? record.localExecutorMode
      : "auto";
  const cloudExecutionTokenPath =
    typeof record.cloudExecutionTokenPath === "string" && record.cloudExecutionTokenPath.trim()
      ? record.cloudExecutionTokenPath.trim()
      : DEFAULT_CLOUD_EXECUTION_TOKEN_PATH;
  const cloudExecutionTokenUrl =
    typeof record.cloudExecutionTokenUrl === "string" && record.cloudExecutionTokenUrl.trim()
      ? record.cloudExecutionTokenUrl.trim()
      : typeof record.cloudBaseUrl === "string" && record.cloudBaseUrl.trim()
        ? new URL(cloudExecutionTokenPath, record.cloudBaseUrl).toString()
        : undefined;
  const cloudExecutionReadPath =
    typeof record.cloudExecutionReadPath === "string" && record.cloudExecutionReadPath.trim()
      ? record.cloudExecutionReadPath.trim()
      : DEFAULT_CLOUD_EXECUTION_READ_PATH;
  const cloudExecutionReadUrl =
    typeof record.cloudExecutionReadUrl === "string" && record.cloudExecutionReadUrl.trim()
      ? record.cloudExecutionReadUrl.trim()
      : typeof record.cloudBaseUrl === "string" && record.cloudBaseUrl.trim()
        ? new URL(cloudExecutionReadPath, record.cloudBaseUrl).toString()
        : undefined;
  const cloudMarketplaceInstalledRolesPath =
    typeof record.cloudMarketplaceInstalledRolesPath === "string" &&
    record.cloudMarketplaceInstalledRolesPath.trim()
      ? record.cloudMarketplaceInstalledRolesPath.trim()
      : DEFAULT_CLOUD_MARKETPLACE_INSTALLED_ROLES_PATH;
  const cloudMarketplaceInstalledRolesUrl =
    typeof record.cloudMarketplaceInstalledRolesUrl === "string" &&
    record.cloudMarketplaceInstalledRolesUrl.trim()
      ? record.cloudMarketplaceInstalledRolesUrl.trim()
      : typeof record.cloudBaseUrl === "string" && record.cloudBaseUrl.trim()
        ? new URL(cloudMarketplaceInstalledRolesPath, record.cloudBaseUrl).toString()
        : undefined;
  const cloudAuditPath =
    typeof record.cloudAuditPath === "string" && record.cloudAuditPath.trim()
      ? record.cloudAuditPath.trim()
      : DEFAULT_CLOUD_AUDIT_PATH;
  const cloudAuditUrl =
    typeof record.cloudAuditUrl === "string" && record.cloudAuditUrl.trim()
      ? record.cloudAuditUrl.trim()
      : typeof record.cloudBaseUrl === "string" && record.cloudBaseUrl.trim()
        ? new URL(cloudAuditPath, record.cloudBaseUrl).toString()
        : undefined;
  const cloudAuditUploadRequired =
    record.cloudAuditUploadRequired === true || record.auditUploadRequired === true;
  const cloudAuditUploadEnabled =
    cloudAuditUploadRequired ||
    record.cloudAuditUploadEnabled === true ||
    record.auditUploadEnabled === true;

  return {
    repoRoot: path.resolve(repoRoot),
    pythonBinary,
    rolePackageOutputRoot: path.resolve(rolePackageOutputRoot),
    allowWrites,
    maxOutputChars,
    executionTokenPublicKeyPem,
    localExecutorCommand,
    localExecutorArgs,
    localExecutorModel,
    localExecutorProfile,
    localExecutorMode,
    useLegacyCodexCliArgs: !explicitLocalExecutorCommand && Boolean(legacyCodexBinary),
    cloudExecutionTokenUrl,
    cloudExecutionReadUrl,
    cloudMarketplaceInstalledRolesUrl,
    cloudAuditUrl,
    cloudAuditUploadEnabled,
    cloudAuditUploadRequired,
  };
}

function stringField(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function preflightError(error: string, code: string) {
  return {
    ok: false,
    code,
    error,
  };
}

export function verifyDijieExecutionPreflight(
  config: Pick<AicsConfig, "executionTokenPublicKeyPem">,
  rawParams: unknown,
) {
  const params = asRecord(rawParams);
  const executionToken = stringField(params, "executionToken");
  if (!executionToken) {
    return preflightError("executionToken is required.", "missing_execution_token");
  }

  const requiredFields = [
    "roleListingId",
    "entitlementId",
    "deviceId",
    "workspaceRef",
    "localGatewayId",
  ] as const;
  const missing = requiredFields.filter((field) => !stringField(params, field));
  if (missing.length > 0) {
    return preflightError(`Missing required fields: ${missing.join(", ")}`, "missing_context");
  }

  const nowMs =
    typeof params.nowMs === "number" && Number.isInteger(params.nowMs) ? params.nowMs : Date.now();
  const verified = verifyDijieExecutionToken(
    executionToken,
    config.executionTokenPublicKeyPem,
    nowMs,
  );
  if (!verified.ok) {
    return preflightError(verified.error, "invalid_execution_token");
  }

  for (const field of requiredFields) {
    if (verified.claims[field] !== stringField(params, field)) {
      return preflightError(
        `Execution token ${field} does not match local request context.`,
        "context_mismatch",
      );
    }
  }

  if (
    !verified.claims.scopes.includes("role.build") &&
    !verified.claims.scopes.includes("role.execute")
  ) {
    return preflightError("Execution token does not include role.build scope.", "missing_scope");
  }

  return {
    ok: true,
    executionId: verified.claims.executionId,
    actorId: verified.claims.actorId,
    roleListingId: verified.claims.roleListingId,
    packageId: verified.claims.packageId,
    packageVersion: verified.claims.packageVersion,
    developerRef: verified.claims.developerRef,
    listingOwnerRef: verified.claims.listingOwnerRef,
    billingBeneficiaryRef: verified.claims.billingBeneficiaryRef,
    entitlementId: verified.claims.entitlementId,
    deviceId: verified.claims.deviceId,
    workspaceRef: verified.claims.workspaceRef,
    localGatewayId: verified.claims.localGatewayId,
    pricing: verified.claims.pricing,
    roleTokenPricing: verified.claims.roleTokenPricing,
    scopes: verified.claims.scopes,
    expiresAt: new Date(verified.claims.exp * 1000).toISOString(),
  };
}

function requireStringParam(
  params: Record<string, unknown>,
  field: string,
  message = `${field} is required`,
): string {
  const value = stringField(params, field);
  if (!value) {
    throw new Error(message);
  }
  return value;
}

function buildPreflightParams(params: Record<string, unknown>) {
  return {
    executionToken: requireStringParam(
      params,
      "execution_token",
      "execution_token is required when confirm_brief=true",
    ),
    roleListingId: requireStringParam(
      params,
      "role_listing_id",
      "role_listing_id is required when confirm_brief=true",
    ),
    entitlementId: requireStringParam(
      params,
      "entitlement_id",
      "entitlement_id is required when confirm_brief=true",
    ),
    deviceId: requireStringParam(
      params,
      "device_id",
      "device_id is required when confirm_brief=true",
    ),
    workspaceRef: requireStringParam(
      params,
      "workspace_ref",
      "workspace_ref is required when confirm_brief=true",
    ),
    localGatewayId: requireStringParam(
      params,
      "local_gateway_id",
      "local_gateway_id is required when confirm_brief=true",
    ),
  };
}

function normalizeContextKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9_]/g, "").toLowerCase();
}

function isForbiddenDeveloperModeContextKey(key: string): boolean {
  return FORBIDDEN_DEVELOPER_MODE_CONTEXT_KEYS.has(normalizeContextKey(key));
}

function redactForbiddenDeveloperModeContextText(value: string): string {
  return value
    .replace(PROVIDER_KEY_NAME_PATTERN, "[redacted_provider_key_name]")
    .replace(PROVIDER_KEY_VALUE_PATTERN, "[redacted_provider_key_value]")
    .replace(CLOUD_BEARER_PATTERN, "[redacted_cloud_bearer]");
}

function sanitizeDeveloperModeContextValue(value: unknown): unknown {
  if (typeof value === "string") {
    return redactForbiddenDeveloperModeContextText(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeDeveloperModeContextValue(entry));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !isForbiddenDeveloperModeContextKey(key))
      .map(([key, entry]) => [key, sanitizeDeveloperModeContextValue(entry)]),
  );
}

function sanitizeDeveloperModeBriefJson(roleBuildBriefJson: string): string {
  try {
    return JSON.stringify(
      sanitizeDeveloperModeContextValue(JSON.parse(roleBuildBriefJson)),
      null,
      2,
    );
  } catch {
    return redactForbiddenDeveloperModeContextText(roleBuildBriefJson);
  }
}

function buildLocalExecutorRoleBuilderPrompt(params: {
  requestZh: string;
  roleBuildBriefJson: string;
}): string {
  const sanitizedRequestZh = redactForbiddenDeveloperModeContextText(params.requestZh);
  const sanitizedRoleBuildBriefJson = sanitizeDeveloperModeBriefJson(params.roleBuildBriefJson);
  return [
    "你是迭界AI主系统岗位包生成，正在通过 OpenClaw main-system local execution / 本地主系统编程执行生成岗位包。",
    "",
    "开发者模式上下文 allowlist：",
    `- 允许：${AICS_DEVELOPER_MODE_CONTEXT_ALLOWLIST.join("、")}。`,
    "- 禁止：平台后端执行/身份/授权 ID、订单或钱包状态、价格快照、云端 bearer、raw token、provider key、审核/结算状态、普通用户对话历史和私有记忆。",
    "",
    DEVELOPER_MODE_GUIDE_PROMPT,
    "",
    ROLE_PACKAGE_BUILT_IN_MATERIALS,
    "",
    "硬性边界：",
    "- 只在当前工作区内创建或修改文件。",
    "- 必须把岗位包写入 `role_package/` 目录。",
    "- 不要写平台数据库，不要修改钱包、订单、entitlement、listing、deployment 或审核状态。",
    "- 如果确认 brief 缺少生成岗位包所需的核心字段，必须失败并在最终回复中明确列出缺失项，不能伪造成功。",
    "- 不要把模型密钥、provider auth、secret 原文写入岗位包。",
    "- 不要读取或输出平台后端资料；execution token、entitlement、审计、结算、订单、钱包和审核状态只由平台桥内部处理。",
    "",
    "最低产物：",
    "- `role_package/manifest.json`",
    "- `role_package/listing.md`",
    "- `role_package/README.md`",
    "- 至少一个 wrapper/adapter 或接入示例文件",
    "- 至少一个 validation 或 smoke test 说明/脚本",
    "",
    "隔离 workspace：当前工作目录就是本次岗位包生成的唯一工作区；只使用 `role_package/` 相对路径，不写本地绝对路径。",
    "",
    "用户中文需求：",
    sanitizedRequestZh,
    "",
    "已确认 RoleBuildBrief JSON：",
    sanitizedRoleBuildBriefJson,
  ].join("\n");
}

function expandLocalExecutorArg(arg: string, outputRoot: string, lastMessagePath: string): string {
  return arg
    .replaceAll("{outputRoot}", outputRoot)
    .replaceAll("{lastMessagePath}", lastMessagePath);
}

function buildLocalExecutorArgs(
  config: AicsConfig,
  outputRoot: string,
  lastMessagePath: string,
): string[] {
  if (config.localExecutorArgs) {
    return config.localExecutorArgs.map((arg) =>
      expandLocalExecutorArg(arg, outputRoot, lastMessagePath),
    );
  }
  if (!config.useLegacyCodexCliArgs) {
    return [];
  }
  // Legacy compatibility path only. This is not the 迭界AI product execution
  // boundary; the product path is the generic local executor and, next,
  // OpenClaw-native workspace/session execution.
  const args = [
    "exec",
    "--cd",
    outputRoot,
    "--skip-git-repo-check",
    "--sandbox",
    "workspace-write",
    "--json",
    "--output-last-message",
    lastMessagePath,
  ];
  if (config.localExecutorModel) {
    args.push("--model", config.localExecutorModel);
  }
  if (config.localExecutorProfile) {
    args.push("--profile", config.localExecutorProfile);
  }
  args.push("-");
  return args;
}

function requireExistingRepo(config: AicsConfig): void {
  if (!existsSync(path.join(config.repoRoot, "main.py"))) {
    throw new Error(`迭界AI repo root is invalid or missing main.py: ${config.repoRoot}`);
  }
}

function resolveOutputRoot(config: AicsConfig, requested: unknown): string {
  const base = path.resolve(config.rolePackageOutputRoot);
  const outputRoot =
    typeof requested === "string" && requested.trim() ? path.resolve(requested) : base;
  const realBaseParent = path.resolve(base);
  const relative = path.relative(realBaseParent, outputRoot);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return outputRoot;
  }
  throw new Error(`output_root must stay under ${realBaseParent}`);
}

function truncateOutput(value: string, maxChars: number): { text: string; truncated: boolean } {
  if (value.length <= maxChars) {
    return { text: value, truncated: false };
  }
  return {
    text: `${value.slice(0, maxChars)}\n[truncated ${value.length - maxChars} chars]`,
    truncated: true,
  };
}

function buildDefaultCommandEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PYTHONPYCACHEPREFIX: process.env.PYTHONPYCACHEPREFIX ?? "/private/tmp/aics_pycache",
  };
}

function buildLocalExecutorCommandEnv(): NodeJS.ProcessEnv {
  const allowedKeys = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "TEMP",
    "TMP",
    "TERM",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "CODEX_HOME",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
    "SSL_CERT_FILE",
    "NODE_EXTRA_CA_CERTS",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
  ];
  const env: NodeJS.ProcessEnv = {
    PYTHONPYCACHEPREFIX: process.env.PYTHONPYCACHEPREFIX ?? "/private/tmp/aics_pycache",
  };
  for (const key of allowedKeys) {
    const value = process.env[key];
    if (value) {
      env[key] = value;
    }
  }
  return env;
}

function runCommand(
  command: string,
  args: string[],
  options: {
    cwd: string;
    maxOutputChars: number;
    timeoutMs?: number;
    stdin?: string;
    env?: NodeJS.ProcessEnv;
  },
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? buildDefaultCommandEnv(),
      stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let killedForTimeout = false;
    const timer = options.timeoutMs
      ? setTimeout(() => {
          killedForTimeout = true;
          child.kill("SIGTERM");
        }, options.timeoutMs)
      : null;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (exitCode, signal) => {
      if (timer) {
        clearTimeout(timer);
      }
      const out = truncateOutput(stdout, options.maxOutputChars);
      const err = truncateOutput(stderr, options.maxOutputChars);
      resolve({
        command: [command, ...args],
        cwd: options.cwd,
        exitCode,
        signal: killedForTimeout ? "SIGTERM" : signal,
        stdout: out.text,
        stderr: err.text,
        truncated: out.truncated || err.truncated,
      });
    });
    if (options.stdin !== undefined) {
      child.stdin?.end(options.stdin);
    }
  });
}

type NativeRoleBuilderRuntime = Pick<PluginRuntime, "agent"> | undefined;

function canRunOpenClawNativeExecutor(
  runtime: NativeRoleBuilderRuntime,
): runtime is Pick<PluginRuntime, "agent"> {
  return typeof runtime?.agent?.runEmbeddedAgent === "function";
}

function collectEmbeddedAgentText(
  result: Awaited<ReturnType<PluginRuntime["agent"]["runEmbeddedAgent"]>>,
): string {
  const payloadText = result.payloads
    ?.map((payload) => payload.text)
    .filter((text): text is string => typeof text === "string" && text.trim().length > 0)
    .join("\n");
  if (payloadText?.trim()) {
    return payloadText;
  }
  if (result.meta.finalAssistantVisibleText?.trim()) {
    return result.meta.finalAssistantVisibleText;
  }
  if (result.meta.finalAssistantRawText?.trim()) {
    return result.meta.finalAssistantRawText;
  }
  return "";
}

function embeddedAgentErrorText(
  result: Awaited<ReturnType<PluginRuntime["agent"]["runEmbeddedAgent"]>>,
): string {
  const payloadErrors = result.payloads
    ?.filter((payload) => payload.isError && payload.text?.trim())
    .map((payload) => payload.text?.trim())
    .filter((text): text is string => Boolean(text))
    .join("\n");
  if (payloadErrors?.trim()) {
    return payloadErrors;
  }
  if (result.meta.failureSignal?.message) {
    return result.meta.failureSignal.message;
  }
  if (result.meta.error?.message) {
    return result.meta.error.message;
  }
  return "";
}

function finiteTokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

function extractOpenClawNativeModelProxyUsage(
  result: Awaited<ReturnType<PluginRuntime["agent"]["runEmbeddedAgent"]>>,
): DijieModelProxyUsage {
  const meta = asRecord(result.meta);
  const agentMeta = asRecord(meta.agentMeta);
  const usage = asRecord(agentMeta.usage);
  const executionTrace = asRecord(meta.executionTrace);
  const attempts = Array.isArray(executionTrace.attempts) ? executionTrace.attempts : [];
  const inputTokens = finiteTokenCount(usage.input);
  const outputTokens = finiteTokenCount(usage.output);
  return {
    requestCount:
      attempts.length > 0 ? attempts.length : inputTokens > 0 || outputTokens > 0 ? 1 : 0,
    inputTokens,
    outputTokens,
  };
}

function zeroModelProxyUsage(): DijieModelProxyUsage {
  return {
    requestCount: 0,
    inputTokens: 0,
    outputTokens: 0,
  };
}

async function runOpenClawNativeRoleBuilder(params: {
  runtime: Pick<PluginRuntime, "agent">;
  runtimeConfig: OpenClawConfig;
  prompt: string;
  workspaceRoot: string;
  timeoutMs: number;
  maxOutputChars: number;
  preflight: ReturnType<typeof verifyDijieExecutionPreflight> & { ok: true };
}): Promise<CommandResult> {
  const sessionId = `dijie-role-builder-${String(params.preflight.executionId)}`;
  const sessionFile = path.join(params.workspaceRoot, ".dijie_openclaw_native_session.json");
  const runId = `${sessionId}-${Date.now()}`;

  const result = await params.runtime.agent.runEmbeddedAgent({
    sessionId,
    sessionKey: sessionId,
    sandboxSessionKey: sessionId,
    sessionFile,
    workspaceDir: params.workspaceRoot,
    cwd: params.workspaceRoot,
    config: params.runtimeConfig,
    prompt: params.prompt,
    transcriptPrompt: "Generate a Dijie role_package from the confirmed RoleBuildBrief.",
    timeoutMs: params.timeoutMs,
    runId,
    trigger: "manual",
    messageChannel: "dijie-role-builder",
    disableMessageTool: true,
    cleanupBundleMcpOnRunEnd: true,
  });

  const stdout = truncateOutput(collectEmbeddedAgentText(result), params.maxOutputChars);
  const stderr = truncateOutput(embeddedAgentErrorText(result), params.maxOutputChars);
  const timedOut = Boolean(result.meta.timeoutPhase);
  const failed =
    timedOut ||
    result.meta.aborted === true ||
    Boolean(result.meta.error) ||
    Boolean(result.meta.failureSignal) ||
    Boolean(result.payloads?.some((payload) => payload.isError));

  return {
    command: ["openclaw-native", "runEmbeddedAgent"],
    cwd: params.workspaceRoot,
    exitCode: timedOut ? null : failed ? 1 : 0,
    signal: timedOut ? "SIGTERM" : null,
    stdout: stdout.text,
    stderr: stderr.text,
    truncated: stdout.truncated || stderr.truncated,
    modelProxyUsage: extractOpenClawNativeModelProxyUsage(result),
  };
}

function toWorkspaceRelativePath(rootRealPath: string, absolutePath: string): string {
  const relative = path.relative(rootRealPath, absolutePath);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`role package file escaped output workspace: ${absolutePath}`);
  }
  return relative.split(path.sep).join("/");
}

function listWorkspaceFiles(workspaceRoot: string): RolePackageFile[] {
  const rootRealPath = realpathSync(workspaceRoot);
  const files: RolePackageFile[] = [];

  function visit(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      if (entry.isSymbolicLink()) {
        throw new Error(
          `role package output must not contain symlinks: ${path.join(directory, entry.name)}`,
        );
      }
      const absolutePath = path.join(directory, entry.name);
      const stats = statSync(absolutePath);
      if (stats.isDirectory()) {
        visit(absolutePath);
        continue;
      }
      if (!stats.isFile()) {
        continue;
      }
      const realPath = realpathSync(absolutePath);
      const relativePath = toWorkspaceRelativePath(rootRealPath, realPath);
      const content = readFileSync(realPath);
      files.push({
        relativePath,
        absolutePath: realPath,
        sizeBytes: stats.size,
        sha256: crypto.createHash("sha256").update(content).digest("hex"),
      });
    }
  }

  visit(rootRealPath);
  return files.sort((a, b) =>
    a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0,
  );
}

function uniqueNonEmptyStrings(values: Array<unknown>): string[] {
  return Array.from(
    new Set(
      values.filter(
        (value): value is string => typeof value === "string" && value.trim().length > 0,
      ),
    ),
  );
}

function buildForbiddenArtifactExactValues(params: {
  preflight: ReturnType<typeof verifyDijieExecutionPreflight> & { ok: true };
  executionToken: string;
}): string[] {
  return uniqueNonEmptyStrings([
    params.executionToken,
    params.preflight.executionId,
    params.preflight.actorId,
    params.preflight.roleListingId,
    params.preflight.entitlementId,
    params.preflight.deviceId,
    params.preflight.workspaceRef,
    params.preflight.localGatewayId,
  ]);
}

function artifactBackendOnlyKeys(content: string): string[] {
  const keys: string[] = [];
  const keyMatches = content.matchAll(/["']?([A-Za-z][A-Za-z0-9_-]{2,})["']?\s*[:=]/gu);
  for (const match of keyMatches) {
    const key = match[1];
    if (key && BACKEND_ONLY_ARTIFACT_KEYS.has(normalizeContextKey(key))) {
      keys.push(key);
    }
  }
  return Array.from(new Set(keys));
}

function scanRolePackageArtifactContent(params: {
  file: RolePackageFile;
  content: string;
  workspaceRoot: string;
  forbiddenExactValues: string[];
}): string[] {
  const errors: string[] = [];
  const prefix = `${params.file.relativePath} contains`;

  for (const exactValue of params.forbiddenExactValues) {
    if (params.content.includes(exactValue)) {
      errors.push(`${prefix} backend-only id or raw execution token`);
      break;
    }
  }

  if (
    PROVIDER_KEY_NAME_PATTERN.test(params.content) ||
    PROVIDER_KEY_VALUE_PATTERN.test(params.content)
  ) {
    errors.push(`${prefix} provider key name or value`);
  }
  if (CLOUD_BEARER_PATTERN.test(params.content)) {
    errors.push(`${prefix} cloud bearer token`);
  }
  if (SECRET_FIELD_PATTERN.test(params.content)) {
    errors.push(`${prefix} secret or token field`);
  }
  if (
    LOCAL_ABSOLUTE_PATH_PATTERN.test(params.content) ||
    params.content.includes(params.workspaceRoot)
  ) {
    errors.push(`${prefix} local absolute path`);
  }
  for (const backendOnlyKey of artifactBackendOnlyKeys(params.content)) {
    errors.push(`${prefix} backend-only field ${backendOnlyKey}`);
  }
  return errors;
}

function scanRolePackageArtifacts(params: {
  workspaceRoot: string;
  files: RolePackageFile[];
  preflight: ReturnType<typeof verifyDijieExecutionPreflight> & { ok: true };
  executionToken: string;
}): string[] {
  const forbiddenExactValues = buildForbiddenArtifactExactValues({
    preflight: params.preflight,
    executionToken: params.executionToken,
  });
  const errors: string[] = [];
  for (const file of params.files) {
    if (!file.relativePath.startsWith("role_package/")) {
      continue;
    }
    const content = readFileSync(file.absolutePath, "utf8");
    errors.push(
      ...scanRolePackageArtifactContent({
        file,
        content,
        workspaceRoot: params.workspaceRoot,
        forbiddenExactValues,
      }),
    );
  }
  return errors;
}

function validateRolePackage(
  workspaceRoot: string,
  files: RolePackageFile[],
  scanContext?: {
    preflight: ReturnType<typeof verifyDijieExecutionPreflight> & { ok: true };
    executionToken: string;
  },
) {
  const filePaths = new Set(files.map((file) => file.relativePath));
  const errors: string[] = [];
  const requiredFiles = [
    "role_package/manifest.json",
    "role_package/listing.md",
    "role_package/README.md",
  ];
  for (const requiredFile of requiredFiles) {
    if (!filePaths.has(requiredFile)) {
      errors.push(`missing ${requiredFile}`);
    }
  }

  if (filePaths.has("role_package/manifest.json")) {
    try {
      JSON.parse(readFileSync(path.join(workspaceRoot, "role_package", "manifest.json"), "utf8"));
    } catch {
      errors.push("role_package/manifest.json must contain valid JSON");
    }
  }

  const rolePackageFiles = files
    .map((file) => file.relativePath)
    .filter((relativePath) => relativePath.startsWith("role_package/"));
  const hasWrapperAdapterOrExample = rolePackageFiles.some((relativePath) =>
    /(^|\/)(wrappers?|adapters?|examples?|samples?|integrations?)(\/|[-_.])|[-_.](wrapper|adapter|example|sample|integration)\./i.test(
      relativePath,
    ),
  );
  if (!hasWrapperAdapterOrExample) {
    errors.push("missing role_package wrapper, adapter, or integration example file");
  }

  const hasValidationOrSmoke = rolePackageFiles.some((relativePath) =>
    /(validation|validate|smoke|tests?|spec)(\/|[-_.]|\.)/i.test(relativePath),
  );
  if (!hasValidationOrSmoke) {
    errors.push("missing role_package validation or smoke test material");
  }

  if (scanContext) {
    errors.push(
      ...scanRolePackageArtifacts({
        workspaceRoot,
        files,
        preflight: scanContext.preflight,
        executionToken: scanContext.executionToken,
      }),
    );
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}

function statusFromLocalExecutorAndValidation(
  result: CommandResult,
  validationOk: boolean,
): DijieExecutionStatus {
  if (result.signal === "SIGTERM" && result.exitCode === null) {
    return "timed_out";
  }
  return result.exitCode === 0 && validationOk ? "completed" : "failed";
}

function errorFromLocalExecutorAndValidation(
  result: CommandResult,
  validationErrors: string[],
): string | undefined {
  if (result.signal === "SIGTERM" && result.exitCode === null) {
    return "local executor timed out";
  }
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    return detail
      ? `local executor failed: ${detail}`
      : `local executor failed with exit code ${String(result.exitCode)}`;
  }
  if (validationErrors.length > 0) {
    return `role_package validation failed: ${validationErrors.join("; ")}`;
  }
  return undefined;
}

function artifactId(relativePath: string): string {
  const normalized = relativePath.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return `artifact_${normalized || "role_package"}`;
}

function buildDijieAuditSummary(params: {
  preflight: ReturnType<typeof verifyDijieExecutionPreflight> & { ok: true };
  result: CommandResult;
  startedAt: string;
  endedAt: string;
  files: RolePackageFile[];
  validation: { ok: boolean; errors: string[] };
}) {
  const changedFiles = params.files.map((file) => file.relativePath);
  const rolePackageFiles = params.files.filter((file) =>
    file.relativePath.startsWith("role_package/"),
  );
  const status = statusFromLocalExecutorAndValidation(params.result, params.validation.ok);
  const error = errorFromLocalExecutorAndValidation(params.result, params.validation.errors);
  const modelProxyUsage = params.result.modelProxyUsage ?? zeroModelProxyUsage();
  const roleResult = {
    executionId: params.preflight.executionId,
    roleListingId: params.preflight.roleListingId,
    packageId: params.preflight.packageId,
    packageVersion: params.preflight.packageVersion,
    developerRef: params.preflight.developerRef,
    listingOwnerRef: params.preflight.listingOwnerRef,
    billingBeneficiaryRef: params.preflight.billingBeneficiaryRef,
    status,
    startedAt: params.startedAt,
    endedAt: params.endedAt,
    roleTokenPricing: params.preflight.roleTokenPricing,
    modelProxyUsage,
    summary:
      status === "completed"
        ? "迭界AI role-builder generated and validated a local role_package."
        : "迭界AI role-builder did not produce a valid local role_package.",
    changedFiles,
    artifacts: rolePackageFiles.map((file) => ({
      id: artifactId(file.relativePath),
      type: "role_package_file",
      title: file.relativePath,
      sizeBytes: file.sizeBytes,
      sha256: file.sha256,
    })),
    ...(error ? { error } : {}),
  };

  return {
    executionId: params.preflight.executionId,
    deviceId: params.preflight.deviceId,
    workspaceRef: params.preflight.workspaceRef,
    roleListingId: params.preflight.roleListingId,
    packageId: params.preflight.packageId,
    packageVersion: params.preflight.packageVersion,
    developerRef: params.preflight.developerRef,
    listingOwnerRef: params.preflight.listingOwnerRef,
    billingBeneficiaryRef: params.preflight.billingBeneficiaryRef,
    entitlementId: params.preflight.entitlementId,
    localGatewayId: params.preflight.localGatewayId,
    status,
    startedAt: params.startedAt,
    endedAt: params.endedAt,
    roleTokenPricing: params.preflight.roleTokenPricing,
    modelProxyUsage,
    toolUsage: {
      shellCommands: 1,
      testsRun: 1,
      filesRead: 0,
      filesChanged: changedFiles.length,
    },
    result: roleResult,
  };
}

async function uploadDijieAudit(params: {
  config: AicsConfig;
  executionToken: string;
  auditSummary: unknown;
}) {
  if (!params.config.cloudAuditUploadEnabled) {
    return { ok: true, skipped: true, required: false };
  }
  if (!params.config.cloudAuditUrl) {
    return {
      ok: false,
      skipped: false,
      required: params.config.cloudAuditUploadRequired,
      error: "cloudAuditUrl or cloudBaseUrl is required when Dijie audit upload is enabled.",
    };
  }
  if (typeof globalThis.fetch !== "function") {
    return {
      ok: false,
      skipped: false,
      required: params.config.cloudAuditUploadRequired,
      error: "global fetch is unavailable for Dijie audit upload.",
    };
  }

  try {
    const response = await globalThis.fetch(params.config.cloudAuditUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${params.executionToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ auditSummary: params.auditSummary }),
    });
    const responseText = await response.text();
    if (!response.ok) {
      return {
        ok: false,
        skipped: false,
        required: params.config.cloudAuditUploadRequired,
        statusCode: response.status,
        error: responseText.trim() || `Dijie audit upload failed with HTTP ${response.status}`,
      };
    }
    return {
      ok: true,
      skipped: false,
      required: params.config.cloudAuditUploadRequired,
      statusCode: response.status,
      response: responseText ? parseAuditUploadResponse(responseText) : undefined,
    };
  } catch (error) {
    return {
      ok: false,
      skipped: false,
      required: params.config.cloudAuditUploadRequired,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function parseAuditUploadResponse(responseText: string): unknown {
  try {
    return JSON.parse(responseText);
  } catch {
    return responseText;
  }
}

function redactCloudAccessTokenText(value: string, cloudAccessToken: string): string {
  return cloudAccessToken
    ? value.replaceAll(cloudAccessToken, "[redacted_cloud_access_token]")
    : value;
}

function redactCloudAccessTokenValue(value: unknown, cloudAccessToken: string): unknown {
  if (typeof value === "string") {
    return redactCloudAccessTokenText(value, cloudAccessToken);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactCloudAccessTokenValue(entry, cloudAccessToken));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => {
      const normalizedKey = key.replaceAll("_", "").toLowerCase();
      if (
        normalizedKey === "cloudaccesstoken" ||
        normalizedKey === "authorization" ||
        normalizedKey === "bearertoken"
      ) {
        return [key, "[redacted_cloud_access_token]"];
      }
      return [key, redactCloudAccessTokenValue(entry, cloudAccessToken)];
    }),
  );
}

function executionAuditReadUrl(baseUrl: string, executionId: string): string {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(encodeURIComponent(executionId), normalizedBase).toString();
}

function marketplaceInstalledRolesUrl(
  baseUrl: string,
  params: { workspaceRef?: string; deviceId?: string },
): string {
  const url = new URL(baseUrl);
  if (params.workspaceRef) {
    url.searchParams.set("workspaceRef", params.workspaceRef);
  }
  if (params.deviceId) {
    url.searchParams.set("deviceId", params.deviceId);
  }
  return url.toString();
}

function createExecutionTokenRequestTool(config: AicsConfig): AnyAgentTool {
  return {
    name: "dijie_execution_token_request",
    label: "迭界AI Execution Token Request",
    description:
      "Request a short-lived execution token from 迭界AI岗位商场. Requires configured cloudExecutionTokenUrl/cloudBaseUrl and a transient customer bearer token.",
    parameters: ExecutionTokenRequestParamsSchema,
    execute: async (_toolCallId, rawParams) => {
      const params = asRecord(rawParams);
      if (!config.cloudExecutionTokenUrl) {
        throw new Error(
          "cloudExecutionTokenUrl or cloudBaseUrl is required before requesting Dijie execution tokens.",
        );
      }
      if (typeof globalThis.fetch !== "function") {
        throw new Error("global fetch is unavailable for Dijie execution token requests.");
      }
      const cloudAccessToken = requireStringParam(
        params,
        "cloud_access_token",
        "cloud_access_token is required for Dijie execution token requests",
      );
      const requestBody = {
        roleListingId: requireStringParam(params, "role_listing_id"),
        entitlementId: requireStringParam(params, "entitlement_id"),
        deviceId: requireStringParam(params, "device_id"),
        workspaceRef: requireStringParam(params, "workspace_ref"),
        localGatewayId: requireStringParam(params, "local_gateway_id"),
      };

      let response: Response;
      try {
        response = await globalThis.fetch(config.cloudExecutionTokenUrl, {
          method: "POST",
          headers: {
            authorization: `Bearer ${cloudAccessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(requestBody),
        });
      } catch (error) {
        return jsonResult({
          ok: false,
          summary: "迭界AI cloud execution token request failed",
          error: redactCloudAccessTokenText(
            error instanceof Error ? error.message : String(error),
            cloudAccessToken,
          ),
        });
      }

      const responseText = await response.text();
      const payload = responseText ? asRecord(parseAuditUploadResponse(responseText)) : {};
      if (!response.ok || payload.ok !== true) {
        return jsonResult({
          ok: false,
          summary: "迭界AI cloud execution token request was rejected",
          statusCode: response.status,
          error: redactCloudAccessTokenText(
            stringField(payload, "error") ??
              stringField(payload, "reason") ??
              `Dijie cloud returned HTTP ${response.status}`,
            cloudAccessToken,
          ),
        });
      }

      const grant = asRecord(payload.grant);
      const token = stringField(grant, "token");
      if (
        !token ||
        !stringField(grant, "executionId") ||
        !stringField(grant, "roleListingId") ||
        !stringField(grant, "entitlementId") ||
        !stringField(grant, "deviceId") ||
        !stringField(grant, "workspaceRef") ||
        !stringField(grant, "localGatewayId") ||
        !isOneTimeAuthorizationPricing(grant.pricing) ||
        !isRoleTokenPricing(grant.roleTokenPricing) ||
        !Array.isArray(grant.scopes) ||
        !grant.scopes.every(isNonEmptyString)
      ) {
        return jsonResult({
          ok: false,
          summary: "迭界AI cloud execution token response did not include a valid grant",
          statusCode: response.status,
        });
      }

      return jsonResult({
        ok: true,
        summary: "迭界AI cloud execution token issued",
        grant: {
          executionId: stringField(grant, "executionId"),
          roleListingId: stringField(grant, "roleListingId"),
          entitlementId: stringField(grant, "entitlementId"),
          deviceId: stringField(grant, "deviceId"),
          workspaceRef: stringField(grant, "workspaceRef"),
          localGatewayId: stringField(grant, "localGatewayId"),
          token,
          issuedAt: stringField(grant, "issuedAt"),
          expiresAt: stringField(grant, "expiresAt"),
          pricing: grant.pricing,
          roleTokenPricing: grant.roleTokenPricing,
          scopes: Array.isArray(grant.scopes) ? grant.scopes : undefined,
        },
      });
    },
  };
}

function createExecutionAuditReadTool(config: AicsConfig): AnyAgentTool {
  return {
    name: "dijie_execution_audit_read",
    label: "迭界AI Execution Audit Read",
    description:
      "Read the safe execution audit projection from 迭界AI岗位商场. Requires configured cloudExecutionReadUrl/cloudBaseUrl and a transient customer bearer token.",
    parameters: ExecutionAuditReadParamsSchema,
    execute: async (_toolCallId, rawParams) => {
      const params = asRecord(rawParams);
      if (!config.cloudExecutionReadUrl) {
        throw new Error(
          "cloudExecutionReadUrl or cloudBaseUrl is required before reading Dijie execution audits.",
        );
      }
      if (typeof globalThis.fetch !== "function") {
        throw new Error("global fetch is unavailable for Dijie execution audit reads.");
      }
      const cloudAccessToken = requireStringParam(
        params,
        "cloud_access_token",
        "cloud_access_token is required for Dijie execution audit reads",
      );
      const executionId = requireStringParam(params, "execution_id");

      let response: Response;
      try {
        response = await globalThis.fetch(
          executionAuditReadUrl(config.cloudExecutionReadUrl, executionId),
          {
            method: "GET",
            headers: {
              authorization: `Bearer ${cloudAccessToken}`,
              accept: "application/json",
            },
          },
        );
      } catch (error) {
        return jsonResult({
          ok: false,
          summary: "迭界AI cloud execution audit read failed",
          error: redactCloudAccessTokenText(
            error instanceof Error ? error.message : String(error),
            cloudAccessToken,
          ),
        });
      }

      const responseText = await response.text();
      const payload = responseText ? asRecord(parseAuditUploadResponse(responseText)) : {};
      if (!response.ok || payload.ok !== true) {
        return jsonResult({
          ok: false,
          summary: "迭界AI cloud execution audit read was rejected",
          statusCode: response.status,
          error: redactCloudAccessTokenText(
            stringField(payload, "error") ??
              stringField(payload, "reason") ??
              `Dijie cloud returned HTTP ${response.status}`,
            cloudAccessToken,
          ),
        });
      }

      return jsonResult({
        ok: true,
        summary: "迭界AI cloud execution audit read completed",
        execution: redactCloudAccessTokenValue(payload.execution, cloudAccessToken),
      });
    },
  };
}

function createMarketplaceInstalledRolesTool(config: AicsConfig): AnyAgentTool {
  return {
    name: "dijie_marketplace_roles_list",
    label: "迭界AI Marketplace Roles",
    description:
      "Read installed and authorized roles from 迭界AI岗位商场. Requires configured cloudMarketplaceInstalledRolesUrl/cloudBaseUrl and a transient customer bearer token.",
    parameters: MarketplaceInstalledRolesParamsSchema,
    execute: async (_toolCallId, rawParams) => {
      const params = asRecord(rawParams);
      if (!config.cloudMarketplaceInstalledRolesUrl) {
        throw new Error(
          "cloudMarketplaceInstalledRolesUrl or cloudBaseUrl is required before reading installed roles.",
        );
      }
      if (typeof globalThis.fetch !== "function") {
        throw new Error("global fetch is unavailable for Dijie installed role reads.");
      }
      const cloudAccessToken = requireStringParam(
        params,
        "cloud_access_token",
        "cloud_access_token is required for Dijie installed role reads",
      );

      let response: Response;
      try {
        response = await globalThis.fetch(
          marketplaceInstalledRolesUrl(config.cloudMarketplaceInstalledRolesUrl, {
            workspaceRef: stringField(params, "workspace_ref"),
            deviceId: stringField(params, "device_id"),
          }),
          {
            method: "GET",
            headers: {
              authorization: `Bearer ${cloudAccessToken}`,
              accept: "application/json",
            },
          },
        );
      } catch (error) {
        return jsonResult({
          ok: false,
          summary: "迭界AI marketplace installed roles read failed",
          error: redactCloudAccessTokenText(
            error instanceof Error ? error.message : String(error),
            cloudAccessToken,
          ),
        });
      }

      const responseText = await response.text();
      const payload = responseText ? asRecord(parseAuditUploadResponse(responseText)) : {};
      if (!response.ok || payload.ok !== true) {
        return jsonResult({
          ok: false,
          summary: "迭界AI marketplace installed roles read was rejected",
          statusCode: response.status,
          error: redactCloudAccessTokenText(
            stringField(payload, "error") ??
              stringField(payload, "reason") ??
              `Dijie marketplace returned HTTP ${response.status}`,
            cloudAccessToken,
          ),
        });
      }

      const roles = Array.isArray(payload.roles)
        ? payload.roles
        : Array.isArray(payload.installedRoles)
          ? payload.installedRoles
          : undefined;
      if (!roles) {
        return jsonResult({
          ok: false,
          summary: "迭界AI marketplace installed roles response did not include roles",
          statusCode: response.status,
        });
      }

      return jsonResult({
        ok: true,
        summary: "迭界AI marketplace installed roles read completed",
        roles: redactCloudAccessTokenValue(roles, cloudAccessToken),
        source: "cloud",
      });
    },
  };
}

function createStatusTool(config: AicsConfig): AnyAgentTool {
  return {
    name: "aics_status",
    label: "迭界AI Status",
    description:
      "Inspect the local 迭界AI repo and run the approved doctor command through the OpenClaw runtime.",
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: async () => {
      requireExistingRepo(config);
      const repoRealPath = realpathSync(config.repoRoot);
      const branch = await runCommand("git", ["branch", "--show-current"], {
        cwd: repoRealPath,
        maxOutputChars: config.maxOutputChars,
        timeoutMs: 10000,
      });
      const status = await runCommand("git", ["status", "--short"], {
        cwd: repoRealPath,
        maxOutputChars: config.maxOutputChars,
        timeoutMs: 10000,
      });
      const doctor = await runCommand(config.pythonBinary, ["main.py", "--doctor"], {
        cwd: repoRealPath,
        maxOutputChars: config.maxOutputChars,
        timeoutMs: 60000,
      });

      return jsonResult({
        summary:
          doctor.exitCode === 0
            ? "迭界AI repo reachable and doctor command completed"
            : "迭界AI repo reachable but doctor command failed",
        repoRoot: repoRealPath,
        branch: branch.stdout.trim(),
        dirtyFiles: status.stdout
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean),
        doctor,
      });
    },
  };
}

function resolveRoleBuilderExecutor(params: {
  config: AicsConfig;
  runtime: NativeRoleBuilderRuntime;
}) {
  const nativeAvailable = canRunOpenClawNativeExecutor(params.runtime);
  const subprocessAvailable = Boolean(params.config.localExecutorCommand);

  if (params.config.localExecutorMode === "native") {
    return nativeAvailable ? "native" : undefined;
  }
  if (params.config.localExecutorMode === "subprocess") {
    return subprocessAvailable ? "subprocess" : undefined;
  }
  if (nativeAvailable) {
    return "native";
  }
  return subprocessAvailable ? "subprocess" : undefined;
}

function createRoleBuilderTool(
  config: AicsConfig,
  runtime: NativeRoleBuilderRuntime,
  runtimeConfig: OpenClawConfig,
): AnyAgentTool {
  return {
    name: "dijie_role_builder",
    label: "迭界AI Role Builder",
    description:
      "Run the 迭界AI role-builder intake path from OpenClaw. By default this creates only a RoleBuildBrief; package writing requires allowWrites=true and confirm_brief=true.",
    parameters: RoleBuilderParamsSchema,
    execute: async (_toolCallId, rawParams) => {
      const params = asRecord(rawParams);
      const requestZh = params.request_zh;
      if (typeof requestZh !== "string" || !requestZh.trim()) {
        throw new Error("request_zh is required");
      }
      const confirmBrief = params.confirm_brief === true;
      if (confirmBrief && !config.allowWrites) {
        throw new Error("confirm_brief requires aics.allowWrites=true in OpenClaw config");
      }
      const roleBuilderExecutor = resolveRoleBuilderExecutor({ config, runtime });
      if (confirmBrief && !roleBuilderExecutor) {
        throw new Error(
          "confirm_brief requires OpenClaw-native runEmbeddedAgent or aics.localExecutorCommand. The role builder must fail closed when no local execution engine is configured.",
        );
      }
      const outputRoot = resolveOutputRoot(config, params.output_root);
      const timeoutMs =
        typeof params.timeout_ms === "number" && Number.isInteger(params.timeout_ms)
          ? params.timeout_ms
          : 120000;

      if (confirmBrief) {
        const roleBuildBriefJson = requireStringParam(
          params,
          "role_build_brief_json",
          "role_build_brief_json is required when confirm_brief=true",
        );
        const preflight = verifyDijieExecutionPreflight(config, buildPreflightParams(params));
        if (!preflight.ok) {
          throw new Error(
            `dijie.execution.preflight failed: ${preflight.code}: ${preflight.error}`,
          );
        }
        mkdirSync(outputRoot, { recursive: true });
        const workspaceRoot = realpathSync(outputRoot);
        const lastMessagePath = path.join(workspaceRoot, ".dijie_local_executor_last_message.md");
        const prompt = buildLocalExecutorRoleBuilderPrompt({
          requestZh,
          roleBuildBriefJson,
        });
        const startedAt = new Date().toISOString();
        const result =
          roleBuilderExecutor === "native" && canRunOpenClawNativeExecutor(runtime)
            ? await runOpenClawNativeRoleBuilder({
                runtime,
                runtimeConfig,
                prompt,
                workspaceRoot,
                timeoutMs,
                maxOutputChars: config.maxOutputChars,
                preflight,
              })
            : await runCommand(
                requireStringParam(
                  { localExecutorCommand: config.localExecutorCommand },
                  "localExecutorCommand",
                  "localExecutorCommand is required for subprocess role-builder execution",
                ),
                buildLocalExecutorArgs(config, workspaceRoot, lastMessagePath),
                {
                  cwd: workspaceRoot,
                  maxOutputChars: config.maxOutputChars,
                  timeoutMs,
                  stdin: prompt,
                  env: buildLocalExecutorCommandEnv(),
                },
              );
        const endedAt = new Date().toISOString();
        const files = listWorkspaceFiles(workspaceRoot);
        const validation = validateRolePackage(workspaceRoot, files, {
          preflight,
          executionToken: requireStringParam(params, "execution_token"),
        });
        const auditSummary = buildDijieAuditSummary({
          preflight,
          result,
          startedAt,
          endedAt,
          files,
          validation,
        });
        const auditUpload = await uploadDijieAudit({
          config,
          executionToken: requireStringParam(params, "execution_token"),
          auditSummary,
        });
        const executionOk = auditSummary.status === "completed" && auditUpload.ok;

        return jsonResult({
          ok: executionOk,
          summary: executionOk
            ? auditUpload.skipped
              ? "迭界AI role-builder OpenClaw main-system local execution completed and validated"
              : "迭界AI role-builder OpenClaw main-system local execution completed, validated, and audited"
            : auditSummary.status !== "completed"
              ? "迭界AI role-builder local executor failed or produced an invalid role_package"
              : "迭界AI role-builder audit upload failed",
          confirmed: true,
          executionId: preflight.executionId,
          roleListingId: preflight.roleListingId,
          packageId: preflight.packageId,
          packageVersion: preflight.packageVersion,
          developerRef: preflight.developerRef,
          listingOwnerRef: preflight.listingOwnerRef,
          billingBeneficiaryRef: preflight.billingBeneficiaryRef,
          entitlementId: preflight.entitlementId,
          deviceId: preflight.deviceId,
          workspaceRef: preflight.workspaceRef,
          localGatewayId: preflight.localGatewayId,
          status: auditSummary.status,
          changedFiles: auditSummary.result.changedFiles,
          artifacts: auditSummary.result.artifacts,
          roleTokenPricing: auditSummary.roleTokenPricing,
          modelProxyUsage: auditSummary.modelProxyUsage,
          toolUsage: auditSummary.toolUsage,
          result: auditSummary.result,
          auditSummary,
          rolePackageValidation: validation,
          auditUpload,
          allowWrites: config.allowWrites,
          outputRoot: workspaceRoot,
          executionEngine: roleBuilderExecutor === "native" ? "openclaw-native" : "subprocess",
          localExecutor: result,
        });
      }

      requireExistingRepo(config);
      const developerId =
        typeof params.developer_id === "string" && params.developer_id.trim()
          ? params.developer_id
          : "merchant_001";

      const args = [
        "main.py",
        "--generate-local-role-package",
        requestZh,
        "--generate-local-role-package-developer-id",
        developerId,
        "--generate-local-role-package-output-root",
        outputRoot,
      ];
      if (confirmBrief) {
        args.push("--generate-local-role-package-confirm");
      }

      const result = await runCommand(config.pythonBinary, args, {
        cwd: realpathSync(config.repoRoot),
        maxOutputChars: config.maxOutputChars,
        timeoutMs,
      });

      return jsonResult({
        summary:
          result.exitCode === 0
            ? confirmBrief
              ? "迭界AI role-builder package command completed"
              : "迭界AI role-builder brief command completed"
            : "迭界AI role-builder command failed",
        confirmed: confirmBrief,
        allowWrites: config.allowWrites,
        outputRoot,
        result,
      });
    },
  };
}

function readToolResultDetails(result: unknown): Record<string, unknown> {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return {};
  }
  const details = (result as { details?: unknown }).details;
  return asRecord(details);
}

async function runRoleBuilderGatewayRequest(
  tool: AnyAgentTool,
  params: unknown,
  failureSummary = "迭界AI role-builder request failed before local execution could complete",
): Promise<Record<string, unknown>> {
  try {
    const result = await tool.execute("gateway-dijie-role-builder", params);
    const details = readToolResultDetails(result);
    return {
      ok: details.ok !== false,
      ...details,
    };
  } catch (error) {
    return {
      ok: false,
      summary: failureSummary,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export default definePluginEntry({
  id: "aics",
  name: "迭界AI",
  description: "迭界AI business logic bridge for OpenClaw.",
  register(api) {
    const config = readPluginConfig(api.pluginConfig);
    const executionAuditReadTool = createExecutionAuditReadTool(config);
    const executionTokenRequestTool = createExecutionTokenRequestTool(config);
    const marketplaceInstalledRolesTool = createMarketplaceInstalledRolesTool(config);
    const roleBuilderTool = createRoleBuilderTool(config, api.runtime, api.config);
    api.registerGatewayMethod(
      "dijie.execution.preflight",
      ({ params, respond }) => {
        respond(true, verifyDijieExecutionPreflight(config, params));
      },
      { scope: "operator.write" },
    );
    api.registerGatewayMethod(
      "dijie.roleBuilder.run",
      async ({ params }) => await runRoleBuilderGatewayRequest(roleBuilderTool, params),
      { scope: "operator.write" },
    );
    api.registerGatewayMethod(
      "dijie.executionToken.request",
      async ({ params }) =>
        await runRoleBuilderGatewayRequest(
          executionTokenRequestTool,
          params,
          "迭界AI execution token request failed before cloud authorization could complete",
        ),
      { scope: "operator.write" },
    );
    api.registerGatewayMethod(
      "dijie.executionAudit.read",
      async ({ params }) =>
        await runRoleBuilderGatewayRequest(
          executionAuditReadTool,
          params,
          "迭界AI execution audit read failed before cloud read could complete",
        ),
      { scope: "operator.read" },
    );
    api.registerGatewayMethod(
      "dijie.marketplace.roles.list",
      async ({ params }) =>
        await runRoleBuilderGatewayRequest(
          marketplaceInstalledRolesTool,
          params,
          "迭界AI marketplace installed roles read failed before marketplace read could complete",
        ),
      { scope: "operator.read" },
    );
    api.registerTool(createStatusTool(config));
    api.registerTool(executionAuditReadTool);
    api.registerTool(executionTokenRequestTool);
    api.registerTool(marketplaceInstalledRolesTool);
    api.registerTool(roleBuilderTool);
  },
});
