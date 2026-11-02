// The facade, worker and injected media class share one prepared module graph.
export const realtimeAudioTestEntrypoints = {
  peer: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "realtime-quicksilver-peer.runtime",
    distWorkerPath: "extensions/openai/realtime-quicksilver-peer.runtime.js",
  },
  media: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "realtime-quicksilver-media.runtime",
    distWorkerPath: "extensions/openai/realtime-quicksilver-media.runtime.js",
  },
  worker: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "realtime-quicksilver-audio.worker",
    distWorkerPath: "extensions/openai/realtime-quicksilver-audio.worker.js",
  },
} as const;
