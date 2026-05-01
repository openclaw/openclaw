import type { OpenClawPluginConfigSchema } from "openclaw/plugin-sdk/plugin-entry";

export const configSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    enabled: { type: "boolean", default: true },
    classification: {
      type: "object",
      additionalProperties: false,
      properties: {
        model: {
          type: "string",
          description:
            "Provider/model for write-time classification. Falls back to agent primary model.",
        },
        timeoutMs: {
          type: "integer",
          minimum: 250,
          maximum: 30000,
          default: 5000,
        },
      },
    },
    decay: {
      type: "object",
      additionalProperties: false,
      properties: {
        halfLifeDays: { type: "number", minimum: 1, maximum: 365, default: 14 },
        minMaintenanceScore: { type: "number", minimum: 0, maximum: 1, default: 0.1 },
      },
    },
    recall: {
      type: "object",
      additionalProperties: false,
      properties: {
        maxResults: { type: "integer", minimum: 1, maximum: 50, default: 15 },
      },
    },
  },
} satisfies OpenClawPluginConfigSchema;

export interface ResolvedStructuredMemoryConfig {
  enabled: boolean;
  classification: {
    model: string | undefined;
    timeoutMs: number;
  };
  decay: {
    halfLifeDays: number;
    minMaintenanceScore: number;
  };
  recall: {
    maxResults: number;
  };
  // Phase 1: RFC-defined domain default confidence
  domainDefaults: {
    personal: number;
    work: number;
    health: number;
    legal: number;
    fallback: number;
  };
}

const DEFAULT_CLASSIFICATION_TIMEOUT_MS = 5000;
const DEFAULT_HALF_LIFE_DAYS = 14;
const DEFAULT_MIN_MAINTENANCE_SCORE = 0.1;
const DEFAULT_MAX_RESULTS = 15;

// RFC-defined domain default confidence values
const DOMAIN_DEFAULT_CONFIDENCE: ResolvedStructuredMemoryConfig["domainDefaults"] = {
  personal: 0.5,
  work: 0.3,
  health: 0.1,
  legal: 0.1,
  // RFC: global fallback is 0.3, not 0.5
  fallback: 0.3,
};

export function getDomainDefaultConfidence(
  attributes?: string,
): number {
  if (!attributes) return DOMAIN_DEFAULT_CONFIDENCE.fallback;
  try {
    const parsed = JSON.parse(attributes) as Record<string, unknown>;
    if (Array.isArray(parsed.domains)) {
      for (const domain of parsed.domains) {
        if (typeof domain === "string") {
          const key = domain.toLowerCase() as keyof typeof DOMAIN_DEFAULT_CONFIDENCE;
          if (key in DOMAIN_DEFAULT_CONFIDENCE) {
            return DOMAIN_DEFAULT_CONFIDENCE[key];
          }
        }
      }
    }
  } catch {
    // fall through
  }
  return DOMAIN_DEFAULT_CONFIDENCE.fallback;
}

export function resolveStructuredMemoryConfig(raw: unknown): ResolvedStructuredMemoryConfig {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const classification = (obj.classification ?? {}) as Record<string, unknown>;
  const decay = (obj.decay ?? {}) as Record<string, unknown>;
  const recall = (obj.recall ?? {}) as Record<string, unknown>;

  return {
    enabled: typeof obj.enabled === "boolean" ? obj.enabled : true,
    classification: {
      model: typeof classification.model === "string" ? classification.model : undefined,
      timeoutMs:
        typeof classification.timeoutMs === "number" && classification.timeoutMs >= 250
          ? classification.timeoutMs
          : DEFAULT_CLASSIFICATION_TIMEOUT_MS,
    },
    decay: {
      halfLifeDays:
        typeof decay.halfLifeDays === "number" && decay.halfLifeDays >= 1
          ? decay.halfLifeDays
          : DEFAULT_HALF_LIFE_DAYS,
      minMaintenanceScore:
        typeof decay.minMaintenanceScore === "number"
          ? decay.minMaintenanceScore
          : DEFAULT_MIN_MAINTENANCE_SCORE,
    },
    recall: {
      maxResults:
        typeof recall.maxResults === "number" && recall.maxResults >= 1
          ? recall.maxResults
          : DEFAULT_MAX_RESULTS,
    },
    domainDefaults: DOMAIN_DEFAULT_CONFIDENCE,
  };
}
