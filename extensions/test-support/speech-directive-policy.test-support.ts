export function createSpeechDirectivePolicy() {
  return {
    enabled: true,
    allowText: true,
    allowProvider: true,
    allowVoice: true,
    allowModelId: true,
    allowVoiceSettings: true,
    allowNormalization: true,
    allowSeed: true,
  };
}
