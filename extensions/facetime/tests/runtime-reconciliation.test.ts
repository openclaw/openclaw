import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HelperActionResult } from "../src/helper-results.js";
import type { FaceTimeHelperPeer } from "../src/helper-rpc.js";
import { PendingFaceTimeDialStore } from "../src/pending-dial-store.js";
import {
  createRuntime,
  FaceTimeHelperActionError,
  mocks,
  pendingDialCancellationResult,
  pendingDialState,
  resetRuntimeTestState,
} from "./runtime.test-support.js";

const originalPeer: FaceTimeHelperPeer = {
  bundleIdentifier: "com.apple.FaceTime",
  processId: 4321,
  processStartedAtMs: Date.parse("Tue Nov 14 22:13:20 2023"),
  connectionGeneration: 1,
};
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

function topologyResult(helperResults: ReturnType<typeof absentPeer>[], generation = 3) {
  return {
    topologyComplete: true,
    topologyGeneration: generation,
    helpersContacted: helperResults.length,
    helperResults,
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

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

function endedCall(callUUID: string, dialID: string | undefined) {
  return {
    event: "ft-call-status-changed",
    data: {
      dial_id: dialID,
      call_uuid: callUUID,
      call_status: 6,
      has_ended: true,
      is_outgoing: true,
    },
  };
}

describe("FaceTime pending dial reconciliation", () => {
  beforeEach(async () => {
    await resetRuntimeTestState();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("preserves newly identified carriers when an older absence reply arrives", async () => {
    const state = await pendingDialState();
    const absence = topologyResult([absentPeer(originalPeer)]);
    let finishStaleReply = (_result: HelperActionResult) => {};
    const staleReply = new Promise<HelperActionResult>((resolve) => {
      finishStaleReply = resolve;
    });
    let queryPending = false;
    let concurrentQueries = 0;
    mocks.helper.findOutgoingCall
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
    const runtime = await createRuntime(state);
    try {
      mocks.helperParams?.onConnect(originalPeer.bundleIdentifier);
      await vi.advanceTimersByTimeAsync(250);
      expect(queryPending).toBe(true);
      await mocks.helperParams?.onMessage(
        {
          event: "ft-outbound-call-identified",
          data: { dial_id: "approved-dial", call_uuid: "identified-call" },
        },
        originalPeer,
      );
      mocks.helperParams?.onConnect(siblingPeer.bundleIdentifier);
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
      await mocks.helperParams?.onMessage(endedCall("identified-call", "approved-dial"));
      await vi.advanceTimersByTimeAsync(250);
      await runtime.stop();
    }
  });

  it("requires two matching absence snapshots after native identity changes", async () => {
    const state = await pendingDialState();
    mocks.helper.findOutgoingCall.mockResolvedValue(topologyResult([absentPeer(originalPeer)]));
    const deleted = observeDeletion();
    const runtime = await createRuntime(state);
    try {
      mocks.helperParams?.onConnect(originalPeer.bundleIdentifier);
      await vi.advanceTimersByTimeAsync(0);
      await mocks.helperParams?.onMessage(
        {
          event: "ft-outbound-call-identified",
          data: { dial_id: "approved-dial", call_uuid: "identified-call" },
        },
        originalPeer,
      );
      await vi.advanceTimersByTimeAsync(250);
      expect(await state.lookup("active")).toMatchObject({ callUUID: "identified-call" });
      await vi.advanceTimersByTimeAsync(250);
      await deleted;
      expect(await state.lookup("active")).toBeUndefined();
    } finally {
      await mocks.helperParams?.onMessage(endedCall("identified-call", "approved-dial"));
      await vi.advanceTimersByTimeAsync(250);
      await runtime.stop();
    }
  });

  it("retains a dial when its helper reports an error after creating the carrier", async () => {
    mocks.helper.startCall.mockRejectedValueOnce(
      new FaceTimeHelperActionError("Outbound safety mute was not retained while ringing"),
    );
    const queryStarted = deferred();
    mocks.helper.findOutgoingCall.mockImplementation(async () => {
      queryStarted.resolve();
      return topologyResult([absentPeer(originalPeer, true)]);
    });
    const runtime = await createRuntime();
    const dialing = runtime.dial({ handle: "owner@example.com" });
    const rejected = expect(dialing).rejects.toThrow("Outbound safety mute was not retained");
    const dialID = (await runtime.status()).outboundCallPending?.dialID;
    try {
      await queryStarted.promise;
      await vi.advanceTimersByTimeAsync(3_000);
      await rejected;
      expect((await runtime.status()).outboundCallPending).toMatchObject({
        dialID,
        delivery: "ambiguous",
      });
      await expect(runtime.dial({ handle: "owner@example.com" })).rejects.toThrow(
        "already pending",
      );
    } finally {
      await mocks.helperParams?.onMessage(endedCall("approved-call", dialID));
      await runtime.stop();
    }
  });

  it.each([
    {
      evidence: "the original helper still retains the dial",
      helperResults: [absentPeer(originalPeer, true), absentPeer(siblingPeer)],
    },
    {
      evidence: "the original helper is disconnected",
      helperResults: [absentPeer(siblingPeer)],
    },
  ])("keeps cancellation pending while $evidence", async ({ helperResults }) => {
    const state = await pendingDialState({ delivery: "cancelling" });
    mocks.helper.findOutgoingCall.mockResolvedValue(topologyResult(helperResults));
    const cancellation = pendingDialCancellationResult();
    for (const entry of cancellation.helperResults) {
      if (entry.cancelled) {
        Object.assign(entry, { call_uuid: "cancelled-call" });
      }
    }
    mocks.helper.cancelOutgoingCall.mockResolvedValue(cancellation);
    const deleted = observeDeletion();
    const runtime = await createRuntime(state);
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
    try {
      await mocks.helperParams?.onMessage(
        {
          event: "ft-outbound-call-identified",
          data: {
            dial_id: "approved-dial",
            call_uuid: "approved-call",
            proxy_identifier: "approved-proxy",
          },
        },
        originalPeer,
      );
      mocks.helperParams?.onConnect(siblingPeer.bundleIdentifier);
      await vi.advanceTimersByTimeAsync(3_000);
      await cancellationPublished.promise;

      expect(await state.lookup("active")).toMatchObject({
        dialID: "approved-dial",
        delivery: "cancelling",
      });
      await expect(runtime.dial({ handle: "owner@example.com" })).rejects.toThrow(
        "already pending",
      );

      mocks.helper.findOutgoingCall.mockResolvedValue(
        topologyResult([absentPeer(originalPeer)], 4),
      );
      mocks.helperParams?.onDisconnect(siblingPeer.bundleIdentifier);
      mocks.helperParams?.onConnect(originalPeer.bundleIdentifier);
      await vi.advanceTimersByTimeAsync(250);
      await deleted;
      expect(await state.lookup("active")).toBeUndefined();
      expect((await runtime.status()).outboundCallPending).toBeUndefined();
    } finally {
      await mocks.helperParams?.onMessage(endedCall("approved-call", "approved-dial"));
      await runtime.stop();
    }
  });
});
