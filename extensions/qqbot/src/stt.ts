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

interface ProviderConfig {
  baseUrl?: string;
  apiKey?: string;
}

interface ChannelSttConfig extends ProviderConfig {
  enabled?: boolean;
  provider?: string;
  model?: string;
}

interface AudioModelConfig extends ProviderConfig {
  provider?: string;
  model?: string;
}

export function resolveSTTConfig(cfg: Record<string, unknown>): STTConfig | null {
  const channels = cfg.channels as { qqbot?: { stt?: ChannelSttConfig } } | undefined;
  const models = cfg.models as { providers?: Record<string, ProviderConfig> } | undefined;
  const tools = cfg.tools as { media?: { audio?: { models?: AudioModelConfig[] } } } | undefined;

  // Prefer plugin-specific STT config.
  const channelStt = channels?.qqbot?.stt;
  if (channelStt && channelStt.enabled !== false) {
    const providerId = channelStt.provider || "openai";
    const providerCfg = models?.providers?.[providerId];
    const baseUrl = channelStt.baseUrl || providerCfg?.baseUrl;
    const apiKey = channelStt.apiKey || providerCfg?.apiKey;
    const model = channelStt.model || "whisper-1";
    if (baseUrl && apiKey) {
      return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey, model };
    }
  }

  // Fall back to framework-level audio model config.
  const audioModelEntry = tools?.media?.audio?.models?.[0];
  if (audioModelEntry) {
    const providerId = audioModelEntry.provider || "openai";
    const providerCfg = models?.providers?.[providerId];
    const baseUrl = audioModelEntry.baseUrl || providerCfg?.baseUrl;
    const apiKey = audioModelEntry.apiKey || providerCfg?.apiKey;
    const model = audioModelEntry.model || "whisper-1";
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
