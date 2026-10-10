import fs from "node:fs";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createEventManagerHarness } from "../manager.test-harness.js";
import { PlivoProvider } from "../providers/plivo.js";
import type { InitiateCallResult } from "../types.js";
import { processEvent } from "./events.js";
import { initiateCall, speak } from "./outbound.js";
import { getCallHistoryFromStore, loadActiveCallsFromStore } from "./store.js";

const { cleanup, createContext, createProvider, setup } = createEventManagerHarness();
beforeEach(setup);
afterEach(cleanup);

it.each([
  { phase: "active", requestUuid: undefined, payload: "CallUUID-only parser control" },
  { phase: "active", requestUuid: "request-uuid", payload: "complete callback" },
  { phase: "ended", requestUuid: "request-uuid", payload: "complete callback" },
])(
  "preserves callback-owned identity when initiation settles after the call is $phase ($payload)",
  async ({ phase, requestUuid }) => {
    const placement = createDeferred<InitiateCallResult>();
    const placementStarted = createDeferred<void>();
    const playback = vi.fn(async () => {});
    const ctx = createContext({
      provider: createProvider({
        initiateCall: () => {
          placementStarted.resolve();
          return placement.promise;
        },
        playTts: playback,
      }),
      webhookUrl: "https://example.com/voice/webhook",
    });
    const parser = new PlivoProvider({ authId: "MA-fixture", authToken: "synthetic-token" });
    const pending = initiateCall(ctx, "+15550000001");
    try {
      await Promise.race([placementStarted.promise, pending]);
      const call = [...ctx.activeCalls.values()][0];
      if (!call) {
        throw new Error("expected the pending outbound call");
      }
      const deliver = async (fields: Record<string, string>) => {
        const parsed = parser.parseWebhookEvent({
          headers: {},
          method: "POST",
          url: `https://example.com/voice/webhook?callId=${call.callId}`,
          query: { callId: call.callId },
          rawBody: new URLSearchParams({
            CallUUID: "canonical-call-uuid",
            ...(requestUuid ? { RequestUUID: requestUuid } : {}),
            Direction: "outbound",
            ...fields,
          }).toString(),
        });
        expect(parsed.events).toHaveLength(1);
        for (const event of parsed.events) {
          await processEvent(ctx, event);
        }
      };
      await deliver({ CallStatus: "in-progress" });
      expect(call.providerCallId).toBe("canonical-call-uuid");
      if (phase === "ended") {
        await deliver({ CallStatus: "completed" });
      }
      const beforeResult = await getCallHistoryFromStore(ctx.storePath);

      placement.resolve({ providerCallId: "request-uuid", status: "initiated" });
      await expect(pending).resolves.toEqual({ callId: call.callId, success: true });
      expect(call.providerCallId).toBe("canonical-call-uuid");

      if (phase === "active") {
        await deliver({ CallStatus: "in-progress", Speech: "Continue the connected call." });
        await expect(speak(ctx, call.callId, "Still connected.")).resolves.toEqual({
          success: true,
        });
        expect(playback).toHaveBeenCalledWith(
          expect.objectContaining({ callId: call.callId, providerCallId: "canonical-call-uuid" }),
        );
        expect(ctx.providerCallIdMap).toEqual(new Map([["canonical-call-uuid", call.callId]]));
      } else {
        expect(await getCallHistoryFromStore(ctx.storePath)).toEqual(beforeResult);
        expect(ctx.activeCalls.size).toBe(0);
        expect(ctx.providerCallIdMap.size).toBe(0);
      }
    } finally {
      placement.resolve({ providerCallId: "request-uuid", status: "initiated" });
      await pending;
    }
  },
);

it("keeps outbound capacity available after storage failure without dialing", async () => {
  const placement = createDeferred<InitiateCallResult>();
  const placementStarted = createDeferred<void>();
  const dial = vi.fn(() => {
    placementStarted.resolve();
    return placement.promise;
  });
  const ctx = createContext({
    provider: createProvider({ initiateCall: dial }),
    webhookUrl: "https://example.com/voice/webhook",
  });
  ctx.config.maxConcurrentCalls = 1;
  const statePath = path.join(ctx.storePath, "state");
  fs.writeFileSync(statePath, "block the database directory");

  await expect(initiateCall(ctx, "+15550000001")).rejects.toMatchObject({
    code: "PLUGIN_STATE_OPEN_FAILED",
  });
  expect(dial).not.toHaveBeenCalled();
  expect(ctx.activeCalls.size).toBe(0);
  expect(ctx.providerCallIdMap.size).toBe(0);

  fs.unlinkSync(statePath);
  const recovered = initiateCall(ctx, "+15550000001");
  try {
    await expect(initiateCall(ctx, "+15550000002")).resolves.toMatchObject({
      success: false,
      error: "Maximum concurrent calls (1) reached",
    });
    await Promise.race([placementStarted.promise, recovered]);
    expect(dial).toHaveBeenCalledOnce();
  } finally {
    placement.resolve({ providerCallId: "provider-recovered", status: "initiated" });
    await recovered;
  }
  const result = await recovered;
  expect(result.success).toBe(true);
  expect(ctx.activeCalls.size).toBe(1);
  expect(ctx.providerCallIdMap.get("provider-recovered")).toBe(result.callId);
  expect(
    (await loadActiveCallsFromStore(ctx.storePath)).activeCalls.get(result.callId),
  ).toMatchObject({
    providerCallId: "provider-recovered",
    state: "initiated",
  });
});

it.each([
  { phase: "terminal", playbackFails: false },
  { phase: "terminal", playbackFails: true },
  { phase: "replaced", playbackFails: false },
  { phase: "replaced", playbackFails: true },
] as const)(
  "does not rewrite a $phase call after delayed playback (failure=$playbackFails)",
  async ({ phase, playbackFails }) => {
    const playbackStarted = createDeferred<void>();
    const playback = createDeferred<void>();
    const ctx = createContext({
      provider: createProvider({
        playTts: () => {
          playbackStarted.resolve();
          return playback.promise;
        },
      }),
      webhookUrl: "https://example.com/voice/webhook",
    });
    const started = await initiateCall(ctx, "+15550000001");
    expect(started.success).toBe(true);
    const call = ctx.activeCalls.get(started.callId);
    if (!call) {
      throw new Error("expected the connected outbound call");
    }
    const pending = speak(ctx, call.callId, "Pending playback");
    const replacement = { ...structuredClone(call), state: "active" as const };
    let historyBeforeSettlement: Awaited<ReturnType<typeof getCallHistoryFromStore>>;
    try {
      await Promise.race([playbackStarted.promise, pending]);
      if (phase === "terminal") {
        await processEvent(ctx, {
          id: "ended-during-playback",
          type: "call.ended",
          callId: call.callId,
          providerCallId: call.providerCallId,
          timestamp: Date.now(),
          reason: "completed",
        });
      } else {
        ctx.activeCalls.set(call.callId, replacement);
      }
      historyBeforeSettlement = await getCallHistoryFromStore(ctx.storePath);
    } finally {
      if (playbackFails) {
        playback.reject(new Error("playback interrupted"));
      } else {
        playback.resolve();
      }
      await pending;
    }
    await expect(pending).resolves.toEqual({
      success: false,
      error: playbackFails ? "playback interrupted" : "Call has ended",
    });
    expect(await getCallHistoryFromStore(ctx.storePath)).toEqual(historyBeforeSettlement);
    if (phase === "terminal") {
      expect(ctx.activeCalls.has(call.callId)).toBe(false);
      expect(call.state).toBe("completed");
    } else {
      expect(ctx.activeCalls.get(call.callId)).toBe(replacement);
      expect(replacement.state).toBe("active");
      expect(replacement.transcript).toEqual([]);
    }
  },
);
