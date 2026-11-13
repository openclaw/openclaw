import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HelperActionResult } from "../src/helper-results.js";
import type { FaceTimeHelperPeer } from "../src/helper-rpc.js";
import { PendingFaceTimeDialStore } from "../src/pending-dial-store.js";
import * as ft from "./runtime.test-support.js";

const originalPeer: FaceTimeHelperPeer = { ...ft.carrierPeer, connectionGeneration: 1 };
const siblingPeer: FaceTimeHelperPeer = {
  ...originalPeer,
  bundleIdentifier: "com.apple.FaceTime.FTConversationService",
  processId: 4322,
  connectionGeneration: 2,
};

function absentPeer(peer: FaceTimeHelperPeer, retained = false) {
  return {
    found: false,
    retained_outbound_dial: retained,
    helperBundleIdentifier: peer.bundleIdentifier,
    helperPeer: peer,
  };
}

function topologyResult(helperResults: readonly ReturnType<typeof absentPeer>[], generation = 3) {
  return ft.helperResult([...helperResults], true, generation);
}

const deferred = () => Promise.withResolvers<void>();
const identifiedCall = (callUUID = "identified-call", proxy_identifier?: string) => ({
  event: "ft-outbound-call-identified",
  data: {
    dial_id: "approved-dial",
    call_uuid: callUUID,
    ...(proxy_identifier ? { proxy_identifier } : {}),
  },
});

function observeDeletion() {
  const deleted = deferred();
  // oxlint-disable-next-line typescript/unbound-method -- The interceptor calls the original with the runtime store as its explicit receiver below.
  const clear = PendingFaceTimeDialStore.prototype.clear;
  vi.spyOn(PendingFaceTimeDialStore.prototype, "clear").mockImplementation(function (
    this: PendingFaceTimeDialStore,
    ...args
  ) {
    const clearing = clear.apply(this, args);
    void clearing.then(
      (applied) => {
        if (applied) {
          // Let the runtime publish the completed clear before observing its status.
          queueMicrotask(deleted.resolve);
        }
      },
      () => undefined,
    );
    return clearing;
  });
  return deleted.promise;
}

describe("FaceTime pending dial reconciliation", () => {
  const { helper } = ft.mocks;
  let events: NonNullable<typeof ft.mocks.helperParams>;
  let cleanup = async () => {};
  async function start(
    state = ft.emptyState(),
    terminal = ft.endedCall("identified-call", { dial_id: "approved-dial" }),
  ) {
    const runtime = await ft.createRuntime(state);
    events = ft.mocks.helperParams!;
    cleanup = async () => {
      await events.onMessage(terminal);
      await vi.advanceTimersByTimeAsync(250);
      await runtime.stop();
    };
    return runtime;
  }
  beforeEach(async () => {
    cleanup = async () => {};
    await ft.resetRuntimeTestState();
    vi.useFakeTimers();
  });
  afterEach(async () => {
    try {
      await cleanup();
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it("preserves newly identified carriers when an older absence reply arrives", async () => {
    const state = await ft.pendingDialState();
    const absence = topologyResult([absentPeer(originalPeer)]);
    const { promise: staleReply, resolve: finishStaleReply } =
      Promise.withResolvers<HelperActionResult>();
    let queryPending = false;
    let concurrentQueries = 0;
    helper.findOutgoingCall
      .mockResolvedValueOnce(absence)
      .mockImplementationOnce(() => {
        queryPending = true;
        return staleReply.finally(() => {
          queryPending = false;
        });
      })
      .mockImplementation(async () => {
        if (queryPending) {
          concurrentQueries += 1;
        }
        return {
          ...absence,
          helperResults: [
            { ...absentPeer(originalPeer), found: true, call_uuid: "identified-call" },
          ],
        };
      });
    const runtime = await start(state);
    try {
      events.onConnect(originalPeer.bundleIdentifier);
      await vi.advanceTimersByTimeAsync(250);
      expect(queryPending).toBe(true);
      await events.onMessage(identifiedCall(), originalPeer);
      events.onConnect(siblingPeer.bundleIdentifier);
      await vi.advanceTimersByTimeAsync(0);
      finishStaleReply(absence);
      await vi.advanceTimersByTimeAsync(0);

      expect(await state.lookup("active")).toMatchObject({ callUUID: "identified-call" });
      expect(concurrentQueries).toBe(0);
      await expect(runtime.dial({ handle: "owner@example.com" })).rejects.toThrow(
        "already pending",
      );
    } finally {
      finishStaleReply(absence);
    }
  });

  it("requires two matching absence snapshots after native identity changes", async () => {
    const state = await ft.pendingDialState();
    helper.findOutgoingCall.mockResolvedValue(topologyResult([absentPeer(originalPeer)]));
    const deleted = observeDeletion();
    await start(state);
    events.onConnect(originalPeer.bundleIdentifier);
    await vi.advanceTimersByTimeAsync(0);
    await events.onMessage(identifiedCall(), originalPeer);
    await vi.advanceTimersByTimeAsync(250);
    expect(await state.lookup("active")).toMatchObject({ callUUID: "identified-call" });
    await vi.advanceTimersByTimeAsync(250);
    await deleted;
    expect(await state.lookup("active")).toBeUndefined();
  });

  it("retains a dial when its helper reports an error after creating the carrier", async () => {
    helper.startCall.mockRejectedValueOnce(
      new Error("Outbound safety mute was not retained while ringing"),
    );
    const queryStarted = deferred();
    helper.findOutgoingCall.mockImplementation(async () => {
      queryStarted.resolve();
      return topologyResult([absentPeer(originalPeer, true)]);
    });
    const terminal = ft.endedCall("approved-call");
    const runtime = await start(undefined, terminal);
    const dialing = runtime.dial({ handle: "owner@example.com" });
    const rejected = expect(dialing).rejects.toThrow("Outbound safety mute was not retained");
    const dialID = (await runtime.status()).outboundCallPending?.dialID;
    terminal.data.dial_id = dialID;
    await queryStarted.promise;
    await vi.advanceTimersByTimeAsync(3_000);
    await rejected;
    expect((await runtime.status()).outboundCallPending).toMatchObject({
      dialID,
      delivery: "ambiguous",
    });
    await expect(runtime.dial({ handle: "owner@example.com" })).rejects.toThrow("already pending");
  });

  it.each([
    [
      "the original helper still retains the dial",
      [absentPeer(originalPeer, true), absentPeer(siblingPeer)],
    ],
    ["the original helper is disconnected", [absentPeer(siblingPeer)]],
  ] as const)("keeps cancellation pending while %s", async (_evidence, helperResults) => {
    const state = await ft.pendingDialState({ delivery: "cancelling" });
    helper.findOutgoingCall.mockResolvedValue(topologyResult(helperResults));
    helper.cancelOutgoingCall.mockResolvedValue(ft.pendingDialCancellationResult("cancelled-call"));
    const deleted = observeDeletion();
    const runtime = await start(state, ft.endedCall("approved-call", { dial_id: "approved-dial" }));
    const cancellationPublished = deferred();
    const register = state.register.bind(state);
    vi.spyOn(state, "register").mockImplementation(async (...args) => {
      await register(...args);
      const value = args[1];
      if (
        value &&
        typeof value === "object" &&
        "callUUID" in value &&
        value.callUUID === "cancelled-call"
      ) {
        cancellationPublished.resolve();
      }
    });
    await events.onMessage(identifiedCall("approved-call", "approved-proxy"), originalPeer);
    events.onConnect(siblingPeer.bundleIdentifier);
    await vi.advanceTimersByTimeAsync(3_000);
    await cancellationPublished.promise;

    expect(await state.lookup("active")).toMatchObject({
      dialID: "approved-dial",
      delivery: "cancelling",
    });
    await expect(runtime.dial({ handle: "owner@example.com" })).rejects.toThrow("already pending");

    helper.findOutgoingCall.mockResolvedValue(topologyResult([absentPeer(originalPeer)], 4));
    events.onDisconnect(siblingPeer.bundleIdentifier);
    events.onConnect(originalPeer.bundleIdentifier);
    await vi.advanceTimersByTimeAsync(250);
    await deleted;
    expect(await state.lookup("active")).toBeUndefined();
    expect((await runtime.status()).outboundCallPending).toBeUndefined();
  });
});
