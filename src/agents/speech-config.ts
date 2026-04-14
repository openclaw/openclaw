import type { OpenClawConfig } from "../config/types.js";
import type { MediaUnderstandingConfig } from "../config/types.tools.js";
import type { TtsConfig } from "../config/types.tts.js";
import { resolveAgentConfig, resolveSessionAgentId } from "./agent-scope.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMergeDefined<T>(base: T | undefined, override: T | undefined): T | undefined {
  if (override === undefined) {
    return base;
  }
  if (base === undefined) {
    return override;
  }
  if (Array.isArray(base) || Array.isArray(override)) {
    return override;
  }
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return override;
  }

  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) {
      continue;
    }
    merged[key] = key in merged ? deepMergeDefined(merged[key], value) : value;
  }
  return merged as T;
}

function mergeAgentTtsConfig(
  cfg: OpenClawConfig,
  override?: TtsConfig,
): OpenClawConfig["messages"] | undefined {
  const mergedTts = deepMergeDefined(cfg.messages?.tts, override);
  if (!mergedTts) {
    return cfg.messages;
  }
  return {
    ...cfg.messages,
    tts: mergedTts,
  };
}

function mergeAgentSttConfig(
  cfg: OpenClawConfig,
  override?: MediaUnderstandingConfig,
): OpenClawConfig["tools"] | undefined {
  const mergedAudio = deepMergeDefined(cfg.tools?.media?.audio, override);
  if (!mergedAudio) {
    return cfg.tools;
  }
  return {
    ...cfg.tools,
    media: {
      ...cfg.tools?.media,
      audio: mergedAudio,
    },
  };
}

export function resolveAgentSpeechConfig(
  cfg: OpenClawConfig,
  agentId?: string | null,
): OpenClawConfig {
  if (!agentId) {
    return cfg;
  }
  const agentConfig = resolveAgentConfig(cfg, agentId);
  if (!agentConfig?.tts && !agentConfig?.stt) {
    return cfg;
  }

  return {
    ...cfg,
    messages: mergeAgentTtsConfig(cfg, agentConfig.tts),
    tools: mergeAgentSttConfig(cfg, agentConfig.stt),
  };
}

export function resolveSessionSpeechConfig(params: {
  cfg: OpenClawConfig;
  sessionKey?: string | null;
}): OpenClawConfig {
  const agentId = resolveSessionAgentId({
    sessionKey: params.sessionKey ?? undefined,
    config: params.cfg,
  });
  return resolveAgentSpeechConfig(params.cfg, agentId);
}
