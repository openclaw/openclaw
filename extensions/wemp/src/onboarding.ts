import {
  addWildcardAllowFrom,
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  promptAccountId,
  type ChannelOnboardingAdapter,
  type ChannelOnboardingDmPolicy,
  type OpenClawConfig,
  type WizardPrompter,
} from "openclaw/plugin-sdk";
import { listWempAccountIds, resolveDefaultWempAccountId, resolveWempAccount } from "./config.js";
import { scaffoldWempKf } from "./scaffold.js";
import type { WempScaffoldAnswers } from "./types.js";
import { toRecord } from "./utils.js";

type WempDmPolicy = "pairing" | "allowlist" | "open" | "disabled";

const DEFAULT_SUPPORT_AGENT_ID = "wemp-kf";
const DEFAULT_PAIRED_AGENT_ID = "main";
const DEFAULT_UNPAIRED_AGENT_ID = "wemp-kf";
const channel = "wemp" as const;
const KNOWN_INPUT_KEYS = new Set([
  "createSupportAgent",
  "supportAgentId",
  "pairedAgentId",
  "unpairedAgentId",
  "answers",
  "brandName",
  "audience",
  "services",
  "contact",
  "escalationRules",
  "tone",
  "template",
]);

const DEFAULT_ANSWERS: WempScaffoldAnswers = {
  brandName: "未命名品牌",
  audience: "请补充服务对象",
  services: "请补充核心服务",
  contact: "请补充联系方式",
  escalationRules: "报价、投诉、交付承诺、复杂技术问题转人工",
  tone: "专业、亲切、简洁",
  template: "general",
};

export interface WempOnboardingPlan {
  createSupportAgent: boolean;
  supportAgentId: string;
  pairedAgentId: string;
  unpairedAgentId: string;
  answers: WempScaffoldAnswers;
}

export interface WempOnboardingInput {
  createSupportAgent?: boolean;
  supportAgentId?: string;
  pairedAgentId?: string;
  unpairedAgentId?: string;
  answers?: Partial<WempScaffoldAnswers>;
  brandName?: string;
  audience?: string;
  services?: string;
  contact?: string;
  escalationRules?: string;
  tone?: string;
  template?: WempScaffoldAnswers["template"] | string;
}

export interface WempOnboardingInputSpec {
  defaults: {
    createSupportAgent: boolean;
    supportAgentId: string;
    pairedAgentId: string;
    unpairedAgentId: string;
    answers: WempScaffoldAnswers;
  };
  requiredPatch: Array<keyof WempScaffoldAnswers>;
  optionalPatch: string[];
  notes: string[];
}

export interface WempOnboardingQuestion {
  id: string;
  label: string;
  required: boolean;
  type: "text" | "select" | "boolean";
  options?: string[];
  placeholder?: string;
}

export interface WempOnboardingStage {
  id: string;
  title: string;
  description: string;
  questions: WempOnboardingQuestion[];
}

export interface WempOnboardingScaffoldResult {
  agentRoot?: string;
  supportAgentId: string;
  created: string[];
  skipped: string[];
  summary: string[];
}

export interface WempOnboardingExecutionResult extends WempOnboardingScaffoldResult {
  plan: WempOnboardingPlan;
}

export interface WempOnboardingHandler {
  id: "wemp";
  defaults: WempOnboardingPlan;
  inputSpec: WempOnboardingInputSpec;
  stages: WempOnboardingStage[];
  buildPlan: (input?: WempOnboardingInput) => WempOnboardingPlan;
  run: (...args: unknown[]) => Promise<WempOnboardingExecutionResult>;
}

export const wempOnboardingInputSpec: WempOnboardingInputSpec = {
  defaults: {
    createSupportAgent: true,
    supportAgentId: DEFAULT_SUPPORT_AGENT_ID,
    pairedAgentId: DEFAULT_PAIRED_AGENT_ID,
    unpairedAgentId: DEFAULT_UNPAIRED_AGENT_ID,
    answers: { ...DEFAULT_ANSWERS },
  },
  requiredPatch: [
    "brandName",
    "audience",
    "services",
    "contact",
    "escalationRules",
    "tone",
    "template",
  ],
  optionalPatch: ["createSupportAgent", "supportAgentId", "pairedAgentId", "unpairedAgentId"],
  notes: [
    "输入缺失时会回退默认值，不会阻断 scaffold 执行。",
    "template 仅支持 enterprise/content/general，非法值自动回退 general。",
  ],
};

export const wempOnboardingStages: WempOnboardingStage[] = [
  {
    id: "channel-access",
    title: "阶段 1：渠道接入配置",
    description: "先完成公众号接入参数，保证 webhook 可用。",
    questions: [
      { id: "appId", label: "公众号 AppID", required: true, type: "text", placeholder: "wx_xxx" },
      {
        id: "appSecret",
        label: "公众号 AppSecret",
        required: true,
        type: "text",
        placeholder: "secret",
      },
      {
        id: "token",
        label: "校验 Token",
        required: true,
        type: "text",
        placeholder: "verify_token",
      },
      {
        id: "encodingAESKey",
        label: "EncodingAESKey",
        required: false,
        type: "text",
        placeholder: "43 chars, optional",
      },
      {
        id: "webhookPath",
        label: "Webhook Path",
        required: true,
        type: "text",
        placeholder: "/wemp",
      },
      {
        id: "dmPolicy",
        label: "DM Policy",
        required: true,
        type: "select",
        options: ["pairing", "allowlist", "open", "disabled"],
      },
    ],
  },
  {
    id: "routing",
    title: "阶段 2：路由配置",
    description: "配置配对前后路由与客服 agent。",
    questions: [
      {
        id: "pairedAgentId",
        label: "已配对路由 Agent",
        required: true,
        type: "text",
        placeholder: "main",
      },
      {
        id: "createSupportAgent",
        label: "是否自动创建客服 Agent",
        required: true,
        type: "boolean",
      },
      {
        id: "supportAgentId",
        label: "客服 Agent ID",
        required: true,
        type: "text",
        placeholder: "wemp-kf",
      },
      {
        id: "unpairedAgentId",
        label: "未配对路由 Agent",
        required: true,
        type: "text",
        placeholder: "wemp-kf",
      },
    ],
  },
  {
    id: "scaffold",
    title: "阶段 3：脚手架生成",
    description: "生成客服基础文件，不覆盖已有文件。",
    questions: [
      {
        id: "template",
        label: "初始化模板",
        required: true,
        type: "select",
        options: ["enterprise", "content", "general"],
      },
    ],
  },
  {
    id: "persona",
    title: "阶段 4：客服人设初始化",
    description: "采集人设与知识库核心问题（必问 + 可选）。",
    questions: [
      { id: "brandName", label: "品牌/公众号名称", required: true, type: "text" },
      { id: "audience", label: "服务对象", required: true, type: "text" },
      { id: "services", label: "核心服务", required: true, type: "text" },
      { id: "escalationRules", label: "转人工规则", required: true, type: "text" },
      { id: "contact", label: "联系方式", required: true, type: "text" },
      { id: "tone", label: "回复风格", required: true, type: "text" },
      { id: "recommendedLinks", label: "推荐文章/官网（可选）", required: false, type: "text" },
      { id: "forbiddenTopics", label: "禁止话题（可选）", required: false, type: "text" },
    ],
  },
];

export function buildDefaultOnboardingPlan(): WempOnboardingPlan {
  return {
    createSupportAgent: true,
    supportAgentId: DEFAULT_SUPPORT_AGENT_ID,
    pairedAgentId: DEFAULT_PAIRED_AGENT_ID,
    unpairedAgentId: DEFAULT_UNPAIRED_AGENT_ID,
    answers: { ...DEFAULT_ANSWERS },
  };
}

export function applyOnboardingAnswers(
  plan: WempOnboardingPlan,
  patch: Partial<WempScaffoldAnswers>,
): WempOnboardingPlan {
  const answers = plan.answers;
  return {
    ...plan,
    answers: {
      brandName: normalizeText(patch.brandName, answers.brandName),
      audience: normalizeText(patch.audience, answers.audience),
      services: normalizeText(patch.services, answers.services),
      contact: normalizeText(patch.contact, answers.contact),
      escalationRules: normalizeText(patch.escalationRules, answers.escalationRules),
      tone: normalizeText(patch.tone, answers.tone),
      template: normalizeTemplate(patch.template, answers.template),
    },
  };
}

export function buildOnboardingPlan(input?: WempOnboardingInput): WempOnboardingPlan {
  const seed = buildDefaultOnboardingPlan();
  const createSupportAgent =
    typeof input?.createSupportAgent === "boolean"
      ? input.createSupportAgent
      : seed.createSupportAgent;
  const supportAgentId = normalizeAgentId(input?.supportAgentId, seed.supportAgentId);
  const pairedAgentId = normalizeAgentId(input?.pairedAgentId, seed.pairedAgentId);
  const unpairedFallback = createSupportAgent ? supportAgentId : seed.unpairedAgentId;
  const unpairedAgentId = normalizeAgentId(input?.unpairedAgentId, unpairedFallback);

  const withRoute = {
    ...seed,
    createSupportAgent,
    supportAgentId,
    pairedAgentId,
    unpairedAgentId,
  };

  return applyOnboardingAnswers(withRoute, extractAnswersPatch(input));
}

export function runOnboardingScaffold(
  workspaceRoot: string,
  plan: WempOnboardingPlan,
): WempOnboardingScaffoldResult {
  if (!plan.createSupportAgent) {
    return {
      supportAgentId: plan.supportAgentId,
      created: [],
      skipped: [],
      summary: [`已跳过客服 agent 创建，未配对路由将使用: ${plan.unpairedAgentId}`],
    };
  }
  const root = normalizeWorkspaceRoot(workspaceRoot);
  const result = scaffoldWempKf(root, plan.answers, plan.supportAgentId);
  const summary = [
    `已初始化客服 agent: ${plan.supportAgentId}`,
    `新增文件: ${result.created.length}，已存在跳过: ${result.skipped.length}`,
  ];
  return {
    agentRoot: result.agentRoot,
    supportAgentId: plan.supportAgentId,
    created: result.created,
    skipped: result.skipped,
    summary,
  };
}

export function executeWempOnboarding(
  workspaceRoot: string,
  input?: WempOnboardingInput,
): WempOnboardingExecutionResult {
  const plan = buildOnboardingPlan(input);
  const scaffold = runOnboardingScaffold(workspaceRoot, plan);
  return {
    ...scaffold,
    plan,
  };
}

export function createWempScaffoldHandler(options?: {
  workspaceRoot?: string;
}): WempOnboardingHandler {
  const fallbackRoot = normalizeWorkspaceRoot(options?.workspaceRoot);
  return {
    id: "wemp",
    defaults: buildDefaultOnboardingPlan(),
    inputSpec: wempOnboardingInputSpec,
    stages: wempOnboardingStages,
    buildPlan: (input?: WempOnboardingInput) => buildOnboardingPlan(input),
    run: async (...args: unknown[]) => {
      const runArgs = normalizeRunArgs(args, fallbackRoot);
      return executeWempOnboarding(runArgs.workspaceRoot, runArgs.input);
    },
  };
}

function parseWempDmPolicy(value: unknown): WempDmPolicy {
  if (value === "open" || value === "allowlist" || value === "disabled") {
    return value;
  }
  return "pairing";
}

function normalizeAllowFromEntries(raw: string[]): string[] {
  return Array.from(new Set(raw.map((entry) => String(entry || "").trim()).filter(Boolean)));
}

function setWempDmPolicy(cfg: OpenClawConfig, dmPolicy: WempDmPolicy): OpenClawConfig {
  const channels = toRecord(cfg.channels);
  const wemp = toRecord(channels.wemp);
  const dm = toRecord(wemp.dm);
  const existingAllowFrom = normalizeAllowFromEntries(
    Array.isArray(dm.allowFrom) ? (dm.allowFrom as string[]) : [],
  );
  const allowFrom =
    dmPolicy === "open"
      ? normalizeAllowFromEntries(addWildcardAllowFrom(existingAllowFrom) as string[])
      : existingAllowFrom;

  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      wemp: {
        ...wemp,
        enabled: true,
        dm: {
          ...dm,
          policy: dmPolicy,
          allowFrom,
        },
      },
    },
  } as OpenClawConfig;
}

function applyWempAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
  patch: Record<string, unknown>,
): OpenClawConfig {
  const channels = toRecord(cfg.channels);
  const wemp = toRecord(channels.wemp);
  if (accountId === DEFAULT_ACCOUNT_ID) {
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        wemp: {
          ...wemp,
          ...patch,
          enabled: true,
        },
      },
    } as OpenClawConfig;
  }

  const accounts = toRecord(wemp.accounts);
  const account = toRecord(accounts[accountId]);
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      wemp: {
        ...wemp,
        enabled: true,
        accounts: {
          ...accounts,
          [accountId]: {
            ...account,
            ...patch,
            enabled: true,
          },
        },
      },
    },
  } as OpenClawConfig;
}

function setWempAllowFrom(
  cfg: OpenClawConfig,
  accountId: string,
  allowFrom: string[],
): OpenClawConfig {
  const normalizedAllowFrom = normalizeAllowFromEntries(allowFrom);
  const channels = toRecord(cfg.channels);
  const wemp = toRecord(channels.wemp);
  if (accountId === DEFAULT_ACCOUNT_ID) {
    const dm = toRecord(wemp.dm);
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        wemp: {
          ...wemp,
          enabled: true,
          dm: {
            ...dm,
            policy: "allowlist",
            allowFrom: normalizedAllowFrom,
          },
        },
      },
    } as OpenClawConfig;
  }

  const accounts = toRecord(wemp.accounts);
  const account = toRecord(accounts[accountId]);
  const dm = toRecord(account.dm);
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      wemp: {
        ...wemp,
        enabled: true,
        accounts: {
          ...accounts,
          [accountId]: {
            ...account,
            dm: {
              ...dm,
              policy: "allowlist",
              allowFrom: normalizedAllowFrom,
            },
            enabled: true,
          },
        },
      },
    },
  } as OpenClawConfig;
}

function parseAllowFromInput(value: string): string[] {
  return normalizeAllowFromEntries(
    String(value || "")
      .split(/[\n,;]+/g)
      .map((entry) => entry.trim()),
  );
}

async function promptWempAllowFrom(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  accountId: string;
}): Promise<OpenClawConfig> {
  const { cfg, prompter, accountId } = params;
  const resolved = resolveWempAccount(cfg, accountId);
  const existingAllowFrom = normalizeAllowFromEntries(resolved.dm.allowFrom);
  let allowFrom: string[] = [];
  while (allowFrom.length === 0) {
    const value = await prompter.text({
      message: "WeChat MP allowFrom (OpenID，支持逗号分隔)",
      placeholder: "openid_xxx,openid_yyy",
      initialValue: existingAllowFrom[0] || undefined,
      validate: (input) => (String(input || "").trim() ? undefined : "Required"),
    });
    allowFrom = parseAllowFromInput(String(value || ""));
    if (allowFrom.length === 0) {
      await prompter.note("请至少输入一个 OpenID。", "WeChat MP allowlist");
    }
  }
  return setWempAllowFrom(cfg, accountId, [...existingAllowFrom, ...allowFrom]);
}

async function promptWempAllowFromForAccount(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  accountId?: string;
}): Promise<OpenClawConfig> {
  const requestedAccountId = params.accountId ? normalizeAccountId(params.accountId) : null;
  const accountId = requestedAccountId ?? resolveDefaultWempAccountId(params.cfg);
  return promptWempAllowFrom({
    cfg: params.cfg,
    prompter: params.prompter,
    accountId,
  });
}

const dmPolicy: ChannelOnboardingDmPolicy = {
  label: "WeChat MP",
  channel,
  policyKey: "channels.wemp.dm.policy",
  allowFromKey: "channels.wemp.dm.allowFrom",
  getCurrent: (cfg) => parseWempDmPolicy(resolveWempAccount(cfg).dm.policy),
  setPolicy: (cfg, policy) => setWempDmPolicy(cfg, parseWempDmPolicy(policy)),
  promptAllowFrom: promptWempAllowFromForAccount,
};

async function promptRequiredText(params: {
  prompter: WizardPrompter;
  message: string;
  initialValue?: string;
  placeholder?: string;
  validate?: (value: string) => string | undefined;
}): Promise<string> {
  const value = await params.prompter.text({
    message: params.message,
    initialValue: params.initialValue,
    placeholder: params.placeholder,
    validate: (input) => {
      const normalized = String(input || "").trim();
      if (!normalized) return "Required";
      return params.validate ? params.validate(normalized) : undefined;
    },
  });
  return String(value || "").trim();
}

async function promptOptionalText(params: {
  prompter: WizardPrompter;
  message: string;
  initialValue?: string;
  placeholder?: string;
  validate?: (value: string) => string | undefined;
}): Promise<string | undefined> {
  const value = await params.prompter.text({
    message: params.message,
    initialValue: params.initialValue,
    placeholder: params.placeholder,
    validate: (input) => {
      const normalized = String(input || "").trim();
      if (!normalized) return undefined;
      return params.validate ? params.validate(normalized) : undefined;
    },
  });
  const normalized = String(value || "").trim();
  return normalized || undefined;
}

export function createWempOnboarding(): ChannelOnboardingAdapter {
  return {
    channel,
    getStatus: async ({ cfg }) => {
      const configured = listWempAccountIds(cfg).some((accountId) => {
        const account = resolveWempAccount(cfg, accountId);
        return account.configured;
      });
      return {
        channel,
        configured,
        statusLines: [`WeChat MP: ${configured ? "configured" : "needs setup"}`],
        selectionHint: configured ? "configured" : "official account",
        quickstartScore: configured ? 1 : 6,
      };
    },
    configure: async ({
      cfg,
      prompter,
      accountOverrides,
      shouldPromptAccountIds,
      forceAllowFrom,
    }) => {
      const override = accountOverrides.wemp?.trim();
      const defaultAccountId = resolveDefaultWempAccountId(cfg);
      let accountId = override
        ? (normalizeAccountId(override) ?? DEFAULT_ACCOUNT_ID)
        : defaultAccountId;
      if (shouldPromptAccountIds && !override) {
        accountId = await promptAccountId({
          cfg,
          prompter,
          label: "WeChat MP",
          currentId: accountId,
          listAccountIds: listWempAccountIds,
          defaultAccountId,
        });
      }

      const resolved = resolveWempAccount(cfg, accountId);
      const appId = await promptRequiredText({
        prompter,
        message: "公众号 AppID",
        initialValue: resolved.appId || undefined,
        placeholder: "wx_xxx",
      });
      const appSecret = await promptRequiredText({
        prompter,
        message: "公众号 AppSecret",
        initialValue: resolved.appSecret || undefined,
        placeholder: "secret",
      });
      const token = await promptRequiredText({
        prompter,
        message: "Webhook 校验 Token",
        initialValue: resolved.token || undefined,
        placeholder: "verify_token",
      });
      const webhookPath = await promptRequiredText({
        prompter,
        message: "Webhook Path",
        initialValue: resolved.webhookPath || "/wemp",
        placeholder: "/wemp",
        validate: (value) => (value.startsWith("/") ? undefined : "Path must start with /"),
      });
      const encodingAESKey = await promptOptionalText({
        prompter,
        message: "EncodingAESKey（可选）",
        initialValue: resolved.encodingAESKey || undefined,
        placeholder: "43 chars, optional",
        validate: (value) => (value.length === 43 ? undefined : "EncodingAESKey must be 43 chars"),
      });

      const patch: Record<string, unknown> = {
        appId,
        appSecret,
        token,
        webhookPath,
      };
      if (encodingAESKey) patch.encodingAESKey = encodingAESKey;

      let next = applyWempAccountConfig(cfg, accountId, patch);
      if (forceAllowFrom) {
        next = await promptWempAllowFrom({
          cfg: next,
          prompter,
          accountId,
        });
      }

      return { cfg: next, accountId };
    },
    dmPolicy,
  };
}

export const buildWempOnboarding = createWempScaffoldHandler;

function normalizeRunArgs(
  args: unknown[],
  fallbackRoot: string,
): { workspaceRoot: string; input?: WempOnboardingInput } {
  if (args.length === 0) {
    return { workspaceRoot: fallbackRoot };
  }

  const firstAsText = normalizeOptionalText(args[0]);
  if (firstAsText) {
    const second = asRecord(args[1]);
    if (second && looksLikeOnboardingInput(second)) {
      return { workspaceRoot: firstAsText, input: second as WempOnboardingInput };
    }
    return { workspaceRoot: firstAsText };
  }

  const first = asRecord(args[0]);
  const second = asRecord(args[1]);
  const workspaceRoot = normalizeWorkspaceRoot(readWorkspaceRoot(first) ?? fallbackRoot);

  if (second && looksLikeOnboardingInput(second)) {
    return { workspaceRoot, input: second as WempOnboardingInput };
  }

  const inputFromFirst = first?.input;
  if (
    asRecord(inputFromFirst) &&
    looksLikeOnboardingInput(inputFromFirst as Record<string, unknown>)
  ) {
    return { workspaceRoot, input: inputFromFirst as WempOnboardingInput };
  }

  if (first && looksLikeOnboardingInput(first)) {
    return { workspaceRoot, input: first as WempOnboardingInput };
  }

  return { workspaceRoot };
}

function extractAnswersPatch(input?: WempOnboardingInput): Partial<WempScaffoldAnswers> {
  const answers = asRecord(input?.answers);
  const patch: Partial<WempScaffoldAnswers> = {};
  const brandName = normalizeOptionalText(input?.brandName ?? answers?.brandName);
  const audience = normalizeOptionalText(input?.audience ?? answers?.audience);
  const services = normalizeOptionalText(input?.services ?? answers?.services);
  const contact = normalizeOptionalText(input?.contact ?? answers?.contact);
  const escalationRules = normalizeOptionalText(input?.escalationRules ?? answers?.escalationRules);
  const tone = normalizeOptionalText(input?.tone ?? answers?.tone);
  const template = normalizeTemplateOptional(input?.template ?? answers?.template);

  if (brandName) patch.brandName = brandName;
  if (audience) patch.audience = audience;
  if (services) patch.services = services;
  if (contact) patch.contact = contact;
  if (escalationRules) patch.escalationRules = escalationRules;
  if (tone) patch.tone = tone;
  if (template) patch.template = template;

  return patch;
}

function normalizeTemplate(
  template: unknown,
  fallback: WempScaffoldAnswers["template"],
): WempScaffoldAnswers["template"] {
  if (template === "enterprise" || template === "content" || template === "general") {
    return template;
  }
  return fallback;
}

function normalizeTemplateOptional(template: unknown): WempScaffoldAnswers["template"] | undefined {
  if (template === "enterprise" || template === "content" || template === "general") {
    return template;
  }
  return undefined;
}

function normalizeText(value: unknown, fallback: string): string {
  return normalizeOptionalText(value) ?? fallback;
}

function normalizeOptionalText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

function normalizeAgentId(value: unknown, fallback: string): string {
  return normalizeOptionalText(value) ?? fallback;
}

function normalizeWorkspaceRoot(value: unknown): string {
  return normalizeOptionalText(value) ?? process.cwd();
}

function readWorkspaceRoot(input?: Record<string, unknown>): string | undefined {
  if (!input) {
    return undefined;
  }
  const candidates = [input.workspaceRoot, input.projectRoot, input.cwd];
  for (const candidate of candidates) {
    const normalized = normalizeOptionalText(candidate);
    if (normalized) {
      return normalized;
    }
  }
  return undefined;
}

function looksLikeOnboardingInput(input: Record<string, unknown>): boolean {
  return Object.keys(input).some((key) => KNOWN_INPUT_KEYS.has(key));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return value as Record<string, unknown>;
}
