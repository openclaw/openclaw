import { createPluginStateSyncKeyedStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  completeAbsence,
  completeAction,
  completeSharedAction,
  createRuntime,
  createTalkDriver,
  FaceTimeHelperActionError,
  incomingCall,
  mocks,
  pendingDialCancellationResult,
  pendingDialCarrierResult,
  pendingDialState,
  resetRuntimeTestState,
} from "./runtime.test-support.js";

describe("FaceTime runtime call sequencing", () => {
  beforeEach(resetRuntimeTestState);

  it("answers muted after suppression, then waits for provider and route readiness", async () => {
    const order: string[] = [];
    let releaseReadiness = () => {};
    const talk = createTalkDriver({
      order,
      readyForAudio: () =>
        new Promise<void>((resolve) => {
          releaseReadiness = resolve;
        }),
    });
    mocks.startTalk.mockImplementationOnce(async () => {
      order.push("suppression-ready");
      return talk;
    });
    mocks.helper.answerCall.mockImplementationOnce(async () => {
      order.push("answer-muted");
      return completeSharedAction({
        outcome: "answered-muted",
        muted: true,
        is_uplink_muted: true,
      });
    });
    mocks.helper.setMuted.mockImplementationOnce(async () => {
      order.push("unmute");
      return completeSharedAction({
        outcome: "media-configured",
        muted: false,
        is_uplink_muted: false,
      });
    });
    mocks.helper.startTransmission.mockImplementationOnce(async () => {
      order.push("start-transmission");
      return completeSharedAction({
        outcome: "media-active",
        muted: false,
        is_uplink_muted: false,
        is_sending_audio: true,
        is_sending_transmission: true,
      });
    });
    const runtime = await createRuntime();

    mocks.helperParams?.onMessage(incomingCall());
    await vi.waitFor(() => expect(talk.readyForAudio).toHaveBeenCalledOnce());

    expect(order).toEqual(["suppression-ready", "answer-muted", "provider-and-route-readiness"]);
    expect(mocks.helper.setMuted).not.toHaveBeenCalled();
    expect(mocks.helper.startTransmission).not.toHaveBeenCalled();
    expect(talk.activate).not.toHaveBeenCalled();

    releaseReadiness();
    await vi.waitFor(() => expect(talk.activate).toHaveBeenCalledOnce());
    expect(order).toEqual([
      "suppression-ready",
      "answer-muted",
      "provider-and-route-readiness",
      "unmute",
      "start-transmission",
      "activate",
    ]);
    await runtime.stop();
  });

  it("targets the replacement outbound carrier while preserving the call lifecycle identity", async () => {
    let releaseReadiness = () => {};
    const talk = createTalkDriver({
      readyForAudio: () =>
        new Promise<void>((resolve) => {
          releaseReadiness = resolve;
        }),
    });
    mocks.startTalk.mockResolvedValueOnce(talk);
    mocks.helper.startCall.mockImplementationOnce(async (_request: unknown, dialID: string) => ({
      dial_id: dialID,
      call_uuid: "outbound-call",
      muted: true,
      is_uplink_muted: true,
      transport: incomingCall().data.transport,
    }));
    const runtime = await createRuntime();
    const dial = await runtime.dial({ handle: "owner@example.com", mode: "audio" });

    mocks.helperParams?.onMessage({
      event: "ft-call-status-changed",
      data: {
        dial_id: dial.dialID,
        call_uuid: "outbound-call",
        call_status: 3,
        is_outgoing: true,
        is_sending_audio: false,
        handle: { value: "owner@example.com" },
        transport: incomingCall().data.transport,
      },
    });
    await vi.waitFor(() => expect(mocks.helper.safetyMute).toHaveBeenCalledWith("outbound-call"));
    expect(mocks.startTalk).not.toHaveBeenCalled();
    expect(mocks.helper.setMuted).not.toHaveBeenCalled();

    mocks.helperParams?.onMessage({
      event: "ft-call-status-changed",
      data: {
        dial_id: dial.dialID,
        call_uuid: "replacement-call",
        call_status: 1,
        is_outgoing: true,
        is_sending_audio: true,
        handle: { value: "owner@example.com" },
        transport: incomingCall().data.transport,
      },
    });
    await vi.waitFor(() => expect(talk.readyForAudio).toHaveBeenCalledOnce());
    expect(mocks.helper.setMuted).not.toHaveBeenCalled();
    expect(mocks.helper.startTransmission).not.toHaveBeenCalled();

    releaseReadiness();
    await vi.waitFor(() => expect(talk.activate).toHaveBeenCalledOnce());
    expect(mocks.helper.setMuted).toHaveBeenCalledWith("replacement-call", false);
    expect(mocks.helper.startTransmission).toHaveBeenCalledWith("replacement-call");
    expect((await runtime.status()).calls).toMatchObject([{ callUUID: "outbound-call" }]);

    mocks.helper.safetyMute.mockClear();
    await expect(runtime.hangup()).resolves.toEqual({ callUUID: "outbound-call" });
    expect(mocks.helper.safetyMute).toHaveBeenCalledWith("replacement-call");
    expect(mocks.helper.leaveCall).toHaveBeenCalledWith("replacement-call");
    await runtime.stop();
  });

  it("routes a realtime caller hangup request to the current carrier", async () => {
    const talk = createTalkDriver({});
    let requestHangup: (() => Promise<void>) | undefined;
    mocks.startTalk.mockImplementationOnce(
      async (params: { onHangupRequested(): Promise<void> }) => {
        requestHangup = () => params.onHangupRequested();
        return talk;
      },
    );
    const runtime = await createRuntime();

    mocks.helperParams?.onMessage(incomingCall(1));
    await vi.waitFor(() => expect(talk.activate).toHaveBeenCalledOnce());
    expect(requestHangup).toBeTypeOf("function");

    await requestHangup?.();

    expect(talk.suspendMedia).toHaveBeenCalledWith("caller-requested-hangup");
    expect(mocks.helper.safetyMute).toHaveBeenCalledWith("call-1");
    expect(mocks.helper.leaveCall).toHaveBeenCalledWith("call-1");
    expect(talk.close).toHaveBeenCalledWith("caller-requested-hangup");
    expect((await runtime.status()).calls).toEqual([]);
    await runtime.stop();
  });

  it("keeps suppression after disconnect acknowledgement until a native ended event", async () => {
    const talk = createTalkDriver({});
    mocks.startTalk.mockResolvedValueOnce(talk);
    const runtime = await createRuntime();
    mocks.helperParams?.onMessage(incomingCall(1));
    await vi.waitFor(() => expect(talk.activate).toHaveBeenCalledOnce());
    mocks.helper.inspectCall.mockResolvedValue({
      helpersContacted: 2,
      topologyGeneration: 1,
      topologyComplete: true,
      helperResults: [
        { outcome: "present", found: true, call_uuid: "call-1" },
        { outcome: "absent", found: false },
      ],
    });

    await expect(runtime.hangup()).rejects.toThrow("carrier hangup pending");
    expect(talk.close).not.toHaveBeenCalled();
    expect((await runtime.status()).calls).toMatchObject([{ carrierHangupPending: true }]);

    mocks.helperParams?.onMessage(incomingCall(6));
    await vi.waitFor(async () => expect((await runtime.status()).calls).toEqual([]));
    expect(talk.close).toHaveBeenCalledWith("native-ended");
    await runtime.stop();
  });

  it("does not answer a call that ends while native suppression is starting", async () => {
    mocks.startTalk.mockImplementationOnce(
      async (params: { signal?: AbortSignal }) =>
        await new Promise((_resolve, reject) => {
          params.signal?.addEventListener(
            "abort",
            () => reject(new Error("FaceTime talk startup aborted")),
            { once: true },
          );
        }),
    );
    const runtime = await createRuntime();

    mocks.helperParams?.onMessage(incomingCall());
    await vi.waitFor(() => expect(mocks.startTalk).toHaveBeenCalledOnce());
    mocks.helperParams?.onMessage(incomingCall(6));
    await vi.waitFor(async () => {
      expect((await runtime.status()).calls).toEqual([]);
    });

    expect(mocks.helper.answerCall).not.toHaveBeenCalled();
    await runtime.stop();
  });

  it("does not answer after helper control is lost during suppression startup", async () => {
    let releaseSuppression = () => {};
    const talk = createTalkDriver({});
    mocks.startTalk.mockImplementationOnce(
      () =>
        new Promise<typeof talk>((resolve) => {
          releaseSuppression = () => resolve(talk);
        }),
    );
    mocks.helper.leaveCall.mockRejectedValueOnce(new Error("helper unavailable"));
    const runtime = await createRuntime();

    mocks.helperParams?.onMessage(incomingCall());
    await vi.waitFor(() => expect(mocks.startTalk).toHaveBeenCalledOnce());
    mocks.helperParams?.onDisconnect("com.apple.FaceTime");
    await vi.waitFor(() => expect(mocks.helper.leaveCall).toHaveBeenCalledWith("call-1"));
    releaseSuppression();
    await vi.waitFor(async () => {
      expect((await runtime.status()).calls).toEqual([]);
    });

    expect(mocks.helper.answerCall).not.toHaveBeenCalled();
    await runtime.stop();
  });

  it("suspends model media and hangs up when provider readiness fails after answer", async () => {
    const talk = createTalkDriver({
      readyForAudio: async () => {
        throw new Error("provider unavailable");
      },
    });
    mocks.startTalk.mockResolvedValueOnce(talk);
    const runtime = await createRuntime();

    mocks.helperParams?.onMessage(incomingCall());
    await vi.waitFor(() => expect(mocks.helper.leaveCall).toHaveBeenCalledWith("call-1"));

    expect(mocks.helper.answerCall).toHaveBeenCalledWith("call-1");
    expect(talk.suspendMedia).toHaveBeenCalled();
    expect(mocks.helper.safetyMute).toHaveBeenCalledWith("call-1");
    expect(mocks.helper.setMuted).not.toHaveBeenCalled();
    expect(mocks.helper.startTransmission).not.toHaveBeenCalled();
    expect(talk.activate).not.toHaveBeenCalled();
    await runtime.stop();
  });

  it("accepts stable complete-topology absence when a termination request fails", async () => {
    let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined;
    try {
      const startupError = new Error("capture failed during startup");
      let releaseStartup: Promise<boolean> | undefined;
      mocks.helper.leaveCall.mockRejectedValueOnce(new Error("carrier cleanup unavailable"));
      mocks.startTalk.mockImplementationOnce(
        async (params: { onFailure(error: Error): Promise<boolean> }) => {
          releaseStartup = params.onFailure(startupError);
          await releaseStartup;
          throw startupError;
        },
      );
      runtime = await createRuntime();

      mocks.helperParams?.onMessage(incomingCall(1));
      await vi.waitFor(() => expect(mocks.helper.leaveCall).toHaveBeenCalledTimes(1));
      expect(releaseStartup).toBeDefined();
      await vi.waitFor(() => expect(mocks.helper.inspectCall).toHaveBeenCalledTimes(1));

      await expect(releaseStartup).resolves.toBe(true);
      await vi.waitFor(async () => {
        expect((await runtime?.status())?.calls).toEqual([]);
      });

      expect(mocks.helper.leaveCall).toHaveBeenCalledOnce();
      expect(mocks.helper.inspectCall).toHaveBeenCalledTimes(2);
    } finally {
      await runtime?.stop();
    }
  });

  it.each(["incoming active", "outbound ringing-to-active", "incoming ringing"])(
    "retains startup suppression while the carrier remains present (%s)",
    async (flow) => {
      let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined;
      try {
        const startupError = new Error("capture failed during startup");
        let releaseStartup: Promise<boolean> | undefined;
        let startupReleased = false;
        mocks.helper.inspectCall.mockResolvedValue({
          helpersContacted: 2,
          topologyGeneration: 1,
          topologyComplete: true,
          helperResults: [
            { outcome: "present", found: true, call_uuid: "call-1" },
            { outcome: "absent", found: false },
          ],
        });
        mocks.startTalk.mockImplementationOnce(
          async (params: { onFailure(error: Error): Promise<boolean> }) => {
            releaseStartup = params.onFailure(startupError);
            void releaseStartup.then(() => {
              startupReleased = true;
            });
            await releaseStartup;
            throw startupError;
          },
        );
        runtime = await createRuntime(
          flow === "outbound ringing-to-active"
            ? pendingDialState({ callUUID: "call-1" })
            : undefined,
        );

        if (flow === "outbound ringing-to-active") {
          const outbound = {
            ...incomingCall(3),
            data: {
              ...incomingCall(3).data,
              dial_id: "approved-dial",
              is_outgoing: true,
            },
          };
          mocks.helperParams?.onMessage(outbound);
          await vi.waitFor(async () => expect((await runtime?.status())?.calls).toHaveLength(1));
          mocks.helperParams?.onMessage({
            ...outbound,
            data: { ...outbound.data, call_status: 1 },
          });
        } else {
          mocks.helperParams?.onMessage(incomingCall(flow === "incoming ringing" ? 4 : 1));
        }
        await vi.waitFor(() => expect(mocks.helper.leaveCall).toHaveBeenCalledTimes(1));
        expect(releaseStartup).toBeDefined();
        await vi.waitFor(() => expect(mocks.helper.inspectCall).toHaveBeenCalledTimes(1));

        await new Promise<void>((resolve) => {
          setTimeout(resolve, 150);
        });
        expect(startupReleased).toBe(false);
        expect((await runtime.status()).calls).toMatchObject([
          { callUUID: "call-1", carrierHangupPending: true },
        ]);

        mocks.helper.inspectCall.mockResolvedValue(completeAbsence());
        await expect(releaseStartup).resolves.toBe(true);
        await vi.waitFor(async () => {
          expect((await runtime?.status())?.calls).toEqual([]);
        });
      } finally {
        mocks.helper.inspectCall.mockResolvedValue(completeAbsence());
        await runtime?.stop();
      }
    },
  );

  it.each(["native-ended", "runtime-stop"])(
    "releases failed startup after confirmed carrier closure with inspection unavailable (%s)",
    async (closure) => {
      const startupError = new Error("capture failed during startup");
      let startupReleased = false;
      let releaseStartup: Promise<boolean> | undefined;
      let confirmProcessAbsence = () => {};
      let inspectProcessAbsence = () => {};
      const processAbsence = new Promise<void>((resolve) => {
        confirmProcessAbsence = resolve;
      });
      const processAbsenceInspected = new Promise<void>((resolve) => {
        inspectProcessAbsence = resolve;
      });
      mocks.helper.inspectCall.mockRejectedValue(new Error("helper inspection unavailable"));
      mocks.startTalk.mockImplementationOnce(
        async (params: { onFailure(error: Error): Promise<boolean> }) => {
          releaseStartup = params.onFailure(startupError);
          await releaseStartup;
          startupReleased = true;
          throw startupError;
        },
      );
      const runtime = await createRuntime();
      let stop: Promise<void> | undefined;
      try {
        mocks.helperParams?.onMessage(incomingCall(4), {
          bundleIdentifier: "com.apple.FaceTime",
          processId: 4321,
          processStartedAtMs: Date.parse("Tue Nov 14 22:13:20 2023"),
          connectionGeneration: 7,
        });
        await vi.waitFor(() => expect(mocks.helper.inspectCall).toHaveBeenCalled());
        expect(startupReleased).toBe(false);
        expect((await runtime.status()).calls).toMatchObject([
          { callUUID: "call-1", phase: "closing", carrierMode: "closing" },
        ]);

        if (closure === "native-ended") {
          mocks.helperParams?.onMessage(incomingCall(6));
        } else {
          mocks.systemRun
            .mockResolvedValueOnce({
              code: 0,
              stdout: "/System/Applications/FaceTime.app/Contents/MacOS/FaceTime\n",
              stderr: "",
            })
            .mockResolvedValueOnce({ code: 0, stdout: "Tue Nov 14 22:13:20 2023\n", stderr: "" })
            .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
            .mockImplementationOnce(async () => {
              inspectProcessAbsence();
              await processAbsence;
              return { code: 1, stdout: "", stderr: "" };
            });
          stop = runtime.stop();
          await processAbsenceInspected;
          expect(startupReleased).toBe(false);
          expect((await runtime.status()).calls).toMatchObject([{ carrierMode: "closing" }]);
          confirmProcessAbsence();
        }

        await vi.waitFor(() => expect(startupReleased).toBe(true));
        await expect(releaseStartup).resolves.toBe(true);
        await vi.waitFor(async () => expect((await runtime.status()).calls).toEqual([]));
        expect(mocks.helper.answerCall).not.toHaveBeenCalled();
        await stop;
      } finally {
        confirmProcessAbsence();
        mocks.helper.inspectCall.mockResolvedValue(completeAbsence());
        await (stop ?? runtime.stop());
      }
      expect(mocks.helper.stop).toHaveBeenCalledOnce();
    },
  );

  it("enters safety-only mode when one helper disconnects but another remains", async () => {
    const talk = createTalkDriver({});
    mocks.startTalk.mockResolvedValueOnce(talk);
    const runtime = await createRuntime();
    mocks.helperParams?.onMessage(incomingCall(1));
    await vi.waitFor(() => expect(talk.activate).toHaveBeenCalledOnce());
    vi.clearAllMocks();
    mocks.helper.connectedSockets = 1;
    mocks.helper.connectedHelperBundles = ["com.apple.mobilephone"];
    talk.suspendMedia.mockRejectedValueOnce(new Error("local suspension failed"));

    mocks.helperParams?.onDisconnect("com.apple.FaceTime");
    await vi.waitFor(() => expect(mocks.helper.leaveCall).toHaveBeenCalledWith("call-1"));

    expect(talk.suspendMedia).toHaveBeenCalled();
    expect(mocks.helper.safetyMute).toHaveBeenCalledWith("call-1");
    await runtime.stop();
  });

  it("retains suppression when a surviving helper reports action absence without the carrier", async () => {
    const talk = createTalkDriver({});
    mocks.startTalk.mockResolvedValueOnce(talk);
    const runtime = await createRuntime();
    mocks.helperParams?.onMessage(incomingCall(1), {
      bundleIdentifier: "com.apple.FaceTime",
      processId: 4321,
      processStartedAtMs: Date.parse("Tue Nov 14 22:13:20 2023"),
      connectionGeneration: 7,
    });
    await vi.waitFor(() => expect(talk.activate).toHaveBeenCalledOnce());
    vi.clearAllMocks();
    mocks.helper.connectedSockets = 1;
    mocks.helper.connectedHelperBundles = ["com.apple.mobilephone"];
    const survivingHelperAbsence = {
      helpersContacted: 1,
      topologyGeneration: 1,
      topologyComplete: true,
      helperResults: [{ outcome: "absent", found: false }],
    };
    mocks.helper.safetyMute.mockResolvedValue(survivingHelperAbsence);
    mocks.helper.leaveCall.mockResolvedValue(survivingHelperAbsence);
    mocks.helper.inspectCall.mockResolvedValue({
      helpersContacted: 1,
      topologyGeneration: 1,
      topologyComplete: false,
      helperResults: [{ outcome: "absent", found: false }],
    });

    mocks.helperParams?.onDisconnect("com.apple.FaceTime");
    await vi.waitFor(() => expect(mocks.helper.leaveCall).toHaveBeenCalledWith("call-1"));

    expect((await runtime.status()).calls).toMatchObject([
      { callUUID: "call-1", carrierHangupPending: true },
    ]);
    expect(mocks.helper.inspectCall).toHaveBeenCalledWith(["call-1"], [4321]);
    expect(talk.close).not.toHaveBeenCalled();

    mocks.helper.connectedSockets = 2;
    mocks.helper.connectedHelperBundles = ["com.apple.mobilephone", "com.apple.FaceTime"];
    mocks.helper.inspectCall.mockResolvedValue(completeAbsence());
    mocks.helperParams?.onConnect("com.apple.FaceTime");
    await vi.waitFor(async () => expect((await runtime.status()).calls).toEqual([]));
    expect(mocks.helper.leaveCall).toHaveBeenCalledTimes(2);
    expect(talk.close).toHaveBeenCalledWith("helper-reconnected");
    await runtime.stop();
  });

  it("closes on stable complete absence even when disconnect acknowledgement is unavailable", async () => {
    const talk = createTalkDriver({});
    mocks.startTalk.mockResolvedValueOnce(talk);
    const runtime = await createRuntime();
    mocks.helper.connectedSockets = 1;
    mocks.helper.connectedHelperBundles = ["com.apple.mobilephone"];
    mocks.helperParams?.onDisconnect("com.apple.FaceTime");
    mocks.helperParams?.onMessage(incomingCall(1));
    await vi.waitFor(() => expect(talk.activate).toHaveBeenCalledOnce());
    mocks.helper.leaveCall.mockRejectedValueOnce(new Error("Call not found!"));

    await expect(runtime.hangup()).resolves.toEqual({ callUUID: "call-1" });
    expect((await runtime.status()).calls).toEqual([]);
    expect(mocks.helper.inspectCall).toHaveBeenCalledTimes(2);
    expect(talk.close).toHaveBeenCalledWith("operator-hangup");
    await runtime.stop();
  });

  it("retains suppression after action absence until native closure when inspection is unavailable", async () => {
    const talk = createTalkDriver({});
    mocks.startTalk.mockResolvedValueOnce(talk);
    const runtime = await createRuntime();
    mocks.helperParams?.onMessage(incomingCall(1));
    await vi.waitFor(() => expect(talk.activate).toHaveBeenCalledOnce());
    mocks.helper.safetyMute.mockResolvedValue(completeAbsence());
    mocks.helper.leaveCall.mockResolvedValue(completeAbsence());
    mocks.helper.inspectCall.mockRejectedValue(new Error("inspection unavailable"));

    await expect(runtime.hangup()).rejects.toThrow("carrier hangup pending");
    expect((await runtime.status()).calls).toMatchObject([{ carrierHangupPending: true }]);
    expect(talk.close).not.toHaveBeenCalled();

    mocks.helperParams?.onMessage(incomingCall(6));
    await vi.waitFor(async () => expect((await runtime.status()).calls).toEqual([]));
    expect(talk.close).toHaveBeenCalledWith("native-ended");
    await runtime.stop();
  });

  it("fences an in-flight unmute before transmission when hangup starts", async () => {
    const talk = createTalkDriver({});
    mocks.startTalk.mockResolvedValueOnce(talk);
    const runtime = await createRuntime();
    let resolveUnmute = (_result: unknown) => {};
    mocks.helper.setMuted.mockImplementationOnce(
      async () =>
        await new Promise((resolve) => {
          resolveUnmute = resolve;
        }),
    );
    mocks.helperParams?.onMessage(incomingCall(1));
    await vi.waitFor(() => expect(mocks.helper.setMuted).toHaveBeenCalledOnce());
    const hangup = runtime.hangup();
    resolveUnmute(
      completeAction({ outcome: "media-configured", muted: false, is_uplink_muted: false }),
    );
    await expect(hangup).resolves.toEqual({ callUUID: "call-1" });
    expect(mocks.helper.startTransmission).not.toHaveBeenCalled();
    expect(mocks.helper.safetyMute).toHaveBeenCalled();
    expect(mocks.helper.leaveCall).toHaveBeenCalled();
    await runtime.stop();
  });

  it("fails closed when any native unmute postcondition is negative", async () => {
    const talk = createTalkDriver({});
    mocks.startTalk.mockResolvedValueOnce(talk);
    mocks.helper.setMuted.mockResolvedValueOnce({
      helpersContacted: 2,
      topologyGeneration: 1,
      topologyComplete: true,
      helperResults: [
        { outcome: "media-configured", muted: false, is_uplink_muted: false },
        { outcome: "media-configured", muted: false, is_uplink_muted: true },
      ],
    });
    const runtime = await createRuntime();

    mocks.helperParams?.onMessage(incomingCall(1));
    await vi.waitFor(() => expect(mocks.helper.safetyMute).toHaveBeenCalled());
    expect(mocks.helper.startTransmission).not.toHaveBeenCalled();
    expect(mocks.helper.leaveCall).toHaveBeenCalled();
    await vi.waitFor(async () => expect((await runtime.status()).calls).toEqual([]));
    await runtime.stop();
  });

  it("fails closed when answer does not observe a safely muted uplink", async () => {
    const talk = createTalkDriver({});
    mocks.startTalk.mockResolvedValueOnce(talk);
    mocks.helper.answerCall.mockResolvedValueOnce(
      completeAction({ outcome: "answered-muted", muted: true, is_uplink_muted: false }),
    );
    const runtime = await createRuntime();

    mocks.helperParams?.onMessage(incomingCall());
    await vi.waitFor(() => expect(mocks.helper.leaveCall).toHaveBeenCalled());
    expect(mocks.helper.setMuted).not.toHaveBeenCalled();
    await vi.waitFor(async () => expect((await runtime.status()).calls).toEqual([]));
    await runtime.stop();
  });

  it("terminates the exact authenticated carrier before releasing suppression on shutdown", async () => {
    const talk = createTalkDriver({});
    mocks.startTalk.mockResolvedValueOnce(talk);
    const runtime = await createRuntime();
    mocks.helperParams?.onMessage(incomingCall(1), {
      bundleIdentifier: "com.apple.FaceTime",
      processId: 4321,
      processStartedAtMs: Date.parse("Tue Nov 14 22:13:20 2023"),
      connectionGeneration: 7,
    });
    await vi.waitFor(() => expect(talk.activate).toHaveBeenCalledOnce());
    mocks.helper.safetyMute.mockRejectedValue(new Error("helper unavailable"));
    mocks.helper.leaveCall.mockRejectedValue(new Error("helper unavailable"));
    mocks.helper.inspectCall.mockRejectedValue(new Error("helper unavailable"));

    await runtime.stop();
    expect(mocks.systemRun).toHaveBeenCalledWith(["/bin/ps", "-p", "4321", "-o", "comm="], {
      timeoutMs: 500,
    });
    expect(mocks.systemRun).toHaveBeenCalledWith(["/bin/ps", "-p", "4321", "-o", "lstart="], {
      timeoutMs: 500,
    });
    expect(mocks.systemRun).toHaveBeenCalledWith(["/bin/kill", "-TERM", "4321"], {
      timeoutMs: 500,
    });
    expect(talk.close).toHaveBeenCalledWith("runtime-stop-carrier-terminated");
  });

  it("retains suppression when the carrier remains alive after force termination", async () => {
    const talk = createTalkDriver({});
    mocks.startTalk.mockResolvedValueOnce(talk);
    const runtime = await createRuntime();
    try {
      mocks.helperParams?.onMessage(incomingCall(1), {
        bundleIdentifier: "com.apple.FaceTime",
        processId: 4321,
        processStartedAtMs: Date.parse("Tue Nov 14 22:13:20 2023"),
        connectionGeneration: 7,
      });
      await vi.waitFor(() => expect(talk.activate).toHaveBeenCalledOnce());
      mocks.helper.inspectCall.mockRejectedValue(new Error("helper inspection unavailable"));
      mocks.carrierProcessAlive = true;

      await expect(runtime.stop()).rejects.toThrow("fail-closed carrier termination failed");
      expect(mocks.systemRun).toHaveBeenCalledWith(["/bin/kill", "-KILL", "4321"], {
        timeoutMs: 500,
      });
      expect(talk.close).not.toHaveBeenCalled();
      expect((await runtime.status()).calls).toMatchObject([
        { carrierMode: "closing", carrierHangupPending: true },
      ]);
    } finally {
      mocks.carrierProcessAlive = false;
      mocks.helper.inspectCall.mockResolvedValue(completeAbsence());
      await runtime.stop();
    }
  });

  it.each([
    {
      name: "retains the authorized pending dial when exact termination fails",
      processExecutable: "/System/Applications/Phone.app/Contents/MacOS/Phone\n",
      rejects: true,
      pendingRemains: true,
    },
    {
      name: "clears the authorized pending dial after exact termination succeeds",
      processExecutable: "/System/Applications/FaceTime.app/Contents/MacOS/FaceTime\n",
      rejects: false,
      pendingRemains: false,
    },
  ])("$name", async ({ processExecutable, rejects, pendingRemains }) => {
    const state = pendingDialState({ callUUIDAliases: ["approved-call"] });
    mocks.helper.cancelOutgoingCall.mockRejectedValue(new Error("helper cancel unavailable"));
    mocks.helper.findOutgoingCall.mockResolvedValue(pendingDialCarrierResult());
    let processExited = false;
    mocks.systemRun.mockImplementation(async (argv: string[]) => {
      if (argv[0] === "/bin/ps") {
        if (processExited) {
          return { code: 1, stdout: "", stderr: "" };
        }
        return argv.includes("lstart=")
          ? { code: 0, stdout: "Tue Nov 14 22:13:20 2023\n", stderr: "" }
          : { code: 0, stdout: processExecutable, stderr: "" };
      }
      if (argv[0] === "/bin/kill") {
        processExited = true;
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const runtime = await createRuntime(state);

    if (rejects) {
      await expect(runtime.stop()).rejects.toThrow("outbound FaceTime dial cleanup failed");
    } else {
      await expect(runtime.stop()).resolves.toBeUndefined();
    }
    expect(state.lookup("active") !== undefined).toBe(pendingRemains);
    expect(mocks.helper.cancelOutgoingCall).toHaveBeenCalledTimes(2);
    expect(mocks.helper.cancelOutgoingCall).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ dialID: "approved-dial", callUUID: "approved-call" }),
    );
    expect(mocks.helper.findOutgoingCall).toHaveBeenCalledOnce();
    expect(mocks.systemRun).toHaveBeenCalledWith(["/bin/ps", "-p", "4321", "-o", "comm="], {
      timeoutMs: 500,
    });
  });

  it("recovers only the exact persisted pending dial after a gateway restart", async () => {
    const state = pendingDialState({
      callUUIDAliases: ["provisional-call", "approved-call"],
    });
    const talk = createTalkDriver({});
    mocks.startTalk.mockResolvedValue(talk);
    mocks.helper.findOutgoingCall.mockResolvedValue({
      helpersContacted: 2,
      helperResults: [{ found: true, call_uuid: "approved-call" }, { found: false }],
    });
    const runtime = await createRuntime(state);

    mocks.helperParams?.onMessage({
      event: "ft-call-status-changed",
      data: {
        call_uuid: "manual-call",
        call_status: 1,
        is_outgoing: true,
        handle: { value: "owner@example.com" },
        transport: {
          kind: "facetime",
          classifier_version: "tu-provider-v1",
          service: 2,
          facetime_transport_type: 1,
          provider_classified: true,
          provider_is_facetime: true,
          provider_is_telephony: false,
          is_using_baseband: false,
          is_wifi_call: false,
          is_voip: true,
          is_emergency: false,
        },
      },
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect((await runtime.status()).calls).toEqual([]);

    mocks.helperParams?.onConnect("com.apple.FaceTime");
    mocks.helperParams?.onMessage({
      event: "ft-call-status-changed",
      data: {
        dial_id: "approved-dial",
        call_uuid: "approved-call",
        call_status: 1,
        is_outgoing: true,
        handle: { value: "owner@example.com" },
        transport: {
          kind: "facetime",
          classifier_version: "tu-provider-v1",
          service: 2,
          facetime_transport_type: 1,
          provider_classified: true,
          provider_is_facetime: true,
          provider_is_telephony: false,
          is_using_baseband: false,
          is_wifi_call: false,
          is_voip: true,
          is_emergency: false,
        },
      },
    });
    await vi.waitFor(() => expect(talk.activate).toHaveBeenCalled());
    expect((await runtime.status()).outboundCallPending).toBeUndefined();
    expect(state.lookup("active")).toBeUndefined();
    mocks.helperParams?.onMessage({
      event: "ft-call-status-changed",
      data: {
        call_uuid: "provisional-call",
        call_status: 6,
        has_ended: true,
        is_outgoing: true,
      },
    });
    await vi.waitFor(async () => expect((await runtime.status()).calls).toEqual([]));
    expect(talk.close).toHaveBeenCalledWith("native-ended");
    await runtime.stop();
  });

  it("cancels and retains a persisted dial fail-closed when restart authorization was removed", async () => {
    const state = pendingDialState();
    mocks.helper.cancelOutgoingCall.mockRejectedValueOnce(
      new Error("helper could not prove cancellation"),
    );
    mocks.helper.findOutgoingCall.mockResolvedValue({
      helpersContacted: 2,
      helperResults: [{ found: true, call_uuid: "approved-call" }, { found: false }],
    });
    const runtime = await createRuntime(state, ["new-owner@example.com"]);

    mocks.helperParams?.onMessage({
      event: "ft-call-status-changed",
      data: {
        dial_id: "approved-dial",
        call_uuid: "approved-call",
        call_status: 1,
        is_outgoing: true,
        handle: { value: "owner@example.com" },
        transport: incomingCall().data.transport,
      },
    });

    await vi.waitFor(() => expect(mocks.helper.cancelOutgoingCall).toHaveBeenCalledOnce());
    expect(mocks.startTalk).not.toHaveBeenCalled();
    expect((await runtime.status()).calls).toEqual([]);
    expect(state.lookup("active")).toMatchObject({
      callUUID: "approved-call",
      delivery: "cancelling",
    });
    await vi.waitFor(() =>
      expect(mocks.warn).toHaveBeenCalledWith(
        expect.stringContaining("cancellation remains pending"),
      ),
    );

    mocks.helperParams?.onMessage({
      event: "ft-call-status-changed",
      data: {
        dial_id: "approved-dial",
        call_uuid: "approved-call",
        call_status: 6,
        has_ended: true,
        is_outgoing: true,
      },
    });
    await vi.waitFor(() => expect(state.lookup("active")).toBeUndefined());
    await runtime.stop();
  });

  it("persists an early pending-dial cancellation until native terminal evidence", async () => {
    const state = pendingDialState({
      dialID: "cancel-dial",
      delivery: "in-flight",
    });
    mocks.helper.cancelOutgoingCall.mockResolvedValue(pendingDialCancellationResult());
    mocks.startTalk.mockResolvedValue(createTalkDriver({}));
    const runtime = await createRuntime(state);

    await expect(runtime.hangup()).resolves.toEqual({ dialID: "cancel-dial" });
    expect(mocks.helper.cancelOutgoingCall).toHaveBeenCalledOnce();
    expect(state.lookup("active")).toMatchObject({ delivery: "cancelling" });

    for (const callStatus of [3, 1]) {
      mocks.helperParams?.onMessage({
        event: "ft-call-status-changed",
        data: {
          dial_id: "cancel-dial",
          call_uuid: "cancelled-call",
          call_status: callStatus,
          is_outgoing: true,
          handle: { value: "owner@example.com" },
          transport: incomingCall().data.transport,
        },
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect((await runtime.status()).calls).toEqual([]);
      expect(state.lookup("active")).toMatchObject({ delivery: "cancelling" });
      expect(mocks.startTalk).not.toHaveBeenCalled();
      expect(mocks.helper.setMuted).not.toHaveBeenCalled();
    }

    mocks.helperParams?.onMessage({
      event: "ft-call-status-changed",
      data: {
        dial_id: "cancel-dial",
        call_uuid: "cancelled-call",
        call_status: 6,
        has_ended: true,
        is_outgoing: true,
      },
    });
    await vi.waitFor(() => expect(state.lookup("active")).toBeUndefined());
    await runtime.stop();
  });

  it("redrives persisted cancellation after restart without promoting the matching carrier", async () => {
    const state = pendingDialState({
      delivery: "cancelling",
      callUUIDAliases: ["approved-call"],
    });
    mocks.helper.findOutgoingCall.mockResolvedValue(pendingDialCarrierResult());
    mocks.helper.cancelOutgoingCall.mockResolvedValue(pendingDialCancellationResult());
    mocks.startTalk.mockResolvedValue(createTalkDriver({}));
    const runtime = await createRuntime(state);

    mocks.helperParams?.onConnect("com.apple.FaceTime");
    await vi.waitFor(() => expect(mocks.helper.cancelOutgoingCall).toHaveBeenCalled());
    expect(state.lookup("active")).toMatchObject({ delivery: "cancelling", ownerEpoch: 2 });

    mocks.helperParams?.onMessage({
      event: "ft-call-status-changed",
      data: {
        dial_id: "approved-dial",
        call_uuid: "approved-call",
        call_status: 1,
        is_outgoing: true,
        handle: { value: "owner@example.com" },
        transport: incomingCall().data.transport,
      },
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect((await runtime.status()).calls).toEqual([]);
    expect(state.lookup("active")).toMatchObject({ delivery: "cancelling" });
    expect(mocks.startTalk).not.toHaveBeenCalled();

    mocks.helperParams?.onMessage({
      event: "ft-call-status-changed",
      data: {
        dial_id: "approved-dial",
        call_uuid: "approved-call",
        call_status: 6,
        has_ended: true,
        is_outgoing: true,
      },
    });
    await vi.waitFor(() => expect(state.lookup("active")).toBeUndefined());
    await runtime.stop();
  });

  it.each([
    { settlement: "reply", error: undefined, expected: "cancelled before helper acknowledgement" },
    {
      settlement: "transport error",
      error: new Error("late transport error"),
      expected: "late transport error",
    },
    {
      settlement: "helper rejection",
      error: new FaceTimeHelperActionError("late helper rejection"),
      expected: "late helper rejection",
    },
  ])(
    "preserves pending cancellation after a late start-call $settlement",
    async ({ error, expected }) => {
      const state = createPluginStateSyncKeyedStoreForTests<unknown>("facetime", {
        namespace: "pending-dial",
        maxEntries: 1,
        overflowPolicy: "reject-new",
      });
      let finishReply = () => {};
      mocks.helper.startCall.mockImplementationOnce(
        () =>
          new Promise<Record<string, unknown>>((resolve, reject) => {
            finishReply = () =>
              error
                ? reject(error)
                : resolve({
                    call_uuid: "late-call",
                    muted: true,
                    is_uplink_muted: true,
                    transport: incomingCall().data.transport,
                  });
          }),
      );
      mocks.helper.cancelOutgoingCall.mockResolvedValue(pendingDialCancellationResult());
      mocks.helper.findOutgoingCall.mockResolvedValue(pendingDialCarrierResult());
      const runtime = await createRuntime(state);
      const dialing = runtime.dial({ handle: "owner@example.com" });
      const settled = expect(dialing).rejects.toThrow(expected);
      const dialID = (await runtime.status()).outboundCallPending!.dialID;

      await expect(runtime.hangup()).resolves.toEqual({ dialID });
      finishReply();
      await settled;
      expect(state.lookup("active")).toMatchObject({ delivery: "cancelling", dialID });
      expect((await runtime.status()).calls).toEqual([]);
      expect(mocks.startTalk).not.toHaveBeenCalled();

      mocks.helperParams?.onMessage({
        event: "ft-call-status-changed",
        data: {
          dial_id: dialID,
          call_uuid: "late-call",
          call_status: 6,
          has_ended: true,
          is_outgoing: true,
        },
      });
      await vi.waitFor(() => expect(state.lookup("active")).toBeUndefined());
      await runtime.stop();
    },
  );

  it("persists managed ringing hangup before a later active event can promote the dial", async () => {
    const state = pendingDialState({ callUUID: "ringing-call" });
    mocks.helper.cancelOutgoingCall.mockResolvedValue(pendingDialCancellationResult());
    mocks.helper.inspectCall.mockResolvedValue(
      completeAction({ outcome: "present", found: true, call_uuid: "ringing-call" }),
    );
    const talk = createTalkDriver({});
    mocks.startTalk.mockResolvedValue(talk);
    const runtime = await createRuntime(state);
    const event = {
      event: "ft-call-status-changed",
      data: {
        dial_id: "approved-dial",
        call_uuid: "ringing-call",
        call_status: 3,
        is_outgoing: true,
        handle: { value: "owner@example.com" },
        transport: incomingCall().data.transport,
      },
    };
    mocks.helperParams?.onMessage(event);
    await vi.waitFor(async () => expect((await runtime.status()).calls).toHaveLength(1));

    await expect(runtime.hangup()).rejects.toThrow("carrier hangup pending");
    expect(state.lookup("active")).toMatchObject({ delivery: "cancelling" });
    mocks.helperParams?.onMessage({ ...event, data: { ...event.data, call_status: 1 } });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(mocks.startTalk).not.toHaveBeenCalled();
    expect(mocks.helper.setMuted).not.toHaveBeenCalled();
    expect(state.lookup("active")).toMatchObject({ delivery: "cancelling" });

    mocks.helperParams?.onMessage({
      ...event,
      data: { ...event.data, call_status: 6, has_ended: true },
    });
    await vi.waitFor(async () => expect((await runtime.status()).calls).toEqual([]));
    expect(state.lookup("active")).toBeUndefined();
    await runtime.stop();
  });
});
