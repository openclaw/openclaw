/**
 * Microsoft Teams runtime wiring.
 *
 * Keeps all msteams-specific bootstrap out of the upstream `runtime.ts`: it
 * resolves the realtime-transcription provider (the same way the webhook
 * streaming init does), builds the msteams PCM TTS adapter, and injects the
 * CallManager + response runtime into the `MsteamsProvider`.
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { resolveConfiguredCapabilityProvider } from "openclaw/plugin-sdk/provider-selection-runtime";
import type { VoiceCallConfig } from "./config.js";
import type { CoreAgentDeps, CoreConfig } from "./core-bridge.js";
import type { CallManager } from "./manager.js";
import { createMsteamsTtsProvider } from "./msteams-tts.js";
import type { VoiceCallProvider } from "./providers/base.js";
import type { MsteamsProvider } from "./providers/msteams.js";
import {
  getRealtimeTranscriptionProvider,
  listRealtimeTranscriptionProviders,
} from "./realtime-transcription.runtime.js";
import type { TelephonyTtsRuntime } from "./telephony-tts.js";

type Logger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
  debug?: (message: string) => void;
};

export async function wireMsteamsRuntime(params: {
  config: VoiceCallConfig;
  coreConfig: CoreConfig;
  fullConfig: OpenClawConfig;
  agentRuntime: CoreAgentDeps;
  ttsRuntime?: TelephonyTtsRuntime;
  manager: CallManager;
  provider: VoiceCallProvider;
  logger: Logger;
}): Promise<void> {
  const { config, coreConfig, fullConfig, agentRuntime, ttsRuntime, manager, provider, logger } =
    params;
  const msteamsProvider = provider as MsteamsProvider;
  const streaming = config.streaming;

  msteamsProvider.setCallManager(manager);
  msteamsProvider.setResponseRuntime({ coreConfig, agentRuntime, voiceConfig: config });

  const resolution = resolveConfiguredCapabilityProvider({
    configuredProviderId: streaming.provider,
    providerConfigs: streaming.providers,
    cfg: fullConfig,
    cfgForResolve: fullConfig,
    getConfiguredProvider: (providerId) => getRealtimeTranscriptionProvider(providerId, fullConfig),
    listProviders: () => listRealtimeTranscriptionProviders(fullConfig),
    resolveProviderConfig: ({ provider: p, cfg: c, rawConfig }) =>
      p.resolveConfig?.({ cfg: c, rawConfig }) ?? rawConfig,
    isProviderConfigured: ({ provider: p, cfg: c, providerConfig }) =>
      p.isConfigured({ cfg: c, providerConfig }),
  });
  if (resolution.ok) {
    msteamsProvider.setTranscriptionProvider(
      resolution.provider,
      resolution.providerConfig,
      fullConfig,
    );
    logger.info(`[voice-call] msteams realtime transcription provider: ${resolution.provider.id}`);
  } else {
    // Fail closed: binding the Teams listener without a usable STT provider would
    // accept calls it can never transcribe (caller in silence). Abort runtime init
    // before the listener binds rather than logging and continuing.
    throw new Error(
      `[voice-call] msteams streaming is enabled but no usable realtime transcription provider resolved (${resolution.code}); refusing to start the Teams listener`,
    );
  }

  if (ttsRuntime?.textToSpeechTelephony) {
    try {
      const ttsProvider = createMsteamsTtsProvider({
        coreConfig,
        ttsOverride: config.tts,
        runtime: ttsRuntime,
        logger,
      });
      msteamsProvider.setTtsProvider(ttsProvider);
      logger.info("[voice-call] msteams TTS provider configured");
    } catch (err) {
      logger.warn(`[voice-call] Failed to initialize msteams TTS: ${formatErrorMessage(err)}`);
    }
  } else {
    logger.warn("[voice-call] Telephony TTS unavailable; msteams streaming TTS disabled");
  }
}
