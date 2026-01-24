/**
 * telegram-tts - Automatic TTS for chat responses
 *
 * Self-contained TTS extension that calls ElevenLabs/OpenAI APIs directly.
 * No external CLI dependencies.
 *
 * Features:
 * - speak tool for programmatic TTS
 * - Multi-provider support (ElevenLabs, OpenAI)
 * - RPC methods for status and control
 *
 * Note: Slash commands (/tts_on, /tts_off, /audio) should be configured
 * via Telegram customCommands and handled by the agent workspace.
 */

import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { PluginApi } from "clawdbot";

const PLUGIN_ID = "telegram-tts";
const DEFAULT_TIMEOUT_MS = 30000;
const TEMP_FILE_CLEANUP_DELAY_MS = 5 * 60 * 1000; // 5 minutes

// =============================================================================
// Types
// =============================================================================

interface TtsConfig {
  enabled?: boolean;
  provider?: "elevenlabs" | "openai";
  elevenlabs?: {
    apiKey?: string;
    voiceId?: string;
    modelId?: string;
  };
  openai?: {
    apiKey?: string;
    model?: string;
    voice?: string;
  };
  prefsPath?: string;
  maxTextLength?: number;
  timeoutMs?: number;
}

interface UserPreferences {
  tts?: {
    enabled?: boolean;
    provider?: "openai" | "elevenlabs";
  };
}

interface TtsResult {
  success: boolean;
  audioPath?: string;
  error?: string;
}

// =============================================================================
// Validation
// =============================================================================

/**
 * Validates ElevenLabs voiceId format to prevent URL injection.
 * Voice IDs are alphanumeric strings, typically 20 characters.
 */
function isValidVoiceId(voiceId: string): boolean {
  return /^[a-zA-Z0-9]{10,40}$/.test(voiceId);
}

/**
 * Validates OpenAI voice name.
 */
function isValidOpenAIVoice(voice: string): boolean {
  const validVoices = ["alloy", "ash", "coral", "echo", "fable", "onyx", "nova", "sage", "shimmer"];
  return validVoices.includes(voice);
}

/**
 * Available OpenAI TTS models.
 */
const OPENAI_TTS_MODELS = [
  "gpt-4o-mini-tts",
  "tts-1",
  "tts-1-hd",
];

/**
 * Validates OpenAI TTS model name.
 */
function isValidOpenAIModel(model: string): boolean {
  return OPENAI_TTS_MODELS.includes(model) || model.startsWith("gpt-4o-mini-tts-");
}

// =============================================================================
// Configuration & Preferences
// =============================================================================

function getPrefsPath(config: TtsConfig): string {
  return (
    config.prefsPath ||
    process.env.CLAWDBOT_TTS_PREFS ||
    join(process.env.HOME || "/home/dev", "clawd", ".user-preferences.json")
  );
}

function isTtsEnabled(prefsPath: string): boolean {
  try {
    if (!existsSync(prefsPath)) return false;
    const prefs: UserPreferences = JSON.parse(readFileSync(prefsPath, "utf8"));
    return prefs?.tts?.enabled === true;
  } catch {
    return false;
  }
}

function setTtsEnabled(prefsPath: string, enabled: boolean): void {
  let prefs: UserPreferences = {};
  try {
    if (existsSync(prefsPath)) {
      prefs = JSON.parse(readFileSync(prefsPath, "utf8"));
    }
  } catch {
    // ignore
  }
  prefs.tts = { ...prefs.tts, enabled };
  writeFileSync(prefsPath, JSON.stringify(prefs, null, 2));
}

function getTtsProvider(prefsPath: string): "openai" | "elevenlabs" | undefined {
  try {
    if (!existsSync(prefsPath)) return undefined;
    const prefs: UserPreferences = JSON.parse(readFileSync(prefsPath, "utf8"));
    return prefs?.tts?.provider;
  } catch {
    return undefined;
  }
}

function setTtsProvider(prefsPath: string, provider: "openai" | "elevenlabs"): void {
  let prefs: UserPreferences = {};
  try {
    if (existsSync(prefsPath)) {
      prefs = JSON.parse(readFileSync(prefsPath, "utf8"));
    }
  } catch {
    // ignore
  }
  prefs.tts = { ...prefs.tts, provider };
  writeFileSync(prefsPath, JSON.stringify(prefs, null, 2));
}

function getApiKey(config: TtsConfig, provider: string): string | undefined {
  if (provider === "elevenlabs") {
    return (
      config.elevenlabs?.apiKey ||
      process.env.ELEVENLABS_API_KEY ||
      process.env.XI_API_KEY
    );
  }
  if (provider === "openai") {
    return config.openai?.apiKey || process.env.OPENAI_API_KEY;
  }
  return undefined;
}

// =============================================================================
// Temp File Cleanup
// =============================================================================

/**
 * Schedules cleanup of a temp directory after a delay.
 * This ensures the file is consumed before deletion.
 */
function scheduleCleanup(tempDir: string, delayMs: number = TEMP_FILE_CLEANUP_DELAY_MS): void {
  setTimeout(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }, delayMs);
}

// =============================================================================
// TTS Providers
// =============================================================================

async function elevenLabsTTS(
  text: string,
  apiKey: string,
  voiceId: string = "pMsXgVXv3BLzUgSXRplE",
  modelId: string = "eleven_multilingual_v2",
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<Buffer> {
  // Validate voiceId to prevent URL injection
  if (!isValidVoiceId(voiceId)) {
    throw new Error(`Invalid voiceId format`);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text,
          model_id: modelId,
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
            style: 0.0,
            use_speaker_boost: true,
          },
        }),
        signal: controller.signal,
      }
    );

    if (!response.ok) {
      // Don't leak API error details to users
      throw new Error(`ElevenLabs API error (${response.status})`);
    }

    return Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timeout);
  }
}

async function openaiTTS(
  text: string,
  apiKey: string,
  model: string = "gpt-4o-mini-tts",
  voice: string = "alloy",
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<Buffer> {
  // Validate model
  if (!isValidOpenAIModel(model)) {
    throw new Error(`Invalid model: ${model}`);
  }
  // Validate voice
  if (!isValidOpenAIVoice(voice)) {
    throw new Error(`Invalid voice: ${voice}`);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: text,
        voice,
        response_format: "mp3",
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      // Don't leak API error details to users
      throw new Error(`OpenAI TTS API error (${response.status})`);
    }

    return Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timeout);
  }
}

// =============================================================================
// Core TTS Function
// =============================================================================

async function textToSpeech(text: string, config: TtsConfig, prefsPath?: string): Promise<TtsResult> {
  // Get user's preferred provider (from prefs) or fall back to config
  const userProvider = prefsPath ? getTtsProvider(prefsPath) : undefined;
  const primaryProvider = userProvider || config.provider || "openai";
  const fallbackProvider = primaryProvider === "openai" ? "elevenlabs" : "openai";
  const timeoutMs = config.timeoutMs || DEFAULT_TIMEOUT_MS;

  const maxLen = config.maxTextLength || 4000;
  if (text.length > maxLen) {
    return {
      success: false,
      error: `Text too long (${text.length} chars, max ${maxLen})`,
    };
  }

  // Try primary provider first, then fallback
  const providers = [primaryProvider, fallbackProvider];
  let lastError: string | undefined;

  for (const provider of providers) {
    const apiKey = getApiKey(config, provider);
    if (!apiKey) {
      lastError = `No API key for ${provider}`;
      continue;
    }

    try {
      let audioBuffer: Buffer;

      if (provider === "elevenlabs") {
        audioBuffer = await elevenLabsTTS(
          text,
          apiKey,
          config.elevenlabs?.voiceId,
          config.elevenlabs?.modelId,
          timeoutMs
        );
      } else if (provider === "openai") {
        audioBuffer = await openaiTTS(
          text,
          apiKey,
          config.openai?.model || "gpt-4o-mini-tts",
          config.openai?.voice,
          timeoutMs
        );
      } else {
        lastError = `Unknown provider: ${provider}`;
        continue;
      }

      // Save to temp file
      const tempDir = mkdtempSync(join(tmpdir(), "tts-"));
      const audioPath = join(tempDir, `voice-${Date.now()}.mp3`);
      writeFileSync(audioPath, audioBuffer);

      // Schedule cleanup after delay (file should be consumed by then)
      scheduleCleanup(tempDir);

      return { success: true, audioPath };
    } catch (err) {
      const error = err as Error;
      if (error.name === "AbortError") {
        lastError = `${provider}: request timed out`;
      } else {
        lastError = `${provider}: ${error.message}`;
      }
      // Continue to try fallback provider
    }
  }

  return {
    success: false,
    error: `TTS conversion failed: ${lastError || "no providers available"}`,
  };
}

// =============================================================================
// Plugin Registration
// =============================================================================

export default function register(api: PluginApi) {
  const log = api.logger;
  const config: TtsConfig = {
    enabled: false,
    provider: "elevenlabs",
    maxTextLength: 4000,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    ...(api.pluginConfig || {}),
  };
  const prefsPath = getPrefsPath(config);

  log.info(`[${PLUGIN_ID}] Registering plugin...`);
  log.info(`[${PLUGIN_ID}] Provider: ${config.provider}`);
  log.info(`[${PLUGIN_ID}] Preferences: ${prefsPath}`);

  // ===========================================================================
  // Tool: speak
  // ===========================================================================
  api.registerTool({
    name: "speak",
    description: `Convert text to speech and generate voice message.
Use this tool when TTS mode is enabled or user requests audio.

IMPORTANT: After calling this tool, you MUST output the result exactly as returned.
The tool returns "MEDIA:/path/to/audio.mp3" - copy this EXACTLY to your response.
This MEDIA: directive tells the system to send the audio file.

Example flow:
1. User asks a question with TTS enabled
2. You call speak({text: "Your answer here"})
3. Tool returns: MEDIA:/tmp/tts-xxx/voice-123.mp3
4. You output: MEDIA:/tmp/tts-xxx/voice-123.mp3

Do NOT add extra text around the MEDIA directive.`,
    parameters: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "The text to convert to speech",
        },
      },
      required: ["text"],
    },
    execute: async (_id: string, params: { text?: unknown }) => {
      // Validate text parameter
      if (typeof params?.text !== "string" || params.text.length === 0) {
        return { content: [{ type: "text", text: "Error: Invalid or missing text parameter" }] };
      }

      const text = params.text;
      log.info(`[${PLUGIN_ID}] speak() called, length: ${text.length}`);

      const result = await textToSpeech(text, config, prefsPath);

      if (result.success && result.audioPath) {
        log.info(`[${PLUGIN_ID}] Audio generated: ${result.audioPath}`);
        // Return with MEDIA directive for clawdbot to send
        return {
          content: [
            {
              type: "text",
              text: `MEDIA:${result.audioPath}`,
            },
          ],
        };
      }

      log.error(`[${PLUGIN_ID}] TTS failed: ${result.error}`);
      return {
        content: [
          {
            type: "text",
            text: result.error || "TTS conversion failed",
          },
        ],
      };
    },
  });

  // ===========================================================================
  // RPC Methods
  // ===========================================================================

  // tts.status - Check if TTS is enabled
  api.registerGatewayMethod("tts.status", async () => {
    const userProvider = getTtsProvider(prefsPath);
    const activeProvider = userProvider || config.provider || "openai";
    return {
      enabled: isTtsEnabled(prefsPath),
      provider: activeProvider,
      fallbackProvider: activeProvider === "openai" ? "elevenlabs" : "openai",
      prefsPath,
      hasOpenAIKey: !!getApiKey(config, "openai"),
      hasElevenLabsKey: !!getApiKey(config, "elevenlabs"),
    };
  });

  // tts.enable - Enable TTS mode
  api.registerGatewayMethod("tts.enable", async () => {
    setTtsEnabled(prefsPath, true);
    log.info(`[${PLUGIN_ID}] TTS enabled via RPC`);
    return { ok: true, enabled: true };
  });

  // tts.disable - Disable TTS mode
  api.registerGatewayMethod("tts.disable", async () => {
    setTtsEnabled(prefsPath, false);
    log.info(`[${PLUGIN_ID}] TTS disabled via RPC`);
    return { ok: true, enabled: false };
  });

  // tts.convert - Convert text to audio (returns path)
  api.registerGatewayMethod("tts.convert", async (params: { text?: unknown }) => {
    // Validate text parameter
    if (typeof params?.text !== "string" || params.text.length === 0) {
      return { ok: false, error: "Invalid or missing 'text' parameter" };
    }
    const result = await textToSpeech(params.text, config, prefsPath);
    if (result.success) {
      return { ok: true, audioPath: result.audioPath };
    }
    return { ok: false, error: result.error };
  });

  // tts.setProvider - Set primary TTS provider
  api.registerGatewayMethod("tts.setProvider", async (params: { provider?: unknown }) => {
    if (params?.provider !== "openai" && params?.provider !== "elevenlabs") {
      return { ok: false, error: "Invalid provider. Use 'openai' or 'elevenlabs'" };
    }
    setTtsProvider(prefsPath, params.provider);
    log.info(`[${PLUGIN_ID}] Provider set to ${params.provider} via RPC`);
    return { ok: true, provider: params.provider };
  });

  // tts.providers - List available providers and their status
  api.registerGatewayMethod("tts.providers", async () => {
    const userProvider = getTtsProvider(prefsPath);
    return {
      providers: [
        {
          id: "openai",
          name: "OpenAI",
          configured: !!getApiKey(config, "openai"),
          models: ["gpt-4o-mini-tts", "tts-1", "tts-1-hd"],
          voices: ["alloy", "ash", "coral", "echo", "fable", "onyx", "nova", "sage", "shimmer"],
        },
        {
          id: "elevenlabs",
          name: "ElevenLabs",
          configured: !!getApiKey(config, "elevenlabs"),
          models: ["eleven_multilingual_v2", "eleven_turbo_v2_5", "eleven_monolingual_v1"],
        },
      ],
      active: userProvider || config.provider || "openai",
    };
  });

  // ===========================================================================
  // Plugin Commands (LLM-free, intercepted automatically)
  // ===========================================================================

  // /tts_on - Enable TTS mode
  api.registerCommand({
    name: "tts_on",
    description: "Enable text-to-speech for responses",
    handler: () => {
      setTtsEnabled(prefsPath, true);
      log.info(`[${PLUGIN_ID}] TTS enabled via /tts_on command`);
      return { text: "🔊 TTS ativado! Agora vou responder em áudio." };
    },
  });

  // /tts_off - Disable TTS mode
  api.registerCommand({
    name: "tts_off",
    description: "Disable text-to-speech for responses",
    handler: () => {
      setTtsEnabled(prefsPath, false);
      log.info(`[${PLUGIN_ID}] TTS disabled via /tts_off command`);
      return { text: "🔇 TTS desativado. Voltando ao modo texto." };
    },
  });

  // /audio <text> - Convert text to audio immediately
  api.registerCommand({
    name: "audio",
    description: "Convert text to audio message",
    acceptsArgs: true,
    handler: async (ctx) => {
      const text = ctx.args?.trim();
      if (!text) {
        return { text: "❌ Uso: /audio <texto para converter em áudio>" };
      }

      log.info(`[${PLUGIN_ID}] /audio command, text length: ${text.length}`);
      const result = await textToSpeech(text, config, prefsPath);

      if (result.success && result.audioPath) {
        log.info(`[${PLUGIN_ID}] Audio generated: ${result.audioPath}`);
        return { text: `MEDIA:${result.audioPath}` };
      }

      log.error(`[${PLUGIN_ID}] /audio failed: ${result.error}`);
      return { text: `❌ Erro ao gerar áudio: ${result.error}` };
    },
  });

  // /tts_provider [openai|elevenlabs] - Set or show TTS provider
  api.registerCommand({
    name: "tts_provider",
    description: "Set or show TTS provider (openai or elevenlabs)",
    acceptsArgs: true,
    handler: (ctx) => {
      const arg = ctx.args?.trim().toLowerCase();
      const currentProvider = getTtsProvider(prefsPath) || config.provider || "openai";

      if (!arg) {
        // Show current provider
        const fallback = currentProvider === "openai" ? "elevenlabs" : "openai";
        const hasOpenAI = !!getApiKey(config, "openai");
        const hasElevenLabs = !!getApiKey(config, "elevenlabs");
        return {
          text: `🎙️ **TTS Provider**\n\n` +
            `Primário: **${currentProvider}** ${currentProvider === "openai" ? "(gpt-4o-mini-tts)" : "(eleven_multilingual_v2)"}\n` +
            `Fallback: ${fallback}\n\n` +
            `OpenAI: ${hasOpenAI ? "✅ configurado" : "❌ sem API key"}\n` +
            `ElevenLabs: ${hasElevenLabs ? "✅ configurado" : "❌ sem API key"}\n\n` +
            `Uso: /tts_provider openai ou /tts_provider elevenlabs`,
        };
      }

      if (arg !== "openai" && arg !== "elevenlabs") {
        return { text: "❌ Provedor inválido. Use: /tts_provider openai ou /tts_provider elevenlabs" };
      }

      setTtsProvider(prefsPath, arg);
      const fallback = arg === "openai" ? "elevenlabs" : "openai";
      log.info(`[${PLUGIN_ID}] Provider set to ${arg} via /tts_provider command`);
      return {
        text: `✅ Provedor TTS alterado!\n\n` +
          `Primário: **${arg}** ${arg === "openai" ? "(gpt-4o-mini-tts)" : "(eleven_multilingual_v2)"}\n` +
          `Fallback: ${fallback}`,
      };
    },
  });

  // ===========================================================================
  // Auto-TTS Hook (message_sending)
  // ===========================================================================

  // Automatically convert text responses to audio when TTS is enabled
  api.on("message_sending", async (event) => {
    // Check if TTS is enabled
    if (!isTtsEnabled(prefsPath)) {
      return; // TTS disabled, don't modify message
    }

    const content = event.content?.trim();
    if (!content) {
      return; // Empty content, skip
    }

    // Skip if already contains MEDIA directive (avoid double conversion)
    if (content.includes("MEDIA:")) {
      return;
    }

    // Skip very short messages (likely errors or status)
    if (content.length < 10) {
      return;
    }

    log.info(`[${PLUGIN_ID}] Auto-TTS: Converting ${content.length} chars`);

    try {
      const result = await textToSpeech(content, config, prefsPath);

      if (result.success && result.audioPath) {
        log.info(`[${PLUGIN_ID}] Auto-TTS: Audio generated: ${result.audioPath}`);
        // Return modified content with MEDIA directive
        // The text is kept for accessibility, audio is appended
        return {
          content: `MEDIA:${result.audioPath}`,
        };
      } else {
        log.warn(`[${PLUGIN_ID}] Auto-TTS: Failed - ${result.error}`);
        // On failure, send original text without audio
        return;
      }
    } catch (err) {
      const error = err as Error;
      log.error(`[${PLUGIN_ID}] Auto-TTS error: ${error.message}`);
      // On error, send original text
      return;
    }
  });

  // ===========================================================================
  // Startup
  // ===========================================================================

  const ttsEnabled = isTtsEnabled(prefsPath);
  const userProvider = getTtsProvider(prefsPath);
  const activeProvider = userProvider || config.provider || "openai";
  const hasKey = !!getApiKey(config, activeProvider);

  log.info(`[${PLUGIN_ID}] Ready. TTS: ${ttsEnabled ? "ON" : "OFF"}, Provider: ${activeProvider}, API Key: ${hasKey ? "OK" : "MISSING"}`);

  if (!hasKey) {
    log.warn(
      `[${PLUGIN_ID}] No API key configured. Set ELEVENLABS_API_KEY or OPENAI_API_KEY.`
    );
  }
}

// =============================================================================
// Plugin Metadata
// =============================================================================

export const meta = {
  id: PLUGIN_ID,
  name: "Telegram TTS",
  description: "Text-to-speech for chat responses using ElevenLabs or OpenAI",
  version: "0.3.0",
};
