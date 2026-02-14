export type ZulipQueuePlanEntry = { stream: string };

export function buildZulipQueuePlan(streams: string[]): ZulipQueuePlanEntry[] {
  const normalized = streams.map((stream) => stream.trim()).filter(Boolean);
  const deduped = Array.from(new Set(normalized));
  return deduped.map((stream) => ({ stream }));
}

export function buildZulipRegisterNarrow(stream: string): string {
  // "stream" is the canonical narrow operator for Zulip's API and works across older deployments.
  // Newer servers may also accept "channel", but prefer "stream" for compatibility.
  return JSON.stringify([["stream", stream]]);
}
