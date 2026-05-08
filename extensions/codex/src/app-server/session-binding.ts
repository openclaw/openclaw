import {
  deleteOpenClawStateKvJson,
  embeddedAgentLog,
  readOpenClawStateKvJson,
  writeOpenClawStateKvJson,
  type OpenClawStateJsonValue,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  ensureAuthProfileStore,
  resolveDefaultAgentDir,
  resolveProviderIdForAuth,
  type AuthProfileStore,
} from "openclaw/plugin-sdk/agent-runtime";
import {
  CODEX_PLUGINS_MARKETPLACE_NAME,
  normalizeCodexServiceTier,
  type CodexAppServerApprovalPolicy,
  type CodexAppServerSandboxMode,
} from "./config.js";
import type { PluginAppPolicyContext } from "./plugin-thread-config.js";
import type { CodexServiceTier } from "./protocol.js";

const CODEX_APP_SERVER_NATIVE_AUTH_PROVIDER = "openai-codex";
const PUBLIC_OPENAI_MODEL_PROVIDER = "openai";
const CODEX_APP_SERVER_BINDING_KV_SCOPE = "codex_app_server_thread_bindings";

type ProviderAuthAliasLookupParams = Parameters<typeof resolveProviderIdForAuth>[1];
type ProviderAuthAliasConfig = NonNullable<ProviderAuthAliasLookupParams>["config"];

export type CodexAppServerAuthProfileLookup = {
  authProfileId?: string;
  authProfileStore?: AuthProfileStore;
  agentDir?: string;
  config?: ProviderAuthAliasConfig;
};

export type CodexAppServerThreadBinding = {
  schemaVersion: 1;
  threadId: string;
  sessionKey?: string;
  sessionFile: string;
  cwd: string;
  authProfileId?: string;
  model?: string;
  modelProvider?: string;
  approvalPolicy?: CodexAppServerApprovalPolicy;
  sandbox?: CodexAppServerSandboxMode;
  serviceTier?: CodexServiceTier;
  dynamicToolsFingerprint?: string;
  pluginAppsFingerprint?: string;
  pluginAppsInputFingerprint?: string;
  pluginAppPolicyContext?: PluginAppPolicyContext;
  createdAt: string;
  updatedAt: string;
};

export type CodexAppServerBindingIdentity =
  | string
  | {
      sessionKey?: string;
      sessionFile?: string;
    };

function normalizeCodexAppServerBindingIdentity(identity: CodexAppServerBindingIdentity): {
  primaryKey: string;
  legacySessionFileKey?: string;
  sessionKey?: string;
  sessionFile: string;
} {
  if (typeof identity === "string") {
    const sessionFile = identity.trim();
    return { primaryKey: sessionFile, sessionFile };
  }
  const sessionKey = identity.sessionKey?.trim() || undefined;
  const sessionFile = identity.sessionFile?.trim() || "";
  return {
    primaryKey: sessionKey ? `session-key:${sessionKey}` : sessionFile,
    legacySessionFileKey: sessionKey && sessionFile ? sessionFile : undefined,
    sessionKey,
    sessionFile,
  };
}

function codexAppServerBindingToJsonValue(
  binding: CodexAppServerThreadBinding,
): OpenClawStateJsonValue {
  return binding as unknown as OpenClawStateJsonValue;
}

function normalizeCodexAppServerBinding(
  identity: ReturnType<typeof normalizeCodexAppServerBindingIdentity>,
  value: unknown,
  lookup: Omit<CodexAppServerAuthProfileLookup, "authProfileId">,
): CodexAppServerThreadBinding | undefined {
  const parsed = value as Partial<CodexAppServerThreadBinding>;
  if (!parsed || parsed.schemaVersion !== 1 || typeof parsed.threadId !== "string") {
    return undefined;
  }
  const authProfileId = typeof parsed.authProfileId === "string" ? parsed.authProfileId : undefined;
  return {
    schemaVersion: 1,
    threadId: parsed.threadId,
    sessionKey:
      typeof parsed.sessionKey === "string" && parsed.sessionKey.trim()
        ? parsed.sessionKey.trim()
        : identity.sessionKey,
    sessionFile:
      typeof parsed.sessionFile === "string" && parsed.sessionFile.trim()
        ? parsed.sessionFile
        : identity.sessionFile,
    cwd: typeof parsed.cwd === "string" ? parsed.cwd : "",
    authProfileId,
    model: typeof parsed.model === "string" ? parsed.model : undefined,
    modelProvider: normalizeCodexAppServerBindingModelProvider({
      ...lookup,
      authProfileId,
      modelProvider: typeof parsed.modelProvider === "string" ? parsed.modelProvider : undefined,
    }),
    approvalPolicy: readApprovalPolicy(parsed.approvalPolicy),
    sandbox: readSandboxMode(parsed.sandbox),
    serviceTier: readServiceTier(parsed.serviceTier),
    dynamicToolsFingerprint:
      typeof parsed.dynamicToolsFingerprint === "string"
        ? parsed.dynamicToolsFingerprint
        : undefined,
    pluginAppsFingerprint:
      typeof parsed.pluginAppsFingerprint === "string" ? parsed.pluginAppsFingerprint : undefined,
    pluginAppsInputFingerprint:
      typeof parsed.pluginAppsInputFingerprint === "string"
        ? parsed.pluginAppsInputFingerprint
        : undefined,
    pluginAppPolicyContext: readPluginAppPolicyContext(parsed.pluginAppPolicyContext),
    createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : new Date().toISOString(),
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
  };
}

export async function readCodexAppServerBinding(
  identity: CodexAppServerBindingIdentity,
  lookup: Omit<CodexAppServerAuthProfileLookup, "authProfileId"> = {},
): Promise<CodexAppServerThreadBinding | undefined> {
  const normalized = normalizeCodexAppServerBindingIdentity(identity);
  if (!normalized.primaryKey) {
    return undefined;
  }
  const value = readOpenClawStateKvJson(CODEX_APP_SERVER_BINDING_KV_SCOPE, normalized.primaryKey);
  if (value !== undefined) {
    return normalizeCodexAppServerBinding(normalized, value, lookup);
  }
  if (normalized.legacySessionFileKey) {
    return normalizeCodexAppServerBinding(
      normalized,
      readOpenClawStateKvJson(CODEX_APP_SERVER_BINDING_KV_SCOPE, normalized.legacySessionFileKey),
      lookup,
    );
  }
  return normalizeCodexAppServerBinding(normalized, undefined, lookup);
}

export async function writeCodexAppServerBinding(
  identity: CodexAppServerBindingIdentity,
  binding: Omit<
    CodexAppServerThreadBinding,
    "schemaVersion" | "sessionKey" | "sessionFile" | "createdAt" | "updatedAt"
  > & {
    sessionKey?: string;
    sessionFile?: string;
    createdAt?: string;
  },
  lookup: Omit<CodexAppServerAuthProfileLookup, "authProfileId"> = {},
): Promise<void> {
  const now = new Date().toISOString();
  const normalized = normalizeCodexAppServerBindingIdentity(identity);
  const payload: CodexAppServerThreadBinding = {
    schemaVersion: 1,
    sessionKey: binding.sessionKey?.trim() || normalized.sessionKey,
    sessionFile: binding.sessionFile?.trim() || normalized.sessionFile,
    threadId: binding.threadId,
    cwd: binding.cwd,
    authProfileId: binding.authProfileId,
    model: binding.model,
    modelProvider: normalizeCodexAppServerBindingModelProvider({
      ...lookup,
      authProfileId: binding.authProfileId,
      modelProvider: binding.modelProvider,
    }),
    approvalPolicy: binding.approvalPolicy,
    sandbox: binding.sandbox,
    serviceTier: binding.serviceTier,
    dynamicToolsFingerprint: binding.dynamicToolsFingerprint,
    pluginAppsFingerprint: binding.pluginAppsFingerprint,
    pluginAppsInputFingerprint: binding.pluginAppsInputFingerprint,
    pluginAppPolicyContext: binding.pluginAppPolicyContext,
    createdAt: binding.createdAt ?? now,
    updatedAt: now,
  };
  writeOpenClawStateKvJson(
    CODEX_APP_SERVER_BINDING_KV_SCOPE,
    normalized.primaryKey,
    codexAppServerBindingToJsonValue(payload),
  );
  if (
    normalized.legacySessionFileKey &&
    normalized.legacySessionFileKey !== normalized.primaryKey
  ) {
    deleteOpenClawStateKvJson(CODEX_APP_SERVER_BINDING_KV_SCOPE, normalized.legacySessionFileKey);
  }
}

function readPluginAppPolicyContext(value: unknown): PluginAppPolicyContext | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.fingerprint !== "string") {
    return undefined;
  }
  const apps = record.apps;
  if (!apps || typeof apps !== "object" || Array.isArray(apps)) {
    return undefined;
  }
  const parsedApps: PluginAppPolicyContext["apps"] = {};
  for (const [appId, rawEntry] of Object.entries(apps)) {
    if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
      return undefined;
    }
    const entry = rawEntry as Record<string, unknown>;
    if (
      "appId" in entry ||
      typeof entry.configKey !== "string" ||
      entry.marketplaceName !== CODEX_PLUGINS_MARKETPLACE_NAME ||
      typeof entry.pluginName !== "string" ||
      typeof entry.allowDestructiveActions !== "boolean" ||
      !Array.isArray(entry.mcpServerNames) ||
      entry.mcpServerNames.some((serverName) => typeof serverName !== "string")
    ) {
      return undefined;
    }
    parsedApps[appId] = {
      configKey: entry.configKey,
      marketplaceName: entry.marketplaceName,
      pluginName: entry.pluginName,
      allowDestructiveActions: entry.allowDestructiveActions,
      mcpServerNames: entry.mcpServerNames,
    };
  }
  const parsedPluginAppIds: PluginAppPolicyContext["pluginAppIds"] = {};
  const rawPluginAppIds = record.pluginAppIds;
  if (rawPluginAppIds && (typeof rawPluginAppIds !== "object" || Array.isArray(rawPluginAppIds))) {
    return undefined;
  }
  if (rawPluginAppIds && typeof rawPluginAppIds === "object") {
    for (const [configKey, appIds] of Object.entries(rawPluginAppIds)) {
      if (!Array.isArray(appIds) || appIds.some((appId) => typeof appId !== "string")) {
        return undefined;
      }
      parsedPluginAppIds[configKey] = appIds;
    }
  }
  return {
    fingerprint: record.fingerprint,
    apps: parsedApps,
    pluginAppIds: parsedPluginAppIds,
  };
}

export async function clearCodexAppServerBinding(
  identity: CodexAppServerBindingIdentity,
): Promise<void> {
  const normalized = normalizeCodexAppServerBindingIdentity(identity);
  deleteOpenClawStateKvJson(CODEX_APP_SERVER_BINDING_KV_SCOPE, normalized.primaryKey);
  if (normalized.legacySessionFileKey) {
    deleteOpenClawStateKvJson(CODEX_APP_SERVER_BINDING_KV_SCOPE, normalized.legacySessionFileKey);
  }
}

export function isCodexAppServerNativeAuthProfile(
  lookup: CodexAppServerAuthProfileLookup,
): boolean {
  const authProfileId = lookup.authProfileId?.trim();
  if (!authProfileId) {
    return false;
  }
  try {
    const credential = resolveCodexAppServerAuthProfileCredential({
      ...lookup,
      authProfileId,
    });
    return isCodexAppServerNativeAuthProvider({
      provider: credential?.provider,
      config: lookup.config,
    });
  } catch (error) {
    embeddedAgentLog.debug("failed to resolve codex app-server auth profile provider", {
      authProfileId,
      error,
    });
    return false;
  }
}

export function normalizeCodexAppServerBindingModelProvider(params: {
  authProfileId?: string;
  modelProvider?: string;
  authProfileStore?: AuthProfileStore;
  agentDir?: string;
  config?: ProviderAuthAliasConfig;
}): string | undefined {
  const modelProvider = params.modelProvider?.trim();
  if (!modelProvider) {
    return undefined;
  }
  if (
    isCodexAppServerNativeAuthProfile(params) &&
    modelProvider.toLowerCase() === PUBLIC_OPENAI_MODEL_PROVIDER
  ) {
    return undefined;
  }
  return modelProvider;
}

function resolveCodexAppServerAuthProfileCredential(
  lookup: CodexAppServerAuthProfileLookup,
): AuthProfileStore["profiles"][string] | undefined {
  const authProfileId = lookup.authProfileId?.trim();
  if (!authProfileId) {
    return undefined;
  }
  const store =
    lookup.authProfileStore ?? loadCodexAppServerAuthProfileStore(lookup.agentDir, lookup.config);
  return store.profiles[authProfileId];
}

function loadCodexAppServerAuthProfileStore(
  agentDir: string | undefined,
  config?: ProviderAuthAliasConfig,
): AuthProfileStore {
  return ensureAuthProfileStore(agentDir?.trim() || resolveDefaultAgentDir(config ?? {}), {
    allowKeychainPrompt: false,
  });
}

function isCodexAppServerNativeAuthProvider(params: {
  provider?: string;
  config?: ProviderAuthAliasConfig;
}): boolean {
  const provider = params.provider?.trim();
  return Boolean(
    provider &&
    resolveProviderIdForAuth(provider, { config: params.config }) ===
      CODEX_APP_SERVER_NATIVE_AUTH_PROVIDER,
  );
}

function readApprovalPolicy(value: unknown): CodexAppServerApprovalPolicy | undefined {
  return value === "never" ||
    value === "on-request" ||
    value === "on-failure" ||
    value === "untrusted"
    ? value
    : undefined;
}

function readSandboxMode(value: unknown): CodexAppServerSandboxMode | undefined {
  return value === "read-only" || value === "workspace-write" || value === "danger-full-access"
    ? value
    : undefined;
}

function readServiceTier(value: unknown): CodexServiceTier | undefined {
  return normalizeCodexServiceTier(value);
}
