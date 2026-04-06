/**
 * OpenAI-compatible STT used at the plugin layer.
 *
 * This avoids pushing raw WAV PCM into the framework media-understanding pipeline.
 */

import * as fs from "node:fs";
import path from "node:path";
import { sanitizeFileName } from "./utils/platform.js";

export interface STTConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

type QQBotSttProviderConfig = {
  baseUrl?: string;
  apiKey?: string;
};

type QQBotSttChannelConfig = QQBotSttProviderConfig & {
  enabled?: boolean;
  provider?: string;
  model?: string;
};

type QQBotSttToolAudioModel = QQBotSttProviderConfig & {
  provider?: string;
  model?: string;
};

type QQBotSttConfigRoot = {
  channels?: {
    qqbot?: {
      stt?: QQBotSttChannelConfig;
    };
  };
  models?: {
    providers?: Record<string, QQBotSttProviderConfig>;
  };
  tools?: {
    media?: {
      audio?: {
        models?: QQBotSttToolAudioModel[];
      };
    };
  };
};

export function resolveSTTConfig(cfg: Record<string, unknown>): STTConfig | null {
  const c = cfg as QQBotSttConfigRoot;

  // Prefer plugin-specific STT config.
  const channelStt = c?.channels?.qqbot?.stt;
  if (channelStt && channelStt.enabled !== false) {
    const providerId: string = channelStt?.provider || "openai";
    const providerCfg = c?.models?.providers?.[providerId];
    const baseUrl: string | undefined = channelStt?.baseUrl || providerCfg?.baseUrl;
    const apiKey: string | undefined = channelStt?.apiKey || providerCfg?.apiKey;
    const model: string = channelStt?.model || "whisper-1";
    if (baseUrl && apiKey) {
      return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey, model };
    }
  }

  // Fall back to framework-level audio model config.
  const audioModelEntry = c?.tools?.media?.audio?.models?.[0];
  if (audioModelEntry) {
    const providerId: string = audioModelEntry?.provider || "openai";
    const providerCfg = c?.models?.providers?.[providerId];
    const baseUrl: string | undefined = audioModelEntry?.baseUrl || providerCfg?.baseUrl;
    const apiKey: string | undefined = audioModelEntry?.apiKey || providerCfg?.apiKey;
    const model: string = audioModelEntry?.model || "whisper-1";
    if (baseUrl && apiKey) {
      return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey, model };
    }
  }

  return null;
}

export async function transcribeAudio(
  audioPath: string,
  cfg: Record<string, unknown>,
): Promise<string | null> {
  const sttCfg = resolveSTTConfig(cfg);
  if (!sttCfg) {
    return null;
  }

  const fileBuffer = fs.readFileSync(audioPath);
  const fileName = sanitizeFileName(path.basename(audioPath));
  const mime = fileName.endsWith(".wav")
    ? "audio/wav"
    : fileName.endsWith(".mp3")
      ? "audio/mpeg"
      : fileName.endsWith(".ogg")
        ? "audio/ogg"
        : "application/octet-stream";

  const form = new FormData();
  form.append("file", new Blob([fileBuffer], { type: mime }), fileName);
  form.append("model", sttCfg.model);

  const resp = await fetch(`${sttCfg.baseUrl}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${sttCfg.apiKey}` },
    body: form,
  });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`STT failed (HTTP ${resp.status}): ${detail.slice(0, 300)}`);
  }

  const result = (await resp.json()) as { text?: string };
  return result.text?.trim() || null;
}
