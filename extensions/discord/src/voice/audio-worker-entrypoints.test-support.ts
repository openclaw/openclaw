// Real audio workers share the invocation's compiled graph with the other subprocess fixtures.
export const discordAudioTestEntrypoints = {
  lifecycle: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "audio-worker.runtime",
    distWorkerPath: "extensions/discord/src/voice/audio-worker.runtime.js",
  },
  pacing: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "audio-starvation.test-support",
    distWorkerPath: "extensions/discord/src/voice/audio-starvation.test-support.js",
  },
} as const;
