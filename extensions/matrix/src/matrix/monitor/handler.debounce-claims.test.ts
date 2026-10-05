// Matrix tests cover replay-claim settlement for debounced (merged) inbound events.
import type { ChannelReplayClaimHandle } from "openclaw/plugin-sdk/persistent-dedupe";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installMatrixMonitorTestRuntime } from "../../test-runtime.js";
import {
  createMatrixHandlerTestHarness,
  createMatrixTextMessageEvent,
} from "./handler.test-helpers.js";

function createClaim(key: string) {
  return {
    keys: [key],
    commit: vi.fn(async () => true),
    release: vi.fn(),
  } satisfies ChannelReplayClaimHandle;
}

function createDeduper(handle: ChannelReplayClaimHandle) {
  return { claim: vi.fn(async () => ({ kind: "claimed" as const, handle })) };
}

beforeEach(() => {
  installMatrixMonitorTestRuntime();
});

describe("matrix handler debounced replay claims", () => {
  it("commits absorbed claims with the merged event's claim", async () => {
    const own = createClaim("own");
    const absorbed = createClaim("absorbed");
    const { handler } = createMatrixHandlerTestHarness({
      accountAllowBots: true,
      configuredBotUserIds: new Set(["@ops:example.org"]),
      inboundDeduper: createDeduper(own),
      isDirectMessage: false,
      roomsConfig: {
        "!room:example.org": { requireMention: false },
      },
      runPrepared: vi.fn(
        async (turn: { ctxPayload: Record<string, unknown>; routeSessionKey: string }) => ({
          admission: { kind: "drop" as const, reason: "bot-loop-protection" as const },
          dispatched: false as const,
          ctxPayload: turn.ctxPayload,
          routeSessionKey: turn.routeSessionKey,
        }),
      ),
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        eventId: "$merged",
        sender: "@ops:example.org",
        body: "one\ntwo",
      }),
      { absorbedReplayClaims: [absorbed] },
    );

    for (const claim of [own, absorbed]) {
      expect(claim.commit).toHaveBeenCalledOnce();
      expect(claim.release).not.toHaveBeenCalled();
    }
  });

  it("releases absorbed claims when the merged event fails", async () => {
    const own = createClaim("own");
    const absorbed = createClaim("absorbed");
    const { handler } = createMatrixHandlerTestHarness({
      inboundDeduper: createDeduper(own),
      runtime: { error: vi.fn() } as never,
      recordInboundSession: vi.fn(async () => {
        throw new Error("disk failed");
      }),
      dispatchInboundMessage: vi.fn(async () => ({
        queuedFinal: true,
        counts: { final: 1, block: 0, tool: 0 },
      })),
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({ eventId: "$merged-fail", body: "one\ntwo" }),
      { absorbedReplayClaims: [absorbed] },
    );

    for (const claim of [own, absorbed]) {
      expect(claim.commit).not.toHaveBeenCalled();
      expect(claim.release).toHaveBeenCalledOnce();
    }
  });

  it("adopts the debounce flush's claim instead of claiming the event again", async () => {
    const preclaimed = createClaim("preclaimed");
    const inboundDeduper = createDeduper(createClaim("unused"));
    const { handler } = createMatrixHandlerTestHarness({
      accountAllowBots: true,
      configuredBotUserIds: new Set(["@ops:example.org"]),
      inboundDeduper,
      isDirectMessage: false,
      roomsConfig: {
        "!room:example.org": { requireMention: false },
      },
      runPrepared: vi.fn(
        async (turn: { ctxPayload: Record<string, unknown>; routeSessionKey: string }) => ({
          admission: { kind: "drop" as const, reason: "bot-loop-protection" as const },
          dispatched: false as const,
          ctxPayload: turn.ctxPayload,
          routeSessionKey: turn.routeSessionKey,
        }),
      ),
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({ eventId: "$merged", sender: "@ops:example.org", body: "hi" }),
      { replayClaim: preclaimed },
    );

    expect(inboundDeduper.claim).not.toHaveBeenCalled();
    expect(preclaimed.commit).toHaveBeenCalledOnce();
    expect(preclaimed.release).not.toHaveBeenCalled();
  });

  it("releases debounce-owned claims when ingress drops the merged event", async () => {
    const preclaimed = createClaim("preclaimed");
    const absorbed = createClaim("absorbed");
    const { handler } = createMatrixHandlerTestHarness({
      inboundDeduper: createDeduper(createClaim("unused")),
      startupMs: Number.MAX_SAFE_INTEGER,
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({ eventId: "$history", body: "old", originServerTs: 1 }),
      { replayClaim: preclaimed, absorbedReplayClaims: [absorbed] },
    );

    for (const claim of [preclaimed, absorbed]) {
      expect(claim.commit).not.toHaveBeenCalled();
      expect(claim.release).toHaveBeenCalledOnce();
    }
  });
});
