// ── Core enums ─────────────────────────────────────────────────────────

export type ConnectorType = "blacklist" | "http" | "import";
export type HttpProviderType =
  | "openai-moderation"
  | "dknownai"
  | "secra"
  | "hidylan"
  | (string & {});

// ── Public context type ─────────────────────────────────────────────────
export type CheckContext = {
  sessionKey?: string;
  channelId?: string;
  userId?: string;
};

// ── Unified decision type ──────────────────────────────────────────────
export type GuardrailsDecision = {
  action: "pass" | "block";
  blockMessage?: string;
  raw?: unknown;
  metadata?: Record<string, unknown>;
  evidence?: string[];
};

// ── Unified backend function type ───────────────────────────────────────
export type BackendFn = (text: string, context: CheckContext) => Promise<GuardrailsDecision>;

// ── import backend: external module function types ──────────────────────
export type ImportCheckFn = (
  text: string,
  context: CheckContext,
  args: Record<string, unknown>,
) => Promise<GuardrailsDecision>;

export type ImportInitFn = (args: Record<string, unknown>) => void | Promise<void>;

// ── HTTP config ─────────────────────────────────────────────────────────
export type HttpConfig = {
  provider: HttpProviderType;
  apiKey: string;
  apiUrl: string;
  model: string;
  params: Record<string, unknown>;
};

// ── Blacklist backend configuration ─────────────────────────────────────
export type BlacklistConfig = {
  blacklistFile: boolean | string;
  caseSensitive: boolean;
  hot: boolean;
  hotDebounceMs: number;
};

// ── Import connector configuration ──────────────────────────────────────
export type ImportConfig = {
  script: string;
  args: Record<string, unknown>;
  hot: boolean;
  hotDebounceMs: number;
};

// ── Channel override configuration ──────────────────────────────────────
export type ChannelOverrideConfig = {
  connector?: ConnectorType;
  http?: Partial<Pick<HttpConfig, "provider" | "apiKey" | "apiUrl" | "model" | "params">>;
  blacklist?: Partial<BlacklistConfig>;
  import?: Partial<ImportConfig>;
  blockMessage?: string;
  fallbackOnError?: "pass" | "block";
  timeoutMs?: number;
};

// ── Plugin configuration ────────────────────────────────────────────────
export type GuardrailsConfig = {
  connector: ConnectorType | "";
  http: HttpConfig;
  blacklist: BlacklistConfig;
  import: ImportConfig;
  timeoutMs: number;
  fallbackOnError: "pass" | "block";
  blockMessage: string;
  channels: Record<string, ChannelOverrideConfig>;
};

// ── Effective per-channel config (resolved from global + override) ──────
export type EffectiveChannelConfig = {
  enabled: boolean;
  connector: ConnectorType | null;
  http: HttpConfig;
  blacklist: BlacklistConfig;
  import: ImportConfig;
  timeoutMs: number;
  fallbackOnError: "pass" | "block";
  blockMessage: string;
};

// ── Logger interface ────────────────────────────────────────────────────
export type Logger = {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
};

// ── Engine auto-detection ───────────────────────────────────────────────
/**
 * Resolve the effective connector type from the explicit `connector` field
 * or by auto-detecting from config fields.
 *
 * Priority: connector explicit > http.provider/http.apiUrl > import.script > blacklistFile
 */
export function resolveConnectorType(config: GuardrailsConfig): ConnectorType | null {
  if (config.connector) {
    return config.connector;
  }
  if (config.http.provider !== "" || config.http.apiUrl) {
    return "http";
  }
  if (config.import.script) {
    return "import";
  }
  if (
    config.blacklist.blacklistFile === true ||
    typeof config.blacklist.blacklistFile === "string"
  ) {
    return "blacklist";
  }
  return null;
}

// ── Channel config resolution ───────────────────────────────────────────
/**
 * Merge global config with a channel override to produce an effective
 * per-channel config.
 *
 * If channelId is missing/empty or not in channels, returns global config.
 * If neither global nor channel has a valid connector, returns enabled=false.
 */
export function resolveChannelConfig(
  global: GuardrailsConfig,
  channelId: string | undefined,
  logger?: Logger,
): EffectiveChannelConfig {
  const globalConnector = resolveConnectorType(global);
  const base: EffectiveChannelConfig = {
    enabled: globalConnector !== null,
    connector: globalConnector,
    http: global.http,
    blacklist: global.blacklist,
    import: global.import,
    timeoutMs: global.timeoutMs,
    fallbackOnError: global.fallbackOnError,
    blockMessage: global.blockMessage,
  };

  if (!channelId || !global.channels[channelId]) {
    return base;
  }

  const override = global.channels[channelId];

  // connector override
  if (override.connector) {
    base.connector = override.connector;
    base.enabled = true;
  }

  // http field-level override
  if (override.http) {
    const httpOverride = override.http;
    base.http = { ...base.http };
    if (httpOverride.provider !== undefined) {
      base.http.provider = httpOverride.provider;
    }
    if (httpOverride.apiKey !== undefined) {
      base.http.apiKey = httpOverride.apiKey;
    }
    if (httpOverride.apiUrl !== undefined) {
      base.http.apiUrl = httpOverride.apiUrl;
    }
    if (httpOverride.model !== undefined) {
      base.http.model = httpOverride.model;
    }
    if (httpOverride.params !== undefined) {
      base.http.params = httpOverride.params;
    }

    // apiKey isolation: when a channel retargets the HTTP backend (different
    // provider or apiUrl) but does not supply its own apiKey, drop the global
    // apiKey so it is never sent to an unintended service.
    const retargeted = httpOverride.provider !== undefined || httpOverride.apiUrl !== undefined;
    if (retargeted && httpOverride.apiKey === undefined && global.http.apiKey) {
      base.http.apiKey = "";
      logger?.warn(
        `guardrails: channel "${channelId}" overrides http provider/apiUrl without apiKey — global apiKey was dropped to avoid sending it to an unintended service`,
      );
    }
  }

  // blacklist field-level override
  if (override.blacklist) {
    const blOverride = override.blacklist;
    base.blacklist = { ...base.blacklist };
    if (blOverride.blacklistFile !== undefined) {
      base.blacklist.blacklistFile = blOverride.blacklistFile;
    }
    if (blOverride.caseSensitive !== undefined) {
      base.blacklist.caseSensitive = blOverride.caseSensitive;
    }
    if (blOverride.hot !== undefined) {
      base.blacklist.hot = blOverride.hot;
    }
    if (blOverride.hotDebounceMs !== undefined) {
      base.blacklist.hotDebounceMs = blOverride.hotDebounceMs;
    }
  }

  // import field-level override
  if (override.import) {
    const impOverride = override.import;
    base.import = { ...base.import };
    if (impOverride.script !== undefined) {
      base.import.script = impOverride.script;
    }
    if (impOverride.args !== undefined) {
      base.import.args = impOverride.args;
    }
    if (impOverride.hot !== undefined) {
      base.import.hot = impOverride.hot;
    }
    if (impOverride.hotDebounceMs !== undefined) {
      base.import.hotDebounceMs = impOverride.hotDebounceMs;
    }
  }

  // scalar overrides
  if (override.blockMessage !== undefined) {
    base.blockMessage = override.blockMessage;
  }
  if (override.fallbackOnError !== undefined) {
    base.fallbackOnError = override.fallbackOnError;
  }
  if (override.timeoutMs !== undefined) {
    base.timeoutMs = override.timeoutMs;
  }

  return base;
}

// ── Config resolution ───────────────────────────────────────────────────
export function resolveConfig(pluginConfig?: Record<string, unknown>): GuardrailsConfig {
  const raw = pluginConfig ?? {};
  return {
    connector: resolveConnectorField(raw.connector),
    http: resolveHttpConfig(raw.http),
    blacklist: resolveBlacklistConfig(raw.blacklist),
    import: resolveImportConfig(raw.import),
    timeoutMs: clamp(typeof raw.timeoutMs === "number" ? raw.timeoutMs : 5000, 500, 30000),
    fallbackOnError: raw.fallbackOnError === "block" ? "block" : "pass",
    blockMessage:
      typeof raw.blockMessage === "string"
        ? raw.blockMessage
        : "This request has been blocked by the guardrails policy.",
    channels: resolveChannelsConfig(raw.channels),
  };
}

// ── Internal helpers ────────────────────────────────────────────────────

const VALID_CONNECTORS = new Set<ConnectorType>(["blacklist", "http", "import"]);

function resolveConnectorField(connector: unknown): ConnectorType | "" {
  if (typeof connector === "string" && VALID_CONNECTORS.has(connector as ConnectorType)) {
    return connector as ConnectorType;
  }
  return "";
}

function resolveHttpConfig(http: unknown): HttpConfig {
  const defaults: HttpConfig = {
    provider: "",
    apiKey: "",
    apiUrl: "",
    model: "omni-moderation-latest",
    params: {},
  };

  if (http === null || typeof http !== "object" || Array.isArray(http)) {
    return { ...defaults };
  }

  const raw = http as Record<string, unknown>;
  return {
    provider: typeof raw.provider === "string" ? raw.provider : "",
    apiKey: typeof raw.apiKey === "string" ? raw.apiKey : "",
    apiUrl: typeof raw.apiUrl === "string" ? raw.apiUrl : "",
    model: typeof raw.model === "string" ? raw.model : "omni-moderation-latest",
    params:
      raw.params !== null && typeof raw.params === "object" && !Array.isArray(raw.params)
        ? (raw.params as Record<string, unknown>)
        : {},
  };
}

function resolveBlacklistConfig(value: unknown): BlacklistConfig {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {
      blacklistFile: false,
      caseSensitive: false,
      hot: false,
      hotDebounceMs: 300,
    };
  }
  const raw = value as Record<string, unknown>;
  return {
    blacklistFile: resolveBlacklistFile(raw.blacklistFile),
    caseSensitive: raw.caseSensitive === true,
    hot: raw.hot === true,
    hotDebounceMs: clamp(typeof raw.hotDebounceMs === "number" ? raw.hotDebounceMs : 300, 50, 5000),
  };
}

function resolveBlacklistFile(value: unknown): boolean | string {
  if (value === true) {
    return true;
  }
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  return false;
}

function resolveImportConfig(importValue: unknown): ImportConfig {
  if (importValue === null || typeof importValue !== "object" || Array.isArray(importValue)) {
    return { script: "", args: {}, hot: false, hotDebounceMs: 300 };
  }

  const raw = importValue as Record<string, unknown>;
  return {
    script: typeof raw.script === "string" ? raw.script : "",
    args:
      raw.args !== null && typeof raw.args === "object" && !Array.isArray(raw.args)
        ? (raw.args as Record<string, unknown>)
        : {},
    hot: raw.hot === true,
    hotDebounceMs: clamp(typeof raw.hotDebounceMs === "number" ? raw.hotDebounceMs : 300, 50, 5000),
  };
}

function resolveChannelsConfig(value: unknown): Record<string, ChannelOverrideConfig> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const raw = value as Record<string, unknown>;
  const result: Record<string, ChannelOverrideConfig> = {};
  for (const [channelId, channelRaw] of Object.entries(raw)) {
    if (channelRaw !== null && typeof channelRaw === "object" && !Array.isArray(channelRaw)) {
      result[channelId] = resolveChannelOverride(channelRaw as Record<string, unknown>);
    }
  }
  return result;
}

function resolveChannelOverride(raw: Record<string, unknown>): ChannelOverrideConfig {
  const override: ChannelOverrideConfig = {};

  if (typeof raw.connector === "string" && VALID_CONNECTORS.has(raw.connector as ConnectorType)) {
    override.connector = raw.connector as ConnectorType;
  }

  // http sub-config
  if (raw.http !== null && typeof raw.http === "object" && !Array.isArray(raw.http)) {
    const httpRaw = raw.http as Record<string, unknown>;
    const httpOverride: ChannelOverrideConfig["http"] = {};
    if (typeof httpRaw.provider === "string") {
      httpOverride.provider = httpRaw.provider;
    }
    if (typeof httpRaw.apiKey === "string") {
      httpOverride.apiKey = httpRaw.apiKey;
    }
    if (typeof httpRaw.apiUrl === "string") {
      httpOverride.apiUrl = httpRaw.apiUrl;
    }
    if (typeof httpRaw.model === "string") {
      httpOverride.model = httpRaw.model;
    }
    if (
      httpRaw.params !== null &&
      typeof httpRaw.params === "object" &&
      !Array.isArray(httpRaw.params)
    ) {
      httpOverride.params = httpRaw.params as Record<string, unknown>;
    }
    if (Object.keys(httpOverride).length > 0) {
      override.http = httpOverride;
    }
  }

  // blacklist sub-config
  if (
    raw.blacklist !== null &&
    typeof raw.blacklist === "object" &&
    !Array.isArray(raw.blacklist)
  ) {
    const blRaw = raw.blacklist as Record<string, unknown>;
    const blOverride: Partial<BlacklistConfig> = {};
    if (
      blRaw.blacklistFile === true ||
      (typeof blRaw.blacklistFile === "string" && blRaw.blacklistFile.length > 0)
    ) {
      blOverride.blacklistFile = blRaw.blacklistFile as boolean | string;
    } else if (blRaw.blacklistFile === false) {
      blOverride.blacklistFile = false;
    }
    if (typeof blRaw.caseSensitive === "boolean") {
      blOverride.caseSensitive = blRaw.caseSensitive;
    }
    if (typeof blRaw.hot === "boolean") {
      blOverride.hot = blRaw.hot;
    }
    if (typeof blRaw.hotDebounceMs === "number") {
      blOverride.hotDebounceMs = clamp(blRaw.hotDebounceMs, 50, 5000);
    }
    if (Object.keys(blOverride).length > 0) {
      override.blacklist = blOverride;
    }
  }

  // import sub-config
  if (raw.import !== null && typeof raw.import === "object" && !Array.isArray(raw.import)) {
    const impRaw = raw.import as Record<string, unknown>;
    const impOverride: Partial<ImportConfig> = {};
    if (typeof impRaw.script === "string") {
      impOverride.script = impRaw.script;
    }
    if (impRaw.args !== null && typeof impRaw.args === "object" && !Array.isArray(impRaw.args)) {
      impOverride.args = impRaw.args as Record<string, unknown>;
    }
    if (typeof impRaw.hot === "boolean") {
      impOverride.hot = impRaw.hot;
    }
    if (typeof impRaw.hotDebounceMs === "number") {
      impOverride.hotDebounceMs = clamp(impRaw.hotDebounceMs, 50, 5000);
    }
    if (Object.keys(impOverride).length > 0) {
      override.import = impOverride;
    }
  }

  // scalar fields
  if (typeof raw.blockMessage === "string") {
    override.blockMessage = raw.blockMessage;
  }
  if (raw.fallbackOnError === "pass" || raw.fallbackOnError === "block") {
    override.fallbackOnError = raw.fallbackOnError;
  }
  if (typeof raw.timeoutMs === "number") {
    override.timeoutMs = clamp(raw.timeoutMs, 500, 30000);
  }

  return override;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
