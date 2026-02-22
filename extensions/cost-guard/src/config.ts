/**
 * Cost Guard configuration schema and types.
 *
 * Validates user-supplied plugin config with sensible defaults.
 * Follows the same parse() / uiHints pattern as memory-lancedb.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProviderLimit = {
  dailyUsd?: number;
  monthlyUsd?: number;
};

export type CostGuardConfig = {
  /** Daily budget in USD (default: 5.0) */
  dailyBudgetUsd: number;
  /** Monthly budget in USD (default: 50.0) */
  monthlyBudgetUsd: number;
  /** Warning threshold as fraction of budget, 0–1 (default: 0.8 = 80%) */
  warningThreshold: number;
  /** Block responses when budget exceeded (default: true) */
  hardStop: boolean;
  /** Optional per-provider budget overrides */
  providerLimits: Record<string, ProviderLimit>;
};

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_DAILY_BUDGET_USD = 5.0;
const DEFAULT_MONTHLY_BUDGET_USD = 50.0;
const DEFAULT_WARNING_THRESHOLD = 0.8;
const DEFAULT_HARD_STOP = true;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ALLOWED_ROOT_KEYS = new Set([
  "dailyBudgetUsd",
  "monthlyBudgetUsd",
  "warningThreshold",
  "hardStop",
  "providerLimits",
]);

const ALLOWED_PROVIDER_KEYS = new Set(["dailyUsd", "monthlyUsd"]);

function assertAllowedKeys(
  obj: Record<string, unknown>,
  allowed: Set<string>,
  label: string,
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new Error(`${label}: unexpected key "${key}"`);
    }
  }
}

function asPositiveNumber(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return value;
}

function parseProviderLimits(raw: unknown): Record<string, ProviderLimit> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const result: Record<string, ProviderLimit> = {};
  for (const [provider, limits] of Object.entries(raw as Record<string, unknown>)) {
    if (!limits || typeof limits !== "object" || Array.isArray(limits)) {
      continue;
    }
    const limitsObj = limits as Record<string, unknown>;
    assertAllowedKeys(limitsObj, ALLOWED_PROVIDER_KEYS, `providerLimits.${provider}`);
    result[provider] = {
      dailyUsd:
        typeof limitsObj.dailyUsd === "number"
          ? asPositiveNumber(limitsObj.dailyUsd, 0)
          : undefined,
      monthlyUsd:
        typeof limitsObj.monthlyUsd === "number"
          ? asPositiveNumber(limitsObj.monthlyUsd, 0)
          : undefined,
    };
  }
  return result;
}

// ---------------------------------------------------------------------------
// Schema (parse + uiHints)
// ---------------------------------------------------------------------------

export const costGuardConfigSchema = {
  parse(value: unknown): CostGuardConfig {
    if (value === undefined || value === null) {
      return {
        dailyBudgetUsd: DEFAULT_DAILY_BUDGET_USD,
        monthlyBudgetUsd: DEFAULT_MONTHLY_BUDGET_USD,
        warningThreshold: DEFAULT_WARNING_THRESHOLD,
        hardStop: DEFAULT_HARD_STOP,
        providerLimits: {},
      };
    }

    if (typeof value !== "object" || Array.isArray(value)) {
      throw new Error("cost-guard config must be an object");
    }

    const cfg = value as Record<string, unknown>;
    assertAllowedKeys(cfg, ALLOWED_ROOT_KEYS, "cost-guard config");

    const warningRaw = asPositiveNumber(cfg.warningThreshold, DEFAULT_WARNING_THRESHOLD);
    const warningThreshold = Math.min(warningRaw, 1);

    return {
      dailyBudgetUsd: asPositiveNumber(cfg.dailyBudgetUsd, DEFAULT_DAILY_BUDGET_USD),
      monthlyBudgetUsd: asPositiveNumber(cfg.monthlyBudgetUsd, DEFAULT_MONTHLY_BUDGET_USD),
      warningThreshold,
      hardStop: typeof cfg.hardStop === "boolean" ? cfg.hardStop : DEFAULT_HARD_STOP,
      providerLimits: parseProviderLimits(cfg.providerLimits),
    };
  },

  uiHints: {
    dailyBudgetUsd: {
      label: "Daily Budget (USD)",
      placeholder: String(DEFAULT_DAILY_BUDGET_USD),
      help: "Maximum daily API spend in USD. Agent responses are blocked when exceeded.",
    },
    monthlyBudgetUsd: {
      label: "Monthly Budget (USD)",
      placeholder: String(DEFAULT_MONTHLY_BUDGET_USD),
      help: "Maximum monthly API spend in USD.",
    },
    warningThreshold: {
      label: "Warning Threshold",
      placeholder: String(DEFAULT_WARNING_THRESHOLD),
      help: "Fraction of budget (0–1) at which a warning is injected into agent context.",
      advanced: true,
    },
    hardStop: {
      label: "Hard Stop",
      help: "When enabled, responses are blocked once the budget is exceeded.",
    },
    providerLimits: {
      label: "Per-Provider Limits",
      help: 'Optional per-provider budget overrides, e.g. { "anthropic": { "dailyUsd": 3 } }.',
      advanced: true,
    },
  },

  jsonSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      dailyBudgetUsd: { type: "number", minimum: 0 },
      monthlyBudgetUsd: { type: "number", minimum: 0 },
      warningThreshold: { type: "number", minimum: 0, maximum: 1 },
      hardStop: { type: "boolean" },
      providerLimits: {
        type: "object",
        additionalProperties: {
          type: "object",
          properties: {
            dailyUsd: { type: "number", minimum: 0 },
            monthlyUsd: { type: "number", minimum: 0 },
          },
          additionalProperties: false,
        },
      },
    },
  },
};
