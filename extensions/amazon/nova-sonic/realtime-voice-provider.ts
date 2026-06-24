import type {
  RealtimeVoiceProviderPlugin,
  RealtimeVoiceProviderCapabilities,
} from "openclaw/plugin-sdk/realtime-voice";
import { trimToUndefined } from "openclaw/plugin-sdk/speech";
import { NovaSonicVoiceBridge } from "./bridge.js";

const DEFAULT_MODEL = "amazon.nova-sonic-v1:0";
const DEFAULT_VOICE = "tiffany";
const DEFAULT_REGION = "us-east-1";

/** Supported Nova Sonic model IDs. */
const SUPPORTED_MODELS = ["amazon.nova-sonic-v1:0", "amazon.nova-2-sonic-v1:0"] as const;

type NovaSonicProviderConfig = {
  enabled: boolean;
  model: string;
  voice: string;
  region: string;
  temperature?: number;
  maxTokens?: number;
};

function normalizeConfig(raw: Record<string, unknown>): NovaSonicProviderConfig {
  const model = trimToUndefined(raw.model) ?? DEFAULT_MODEL;
  if (!SUPPORTED_MODELS.includes(model as (typeof SUPPORTED_MODELS)[number])) {
    throw new Error(
      `Unsupported Nova Sonic model: ${model}. Supported: ${SUPPORTED_MODELS.join(", ")}`,
    );
  }
  return {
    enabled: raw.enabled !== false,
    model,
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
): RealtimeVoiceProviderPlugin | null {
  const novaSonicConfig = (pluginConfig?.novaSonic ?? {}) as Record<string, unknown>;
  const config = normalizeConfig(novaSonicConfig);
  if (!config.enabled) return null;

  const capabilities: RealtimeVoiceProviderCapabilities = {
    transports: ["gateway-relay"],
    inputAudioFormats: [
      { encoding: "g711_ulaw", sampleRateHz: 8000, channels: 1 },
      { encoding: "pcm16", sampleRateHz: 24000, channels: 1 },
    ],
    outputAudioFormats: [
      { encoding: "g711_ulaw", sampleRateHz: 8000, channels: 1 },
      { encoding: "pcm16", sampleRateHz: 24000, channels: 1 },
    ],
    supportsBargeIn: true,
    supportsToolCalls: true,
  };

  return {
    id: "amazon-nova-sonic",
    label: "Amazon Nova Sonic",
    autoSelectOrder: 15,
    capabilities,

    resolveConfig: ({ rawConfig }) => {
      const raw = (rawConfig as Record<string, unknown>)?.novaSonic ?? rawConfig;
      return normalizeConfig(raw as Record<string, unknown>);
    },

    isConfigured: ({ providerConfig }) => {
      const config = normalizeConfig((providerConfig ?? {}) as Record<string, unknown>);
      return config.enabled;
    },

    createBridge: (req) => {
      const config = normalizeConfig((req.providerConfig ?? {}) as Record<string, unknown>);

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
