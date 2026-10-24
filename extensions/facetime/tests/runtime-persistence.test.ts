import { observeHostDataSql } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRuntime,
  createTalkDriver,
  carrierPeer,
  dialReply,
  emptyState,
  expectNotCalled,
  failTalkStartup,
  incomingCall,
  mocks,
  pendingDialCancellationResult,
  pendingDialCarrierResult,
  pendingDialState,
  resetRuntimeTestState,
} from "./runtime.test-support.js";

const { helper, startTalk } = mocks;

const deferred = () => Promise.withResolvers<void>();

function barrier() {
  const entered = deferred();
  const release = deferred();
  return {
    entered: entered.promise,
    release: release.resolve,
    wait: async () => {
      entered.resolve();
      await release.promise;
    },
  };
}

function suspendNextWrite(state: ReturnType<typeof emptyState>) {
  const pause = barrier();
  const register = state.register.bind(state);
  vi.spyOn(state, "register").mockImplementationOnce(async (...args) => {
    await pause.wait();
    await register(...args);
  });
  return pause;
}

function outgoingCall(dialID: string, status: number) {
  return incomingCall(status, { dial_id: dialID, call_uuid: "outbound-call", is_outgoing: true });
}

describe("FaceTime runtime asynchronous persistence", () => {
  beforeEach(async () => {
    await resetRuntimeTestState();
    helper.cancelOutgoingCall.mockResolvedValue(pendingDialCancellationResult());
    helper.findOutgoingCall.mockResolvedValue(pendingDialCarrierResult());
  });

  it.each(["open", "lookup"] as const)(
    "propagates a V2 %s failure before starting the helper",
    async (stage) => {
      const state = emptyState();
      const failure = new Error("worker state unavailable");
      const openKeyedStoreV2 = vi.fn(() => {
        if (stage === "open") {
          throw failure;
        }
        return state;
      });
      if (stage === "lookup") {
        vi.spyOn(state, "lookup").mockRejectedValueOnce(failure);
      }

      await expect(createRuntime(state, undefined, { openKeyedStoreV2 })).rejects.toBe(failure);
      expect(openKeyedStoreV2).toHaveBeenCalledOnce();
      expect(helper.start).not.toHaveBeenCalled();
    },
  );

  it("never dispatches a helper dial when its initial persistence fails", async () => {
    const state = emptyState();
    const runtime = await createRuntime(state);
    const failure = new Error("pending dial publication failed");
    vi.spyOn(state, "register").mockRejectedValueOnce(failure);
    try {
      await expect(runtime.dial({ handle: "owner@example.com" })).rejects.toBe(failure);

      expect(helper.startCall).not.toHaveBeenCalled();
      expect(await state.lookup("active")).toBeUndefined();
    } finally {
      await runtime.stop();
    }
  });

  it.each([4, 1])(
    "reserves outbound admission until durable publication while incoming status %s arrives",
    async (callStatus) => {
      const state = emptyState();
      const runtime = await createRuntime(state);
      const hostSql = observeHostDataSql();
      startTalk.mockResolvedValue(createTalkDriver({}));
      helper.startCall.mockImplementation(async (_request: unknown, dialID: string) => {
        expect(await state.lookup("active")).toMatchObject({ dialID, delivery: "in-flight" });
        return dialReply("outbound-call", { dial_id: dialID });
      });
      const write = suspendNextWrite(state);
      const dialing = runtime.dial({ handle: "owner@example.com" });
      const outcome = dialing.then(
        () => undefined,
        (error: unknown) => error,
      );
      try {
        await write.entered;
        expect(await state.lookup("active")).toBeUndefined();
        await mocks.helperParams?.onMessage(incomingCall(callStatus));
        expect((await runtime.status()).calls).toEqual([]);

        expectNotCalled(helper.answerCall, startTalk, helper.startCall);
        write.release();
        expect(await outcome).toBeUndefined();
        expect(helper.startCall).toHaveBeenCalledOnce();
        expect(helper.cancelOutgoingCall).not.toHaveBeenCalled();
        expect(await state.lookup("active")).toMatchObject({ delivery: "accepted" });
        const pending = (await runtime.status()).outboundCallPending!;
        await mocks.helperParams?.onMessage(outgoingCall(pending.dialID, 6));
        expect(await state.lookup("active")).toBeUndefined();
        for (const call of hostSql.calls) {
          expect(call).not.toHaveBeenCalled();
        }
      } finally {
        hostSql.restore();
        write.release();
        await outcome;
        await runtime.stop();
      }
    },
  );

  it("does not retire an undispatched dial when a helper connects during persistence", async () => {
    const state = emptyState();
    const runtime = await createRuntime(state);
    const write = suspendNextWrite(state);
    helper.findOutgoingCall.mockResolvedValue({
      topologyComplete: true,
      topologyGeneration: 1,
      helpersContacted: 1,
      helperResults: [{ found: false, helperBundleIdentifier: "com.apple.FaceTime" }],
    });
    helper.startCall.mockResolvedValue(dialReply());
    vi.useFakeTimers();
    const dialing = runtime.dial({ handle: "owner@example.com" });
    const outcome = dialing.then(
      (result) => result,
      (error: unknown) => error,
    );
    try {
      await write.entered;
      mocks.helperParams?.onConnect("com.apple.FaceTime");
      await vi.advanceTimersByTimeAsync(250);
      write.release();
      expect(await outcome).toMatchObject({ callUUID: "outbound-call" });
      expect(helper.startCall).toHaveBeenCalledOnce();
    } finally {
      write.release();
      await outcome;
      const pending = (await runtime.status()).outboundCallPending;
      if (pending) {
        await mocks.helperParams?.onMessage(outgoingCall(pending.dialID, 6));
      }
      await runtime.stop();
      vi.useRealTimers();
    }
  });

  it("fences managed-call activation before cancellation persistence settles", async () => {
    const state = await pendingDialState();
    const runtime = await createRuntime(state);
    const readiness = barrier();
    const talk = createTalkDriver({ readyForAudio: readiness.wait });
    const activated = deferred();
    talk.activate.mockImplementation(activated.resolve);
    startTalk.mockResolvedValue(talk);
    const active = mocks.helperParams?.onMessage(outgoingCall("approved-dial", 1));
    await readiness.entered;
    const write = suspendNextWrite(state);
    const hangingUp = runtime.hangup();
    const outcome = hangingUp.then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      await write.entered;
      readiness.release();
      await Promise.race([active, activated.promise]);
      expectNotCalled(talk.activate, helper.setMuted, helper.startTransmission, helper.leaveCall);
      write.release();
      expect(await outcome).toBeUndefined();
    } finally {
      write.release();
      readiness.release();
      await Promise.all([active, outcome]);
      await runtime.stop();
    }
  });

  it("reports shutdown cleanup failure while startup still waits for carrier closure", async () => {
    const state = emptyState();
    const runtime = await createRuntime(state);
    const inspected = deferred();
    const helperStopped = deferred();
    const releaseStartup = deferred();
    const startup = failTalkStartup(releaseStartup.promise);
    helper.inspectCall.mockImplementation(async () => {
      inspected.resolve();
      throw new Error("carrier inspection unavailable");
    });
    helper.stop.mockImplementation(async () => helperStopped.resolve());
    mocks.systemRun.mockRejectedValue(new Error("carrier process cannot be terminated"));
    vi.useFakeTimers();
    const active = mocks.helperParams?.onMessage(incomingCall(4), carrierPeer);
    let stopError: unknown;
    let stopping: Promise<void> | undefined;
    try {
      await inspected.promise;
      stopping = runtime.stop().catch((error: unknown) => {
        stopError = error;
      });
      await helperStopped.promise;
      await stopping;
      expect(stopError).toEqual(
        expect.objectContaining({
          message: expect.stringContaining("carrier closure remains unconfirmed"),
        }),
      );
      expect((await runtime.status()).calls).toMatchObject([{ phase: "closing" }]);
      expect(helper.answerCall).not.toHaveBeenCalled();
    } finally {
      releaseStartup.resolve();
      await active;
      await vi.advanceTimersByTimeAsync(1_000);
      await startup.closure;
      await stopping;
      vi.useRealTimers();
    }
  });

  it("does not promote or resurrect a dial ended while an earlier event save is suspended", async () => {
    const state = await pendingDialState();
    const runtime = await createRuntime(state);
    const talk = createTalkDriver({});
    startTalk.mockResolvedValue(talk);
    const write = suspendNextWrite(state);
    const active = mocks.helperParams?.onMessage(outgoingCall("approved-dial", 1));
    let ended: void | Promise<void>;
    try {
      await write.entered;
      ended = mocks.helperParams?.onMessage(outgoingCall("approved-dial", 6));
      expect(startTalk).not.toHaveBeenCalled();

      write.release();
      await Promise.all([active, ended]);

      expectNotCalled(startTalk, helper.setMuted);
      expect((await runtime.status()).calls).toEqual([]);
      expect((await runtime.status()).outboundCallPending).toBeUndefined();
      expect(await state.lookup("active")).toBeUndefined();
    } finally {
      write.release();
      await active;
      await runtime.stop();
    }
  });

  it("joins an initial pending save during stop and prevents helper dispatch afterward", async () => {
    const state = emptyState();
    const runtime = await createRuntime(state);
    const write = suspendNextWrite(state);
    const dialing = runtime.dial({ handle: "owner@example.com" });
    const rejectedDial = expect(dialing).rejects.toThrow("cancelled before helper dispatch");
    await write.entered;
    let stopped = false;
    const stopping = runtime.stop().then(() => {
      stopped = true;
    });
    try {
      await Promise.resolve();
      expect(stopped).toBe(false);
      expectNotCalled(helper.stop, helper.startCall);

      write.release();
      await Promise.all([rejectedDial, stopping]);

      expect(helper.startCall).not.toHaveBeenCalled();
      expect(helper.stop).toHaveBeenCalledOnce();
      expect(await state.lookup("active")).toBeUndefined();
    } finally {
      write.release();
      await Promise.all([rejectedDial, stopping]);
    }
  });

  it("closes a promoted call before pending deletion settles and fences delayed readiness", async () => {
    const state = await pendingDialState();
    const readiness = barrier();
    const talkClosed = deferred();
    const talk = createTalkDriver({ readyForAudio: readiness.wait });
    talk.close.mockImplementation(async () => talkClosed.resolve());
    startTalk.mockResolvedValue(talk);
    const deletion = barrier();
    const observe = state.observe.bind(state);
    vi.spyOn(state, "observe").mockImplementationOnce(async (...args) => {
      await deletion.wait();
      return await observe(...args);
    });
    const runtime = await createRuntime(state);
    const active = mocks.helperParams?.onMessage(outgoingCall("approved-dial", 1));
    let ended: void | Promise<void> = undefined;
    try {
      await readiness.entered;
      ended = mocks.helperParams?.onMessage(outgoingCall("approved-dial", 6));
      await deletion.entered;

      expect((await runtime.status()).calls).toMatchObject([{ phase: "closing" }]);
      expect(await state.lookup("active")).toMatchObject({ dialID: "approved-dial" });
      readiness.release();
      await active;
      await talkClosed.promise;
      expect(talk.close).toHaveBeenCalledWith("native-ended");
      expectNotCalled(talk.activate, helper.setMuted, helper.startTransmission);

      deletion.release();
      await ended;
      expect((await runtime.status()).calls).toEqual([]);
      expect(await state.lookup("active")).toBeUndefined();
    } finally {
      readiness.release();
      deletion.release();
      await Promise.all([active, ended]);
      await runtime.stop();
    }
  });

  it("publishes cancellation intent before asking the helper to cancel", async () => {
    const state = await pendingDialState();
    const runtime = await createRuntime(state);
    const write = suspendNextWrite(state);
    helper.cancelOutgoingCall.mockImplementationOnce(async () => {
      expect(await state.lookup("active")).toMatchObject({
        dialID: "approved-dial",
        delivery: "cancelling",
      });
      return pendingDialCancellationResult();
    });
    const hangingUp = runtime.hangup();
    try {
      await write.entered;
      expect(helper.cancelOutgoingCall).not.toHaveBeenCalled();
      expect(await state.lookup("active")).toMatchObject({ delivery: "accepted" });

      write.release();
      await expect(hangingUp).resolves.toMatchObject({ dialID: "approved-dial" });
      expect(helper.cancelOutgoingCall).toHaveBeenCalledOnce();
      await mocks.helperParams?.onMessage(outgoingCall("approved-dial", 6));
      expect(await state.lookup("active")).toBeUndefined();
    } finally {
      write.release();
      await hangingUp;
      await runtime.stop();
    }
  });

  it("does not republish a terminal dial when stop overlaps delivery of its deletion result", async () => {
    const state = await pendingDialState();
    const deletion = barrier();
    const compareAndApply = state.compareAndApply.bind(state);
    vi.spyOn(state, "compareAndApply").mockImplementationOnce(async (...args) => {
      const result = await compareAndApply(...args);
      await deletion.wait();
      return result;
    });
    const runtime = await createRuntime(state);
    const register = vi.spyOn(state, "register");
    const ended = mocks.helperParams?.onMessage(outgoingCall("approved-dial", 6));
    let stopping: Promise<void> | undefined;
    try {
      await deletion.entered;
      expect(await state.lookup("active")).toBeUndefined();
      stopping = runtime.stop();
      await Promise.resolve();

      deletion.release();
      await Promise.all([ended, stopping]);

      expectNotCalled(register, helper.cancelOutgoingCall);
      expect(await state.lookup("active")).toBeUndefined();
    } finally {
      deletion.release();
      await ended;
      await (stopping ?? runtime.stop());
    }
  });

  it("joins a late helper reply during stop after a terminal event clears the pending dial", async () => {
    const state = emptyState();
    const runtime = await createRuntime(state);
    const reply = barrier();
    helper.startCall.mockImplementationOnce(async (_request: unknown, dialID: string) => {
      await reply.wait();
      return dialReply("outbound-call", { dial_id: dialID });
    });
    const dialing = runtime.dial({ handle: "owner@example.com" });
    let stopping: Promise<void> | undefined;
    try {
      await reply.entered;
      const dialID = (await runtime.status()).outboundCallPending!.dialID;
      await mocks.helperParams?.onMessage(outgoingCall(dialID, 6));
      expect((await runtime.status()).outboundCallPending).toBeUndefined();
      let stopped = false;
      stopping = runtime.stop().then(() => {
        stopped = true;
      });

      expect(await state.lookup("active")).toBeUndefined();
      expect(stopped).toBe(false);
      expect(helper.stop).not.toHaveBeenCalled();
      reply.release();
      await Promise.all([dialing, stopping]);

      expect(helper.stop).toHaveBeenCalledOnce();
      expect(helper.cancelOutgoingCall).not.toHaveBeenCalled();
      expect(await state.lookup("active")).toBeUndefined();
    } finally {
      reply.release();
      await dialing.catch(() => undefined);
      await (stopping ?? runtime.stop());
    }
  });
});
