/**
 * telegram-tts - Automatic TTS for chat responses
 *
 * This plugin provides a `speak` tool that converts text to speech using
 * ElevenLabs API and sends the response as a voice message.
 *
 * When TTS mode is enabled (via user preferences or config), the agent
 * is instructed to use the speak tool for all responses.
 */

import { execSync } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type { PluginApi, PluginConfig } from "clawdbot";

const PLUGIN_ID = "telegram-tts";

interface TelegramTtsConfig {
  enabled?: boolean;
  provider?: "elevenlabs" | "openai";
  elevenlabs?: {
    apiKey?: string;
    voiceId?: string;
    modelId?: string;
  };
  prefsPath?: string;
  maxTextLength?: number;
  channels?: string[];
}

interface UserPreferences {
  tts?: {
    enabled?: boolean;
  };
}

/**
 * Load environment variables from .clawdbot/.env
 */
function loadEnv(): Record<string, string> {
  const envPath = join(process.env.HOME || "/home/dev", ".clawdbot", ".env");
  const env: Record<string, string> = { ...process.env } as Record<string, string>;

  if (existsSync(envPath)) {
    const content = readFileSync(envPath, "utf8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) {
        const [key, ...valueParts] = trimmed.split("=");
        if (key && valueParts.length > 0) {
          let value = valueParts.join("=");
          // Remove quotes if present
          if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
          ) {
            value = value.slice(1, -1);
          }
          env[key.trim()] = value;
        }
      }
    }
  }
  return env;
}

/**
 * Check if TTS is enabled in user preferences
 */
function isTtsEnabled(prefsPath: string): boolean {
  try {
    if (!existsSync(prefsPath)) return false;
    const prefs: UserPreferences = JSON.parse(readFileSync(prefsPath, "utf8"));
    return prefs?.tts?.enabled === true;
  } catch {
    return false;
  }
}

/**
 * Set TTS enabled state in user preferences
 */
function setTtsEnabled(prefsPath: string, enabled: boolean): void {
  let prefs: UserPreferences = {};
  try {
    if (existsSync(prefsPath)) {
      prefs = JSON.parse(readFileSync(prefsPath, "utf8"));
    }
  } catch {
    // ignore
  }
  prefs.tts = { enabled };
  writeFileSync(prefsPath, JSON.stringify(prefs, null, 2));
}

/**
 * Convert text to audio using sag CLI (ElevenLabs wrapper)
 */
function textToAudio(text: string): string | null {
  try {
    const escapedText = text.replace(/'/g, "'\\''");
    const env = loadEnv();

    const result = execSync(`sag '${escapedText}'`, {
      encoding: "utf8",
      timeout: 60000,
      env,
    }).trim();

    if (result && existsSync(result)) {
      return result;
    }
    return null;
  } catch (err) {
    console.error(`[${PLUGIN_ID}] TTS error:`, (err as Error).message);
    return null;
  }
}

/**
 * Plugin registration
 */
export default function register(api: PluginApi) {
  const log = api.logger;
  const config = (api.pluginConfig || {}) as TelegramTtsConfig;
  const prefsPath =
    config.prefsPath ||
    process.env.CLAWDBOT_TTS_PREFS ||
    join(process.env.HOME || "/home/dev", "clawd", ".user-preferences.json");

  log.info(`[${PLUGIN_ID}] Registering plugin...`);
  log.info(`[${PLUGIN_ID}] Preferences path: ${prefsPath}`);

  // Register the 'speak' tool for TTS
  api.registerTool({
    name: "speak",
    description:
      "Convert text to speech and send as voice message. Use this tool when TTS mode is enabled or when the user requests an audio response.",
    parameters: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "The text to convert to speech and send as voice message",
        },
      },
      required: ["text"],
    },
    execute: async (_id: string, params: { text: string }) => {
      const { text } = params;
      log.info(`[${PLUGIN_ID}] speak() called, text length: ${text?.length || 0}`);

      if (!text) {
        return { content: [{ type: "text", text: "Error: No text provided" }] };
      }

      const maxLen = config.maxTextLength || 4000;
      if (text.length > maxLen) {
        return {
          content: [
            {
              type: "text",
              text: `Error: Text too long (${text.length} chars, max ${maxLen})`,
            },
          ],
        };
      }

      const audioPath = textToAudio(text);

      if (audioPath) {
        log.info(`[${PLUGIN_ID}] Audio generated: ${audioPath}`);
        return {
          content: [{ type: "text", text: `Voice message generated successfully.` }],
          media: audioPath,
          asVoice: true,
        };
      }

      log.error(`[${PLUGIN_ID}] TTS conversion failed`);
      return {
        content: [{ type: "text", text: `TTS conversion failed. Original: ${text}` }],
      };
    },
  });

  // Register Gateway RPC methods
  api.registerGatewayMethod("tts.status", async () => ({
    enabled: isTtsEnabled(prefsPath),
    prefsPath,
    pluginId: PLUGIN_ID,
    config: {
      provider: config.provider || "elevenlabs",
      maxTextLength: config.maxTextLength || 4000,
    },
  }));

  api.registerGatewayMethod("tts.enable", async () => {
    setTtsEnabled(prefsPath, true);
    return { ok: true, enabled: true };
  });

  api.registerGatewayMethod("tts.disable", async () => {
    setTtsEnabled(prefsPath, false);
    return { ok: true, enabled: false };
  });

  api.registerGatewayMethod("tts.convert", async (params: { text: string }) => {
    if (!params.text) return { ok: false, error: "No text provided" };
    const audioPath = textToAudio(params.text);
    return audioPath ? { ok: true, audioPath } : { ok: false, error: "Conversion failed" };
  });

  log.info(
    `[${PLUGIN_ID}] Plugin ready. TTS is currently ${isTtsEnabled(prefsPath) ? "ENABLED" : "disabled"}`
  );
}

export const meta = {
  id: PLUGIN_ID,
  name: "Telegram TTS",
  description: "Automatic text-to-speech for chat responses using ElevenLabs",
  version: "0.1.0",
};
