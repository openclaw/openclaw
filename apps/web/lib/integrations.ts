import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { resolveOpenClawStateDir } from "@/lib/workspace";

export type DenchIntegrationId = "exa" | "apollo" | "elevenlabs";

export type DenchIntegrationMetadata = {
  schemaVersion: 1;
  exa?: {
    ownsSearch?: boolean;
    fallbackProvider?: string | null;
  };
  apollo?: Record<string, never>;
  elevenlabs?: Record<string, never>;
  future?: {
    composio?: {
      providers?: string[];
    };
  };
};

export type IntegrationAuthSummary = {
  configured: boolean;
  source: "config" | "env" | "missing";
};

export type IntegrationPluginState = {
  pluginId: string;
  configured: boolean;
  enabled: boolean;
  allowlisted: boolean;
  loadPathConfigured: boolean;
  installRecorded: boolean;
  installPath: string | null;
  installPathExists: boolean;
  sourcePath: string | null;
};

export type IntegrationHealthIssue =
  | "missing_plugin_entry"
  | "plugin_disabled"
  | "plugin_not_allowlisted"
  | "plugin_load_path_missing"
  | "plugin_install_missing"
  | "plugin_install_path_missing"
  | "missing_auth"
  | "missing_gateway"
  | "missing_override"
  | "built_in_search_still_enabled";

export type DenchIntegrationState = {
  id: DenchIntegrationId;
  label: string;
  enabled: boolean;
  available: boolean;
  gatewayBaseUrl: string | null;
  auth: IntegrationAuthSummary;
  plugin: IntegrationPluginState | null;
  managedByDench: boolean;
  healthIssues: IntegrationHealthIssue[];
  health: {
    status: "healthy" | "degraded" | "disabled";
    pluginMissing: boolean;
    pluginInstalledButDisabled: boolean;
    configMismatch: boolean;
    missingAuth: boolean;
    missingGatewayOverride: boolean;
  };
  overrideActive?: boolean;
};

export type BuiltInSearchState = {
  enabled: boolean;
  denied: boolean;
  provider: string | null;
};

export type IntegrationsState = {
  metadata: DenchIntegrationMetadata;
  search: {
    builtIn: BuiltInSearchState;
    effectiveOwner: "exa" | "web_search" | "none";
  };
  integrations: DenchIntegrationState[];
};

export type IntegrationToggleResult = {
  state: IntegrationsState;
  changed: boolean;
};

export type IntegrationRuntimeRefresh = {
  attempted: boolean;
  restarted: boolean;
  error: string | null;
  profile: string;
};

export type IntegrationRepairEntry = {
  id: "exa" | "apollo";
  pluginId: string;
  assetAvailable: boolean;
  assetCopied: boolean;
  repaired: boolean;
  issues: string[];
};

export type IntegrationsRepairResult = {
  changed: boolean;
  repairs: IntegrationRepairEntry[];
  repairedIds: Array<IntegrationRepairEntry["id"]>;
  state: IntegrationsState;
};

type UnknownRecord = Record<string, unknown>;

/**
 * The full openclaw.json parsed as an opaque record so that writes preserve
 * every key the integrations code does not know about (meta, wizard, auth,
 * agents, gateway, etc.).
 */
type OpenClawConfig = UnknownRecord;

const DEFAULT_GATEWAY_URL = "https://gateway.merseoriginals.com";
const DEFAULT_FALLBACK_PROVIDER = "duckduckgo";
const METADATA_FILENAME = ".dench-integrations.json";
const EXA_PLUGIN_ID = "exa-search";
const APOLLO_PLUGIN_ID = "apollo-enrichment";
const execFileAsync = promisify(execFile);

function asRecord(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => readString(item))
    .filter((item): item is string => Boolean(item));
}

function openClawConfigPath(): string {
  return join(resolveOpenClawStateDir(), "openclaw.json");
}

function integrationsMetadataPath(): string {
  return join(resolveOpenClawStateDir(), METADATA_FILENAME);
}

function readJsonFile<T>(path: string, fallback: T): T {
  if (!existsSync(path)) {
    return fallback;
  }
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

export function readOpenClawConfigForIntegrations(): OpenClawConfig {
  const raw = readJsonFile<unknown>(openClawConfigPath(), {});
  return asRecord(raw) ?? {};
}

export function writeOpenClawConfigForIntegrations(config: OpenClawConfig): void {
  const configPath = openClawConfigPath();
  const dirPath = resolveOpenClawStateDir();
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

export function readIntegrationsMetadata(): DenchIntegrationMetadata {
  const parsed = readJsonFile<DenchIntegrationMetadata | UnknownRecord>(
    integrationsMetadataPath(),
    { schemaVersion: 1 },
  );
  const schemaVersion =
    asRecord(parsed) && parsed.schemaVersion === 1 ? 1 : 1;
  return {
    schemaVersion,
    ...(asRecord(parsed)?.exa ? { exa: asRecord(parsed)?.exa as DenchIntegrationMetadata["exa"] } : {}),
    ...(asRecord(parsed)?.apollo ? { apollo: {} } : {}),
    ...(asRecord(parsed)?.elevenlabs ? { elevenlabs: {} } : {}),
    ...(asRecord(parsed)?.future ? { future: asRecord(parsed)?.future as DenchIntegrationMetadata["future"] } : {}),
  };
}

export function writeIntegrationsMetadata(metadata: DenchIntegrationMetadata): void {
  const filePath = integrationsMetadataPath();
  const dirPath = resolveOpenClawStateDir();
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
  writeFileSync(filePath, JSON.stringify(metadata, null, 2) + "\n", "utf-8");
}

function resolveGatewayBaseUrl(config: OpenClawConfig): string | null {
  const plugins = asRecord(config.plugins);
  const pluginEntries = asRecord(plugins?.entries);
  const gatewayConfig = asRecord(asRecord(pluginEntries?.["dench-ai-gateway"])?.config);
  return (
    readString(gatewayConfig?.gatewayUrl) ||
    process.env.DENCH_GATEWAY_URL?.trim() ||
    DEFAULT_GATEWAY_URL
  );
}

function ensureRecord(parent: UnknownRecord, key: string): UnknownRecord {
  const existing = asRecord(parent[key]);
  if (existing) {
    return existing;
  }
  const fresh: UnknownRecord = {};
  parent[key] = fresh;
  return fresh;
}

function ensurePluginsConfig(config: OpenClawConfig): UnknownRecord {
  return ensureRecord(config, "plugins");
}

function ensureToolsConfig(config: OpenClawConfig): UnknownRecord {
  return ensureRecord(config, "tools");
}

function ensureWebSearchConfig(config: OpenClawConfig): UnknownRecord {
  const tools = ensureToolsConfig(config);
  const web = ensureRecord(tools, "web");
  return ensureRecord(web, "search");
}

function ensureStringList(target: unknown): string[] {
  return Array.isArray(target) ? readStringList(target) : [];
}

function setStringList(target: string[], nextValues: string[]): boolean {
  const next = Array.from(new Set(nextValues.filter(Boolean)));
  if (target.length === next.length && target.every((value, index) => value === next[index])) {
    return false;
  }
  target.length = 0;
  target.push(...next);
  return true;
}

function addUnique(list: string[], value: string): boolean {
  if (list.includes(value)) {
    return false;
  }
  list.push(value);
  return true;
}

function removeValue(list: string[], value: string): boolean {
  const next = list.filter((item) => item !== value);
  return setStringList(list, next);
}

function ensurePluginRegistration(config: OpenClawConfig, pluginId: string): boolean {
  const plugins = ensurePluginsConfig(config);
  const allow = ensureStringList(plugins.allow);
  plugins.allow = allow;
  const load = ensureRecord(plugins, "load");
  const loadPaths = ensureStringList(load.paths);
  load.paths = loadPaths;
  const entries = ensureRecord(plugins, "entries");
  const installs = ensureRecord(plugins, "installs");

  let changed = false;
  const { installPath, sourcePath } = resolveBundledPluginPaths(pluginId);
  const pluginExists = existsSync(installPath);

  changed = addUnique(allow, pluginId) || changed;

  if (!entries[pluginId] || !asRecord(entries[pluginId])) {
    entries[pluginId] = { enabled: true };
    changed = true;
  }
  const entry = asRecord(entries[pluginId]);
  if (entry && entry.enabled !== true) {
    entry.enabled = true;
    changed = true;
  }

  if (pluginExists) {
    changed = addUnique(loadPaths, installPath) || changed;
    const install = asRecord(installs[pluginId]);
    if (!install) {
      installs[pluginId] = { installPath, sourcePath };
      changed = true;
    } else {
      if (install.installPath !== installPath) {
        install.installPath = installPath;
        changed = true;
      }
      if (install.sourcePath !== sourcePath) {
        install.sourcePath = sourcePath;
        changed = true;
      }
    }
  }

  return changed;
}

function resolveBundledPluginPaths(pluginId: string): {
  installPath: string;
  sourcePath: string;
} {
  const cwdCandidates = [
    join(process.cwd(), "extensions", pluginId),
    join(process.cwd(), "..", "..", "extensions", pluginId),
  ];
  const sourcePath = cwdCandidates.find((candidate) => existsSync(candidate)) ?? cwdCandidates[0];
  return {
    installPath: join(resolveOpenClawStateDir(), "extensions", pluginId),
    sourcePath,
  };
}

function repairBundledPluginRegistration(
  config: OpenClawConfig,
  params: {
    id: "exa" | "apollo";
    pluginId: string;
  },
): IntegrationRepairEntry & { changed: boolean } {
  const plugins = ensurePluginsConfig(config);
  const allow = ensureStringList(plugins.allow);
  plugins.allow = allow;
  const load = ensureRecord(plugins, "load");
  const loadPaths = ensureStringList(load.paths);
  load.paths = loadPaths;
  const entries = ensureRecord(plugins, "entries");
  const installs = ensureRecord(plugins, "installs");

  const { installPath, sourcePath } = resolveBundledPluginPaths(params.pluginId);
  const sourceExists = existsSync(sourcePath);
  let installExists = existsSync(installPath);
  let assetCopied = false;
  const issues: string[] = [];
  let changed = false;

  if (!installExists && sourceExists) {
    mkdirSync(dirname(installPath), { recursive: true });
    cpSync(sourcePath, installPath, { recursive: true, force: true });
    installExists = true;
    assetCopied = true;
    changed = true;
  }

  if (!installExists && !sourceExists) {
    issues.push("source_asset_missing");
  }

  const existingEntry = asRecord(entries[params.pluginId]);
  const preservedEnabled = existingEntry?.enabled !== false;
  if (!existingEntry) {
    entries[params.pluginId] = { enabled: preservedEnabled };
    changed = true;
  }

  if (installExists) {
    changed = addUnique(allow, params.pluginId) || changed;
    changed = addUnique(loadPaths, installPath) || changed;
    const install = asRecord(installs[params.pluginId]);
    if (!install) {
      installs[params.pluginId] = { installPath, sourcePath };
      changed = true;
    } else {
      if (install.installPath !== installPath) {
        install.installPath = installPath;
        changed = true;
      }
      if (install.sourcePath !== sourcePath) {
        install.sourcePath = sourcePath;
        changed = true;
      }
    }
  } else {
    issues.push("install_path_missing");
  }

  return {
    id: params.id,
    pluginId: params.pluginId,
    assetAvailable: installExists,
    assetCopied,
    repaired: changed && installExists,
    issues,
    changed,
  };
}

function setPluginEnabled(config: OpenClawConfig, pluginId: string, enabled: boolean): boolean {
  const plugins = ensurePluginsConfig(config);
  const entries = ensureRecord(plugins, "entries");
  let changed = false;
  const existing = asRecord(entries[pluginId]);
  if (!existing) {
    entries[pluginId] = { enabled };
    changed = true;
  } else if (existing.enabled !== enabled) {
    existing.enabled = enabled;
    changed = true;
  }
  return changed;
}

function setWebSearchPolicy(config: OpenClawConfig, params: {
  enabled: boolean;
  denied: boolean;
}): boolean {
  let changed = false;
  const tools = ensureToolsConfig(config);
  const deny = ensureStringList(tools.deny);
  tools.deny = deny;
  const webSearch = ensureWebSearchConfig(config);

  if (webSearch.enabled !== params.enabled) {
    webSearch.enabled = params.enabled;
    changed = true;
  }
  if (params.denied) {
    changed = addUnique(deny, "web_search") || changed;
  } else {
    changed = removeValue(deny, "web_search") || changed;
  }
  return changed;
}

function resolveDenchAuth(config: OpenClawConfig): IntegrationAuthSummary {
  const models = asRecord(config.models);
  const provider = asRecord(asRecord(models?.providers)?.["dench-cloud"]);
  if (readString(provider?.apiKey)) {
    return { configured: true, source: "config" };
  }
  if (process.env.DENCH_CLOUD_API_KEY?.trim() || process.env.DENCH_API_KEY?.trim()) {
    return { configured: true, source: "env" };
  }
  return { configured: false, source: "missing" };
}

function resolveDenchApiKey(config: OpenClawConfig): string | null {
  const models = asRecord(config.models);
  const provider = asRecord(asRecord(models?.providers)?.["dench-cloud"]);
  if (readString(provider?.apiKey)) {
    return readString(provider?.apiKey) ?? null;
  }
  if (process.env.DENCH_CLOUD_API_KEY?.trim()) {
    return process.env.DENCH_CLOUD_API_KEY.trim();
  }
  if (process.env.DENCH_API_KEY?.trim()) {
    return process.env.DENCH_API_KEY.trim();
  }
  return null;
}

function ensureTtsConfig(config: OpenClawConfig): UnknownRecord {
  const messages = ensureRecord(config, "messages");
  return ensureRecord(messages, "tts");
}

function ensureTtsProviders(config: OpenClawConfig): UnknownRecord {
  const tts = ensureTtsConfig(config);
  return ensureRecord(tts, "providers");
}

function readPluginState(config: OpenClawConfig, pluginId: string): IntegrationPluginState {
  const plugins = asRecord(config.plugins);
  const entries = asRecord(plugins?.entries);
  const installs = asRecord(plugins?.installs);
  const allow = readStringList(plugins?.allow);
  const load = asRecord(plugins?.load);
  const loadPaths = readStringList(load?.paths);
  const entry = asRecord(entries?.[pluginId]);
  const install = asRecord(installs?.[pluginId]);
  const installPath = readString(install?.installPath) ?? null;
  const sourcePath = readString(install?.sourcePath) ?? null;

  return {
    pluginId,
    configured: Boolean(entry),
    enabled: entry?.enabled !== false && Boolean(entry),
    allowlisted: allow.includes(pluginId),
    loadPathConfigured: loadPaths.some((path) => path === installPath),
    installRecorded: Boolean(install),
    installPath,
    installPathExists: installPath ? existsSync(installPath) : false,
    sourcePath,
  };
}

function readBuiltInSearchState(config: OpenClawConfig): BuiltInSearchState {
  const tools = asRecord(config.tools);
  const deny = readStringList(tools?.deny);
  const web = asRecord(tools?.web);
  const searchConfig = asRecord(web?.search);
  return {
    enabled: readBoolean(searchConfig?.enabled) !== false,
    denied: deny.includes("web_search"),
    provider: readString(searchConfig?.provider) ?? null,
  };
}

function resolveEffectiveSearchOwner(params: {
  exaState: DenchIntegrationState;
  builtInSearch: BuiltInSearchState;
}): "exa" | "web_search" | "none" {
  if (params.exaState.enabled && params.exaState.available && (params.builtInSearch.denied || !params.builtInSearch.enabled)) {
    return "exa";
  }
  if (params.builtInSearch.enabled && !params.builtInSearch.denied) {
    return "web_search";
  }
  return "none";
}

function buildHealth(enabled: boolean, issues: IntegrationHealthIssue[]): DenchIntegrationState["health"] {
  return {
    status: enabled ? (issues.length === 0 ? "healthy" : "degraded") : "disabled",
    pluginMissing:
      issues.includes("missing_plugin_entry") ||
      issues.includes("plugin_install_missing") ||
      issues.includes("plugin_install_path_missing"),
    pluginInstalledButDisabled: issues.includes("plugin_disabled"),
    configMismatch:
      issues.includes("plugin_not_allowlisted") ||
      issues.includes("plugin_load_path_missing") ||
      issues.includes("built_in_search_still_enabled") ||
      issues.includes("missing_override"),
    missingAuth: issues.includes("missing_auth"),
    missingGatewayOverride: issues.includes("missing_override"),
  };
}

function buildExaState(
  config: OpenClawConfig,
  gatewayBaseUrl: string | null,
  auth: IntegrationAuthSummary,
  builtInSearch: BuiltInSearchState,
): DenchIntegrationState {
  const plugin = readPluginState(config, "exa-search");
  const healthIssues: IntegrationHealthIssue[] = [];
  if (!plugin.configured) healthIssues.push("missing_plugin_entry");
  if (plugin.configured && !plugin.enabled) healthIssues.push("plugin_disabled");
  if (!plugin.allowlisted) healthIssues.push("plugin_not_allowlisted");
  if (!plugin.loadPathConfigured) healthIssues.push("plugin_load_path_missing");
  if (!plugin.installRecorded) healthIssues.push("plugin_install_missing");
  if (plugin.installRecorded && !plugin.installPathExists) healthIssues.push("plugin_install_path_missing");
  if (!auth.configured) healthIssues.push("missing_auth");
  if (!gatewayBaseUrl) healthIssues.push("missing_gateway");
  if (plugin.enabled && builtInSearch.enabled && !builtInSearch.denied) {
    healthIssues.push("built_in_search_still_enabled");
  }

  const enabled = plugin.configured && plugin.enabled;
  const available =
    enabled &&
    plugin.allowlisted &&
    plugin.loadPathConfigured &&
    plugin.installRecorded &&
    plugin.installPathExists &&
    auth.configured &&
    Boolean(gatewayBaseUrl);

  return {
    id: "exa",
    label: "Exa Search",
    enabled,
    available,
    gatewayBaseUrl,
    auth,
    plugin,
    managedByDench: true,
    healthIssues,
    health: buildHealth(enabled, healthIssues),
  };
}

function buildApolloState(
  config: OpenClawConfig,
  gatewayBaseUrl: string | null,
  auth: IntegrationAuthSummary,
): DenchIntegrationState {
  const plugin = readPluginState(config, APOLLO_PLUGIN_ID);
  const healthIssues: IntegrationHealthIssue[] = [];
  if (!plugin.configured) healthIssues.push("missing_plugin_entry");
  if (plugin.configured && !plugin.enabled) healthIssues.push("plugin_disabled");
  if (!plugin.allowlisted) healthIssues.push("plugin_not_allowlisted");
  if (!plugin.loadPathConfigured) healthIssues.push("plugin_load_path_missing");
  if (!plugin.installRecorded) healthIssues.push("plugin_install_missing");
  if (plugin.installRecorded && !plugin.installPathExists) healthIssues.push("plugin_install_path_missing");
  if (!auth.configured) healthIssues.push("missing_auth");
  if (!gatewayBaseUrl) healthIssues.push("missing_gateway");

  const enabled = plugin.configured && plugin.enabled;
  const available =
    enabled &&
    plugin.allowlisted &&
    plugin.loadPathConfigured &&
    plugin.installRecorded &&
    plugin.installPathExists &&
    auth.configured &&
    Boolean(gatewayBaseUrl);

  return {
    id: "apollo",
    label: "Apollo Enrichment",
    enabled,
    available,
    gatewayBaseUrl,
    auth,
    plugin,
    managedByDench: true,
    healthIssues,
    health: buildHealth(enabled, healthIssues),
  };
}

function buildElevenLabsState(
  config: OpenClawConfig,
  gatewayBaseUrl: string | null,
  auth: IntegrationAuthSummary,
): DenchIntegrationState {
  const messages = asRecord(config.messages);
  const tts = asRecord(messages?.tts);
  const providers = asRecord(tts?.providers);
  const elevenlabs = asRecord(providers?.elevenlabs);
  const overrideBaseUrl = readString(elevenlabs?.baseUrl) ?? null;
  const ttsProvider = readString(tts?.provider);
  const overrideActive = Boolean(
    ttsProvider === "elevenlabs" &&
    overrideBaseUrl &&
    gatewayBaseUrl &&
    overrideBaseUrl === gatewayBaseUrl,
  );
  const healthIssues: IntegrationHealthIssue[] = [];
  if (!auth.configured) healthIssues.push("missing_auth");
  if (!gatewayBaseUrl) healthIssues.push("missing_gateway");
  if (!overrideActive) healthIssues.push("missing_override");

  return {
    id: "elevenlabs",
    label: "ElevenLabs",
    enabled: overrideActive,
    available: auth.configured && Boolean(gatewayBaseUrl),
    gatewayBaseUrl: overrideBaseUrl ?? gatewayBaseUrl,
    auth,
    plugin: null,
    managedByDench: true,
    healthIssues,
    health: buildHealth(overrideActive, healthIssues),
    overrideActive,
  };
}

export function getIntegrationsState(): IntegrationsState {
  const config = readOpenClawConfigForIntegrations();
  const metadata = readIntegrationsMetadata();
  const gatewayBaseUrl = resolveGatewayBaseUrl(config);
  const auth = resolveDenchAuth(config);
  const builtInSearch = readBuiltInSearchState(config);
  const exa = buildExaState(config, gatewayBaseUrl, auth, builtInSearch);
  const apollo = buildApolloState(config, gatewayBaseUrl, auth);
  const elevenlabs = buildElevenLabsState(config, gatewayBaseUrl, auth);

  return {
    metadata: {
      schemaVersion: 1,
      exa: {
        ownsSearch: metadata.exa?.ownsSearch ?? false,
        fallbackProvider: metadata.exa?.fallbackProvider ?? DEFAULT_FALLBACK_PROVIDER,
      },
      ...(metadata.apollo ? { apollo: {} } : {}),
      ...(metadata.elevenlabs ? { elevenlabs: {} } : {}),
      ...(metadata.future ? { future: metadata.future } : {}),
    },
    search: {
      builtIn: builtInSearch,
      effectiveOwner: resolveEffectiveSearchOwner({ exaState: exa, builtInSearch }),
    },
    integrations: [exa, apollo, elevenlabs],
  };
}

export function getIntegrationState(id: DenchIntegrationId): DenchIntegrationState | undefined {
  return getIntegrationsState().integrations.find((integration) => integration.id === id);
}

function resolveOpenClawProfileName(): string {
  const stateDir = resolveOpenClawStateDir();
  const dirName = basename(stateDir);
  if (dirName === ".openclaw") {
    return "default";
  }
  if (dirName.startsWith(".openclaw-")) {
    const suffix = dirName.slice(".openclaw-".length).trim();
    return suffix || "default";
  }
  return "default";
}

function extractRefreshError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  const structured = error as {
    shortMessage?: string;
    stderr?: string | Buffer;
    stdout?: string | Buffer;
  };
  const stderr = typeof structured?.stderr === "string"
    ? structured.stderr.trim()
    : Buffer.isBuffer(structured?.stderr)
      ? structured.stderr.toString("utf-8").trim()
      : "";
  if (stderr) {
    return stderr.split("\n")[0] ?? stderr;
  }
  const stdout = typeof structured?.stdout === "string"
    ? structured.stdout.trim()
    : Buffer.isBuffer(structured?.stdout)
      ? structured.stdout.toString("utf-8").trim()
      : "";
  if (stdout) {
    return stdout.split("\n")[0] ?? stdout;
  }
  return structured?.shortMessage?.trim() || "Gateway restart failed.";
}

export async function refreshIntegrationsRuntime(): Promise<IntegrationRuntimeRefresh> {
  const profile = resolveOpenClawProfileName();
  try {
    await execFileAsync("openclaw", ["--profile", profile, "gateway", "restart"], {
      timeout: 30_000,
      env: process.env,
    });
    return {
      attempted: true,
      restarted: true,
      error: null,
      profile,
    };
  } catch (error) {
    return {
      attempted: true,
      restarted: false,
      error: extractRefreshError(error),
      profile,
    };
  }
}

export function repairOlderIntegrationsProfile(): IntegrationsRepairResult {
  const config = readOpenClawConfigForIntegrations();
  const repairs = [
    repairBundledPluginRegistration(config, { id: "exa", pluginId: EXA_PLUGIN_ID }),
    repairBundledPluginRegistration(config, { id: "apollo", pluginId: APOLLO_PLUGIN_ID }),
  ];
  const changed = repairs.some((repair) => repair.changed);

  if (changed) {
    writeOpenClawConfigForIntegrations(config);
  }

  return {
    changed,
    repairs: repairs.map(({ changed: _changed, ...repair }) => repair),
    repairedIds: repairs
      .filter((repair) => repair.repaired)
      .map((repair) => repair.id),
    state: getIntegrationsState(),
  };
}

export function setExaIntegrationEnabled(enabled: boolean): IntegrationToggleResult {
  const config = readOpenClawConfigForIntegrations();
  const metadata = readIntegrationsMetadata();
  let changed = false;

  if (enabled) {
    changed = ensurePluginRegistration(config, EXA_PLUGIN_ID) || changed;
    changed = setPluginEnabled(config, EXA_PLUGIN_ID, true) || changed;
    changed = setWebSearchPolicy(config, { enabled: false, denied: true }) || changed;
  } else {
    changed = setPluginEnabled(config, EXA_PLUGIN_ID, false) || changed;
    changed = setWebSearchPolicy(config, { enabled: true, denied: false }) || changed;
  }

  const nextMetadata: DenchIntegrationMetadata = {
    ...metadata,
    schemaVersion: 1,
    exa: {
      ownsSearch: enabled,
      fallbackProvider: DEFAULT_FALLBACK_PROVIDER,
    },
  };
  if (JSON.stringify(nextMetadata) !== JSON.stringify(metadata)) {
    writeIntegrationsMetadata(nextMetadata);
    changed = true;
  }

  if (changed) {
    writeOpenClawConfigForIntegrations(config);
  }

  return {
    state: getIntegrationsState(),
    changed,
  };
}

export function setApolloIntegrationEnabled(enabled: boolean): IntegrationToggleResult {
  const config = readOpenClawConfigForIntegrations();
  let changed = false;

  if (enabled) {
    changed = ensurePluginRegistration(config, APOLLO_PLUGIN_ID) || changed;
    changed = setPluginEnabled(config, APOLLO_PLUGIN_ID, true) || changed;
  } else {
    changed = setPluginEnabled(config, APOLLO_PLUGIN_ID, false) || changed;
  }

  if (changed) {
    writeOpenClawConfigForIntegrations(config);
  }

  return {
    state: getIntegrationsState(),
    changed,
  };
}

export function setElevenLabsIntegrationEnabled(enabled: boolean): IntegrationToggleResult {
  const config = readOpenClawConfigForIntegrations();
  const tts = ensureTtsConfig(config);
  const providers = ensureTtsProviders(config);
  const gatewayBaseUrl = resolveGatewayBaseUrl(config) ?? DEFAULT_GATEWAY_URL;
  const denchApiKey = resolveDenchApiKey(config);
  let changed = false;

  if (enabled) {
    if (tts.provider !== "elevenlabs") {
      tts.provider = "elevenlabs";
      changed = true;
    }
    const existing = asRecord(providers.elevenlabs);
    if (!existing) {
      providers.elevenlabs = {};
    }
    const elevenlabs = asRecord(providers.elevenlabs);
    if (elevenlabs && elevenlabs.baseUrl !== gatewayBaseUrl) {
      elevenlabs.baseUrl = gatewayBaseUrl;
      changed = true;
    }
    if (elevenlabs && denchApiKey && elevenlabs.apiKey !== denchApiKey) {
      elevenlabs.apiKey = denchApiKey;
      changed = true;
    }
  } else {
    const elevenlabs = asRecord(providers.elevenlabs);
    if (elevenlabs) {
      if (elevenlabs.baseUrl === gatewayBaseUrl || elevenlabs.baseUrl === DEFAULT_GATEWAY_URL) {
        delete elevenlabs.baseUrl;
        changed = true;
      }
      if (denchApiKey && elevenlabs.apiKey === denchApiKey) {
        delete elevenlabs.apiKey;
        changed = true;
      }
      if (Object.keys(elevenlabs).length === 0) {
        delete providers.elevenlabs;
        changed = true;
      }
    }
    if (tts.provider === "elevenlabs") {
      delete tts.provider;
      changed = true;
    }
  }

  if (changed) {
    writeOpenClawConfigForIntegrations(config);
  }

  return {
    state: getIntegrationsState(),
    changed,
  };
}
