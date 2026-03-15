import type { OpenClawPluginConfigSchema } from "openclaw/plugin-sdk/structured-context";

export const CONTEXT_PRESERVE_TYPES = [
  "user_instruction",
  "assistant_decision",
  "constraint",
  "pending_user_ask",
  "artifact_reference",
  "error",
] as const;

export type ContextPreserveType = (typeof CONTEXT_PRESERVE_TYPES)[number];

export const OVERSIZED_TOOL_OUTPUT_POLICIES = ["artifact_ref", "truncate"] as const;

export type OversizedToolOutputPolicy = (typeof OVERSIZED_TOOL_OUTPUT_POLICIES)[number];

export type Layer0ContextConfig = {
  enabled: boolean;
  recentTurns: number;
  preserveTypes: ContextPreserveType[];
  qualityGuardEnabled: boolean;
  qualityGuardMaxRetries: number;
  oversizedToolOutputPolicy: OversizedToolOutputPolicy;
};

export type StructuredContextPluginConfig = {
  context: Layer0ContextConfig;
};

const DEFAULT_CONTEXT_CONFIG: Layer0ContextConfig = {
  enabled: true,
  recentTurns: 5,
  preserveTypes: [...CONTEXT_PRESERVE_TYPES] as ContextPreserveType[],
  qualityGuardEnabled: true,
  qualityGuardMaxRetries: 1,
  oversizedToolOutputPolicy: "artifact_ref",
};

export const DEFAULT_STRUCTURED_CONTEXT_PLUGIN_CONFIG: StructuredContextPluginConfig = {
  context: DEFAULT_CONTEXT_CONFIG,
};

type ParseResult =
  | { ok: true; value: StructuredContextPluginConfig }
  | { ok: false; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isPreserveType(value: string): value is ContextPreserveType {
  return CONTEXT_PRESERVE_TYPES.includes(value as ContextPreserveType);
}

function isOversizedPolicy(value: string): value is OversizedToolOutputPolicy {
  return OVERSIZED_TOOL_OUTPUT_POLICIES.includes(value as OversizedToolOutputPolicy);
}

function normalizePreserveTypes(value: unknown): ContextPreserveType[] {
  if (!Array.isArray(value)) {
    return [...DEFAULT_CONTEXT_CONFIG.preserveTypes];
  }

  const normalized = value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(
      (entry): entry is ContextPreserveType => typeof entry === "string" && isPreserveType(entry),
    );

  return normalized.length > 0 ? normalized : [...DEFAULT_CONTEXT_CONFIG.preserveTypes];
}

function parseContextConfig(value: unknown): ParseResult {
  if (value === undefined) {
    return {
      ok: true,
      value: {
        context: { ...DEFAULT_CONTEXT_CONFIG },
      },
    };
  }

  if (!isRecord(value)) {
    return { ok: false, message: "expected config object" };
  }

  const allowedTopLevel = new Set(["context"]);
  for (const key of Object.keys(value)) {
    if (!allowedTopLevel.has(key)) {
      return { ok: false, message: `unknown config key: ${key}` };
    }
  }

  const rawContext = value.context;
  if (rawContext !== undefined && !isRecord(rawContext)) {
    return { ok: false, message: "context must be an object" };
  }

  const contextRecord = (rawContext ?? {}) as Record<string, unknown>;
  const allowedContextKeys = new Set([
    "enabled",
    "recentTurns",
    "preserveTypes",
    "qualityGuardEnabled",
    "qualityGuardMaxRetries",
    "oversizedToolOutputPolicy",
  ]);

  for (const key of Object.keys(contextRecord)) {
    if (!allowedContextKeys.has(key)) {
      return { ok: false, message: `unknown context config key: ${key}` };
    }
  }

  const enabled = contextRecord.enabled;
  if (enabled !== undefined && typeof enabled !== "boolean") {
    return { ok: false, message: "context.enabled must be a boolean" };
  }

  const recentTurns = contextRecord.recentTurns;
  if (
    recentTurns !== undefined &&
    (typeof recentTurns !== "number" ||
      !Number.isInteger(recentTurns) ||
      recentTurns < 1 ||
      recentTurns > 200)
  ) {
    return { ok: false, message: "context.recentTurns must be an integer between 1 and 200" };
  }

  const qualityGuardEnabled = contextRecord.qualityGuardEnabled;
  if (qualityGuardEnabled !== undefined && typeof qualityGuardEnabled !== "boolean") {
    return { ok: false, message: "context.qualityGuardEnabled must be a boolean" };
  }

  const qualityGuardMaxRetries = contextRecord.qualityGuardMaxRetries;
  if (
    qualityGuardMaxRetries !== undefined &&
    (typeof qualityGuardMaxRetries !== "number" ||
      !Number.isInteger(qualityGuardMaxRetries) ||
      qualityGuardMaxRetries < 0 ||
      qualityGuardMaxRetries > 3)
  ) {
    return {
      ok: false,
      message: "context.qualityGuardMaxRetries must be an integer between 0 and 3",
    };
  }

  const oversizedToolOutputPolicy = contextRecord.oversizedToolOutputPolicy;
  if (
    oversizedToolOutputPolicy !== undefined &&
    (typeof oversizedToolOutputPolicy !== "string" || !isOversizedPolicy(oversizedToolOutputPolicy))
  ) {
    return {
      ok: false,
      message: `context.oversizedToolOutputPolicy must be one of: ${OVERSIZED_TOOL_OUTPUT_POLICIES.join(", ")}`,
    };
  }

  return {
    ok: true,
    value: {
      context: {
        enabled: typeof enabled === "boolean" ? enabled : DEFAULT_CONTEXT_CONFIG.enabled,
        recentTurns:
          typeof recentTurns === "number" ? recentTurns : DEFAULT_CONTEXT_CONFIG.recentTurns,
        preserveTypes: normalizePreserveTypes(contextRecord.preserveTypes),
        qualityGuardEnabled:
          typeof qualityGuardEnabled === "boolean"
            ? qualityGuardEnabled
            : DEFAULT_CONTEXT_CONFIG.qualityGuardEnabled,
        qualityGuardMaxRetries:
          typeof qualityGuardMaxRetries === "number"
            ? qualityGuardMaxRetries
            : DEFAULT_CONTEXT_CONFIG.qualityGuardMaxRetries,
        oversizedToolOutputPolicy:
          typeof oversizedToolOutputPolicy === "string" &&
          isOversizedPolicy(oversizedToolOutputPolicy)
            ? oversizedToolOutputPolicy
            : DEFAULT_CONTEXT_CONFIG.oversizedToolOutputPolicy,
      },
    },
  };
}

export function createStructuredContextConfigSchema(): OpenClawPluginConfigSchema {
  return {
    safeParse(value: unknown) {
      const parsed = parseContextConfig(value);
      if (parsed.ok) {
        return { success: true, data: parsed.value };
      }
      return {
        success: false,
        error: {
          issues: [{ path: [], message: parsed.message }],
        },
      };
    },
    jsonSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        context: {
          type: "object",
          additionalProperties: false,
          properties: {
            enabled: { type: "boolean", default: DEFAULT_CONTEXT_CONFIG.enabled },
            recentTurns: {
              type: "number",
              minimum: 1,
              maximum: 200,
              default: DEFAULT_CONTEXT_CONFIG.recentTurns,
            },
            preserveTypes: {
              type: "array",
              items: {
                type: "string",
                enum: [...CONTEXT_PRESERVE_TYPES],
              },
              default: [...DEFAULT_CONTEXT_CONFIG.preserveTypes],
            },
            qualityGuardEnabled: {
              type: "boolean",
              default: DEFAULT_CONTEXT_CONFIG.qualityGuardEnabled,
            },
            qualityGuardMaxRetries: {
              type: "number",
              minimum: 0,
              maximum: 3,
              default: DEFAULT_CONTEXT_CONFIG.qualityGuardMaxRetries,
            },
            oversizedToolOutputPolicy: {
              type: "string",
              enum: [...OVERSIZED_TOOL_OUTPUT_POLICIES],
              default: DEFAULT_CONTEXT_CONFIG.oversizedToolOutputPolicy,
            },
          },
        },
      },
    },
  };
}

export function resolveStructuredContextConfig(rawConfig: unknown): StructuredContextPluginConfig {
  const parsed = parseContextConfig(rawConfig);
  if (!parsed.ok) {
    throw new Error(parsed.message);
  }
  return parsed.value;
}
