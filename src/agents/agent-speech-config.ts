import type { AgentSttConfig } from "../config/types.agents.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { TtsConfig } from "../config/types.tts.js";

/**
 * Return a shallow-cloned cfg with agent TTS overrides merged onto
 * `messages.tts`. Fields set in agentTts take precedence; nested
 * `providers` maps are shallow-merged so untouched global providers
 * are preserved.
 *
 * When agentTts is undefined or empty the original cfg is returned
 * unchanged (no allocation).
 */
export function mergeAgentTtsIntoConfig(
  cfg: OpenClawConfig,
  agentTts: TtsConfig | undefined,
): OpenClawConfig {
  if (!agentTts || Object.keys(agentTts).length === 0) {
    return cfg;
  }
  const globalTts = cfg.messages?.tts ?? {};
  const mergedProviders =
    agentTts.providers || globalTts.providers
      ? { ...globalTts.providers, ...agentTts.providers }
      : undefined;
  return {
    ...cfg,
    messages: {
      ...cfg.messages,
      tts: {
        ...globalTts,
        ...agentTts,
        ...(mergedProviders !== undefined ? { providers: mergedProviders } : {}),
      },
    },
  };
}

/**
 * Return a shallow-cloned cfg with agent STT overrides merged onto
 * `tools.media.audio`. Fields set in agentStt take precedence.
 *
 * When agentStt is undefined or empty the original cfg is returned
 * unchanged (no allocation).
 */
export function mergeAgentSttIntoConfig(
  cfg: OpenClawConfig,
  agentStt: AgentSttConfig | undefined,
): OpenClawConfig {
  if (!agentStt || Object.keys(agentStt).length === 0) {
    return cfg;
  }
  const globalAudio = cfg.tools?.media?.audio ?? {};
  return {
    ...cfg,
    tools: {
      ...cfg.tools,
      media: {
        ...cfg.tools?.media,
        audio: {
          ...globalAudio,
          ...agentStt,
        },
      },
    },
  };
}
