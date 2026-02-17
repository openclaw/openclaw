import type { FogClawConfig, GuardrailAction, RedactStrategy } from "./types.js";

const VALID_GUARDRAIL_MODES: GuardrailAction[] = ["redact", "block", "warn"];
const VALID_REDACT_STRATEGIES: RedactStrategy[] = ["token", "mask", "hash"];

export const DEFAULT_CONFIG: FogClawConfig = {
  enabled: true,
  guardrail_mode: "redact",
  redactStrategy: "token",
  model: "onnx-community/gliner_large-v2.1",
  confidence_threshold: 0.5,
  custom_entities: [],
  entityActions: {},
};

export function loadConfig(overrides: Partial<FogClawConfig>): FogClawConfig {
  const config: FogClawConfig = { ...DEFAULT_CONFIG, ...overrides };

  if (!VALID_GUARDRAIL_MODES.includes(config.guardrail_mode)) {
    throw new Error(
      `Invalid guardrail_mode "${config.guardrail_mode}". Must be one of: ${VALID_GUARDRAIL_MODES.join(", ")}`,
    );
  }

  if (!VALID_REDACT_STRATEGIES.includes(config.redactStrategy)) {
    throw new Error(
      `Invalid redactStrategy "${config.redactStrategy}". Must be one of: ${VALID_REDACT_STRATEGIES.join(", ")}`,
    );
  }

  if (config.confidence_threshold < 0 || config.confidence_threshold > 1) {
    throw new Error(
      `confidence_threshold must be between 0 and 1, got ${config.confidence_threshold}`,
    );
  }

  for (const [entityType, action] of Object.entries(config.entityActions)) {
    if (!VALID_GUARDRAIL_MODES.includes(action)) {
      throw new Error(
        `Invalid action "${action}" for entity type "${entityType}". Must be one of: ${VALID_GUARDRAIL_MODES.join(", ")}`,
      );
    }
  }

  return config;
}
