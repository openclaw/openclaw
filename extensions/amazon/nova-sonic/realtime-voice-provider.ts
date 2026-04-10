import type { RealtimeVoiceProviderPlugin } from "openclaw/plugin-sdk/realtime-voice";
import { trimToUndefined } from "openclaw/plugin-sdk/speech";
import { NovaSonicVoiceBridge } from "./bridge.js";

const DEFAULT_MODEL = "amazon.nova-sonic-v1:0";
const DEFAULT_VOICE = "tiffany";
const DEFAULT_REGION = "us-east-1";

type NovaSonicProviderConfig = {
  enabled: boolean;
  model: string;
  voice: string;
  region: string;
  temperature?: number;
  maxTokens?: number;
};

function normalizeConfig(raw: Record<string, unknown>): NovaSonicProviderConfig {
  return {
    enabled: raw.enabled !== false,
    model: trimToUndefined(raw.model) ?? DEFAULT_MODEL,
    voice: trimToUndefined(raw.voice) ?? DEFAULT_VOICE,
    region: trimToUndefined(raw.region) ?? DEFAULT_REGION,
    temperature: typeof raw.temperature === "number" ? raw.temperature : undefined,
    maxTokens: typeof raw.maxTokens === "number" ? raw.maxTokens : undefined,
  };
}

/**
 * Build the Amazon Nova Sonic realtime voice provider.
 * Config is read from the parent `amazon` plugin's `novaSonic` key.
 */
export function buildNovaSonicVoiceProvider(
  pluginConfig?: Record<string, unknown>,
): RealtimeVoiceProviderPlugin {
  return {
    id: "amazon-nova-sonic",
    label: "Amazon Nova Sonic",
    autoSelectOrder: 15,

    resolveConfig: ({ rawConfig }) => {
      const raw = (rawConfig as Record<string, unknown>)?.novaSonic ?? rawConfig;
      return normalizeConfig(raw as Record<string, unknown>);
    },

    isConfigured: ({ providerConfig }) => {
      const config = normalizeConfig(
        (providerConfig ?? {}) as Record<string, unknown>,
      );
      return config.enabled;
    },

    createBridge: (req) => {
      const config = normalizeConfig(
        (req.providerConfig ?? {}) as Record<string, unknown>,
      );

      return new NovaSonicVoiceBridge({
        ...req,
        region: config.region,
        model: config.model,
        voice: config.voice,
        temperature: config.temperature,
        maxTokens: config.maxTokens,
      });
    },
  };
}
