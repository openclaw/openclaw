import os from "node:os";
import { describe, expect, it, vi } from "vitest";
import * as runtimeConfig from "../config/config.js";
import * as sessionTargets from "../config/sessions/targets-runtime.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { promptCacheKeepWarmState } from "./prompt-cache-keep-warm-candidates.js";
import {
  readObservedPromptCacheTtlMs,
  readStoredPromptCacheKeepWarm,
  resolvePromptCacheKeepWarmMaxPings,
  runPromptCacheKeepWarm,
} from "./prompt-cache-keep-warm.js";
import type { SessionEntry as TranscriptEntry } from "./sessions/session-manager.js";

const route = { provider: "anthropic", model: "claude-opus-5-5" };
let nextId = 0;

const reply = (
  usage: { cacheRead?: number; cacheWrite5m?: number; cacheWrite1h?: number },
  replyRoute = route,
) =>
  ({
    type: "message",
    id: `entry-${nextId++}`,
    message: { role: "assistant", ...replyRoute, usage },
  }) as unknown as TranscriptEntry;
const boundary = (type: "compaction" | "model_change") =>
  ({ type, id: `entry-${nextId++}` }) as unknown as TranscriptEntry;

describe("readObservedPromptCacheTtlMs", () => {
  it("uses the tier the session's responses wrote, newest first", () => {
    expect(
      readObservedPromptCacheTtlMs(
        [reply({ cacheWrite5m: 10 }), reply({ cacheWrite1h: 10 })],
        route,
      ),
    ).toBe(60 * 60_000);
    // A pure read keeps the tier an earlier response proved; a proxy that forces 1h shows here.
    expect(
      readObservedPromptCacheTtlMs([reply({ cacheWrite1h: 10 }), reply({ cacheRead: 90 })], route),
    ).toBe(60 * 60_000);
    // Both tiers in one response: the shorter one expires first.
    expect(readObservedPromptCacheTtlMs([reply({ cacheWrite1h: 5, cacheWrite5m: 5 })], route)).toBe(
      5 * 60_000,
    );
  });

  it("knows nothing across another prefix or route", () => {
    expect(readObservedPromptCacheTtlMs([reply({ cacheRead: 90 })], route)).toBeUndefined();
    expect(
      readObservedPromptCacheTtlMs(
        [reply({ cacheWrite1h: 10 }), boundary("compaction"), reply({ cacheRead: 9 })],
        route,
      ),
    ).toBeUndefined();
    expect(
      readObservedPromptCacheTtlMs(
        [
          reply({ cacheWrite1h: 10 }),
          reply({ cacheRead: 9 }, { provider: "openai", model: "gpt-6.1-sol" }),
        ],
        route,
      ),
    ).toBeUndefined();
  });
});

describe("resolvePromptCacheKeepWarmMaxPings", () => {
  // Opus 5.5 list prices per million: input 4, cache read 0.2, 5m write 5.
  const opus = { input: 4, cacheRead: 0.2, cacheWrite: 5 };
  it("keeps all pings below half of one cache rewrite", () => {
    expect(resolvePromptCacheKeepWarmMaxPings(opus, 5 * 60_000)).toBe(12);
    // The 1h tier writes at 2x input.
    expect(resolvePromptCacheKeepWarmMaxPings(opus, 60 * 60_000)).toBe(19);
    expect(
      resolvePromptCacheKeepWarmMaxPings(
        { input: 2, cacheRead: 0.2, cacheWrite: 2.5 },
        30 * 60_000,
      ),
    ).toBe(5);
  });

  it("bounds unpriced and nearly free reads", () => {
    expect(
      resolvePromptCacheKeepWarmMaxPings({ input: 0, cacheRead: 0, cacheWrite: 0 }, 5 * 60_000),
    ).toBe(3);
    expect(
      resolvePromptCacheKeepWarmMaxPings({ input: 4, cacheRead: 0.001, cacheWrite: 5 }, 5 * 60_000),
    ).toBe(24);
  });
});

describe("readStoredPromptCacheKeepWarm", () => {
  const record = {
    anchorEntryId: "reply-1",
    ...route,
    lastPingAt: 10_000,
    pings: 4,
  };
  const entry = (lastInteractionAt: number) => ({ lastInteractionAt, promptCacheKeepWarm: record });

  it("resumes a series after a restart from the row", () => {
    expect(readStoredPromptCacheKeepWarm(entry(5_000), "reply-1", route)).toEqual({
      pings: 4,
      pingedAt: 10_000,
    });
  });

  it("keeps the budget across an automation turn and renews it on a human turn", () => {
    // A wake or cron reply re-anchors: the old prewarm no longer touched this prefix.
    expect(readStoredPromptCacheKeepWarm(entry(5_000), "reply-2", route)).toEqual({
      pings: 4,
      pingedAt: 0,
    });
    expect(readStoredPromptCacheKeepWarm(entry(12_000), "reply-2", route).pings).toBe(0);
  });

  it("does not count another route's prewarm as a cache touch", () => {
    expect(
      readStoredPromptCacheKeepWarm(entry(5_000), "reply-1", { ...route, model: "other" }).pingedAt,
    ).toBe(0);
  });
});

it.skipIf(Boolean(process.versions.bun))(
  "defers keep-warm session recovery until host memory returns",
  async () => {
    const recovered = promptCacheKeepWarmState.recovered;
    promptCacheKeepWarmState.recovered = false;
    resetGatewayWorkAdmission();
    vi.spyOn(runtimeConfig, "getRuntimeConfig").mockReturnValue({});
    const targets = vi
      .spyOn(sessionTargets, "resolveAllAgentSessionStoreTargetsAsync")
      .mockResolvedValue([]);
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.spyOn(process, "constrainedMemory").mockReturnValue(0);
    vi.spyOn(os, "totalmem").mockReturnValue(353 * 1024 ** 2);
    const free = vi.spyOn(os, "freemem").mockReturnValue(40 * 1024 ** 2);
    vi.spyOn(Date, "now").mockReturnValue(10_000);
    try {
      const signal = new AbortController().signal;
      await expect(runPromptCacheKeepWarm(signal)).resolves.toBe(70_000);
      expect(targets).not.toHaveBeenCalled();
      expect(promptCacheKeepWarmState.recovered).toBe(false);

      free.mockReturnValue(200 * 1024 ** 2);
      await expect(runPromptCacheKeepWarm(signal)).resolves.toBe(Infinity);
      expect(targets).toHaveBeenCalledOnce();
    } finally {
      promptCacheKeepWarmState.recovered = recovered;
      vi.restoreAllMocks();
      resetGatewayWorkAdmission();
    }
  },
);
