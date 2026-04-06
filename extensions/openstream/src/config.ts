export type StreamingMode = "standard" | "enhanced" | "ultra";
export type DoctorDefaultProvider = "ollama" | "openstream";

export type OpenStreamPluginConfig = {
  promptGuidance?: boolean;
  streamingMode?: StreamingMode;
  enableMegaContext?: boolean;
  maxContextWindow?: number;
  doctorDefaultProvider?: DoctorDefaultProvider;
};

export type ResolvedOpenStreamPluginConfig = Required<OpenStreamPluginConfig>;

export const DEFAULT_OPENSTREAM_PLUGIN_CONFIG: ResolvedOpenStreamPluginConfig = {
  promptGuidance: true,
  streamingMode: "enhanced",
  enableMegaContext: true,
  maxContextWindow: 262144,
  doctorDefaultProvider: "ollama",
};

const ALLOWED_STREAMING_MODES = new Set<StreamingMode>(["standard", "enhanced", "ultra"]);
const ALLOWED_DOCTOR_PROVIDERS = new Set<DoctorDefaultProvider>(["ollama", "openstream"]);

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : undefined;
}

function asStreamingMode(value: unknown): StreamingMode | undefined {
  return typeof value === "string" && ALLOWED_STREAMING_MODES.has(value as StreamingMode)
    ? (value as StreamingMode)
    : undefined;
}

function asDoctorDefaultProvider(value: unknown): DoctorDefaultProvider | undefined {
  return typeof value === "string" && ALLOWED_DOCTOR_PROVIDERS.has(value as DoctorDefaultProvider)
    ? (value as DoctorDefaultProvider)
    : undefined;
}

export function resolveOpenStreamPluginConfig(raw: unknown): ResolvedOpenStreamPluginConfig {
  const cfg = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const maxContextWindow = asInteger(cfg.maxContextWindow);
  return {
    promptGuidance:
      asBoolean(cfg.promptGuidance) ?? DEFAULT_OPENSTREAM_PLUGIN_CONFIG.promptGuidance,
    streamingMode:
      asStreamingMode(cfg.streamingMode) ?? DEFAULT_OPENSTREAM_PLUGIN_CONFIG.streamingMode,
    enableMegaContext:
      asBoolean(cfg.enableMegaContext) ?? DEFAULT_OPENSTREAM_PLUGIN_CONFIG.enableMegaContext,
    maxContextWindow:
      maxContextWindow && maxContextWindow >= 32768 && maxContextWindow <= 2097152
        ? maxContextWindow
        : DEFAULT_OPENSTREAM_PLUGIN_CONFIG.maxContextWindow,
    doctorDefaultProvider:
      asDoctorDefaultProvider(cfg.doctorDefaultProvider) ??
      DEFAULT_OPENSTREAM_PLUGIN_CONFIG.doctorDefaultProvider,
  };
}

export const openstreamPluginConfigSchema = {
  validate(value: unknown) {
    if (value == null) {
      return { ok: true as const, value: DEFAULT_OPENSTREAM_PLUGIN_CONFIG };
    }
    if (typeof value !== "object" || Array.isArray(value)) {
      return { ok: false as const, errors: ["openstream config must be an object"] };
    }
    const cfg = value as Record<string, unknown>;
    const errors: string[] = [];
    const allowed = new Set([
      "promptGuidance",
      "streamingMode",
      "enableMegaContext",
      "maxContextWindow",
      "doctorDefaultProvider",
    ]);
    for (const key of Object.keys(cfg)) {
      if (!allowed.has(key)) {
        errors.push(`unsupported key: ${key}`);
      }
    }
    if (cfg.promptGuidance != null && typeof cfg.promptGuidance !== "boolean") {
      errors.push("promptGuidance must be a boolean");
    }
    if (cfg.enableMegaContext != null && typeof cfg.enableMegaContext !== "boolean") {
      errors.push("enableMegaContext must be a boolean");
    }
    if (
      cfg.streamingMode != null &&
      (typeof cfg.streamingMode !== "string" ||
        !ALLOWED_STREAMING_MODES.has(cfg.streamingMode as StreamingMode))
    ) {
      errors.push("streamingMode must be one of: standard, enhanced, ultra");
    }
    if (
      cfg.doctorDefaultProvider != null &&
      (typeof cfg.doctorDefaultProvider !== "string" ||
        !ALLOWED_DOCTOR_PROVIDERS.has(cfg.doctorDefaultProvider as DoctorDefaultProvider))
    ) {
      errors.push("doctorDefaultProvider must be one of: ollama, openstream");
    }
    if (cfg.maxContextWindow != null) {
      const maxContextWindow = asInteger(cfg.maxContextWindow);
      if (
        maxContextWindow === undefined ||
        maxContextWindow < 32768 ||
        maxContextWindow > 2097152
      ) {
        errors.push("maxContextWindow must be an integer between 32768 and 2097152");
      }
    }
    return errors.length > 0
      ? { ok: false as const, errors }
      : { ok: true as const, value: resolveOpenStreamPluginConfig(cfg) };
  },
  jsonSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      promptGuidance: { type: "boolean" },
      streamingMode: { type: "string", enum: ["standard", "enhanced", "ultra"] },
      enableMegaContext: { type: "boolean" },
      maxContextWindow: { type: "integer", minimum: 32768, maximum: 2097152 },
      doctorDefaultProvider: { type: "string", enum: ["ollama", "openstream"] },
    },
  },
  uiHints: {
    promptGuidance: {
      label: "Prompt guidance",
      help: "Inject cached Ollama/tool-call recovery guidance into system prompt space.",
    },
    streamingMode: {
      label: "Streaming mode",
      help: "Doctor/sample-config preset that matches the intended OpenStream runtime behavior.",
    },
    enableMegaContext: {
      label: "Mega context",
      help: "Prefer larger context recommendations for model families that advertise long context.",
    },
    maxContextWindow: {
      label: "Max context window",
      help: "Upper bound used in generated recommendations and plugin guidance.",
      advanced: true,
    },
    doctorDefaultProvider: {
      label: "Default provider label",
      help: "Whether sample snippets default to the built-in Ollama provider or a future overlay provider.",
      advanced: true,
    },
  },
};
