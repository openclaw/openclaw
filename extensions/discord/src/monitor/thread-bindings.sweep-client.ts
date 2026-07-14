import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
// Discord sweep-owned REST client factory. Kept separate from
// thread-bindings.manager.ts so the manager file does not grow past the
// legacy size cap enforced by scripts/check-ts-max-loc.ts.
import { createDiscordRestClient } from "../client.js";

// Bounds each per-binding Discord getChannel probe so a stalled request aborts
// within one sweep tick instead of holding the single-flight guard indefinitely.
// 15s gives ~8x headroom against the 120s THREAD_BINDINGS_SWEEP_INTERVAL_MS.
export const DISCORD_SWEEP_PROBE_TIMEOUT_MS = 15_000;

export function createSweepRestClient(params: {
  cfg: OpenClawConfig;
  accountId: string;
  // token matches createDiscordRestClient (optional). If the sweep starts
  // before a token is registered, createDiscordRestClient throws and the
  // outer `try` in runSweepOnce returns; the guard then releases so the
  // next 120s tick can retry.
  token?: string;
}): ReturnType<typeof createDiscordRestClient>["rest"] {
  return createDiscordRestClient({
    ...params,
    timeoutMs: DISCORD_SWEEP_PROBE_TIMEOUT_MS,
  }).rest;
}
