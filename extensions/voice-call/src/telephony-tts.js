import { deepMergeDefined } from "./deep-merge.js";
import { convertPcmToMulaw8k } from "./telephony-audio.js";
function createTelephonyTtsProvider(params) {
  const { coreConfig, ttsOverride, runtime } = params;
  const mergedConfig = applyTtsOverride(coreConfig, ttsOverride);
  return {
    synthesizeForTelephony: async (text) => {
      const result = await runtime.textToSpeechTelephony({
        text,
        cfg: mergedConfig
      });
      if (!result.success || !result.audioBuffer || !result.sampleRate) {
        throw new Error(result.error ?? "TTS conversion failed");
      }
      return convertPcmToMulaw8k(result.audioBuffer, result.sampleRate);
    }
  };
}
function applyTtsOverride(coreConfig, override) {
  if (!override) {
    return coreConfig;
  }
  const base = coreConfig.messages?.tts;
  const merged = mergeTtsConfig(base, override);
  if (!merged) {
    return coreConfig;
  }
  return {
    ...coreConfig,
    messages: {
      ...coreConfig.messages,
      tts: merged
    }
  };
}
function mergeTtsConfig(base, override) {
  if (!base && !override) {
    return void 0;
  }
  if (!override) {
    return base;
  }
  if (!base) {
    return override;
  }
  return deepMergeDefined(base, override);
}
export {
  createTelephonyTtsProvider
};
