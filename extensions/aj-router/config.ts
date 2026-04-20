/**
 * Config loader for the AJ Router plugin.
 *
 * Reads the raw `pluginConfig` block (from `plugins.entries["aj-router"].config`
 * in `openclaw.json`), validates required invariants, and returns a typed,
 * defaulted `RouterConfig` that the runtime paths can trust.
 *
 * No runtime side effects here — pure parse + defaults. All missing keys fall
 * back to safe defaults so the plugin is a no-op when enabled without config.
 */

export type ClassifierTier = "simple" | "medium" | "complex";

export type ClassifierMode = "heuristic" | "llm";

export type SensitivityRule = {
  /**
   * If set, every request with this sensitivity is forced to the given alias
   * regardless of classifier output. Used for `privileged` → local model.
   */
  forceAlias?: string;
  /**
   * If true, the request must NEVER leave the local machine. Enforced by
   * refusing to resolve to any provider that is not `ollama`/`lmstudio` or
   * another local-only provider.
   */
  blockExternal?: boolean;
  /**
   * Whitelist of allowed provider ids. `"*"` means any. If omitted, no
   * provider filter is applied.
   */
  allowedProviders?: string[] | "*";
};

export type RouterConfig = {
  /** Alias used when no classification output is available. */
  defaultAlias: string;
  /** Alias → concrete "provider/model" reference. */
  aliases: Record<string, string>;
  /** Classifier tier → alias. */
  classificationRules: Record<ClassifierTier, string>;
  /** Classifier implementation. v1 ships heuristic only. */
  classifier: {
    mode: ClassifierMode;
    model: string;
  };
  /** Sensitivity label → rule. */
  sensitivity: Record<string, SensitivityRule>;
  /** Fallback label when the request carries no sensitivity field. */
  defaultSensitivity: string;
  /** Confidence floor. Below this, escalate one alias up the ladder. */
  escalationThreshold: number;
  /** Abort a request whose estimated cost exceeds this dollar amount. */
  budgetCeilingUsdPerRequest: number;
  /** Absolute path for the routing JSONL log. */
  logsDir: string;
};

/**
 * Hard-coded defaults. Mirrors the out-of-repo `aj/router/routing.json`
 * contents so the plugin works even if a user never writes config.
 */
export const ROUTER_DEFAULTS: RouterConfig = {
  defaultAlias: "workhorse",
  aliases: {
    speed: "anthropic/claude-haiku-4-5",
    workhorse: "anthropic/claude-sonnet-4-6",
    flagship: "anthropic/claude-sonnet-4-6",
    value: "anthropic/claude-sonnet-4-6",
    realtime: "anthropic/claude-sonnet-4-6",
    multimodal: "anthropic/claude-sonnet-4-6",
    terminal: "anthropic/claude-sonnet-4-6",
    bulk: "anthropic/claude-haiku-4-5",
    privileged: "anthropic/claude-sonnet-4-6",
  },
  classificationRules: {
    simple: "speed",
    medium: "workhorse",
    complex: "flagship",
  },
  classifier: {
    mode: "heuristic",
    model: "anthropic/claude-haiku-4-5",
  },
  sensitivity: {
    privileged: { forceAlias: "privileged", blockExternal: true },
    confidential: { allowedProviders: ["anthropic"] },
    internal: { allowedProviders: ["anthropic", "google", "openai"] },
    public: { allowedProviders: "*" },
  },
  defaultSensitivity: "internal",
  escalationThreshold: 0.85,
  budgetCeilingUsdPerRequest: 0.05,
  logsDir: "",
};

function isStringRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function coerceStringMap(value: unknown): Record<string, string> | undefined {
  if (!isStringRecord(value)) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== "string") {
      return undefined;
    }
    out[k] = v;
  }
  return out;
}

function coerceClassifier(value: unknown): RouterConfig["classifier"] {
  if (!isStringRecord(value)) {
    return { ...ROUTER_DEFAULTS.classifier };
  }
  const mode = value.mode === "llm" ? "llm" : "heuristic";
  const model =
    typeof value.model === "string" && value.model.length > 0
      ? value.model
      : ROUTER_DEFAULTS.classifier.model;
  return { mode, model };
}

function coerceSensitivity(value: unknown): Record<string, SensitivityRule> {
  if (!isStringRecord(value)) {
    return { ...ROUTER_DEFAULTS.sensitivity };
  }
  const out: Record<string, SensitivityRule> = {};
  for (const [label, raw] of Object.entries(value)) {
    if (!isStringRecord(raw)) {
      continue;
    }
    const rule: SensitivityRule = {};
    if (typeof raw.forceAlias === "string") {
      rule.forceAlias = raw.forceAlias;
    }
    if (typeof raw.blockExternal === "boolean") {
      rule.blockExternal = raw.blockExternal;
    }
    if (raw.allowedProviders === "*") {
      rule.allowedProviders = "*";
    } else if (Array.isArray(raw.allowedProviders)) {
      const providers = raw.allowedProviders.filter((v): v is string => typeof v === "string");
      if (providers.length === raw.allowedProviders.length) {
        rule.allowedProviders = providers;
      }
    }
    out[label] = rule;
  }
  return out;
}

function coerceClassificationRules(value: unknown): Record<ClassifierTier, string> {
  const stringMap = coerceStringMap(value);
  if (!stringMap) {
    return { ...ROUTER_DEFAULTS.classificationRules };
  }
  const out: Record<ClassifierTier, string> = {
    ...ROUTER_DEFAULTS.classificationRules,
  };
  for (const tier of ["simple", "medium", "complex"] as const) {
    const alias = stringMap[tier];
    if (typeof alias === "string" && alias.length > 0) {
      out[tier] = alias;
    }
  }
  return out;
}

/**
 * Resolve the default logs directory. Kept as a function so tests can stub
 * `homedir` via dependency injection in callers.
 */
export function defaultLogsDir(homeDir: string): string {
  return `${homeDir}/.openclaw/logs/aj-router`;
}

export type ResolveConfigParams = {
  /** Raw value from `api.pluginConfig`. May be undefined/null. */
  raw: unknown;
  /** Home directory (to compute the default logs path). */
  homeDir: string;
};

/** Parse and default the router config. Never throws. */
export function resolveConfig(params: ResolveConfigParams): RouterConfig {
  const raw = isStringRecord(params.raw) ? params.raw : {};
  const aliases = coerceStringMap(raw.aliases) ?? { ...ROUTER_DEFAULTS.aliases };
  const classificationRules = coerceClassificationRules(raw.classificationRules);
  const classifier = coerceClassifier(raw.classifier);
  const sensitivity = coerceSensitivity(raw.sensitivity);
  const defaultAlias =
    typeof raw.defaultAlias === "string" && raw.defaultAlias.length > 0
      ? raw.defaultAlias
      : ROUTER_DEFAULTS.defaultAlias;
  const defaultSensitivity =
    typeof raw.defaultSensitivity === "string" && raw.defaultSensitivity.length > 0
      ? raw.defaultSensitivity
      : ROUTER_DEFAULTS.defaultSensitivity;
  const escalationThreshold =
    typeof raw.escalationThreshold === "number"
      ? raw.escalationThreshold
      : ROUTER_DEFAULTS.escalationThreshold;
  const budgetCeilingUsdPerRequest =
    typeof raw.budgetCeilingUsdPerRequest === "number"
      ? raw.budgetCeilingUsdPerRequest
      : ROUTER_DEFAULTS.budgetCeilingUsdPerRequest;
  const logsDir =
    typeof raw.logsDir === "string" && raw.logsDir.length > 0
      ? raw.logsDir
      : defaultLogsDir(params.homeDir);

  return {
    defaultAlias,
    aliases,
    classificationRules,
    classifier,
    sensitivity,
    defaultSensitivity,
    escalationThreshold,
    budgetCeilingUsdPerRequest,
    logsDir,
  };
}
