import { withEnvAsync } from "openclaw/plugin-sdk/test-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  mocks,
  resetTalkDriverMocks,
  startParams,
  startReadyFaceTimeTalkDriver,
} from "./talk-driver.test-support.js";

const { resolveFaceTimeConfig } = await import("../src/config.js");
const { agentIdFromSessionKey, resolveFaceTimeRealtimeProvider } =
  await import("../src/talk-driver-config.js");
const { startFaceTimeTalkDriver } = await import("../src/talk-driver.js");

describe("FaceTime talk driver lifecycle", () => {
  beforeEach(resetTalkDriverMocks);

  it("uses an explicit agent session key without resolving a default agent", () => {
    const callsBefore = mocks.resolveDefaultAgentId.mock.calls.length;

    expect(agentIdFromSessionKey("agent:lobster:facetime", {} as never)).toBe("lobster");
    expect(mocks.resolveDefaultAgentId).toHaveBeenCalledTimes(callsBefore);
  });

  it("resolves only the explicitly selected plugin-local provider secret", async () => {
    await withEnvAsync({ SELECTED_REALTIME_KEY: "selected-key" }, async () => {
      await resolveFaceTimeRealtimeProvider({
        config: resolveFaceTimeConfig({
          ownerHandles: ["caller@example.com"],
          realtime: {
            provider: "selected",
            providers: {
              ignored: {
                apiKey: { source: "env", provider: "default", id: "MISSING_IGNORED_KEY" },
              },
              selected: {
                apiKey: { source: "env", provider: "default", id: "SELECTED_REALTIME_KEY" },
              },
            },
          },
        }),
        fullConfig: {} as never,
        agentId: "main",
      });

      expect(mocks.resolveProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          configuredProviderId: "selected",
          providerConfigs: { selected: { apiKey: "selected-key" } },
          surface: "bridge",
        }),
      );
    });
  });

  it.each([false, true])(
    "retains aborted provider-startup suppression until carrier closure is confirmed (%s)",
    async (carrierClosed) => {
      let releaseConnect = () => {};
      mocks.bridge.connect.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseConnect = resolve;
          }),
      );
      let releaseCarrierSafety = (_safeToClose: boolean) => {};
      const onFailure = vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            releaseCarrierSafety = resolve;
          }),
      );
      const controller = new AbortController();
      const driver = await startFaceTimeTalkDriver(
        startParams({ signal: controller.signal, onFailure }),
      );
      const ready = driver.readyForAudio();
      const failed = expect(ready).rejects.toThrow("startup aborted");

      await vi.waitFor(() => expect(mocks.bridge.connect).toHaveBeenCalledOnce());
      controller.abort();

      await vi.waitFor(() => expect(onFailure).toHaveBeenCalledOnce());
      expect(mocks.bridge.close).toHaveBeenCalledOnce();
      expect(mocks.pump.suspendMedia).toHaveBeenCalledOnce();
      expect(mocks.pump.stop).not.toHaveBeenCalled();
      expect(driver.processOutputSuppressed()).toBe(true);

      releaseConnect();
      mocks.sessionParams?.onReady();
      await Promise.resolve();
      driver.activate();
      expect(driver.realtimeActive()).toBe(false);
      expect(mocks.pump.routeReady).not.toHaveBeenCalled();
      expect(mocks.bridge.triggerGreeting).not.toHaveBeenCalled();
      expect(mocks.pump.stop).not.toHaveBeenCalled();

      releaseCarrierSafety(carrierClosed);
      await failed;
      expect(mocks.pump.stop).toHaveBeenCalledTimes(carrierClosed ? 1 : 0);

      await driver.close("carrier-closed");
      expect(mocks.pump.stop).toHaveBeenCalledOnce();
    },
  );

  it("fails closed when OpenClaw cannot forward authenticated sender identity", async () => {
    mocks.senderAuthVersion = undefined;

    await expect(startFaceTimeTalkDriver(startParams())).rejects.toThrow(
      "does not support authenticated sender identity",
    );
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.pump.stop).not.toHaveBeenCalled();
  });

  it("connects the provider while waiting for native suppression", async () => {
    let releaseSuppression = () => {};
    mocks.pump.suppressionReady.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseSuppression = resolve;
        }),
    );
    const starting = startFaceTimeTalkDriver(startParams());

    await vi.waitFor(() => expect(mocks.pump.suppressionReady).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(mocks.createSession).toHaveBeenCalledOnce());
    expect(mocks.bridge.connect).toHaveBeenCalledOnce();

    releaseSuppression();
    const driver = await starting;

    expect(driver.processOutputSuppressed()).toBe(true);
  });

  it("waits for provider connect, provider ready, and microphone routing", async () => {
    let releaseConnect = () => {};
    let releaseRoute = () => {};
    mocks.bridge.connect.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseConnect = resolve;
        }),
    );
    mocks.pump.routeReady.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseRoute = resolve;
        }),
    );
    const driver = await startFaceTimeTalkDriver(startParams());
    const first = driver.readyForAudio();
    const second = driver.readyForAudio();
    let fullyReady = false;
    void first.then(() => {
      fullyReady = true;
    });

    await vi.waitFor(() => expect(mocks.bridge.connect).toHaveBeenCalledOnce());
    expect(mocks.pump.routeReady).not.toHaveBeenCalled();
    expect(driver.realtimeActive()).toBe(false);

    releaseConnect();
    await Promise.resolve();
    expect(driver.realtimeActive()).toBe(false);

    mocks.sessionParams?.onReady();
    await vi.waitFor(() => expect(driver.realtimeActive()).toBe(true));
    expect(mocks.pump.routeReady).toHaveBeenCalledOnce();
    expect(fullyReady).toBe(false);

    releaseRoute();
    await Promise.all([first, second]);
    expect(fullyReady).toBe(true);
    expect(driver.realtimeActive()).toBe(true);
  });

  it("keeps the carrier alive for a recoverable provider error after readiness", async () => {
    const onFailure = vi.fn(async () => true);
    const driver = await startReadyFaceTimeTalkDriver(startParams({ onFailure }));

    mocks.sessionParams?.onError(new Error("socket reconnecting"));
    await Promise.resolve();

    expect(driver.realtimeActive()).toBe(true);
    expect(onFailure).not.toHaveBeenCalled();
    expect(mocks.pump.suspendMedia).not.toHaveBeenCalled();
  });

  it("ignores a stale response terminal and drains only the current response", async () => {
    await startReadyFaceTimeTalkDriver();
    mocks.pump.queuedAudioFrames.mockReturnValue(240);
    mocks.sessionParams?.onEvent({
      direction: "server",
      type: "response.created",
      responseId: "response-current",
    });
    mocks.sessionParams?.audioSink.sendAudio(Buffer.alloc(480));
    mocks.sessionParams?.onResponseDone?.({
      status: "completed",
      responseId: "response-stale",
    });
    expect(mocks.pump.finishOutputAudio).not.toHaveBeenCalled();

    mocks.sessionParams?.onResponseDone?.({
      status: "completed",
      responseId: "response-current",
    });
    expect(mocks.pump.finishOutputAudio).toHaveBeenCalledOnce();
    mocks.pump.queuedAudioFrames.mockReturnValue(0);
    mocks.pumpParams?.onPlaybackDrained({ generation: 1, playedFrames: 240 });
    expect(mocks.pump.clearOutputAudio).not.toHaveBeenCalled();
  });

  it.each(["cancelled", "failed", "incomplete"] as const)(
    "flushes native playback for a %s response outcome without killing the carrier",
    async (status) => {
      const onFailure = vi.fn(async () => true);
      const driver = await startReadyFaceTimeTalkDriver(startParams({ onFailure }));
      mocks.sessionParams?.onEvent({
        direction: "server",
        type: "response.created",
        responseId: "response-1",
      });
      mocks.sessionParams?.audioSink.sendAudio(Buffer.alloc(480));
      mocks.sessionParams?.onResponseDone?.({
        status,
        responseId: "response-1",
        ...(status === "failed" || status === "incomplete"
          ? { message: `response ${status}` }
          : {}),
      });

      expect(mocks.pump.clearOutputAudio).toHaveBeenCalled();
      expect(onFailure).not.toHaveBeenCalled();
      expect(driver.realtimeActive()).toBe(true);
    },
  );

  it("rejects pending audio readiness when safety suspension wins the route race", async () => {
    let releaseRoute = () => {};
    mocks.pump.routeReady.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseRoute = resolve;
        }),
    );
    const driver = await startFaceTimeTalkDriver(startParams());
    const ready = driver.readyForAudio();
    const failed = expect(ready).rejects.toThrow(
      "FaceTime model media suspended: carrier-hangup-pending",
    );
    await vi.waitFor(() => expect(mocks.createSession).toHaveBeenCalledOnce());
    mocks.sessionParams?.onReady();
    await vi.waitFor(() => expect(driver.realtimeActive()).toBe(true));

    await driver.suspendMedia("carrier-hangup-pending");
    releaseRoute();

    await failed;
    expect(driver.realtimeActive()).toBe(false);
  });

  it("waits for asynchronous provider shutdown before suspending native media", async () => {
    let finishClose = () => {};
    mocks.bridge.close.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishClose = resolve;
        }),
    );
    const driver = await startReadyFaceTimeTalkDriver();

    const suspended = driver.suspendMedia("carrier-hangup-pending");
    await vi.waitFor(() => expect(mocks.bridge.close).toHaveBeenCalledOnce());
    expect(mocks.pump.suspendMedia).not.toHaveBeenCalled();
    finishClose();
    await suspended;

    expect(mocks.pump.suspendMedia).toHaveBeenCalledOnce();
  });

  it("fails closed when the provider never becomes ready after connect", async () => {
    vi.useFakeTimers();
    try {
      const onFailure = vi.fn(async () => true);
      const driver = await startFaceTimeTalkDriver(startParams({ onFailure }));
      const ready = driver.readyForAudio();
      const failed = expect(ready).rejects.toThrow(
        "Realtime provider was not ready within 15 seconds",
      );

      await vi.advanceTimersByTimeAsync(15_000);

      await failed;
      expect(onFailure).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Realtime provider was not ready within 15 seconds",
        }),
      );
      expect(mocks.pump.suspendMedia).toHaveBeenCalledOnce();
      expect(mocks.bridge.close).toHaveBeenCalledOnce();
      expect(mocks.pump.stop).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not forward caller audio before final activation", async () => {
    const driver = await startReadyFaceTimeTalkDriver();

    mocks.pumpParams?.onInputAudio(Buffer.from([1, 2]));
    expect(mocks.bridge.sendAudio).not.toHaveBeenCalled();

    driver.activate();
    mocks.pumpParams?.onInputAudio(Buffer.from([3, 4]));
    expect(mocks.bridge.sendAudio).toHaveBeenCalledOnce();
    expect(mocks.bridge.sendAudio).toHaveBeenCalledWith(Buffer.from([3, 4]));
  });

  it("reports an audio-child failure to the owning runtime", async () => {
    const onFailure = vi.fn();
    await startReadyFaceTimeTalkDriver(startParams({ onFailure }));

    await mocks.pumpParams?.onError(new Error("capture failed"));

    expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({ message: "capture failed" }));
    expect(mocks.pump.stop).toHaveBeenCalledOnce();
    expect(mocks.pump.suspendMedia).toHaveBeenCalledOnce();
    expect(mocks.bridge.close).toHaveBeenCalledOnce();
  });

  it("reports carrier failure and performs final teardown when media suspension rejects", async () => {
    const onFailure = vi.fn(async () => true);
    const driver = await startReadyFaceTimeTalkDriver(startParams({ onFailure }));
    mocks.pump.suspendMedia.mockRejectedValueOnce(new Error("native playback teardown failed"));

    await mocks.pumpParams?.onError(new Error("capture failed"));

    expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({ message: "capture failed" }));
    expect(mocks.pump.stop).toHaveBeenCalledOnce();
    expect(driver.realtimeActive()).toBe(false);
  });

  it("retains process-tap suppression when carrier cleanup is not yet safe", async () => {
    const onFailure = vi.fn(async () => false);
    await startReadyFaceTimeTalkDriver(startParams({ onFailure }));

    await expect(mocks.pumpParams?.onError(new Error("carrier hangup pending"))).resolves.toBe(
      false,
    );

    expect(onFailure).toHaveBeenCalledOnce();
    expect(mocks.pump.stop).not.toHaveBeenCalled();
    expect(mocks.pump.suspendMedia).toHaveBeenCalledOnce();
    expect(mocks.bridge.close).toHaveBeenCalledOnce();
  });

  it("stops all model media while retaining native process suppression", async () => {
    const driver = await startReadyFaceTimeTalkDriver();
    driver.activate();
    mocks.pumpParams?.onInputAudio(Buffer.from([1, 2]));
    mocks.sessionParams?.audioSink.sendAudio(Buffer.from([3, 4]));
    expect(mocks.bridge.sendAudio).toHaveBeenCalledOnce();
    expect(mocks.pump.writeOutputAudio).toHaveBeenCalledOnce();

    await driver.suspendMedia("carrier-hangup-pending");
    mocks.pumpParams?.onInputAudio(Buffer.from([5, 6]));
    mocks.sessionParams?.audioSink.sendAudio(Buffer.from([7, 8]));
    mocks.sessionParams?.audioSink.clearAudio();

    expect(driver.processOutputSuppressed()).toBe(true);
    expect(driver.realtimeActive()).toBe(false);
    expect(mocks.bridge.sendAudio).toHaveBeenCalledTimes(1);
    expect(mocks.pump.writeOutputAudio).toHaveBeenCalledTimes(1);
    expect(mocks.pump.clearOutputAudio).not.toHaveBeenCalled();
    expect(mocks.pump.suspendMedia).toHaveBeenCalledOnce();
    expect(mocks.pump.stop).not.toHaveBeenCalled();
  });

  it("rejects startup instead of returning a stopped driver after an audio failure", async () => {
    mocks.bridge.connect.mockImplementation(() => new Promise<void>(() => {}));
    const onFailure = vi.fn(async () => true);
    const driver = await startFaceTimeTalkDriver(startParams({ onFailure }));
    const ready = driver.readyForAudio();

    await vi.waitFor(() => expect(mocks.bridge.connect).toHaveBeenCalledOnce());
    await mocks.pumpParams?.onError(new Error("capture failed during connect"));

    await expect(ready).rejects.toThrow("capture failed during connect");
    expect(onFailure).toHaveBeenCalledOnce();
    expect(mocks.pump.stop).toHaveBeenCalledOnce();
    expect(mocks.bridge.close).toHaveBeenCalledOnce();
  });

  it("retains process suppression until provider-startup carrier cleanup is safe", async () => {
    mocks.bridge.connect.mockRejectedValue(new Error("provider connect failed"));
    let releaseCarrierSafety = (_safeToClose: boolean) => {};
    const onFailure = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          releaseCarrierSafety = resolve;
        }),
    );
    const driver = await startFaceTimeTalkDriver(startParams({ onFailure }));
    const ready = driver.readyForAudio();

    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledOnce());
    expect(mocks.pump.stop).not.toHaveBeenCalled();
    expect(mocks.pump.suspendMedia).toHaveBeenCalledOnce();
    expect(mocks.bridge.close).toHaveBeenCalledOnce();

    releaseCarrierSafety(true);

    await expect(ready).rejects.toThrow("provider connect failed");

    expect(mocks.pump.stop).toHaveBeenCalledOnce();
    expect(mocks.bridge.close).toHaveBeenCalledOnce();
  });

  it("stops native audio when Realtime session construction throws", async () => {
    mocks.createSession.mockImplementationOnce(() => {
      throw new Error("session construction failed");
    });

    const driver = await startFaceTimeTalkDriver(startParams());
    await expect(driver.readyForAudio()).rejects.toThrow("session construction failed");
    expect(mocks.pump.stop).toHaveBeenCalledOnce();
  });

  it("greets after the answered call's media route settles despite raw VAD noise", async () => {
    const driver = await startReadyFaceTimeTalkDriver();

    vi.useFakeTimers();
    try {
      expect(mocks.bridge.triggerGreeting).not.toHaveBeenCalled();
      driver.activate();
      driver.activate();
      mocks.sessionParams?.onEvent({
        direction: "server",
        type: "input_audio_buffer.speech_started",
      });
      await vi.advanceTimersByTimeAsync(100);

      expect(mocks.bridge.triggerGreeting).toHaveBeenCalledWith(
        "Greet the caller briefly, introduce yourself using your configured identity, and ask how you can help.",
      );
      expect(mocks.bridge.triggerGreeting).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ends the current call directly without consulting the agent", async () => {
    await startReadyFaceTimeTalkDriver();

    expect(mocks.sessionParams?.tools?.map((tool) => tool.name)).toEqual([
      "openclaw_agent_consult",
      "facetime_end_call",
    ]);
    expect(mocks.sessionParams?.instructions).toContain("call facetime_end_call immediately");

    await mocks.sessionParams?.onToolCall({
      itemId: "item-hangup",
      callId: "provider-hangup",
      name: "facetime_end_call",
      args: {},
    });

    expect(mocks.bridge.submitToolResult).toHaveBeenCalledWith(
      "provider-hangup",
      {
        status: "ending",
        message: "The current FaceTime call is ending. Do not speak another response.",
      },
      { suppressResponse: true },
    );
    expect(mocks.hangupRequested).toHaveBeenCalledOnce();
    expect(mocks.consult).not.toHaveBeenCalled();
  });

  it("keeps direct hangup available when agent consult tools are disabled", async () => {
    await startReadyFaceTimeTalkDriver(
      startParams({
        config: resolveFaceTimeConfig({
          ownerHandles: ["caller@example.com"],
          realtime: { toolPolicy: "none" },
        }),
      }),
    );

    expect(mocks.sessionParams?.tools?.map((tool) => tool.name)).toEqual(["facetime_end_call"]);
  });

  it("deduplicates repeated realtime hangup tool events", async () => {
    await startReadyFaceTimeTalkDriver();
    const event = {
      itemId: "item-hangup",
      callId: "provider-hangup",
      name: "facetime_end_call",
      args: {},
    };

    await mocks.sessionParams?.onToolCall(event);
    await mocks.sessionParams?.onToolCall(event);

    expect(mocks.hangupRequested).toHaveBeenCalledOnce();
    expect(mocks.consult).not.toHaveBeenCalled();
  });

  it("makes concurrent close callers join the same cleanup", async () => {
    let finishStop = () => {};
    mocks.pump.stop.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishStop = resolve;
        }),
    );
    const driver = await startReadyFaceTimeTalkDriver();

    const first = driver.close("first");
    const second = driver.close("second");
    await vi.waitFor(() => expect(mocks.pump.stop).toHaveBeenCalledOnce());
    finishStop();
    await Promise.all([first, second]);

    expect(mocks.bridge.close).toHaveBeenCalledOnce();
  });

  it("combines custom instructions with workspace identity and agent proxy policy", async () => {
    mocks.bridge.connect.mockResolvedValue();
    mocks.resolveBootstrapContext.mockResolvedValue(
      "OpenClaw realtime voice profile context:\n\n### IDENTITY.md\nName: Tide",
    );
    await startReadyFaceTimeTalkDriver(
      startParams({
        config: resolveFaceTimeConfig({
          ownerHandles: ["caller@example.com"],
          realtime: { instructions: "Speak warmly and keep answers short." },
        }),
      }),
    );

    expect(mocks.sessionParams?.instructions).toContain("Speak warmly and keep answers short.");
    expect(mocks.sessionParams?.instructions).toContain("Name: Tide");
    expect(mocks.sessionParams?.instructions).toContain("same configured OpenClaw agent");
    expect(mocks.sessionParams?.instructions).toContain(
      "authenticated owner/user described by the loaded workspace profile context",
    );
    expect(mocks.sessionParams?.instructions).toContain(
      "Answer greetings, acknowledgements, and questions about your own identity or persona directly",
    );
    expect(mocks.sessionParams?.instructions).toContain("Consult behavior: substantive.");
    expect(mocks.sessionParams?.instructions).toContain("Never claim you retried");
    expect(mocks.sessionParams?.instructions).not.toContain("Lobster");
    expect(mocks.sessionParams?.instructions).not.toContain("Omar");
  });
});
