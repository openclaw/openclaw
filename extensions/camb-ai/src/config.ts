import { z } from "zod";

/**
 * TTS model options for MARS models
 */
export const TtsModelSchema = z.enum(["mars-pro", "mars-flash", "mars-instruct", "auto"]);
export type TtsModel = z.infer<typeof TtsModelSchema>;

/**
 * TTS output format
 */
export const OutputFormatSchema = z.enum(["mp3", "wav"]);
export type OutputFormat = z.infer<typeof OutputFormatSchema>;

/**
 * TTS configuration
 */
export const TtsConfigSchema = z
  .object({
    /** MARS model to use */
    model: TtsModelSchema.default("mars-flash"),
    /** Default language for TTS (e.g., "en-us", "es-es") */
    defaultLanguage: z.string().default("en-us"),
    /** Default voice ID for TTS */
    defaultVoiceId: z.number().int().positive().optional(),
    /** Output audio format */
    outputFormat: OutputFormatSchema.default("mp3"),
  })
  .strict()
  .default({
    model: "mars-flash",
    defaultLanguage: "en-us",
    outputFormat: "mp3",
  });
export type TtsConfig = z.infer<typeof TtsConfigSchema>;

/**
 * Voice cloning configuration (opt-in for safety)
 */
export const VoiceCloningConfigSchema = z
  .object({
    /** Enable voice cloning capabilities */
    enabled: z.boolean().default(false),
  })
  .strict()
  .default({ enabled: false });
export type VoiceCloningConfig = z.infer<typeof VoiceCloningConfigSchema>;

/**
 * Sound generation configuration
 */
export const SoundGenerationConfigSchema = z
  .object({
    /** Enable sound/music generation */
    enabled: z.boolean().default(true),
  })
  .strict()
  .default({ enabled: true });
export type SoundGenerationConfig = z.infer<typeof SoundGenerationConfigSchema>;

/**
 * Main Camb AI plugin configuration
 */
export const CambAiConfigSchema = z
  .object({
    /** Enable Camb AI plugin */
    enabled: z.boolean().default(true),

    /** Camb AI API key (or use CAMB_API_KEY env var) */
    apiKey: z.string().optional(),

    /** TTS configuration */
    tts: TtsConfigSchema,

    /** Voice cloning configuration */
    voiceCloning: VoiceCloningConfigSchema,

    /** Sound generation configuration */
    soundGeneration: SoundGenerationConfigSchema,

    /** Polling interval for async task status checks (ms) */
    pollingIntervalMs: z.number().int().min(500).default(2000),

    /** Polling timeout for async task completion (ms) */
    pollingTimeoutMs: z.number().int().min(5000).default(120000),
  })
  .strict();

export type CambAiConfig = z.infer<typeof CambAiConfigSchema>;

/**
 * Resolve configuration with environment variable fallbacks
 */
export function resolveCambAiConfig(config: CambAiConfig): CambAiConfig {
  const resolved = { ...config };
  resolved.apiKey = resolved.apiKey ?? process.env.CAMB_API_KEY;
  return resolved;
}

/**
 * Validate configuration
 */
export function validateCambAiConfig(config: CambAiConfig): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (!config.enabled) {
    return { valid: true, errors: [] };
  }

  if (!config.apiKey) {
    errors.push("plugins.entries.camb-ai.config.apiKey is required (or set CAMB_API_KEY env var)");
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Language codes supported by Camb AI
 * Common subset - full list available via the languages API
 */
export const COMMON_LANGUAGES = [
  "en-us",
  "en-uk",
  "es-es",
  "es-mx",
  "fr-fr",
  "de-de",
  "it-it",
  "pt-br",
  "pt-pt",
  "zh-cn",
  "zh-tw",
  "ja-jp",
  "ko-kr",
  "ar-sa",
  "hi-in",
  "ru-ru",
  "nl-nl",
  "pl-pl",
  "tr-tr",
  "vi-vn",
] as const;
