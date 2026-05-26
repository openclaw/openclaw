//#region packages/memory-host-sdk/src/host/status-format.d.ts
type Tone = "ok" | "warn" | "muted";
declare function resolveMemoryVectorState(vector: {
  enabled: boolean;
  available?: boolean;
}): {
  tone: Tone;
  state: "ready" | "unavailable" | "disabled" | "unknown";
};
declare function resolveMemoryFtsState(fts: {
  enabled: boolean;
  available: boolean;
}): {
  tone: Tone;
  state: "ready" | "unavailable" | "disabled";
};
declare function resolveMemoryCacheSummary(cache: {
  enabled: boolean;
  entries?: number;
}): {
  tone: Tone;
  text: string;
};
//#endregion
export { resolveMemoryVectorState as i, resolveMemoryCacheSummary as n, resolveMemoryFtsState as r, Tone as t };