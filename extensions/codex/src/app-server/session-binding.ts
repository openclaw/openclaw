import fs from "node:fs/promises";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
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
  sessionFile: string;
  cwd: string;
  authProfileId?: string;
  model?: string;
  modelProvider?: string;
  approvalPolicy?: CodexAppServerApprovalPolicy;
  sandbox?: CodexAppServerSandboxMode;
  serviceTier?: CodexServiceTier;
  dynamicToolsFingerprint?: string;
  userMcpServersFingerprint?: string;
  mcpServersFingerprint?: string;
  pluginAppsFingerprint?: string;
  pluginAppsInputFingerprint?: string;
  pluginAppPolicyContext?: PluginAppPolicyContext;
  contextEngine?: CodexAppServerContextEngineBinding;
  createdAt: string;
  updatedAt: string;
};

type PersistedCodexAppServerThreadBinding = Partial<CodexAppServerThreadBinding> & {
  bindings?: unknown;
};

export type CodexAppServerContextEngineBinding = {
  schemaVersion: 1;
  engineId: string;
  policyFingerprint: string;
  projection?: CodexAppServerContextEngineProjectionBinding;
};

export type CodexAppServerContextEngineProjectionBinding = {
  schemaVersion: 1;
  mode: "thread_bootstrap";
  epoch: string;
  fingerprint?: string;
};

export function resolveCodexAppServerBindingPath(sessionFile: string): string {
  return `${sessionFile}.codex-app-server.json`;
}

export async function readCodexAppServerBinding(
  sessionFile: string,
  lookup: Omit<CodexAppServerAuthProfileLookup, "authProfileId"> = {},
): Promise<CodexAppServerThreadBinding | undefined> {
  const bindings = await readCodexAppServerBindings(sessionFile, lookup);
  return bindings[0];
}

export async function readCodexAppServerBindings(
  sessionFile: string,
  lookup: Omit<CodexAppServerAuthProfileLookup, "authProfileId"> = {},
): Promise<CodexAppServerThreadBinding[]> {
  const path = resolveCodexAppServerBindingPath(sessionFile);
  let raw: string;
  try {
    raw = await fs.readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) {
      return [];
    }
    embeddedAgentLog.warn("failed to read codex app-server binding", { path, error });
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as PersistedCodexAppServerThreadBinding;
    const primary = readCodexAppServerBindingRecord(parsed, sessionFile, lookup);
    if (!primary) {
      return [];
    }
    const alternates = Array.isArray(parsed.bindings)
      ? parsed.bindings.flatMap((entry) => {
          const binding = readCodexAppServerBindingRecord(entry, sessionFile, lookup);
          return binding ? [binding] : [];
        })
      : [];
    return dedupeCodexAppServerBindings([primary, ...alternates]);
  } catch (error) {
    embeddedAgentLog.warn("failed to parse codex app-server binding", { path, error });
    return [];
  }
}

export async function writeCodexAppServerBinding(
  sessionFile: string,
  binding: Omit<
    CodexAppServerThreadBinding,
    "schemaVersion" | "sessionFile" | "createdAt" | "updatedAt"
  > & {
    createdAt?: string;
  },
  lookup: Omit<CodexAppServerAuthProfileLookup, "authProfileId"> = {},
): Promise<void> {
  const now = new Date().toISOString();
  const payload = createCodexAppServerBindingPayload(sessionFile, binding, lookup, now);
  let previousBindings: CodexAppServerThreadBinding[] = [];
  try {
    previousBindings = await readCodexAppServerBindings(sessionFile, lookup);
  } catch {
    previousBindings = [];
  }
  const bindings = upsertCodexAppServerBinding(previousBindings, payload);
  const alternates = bindings.filter(
    (candidate) => !isSameCodexAppServerBinding(candidate, payload),
  );
  const persistedPayload: PersistedCodexAppServerThreadBinding = {
    ...payload,
    ...(alternates.length ? { bindings: alternates.map(toPersistedCodexAppServerBinding) } : {}),
  };
  await fs.writeFile(
    resolveCodexAppServerBindingPath(sessionFile),
    `${JSON.stringify(persistedPayload, null, 2)}\n`,
  );
}

function createCodexAppServerBindingPayload(
  sessionFile: string,
  binding: Omit<
    CodexAppServerThreadBinding,
    "schemaVersion" | "sessionFile" | "createdAt" | "updatedAt"
  > & {
    createdAt?: string;
  },
  lookup: Omit<CodexAppServerAuthProfileLookup, "authProfileId">,
  now: string,
): CodexAppServerThreadBinding {
  return {
    schemaVersion: 1,
    sessionFile,
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
    userMcpServersFingerprint: binding.userMcpServersFingerprint,
    mcpServersFingerprint: binding.mcpServersFingerprint,
    pluginAppsFingerprint: binding.pluginAppsFingerprint,
    pluginAppsInputFingerprint: binding.pluginAppsInputFingerprint,
    pluginAppPolicyContext: binding.pluginAppPolicyContext,
    contextEngine: binding.contextEngine,
    createdAt: binding.createdAt ?? now,
    updatedAt: now,
  };
}

function readCodexAppServerBindingRecord(
  value: unknown,
  sessionFile: string,
  lookup: Omit<CodexAppServerAuthProfileLookup, "authProfileId">,
): CodexAppServerThreadBinding | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const parsed = value as Partial<CodexAppServerThreadBinding>;
  if (parsed.schemaVersion !== 1 || typeof parsed.threadId !== "string") {
    return undefined;
  }
  const authProfileId = typeof parsed.authProfileId === "string" ? parsed.authProfileId : undefined;
  return {
    schemaVersion: 1,
    threadId: parsed.threadId,
    sessionFile,
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
    userMcpServersFingerprint:
      typeof parsed.userMcpServersFingerprint === "string"
        ? parsed.userMcpServersFingerprint
        : undefined,
    mcpServersFingerprint:
      typeof parsed.mcpServersFingerprint === "string" ? parsed.mcpServersFingerprint : undefined,
    pluginAppsFingerprint:
      typeof parsed.pluginAppsFingerprint === "string" ? parsed.pluginAppsFingerprint : undefined,
    pluginAppsInputFingerprint:
      typeof parsed.pluginAppsInputFingerprint === "string"
        ? parsed.pluginAppsInputFingerprint
        : undefined,
    pluginAppPolicyContext: readPluginAppPolicyContext(parsed.pluginAppPolicyContext),
    contextEngine: readContextEngineBinding(parsed.contextEngine),
    createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : new Date().toISOString(),
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
  };
}

function toPersistedCodexAppServerBinding(
  binding: CodexAppServerThreadBinding,
): CodexAppServerThreadBinding {
  return { ...binding };
}

function upsertCodexAppServerBinding(
  bindings: CodexAppServerThreadBinding[],
  next: CodexAppServerThreadBinding,
): CodexAppServerThreadBinding[] {
  return [next, ...bindings.filter((binding) => !isSameCodexAppServerBinding(binding, next))].slice(
    0,
    8,
  );
}

function dedupeCodexAppServerBindings(
  bindings: CodexAppServerThreadBinding[],
): CodexAppServerThreadBinding[] {
  const deduped: CodexAppServerThreadBinding[] = [];
  for (const binding of bindings) {
    if (deduped.some((existing) => isSameCodexAppServerBinding(existing, binding))) {
      continue;
    }
    deduped.push(binding);
  }
  return deduped;
}

function isSameCodexAppServerBinding(
  left: CodexAppServerThreadBinding,
  right: CodexAppServerThreadBinding,
): boolean {
  if (left.dynamicToolsFingerprint && right.dynamicToolsFingerprint) {
    return left.dynamicToolsFingerprint === right.dynamicToolsFingerprint;
  }
  return left.threadId === right.threadId;
}

function readContextEngineBinding(value: unknown): CodexAppServerContextEngineBinding | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 1 ||
    typeof record.engineId !== "string" ||
    typeof record.policyFingerprint !== "string"
  ) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    engineId: record.engineId,
    policyFingerprint: record.policyFingerprint,
    projection: readContextEngineProjectionBinding(record.projection),
  };
}

function readContextEngineProjectionBinding(
  value: unknown,
): CodexAppServerContextEngineProjectionBinding | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 1 ||
    record.mode !== "thread_bootstrap" ||
    typeof record.epoch !== "string" ||
    !record.epoch.trim()
  ) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    mode: "thread_bootstrap",
    epoch: record.epoch,
    fingerprint: typeof record.fingerprint === "string" ? record.fingerprint : undefined,
  };
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

export async function clearCodexAppServerBinding(sessionFile: string): Promise<void> {
  try {
    await fs.unlink(resolveCodexAppServerBindingPath(sessionFile));
  } catch (error) {
    if (!isNotFound(error)) {
      embeddedAgentLog.warn("failed to clear codex app-server binding", { sessionFile, error });
    }
  }
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
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
    lookup.authProfileStore ??
    loadCodexAppServerAuthProfileStore({
      agentDir: lookup.agentDir,
      authProfileId,
      config: lookup.config,
    });
  return store.profiles[authProfileId];
}

function loadCodexAppServerAuthProfileStore(params: {
  agentDir: string | undefined;
  authProfileId: string;
  config?: ProviderAuthAliasConfig;
}): AuthProfileStore {
  return ensureAuthProfileStore(
    params.agentDir?.trim() || resolveDefaultAgentDir(params.config ?? {}),
    {
      allowKeychainPrompt: false,
      config: params.config,
      externalCliProviderIds: [CODEX_APP_SERVER_NATIVE_AUTH_PROVIDER],
      externalCliProfileIds: [params.authProfileId],
    },
  );
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
