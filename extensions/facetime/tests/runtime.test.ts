import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  helperParams: undefined as
    | undefined
    | {
        onMessage(message: unknown): void;
        onConnect(bundleIdentifier: string): void;
        onDisconnect(bundleIdentifier: string): void;
      },
  helper: {
    connectedSockets: 2,
    connectedHelperBundles: ["com.apple.FaceTime", "com.apple.mobilephone"],
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    answerCall: vi.fn(async () => ({})),
    leaveCall: vi.fn(async () => ({})),
    safetyMute: vi.fn(async () => ({})),
    setMuted: vi.fn(async () => ({})),
    startTransmission: vi.fn(async () => ({})),
    startCall: vi.fn(),
    findOutgoingCall: vi.fn(),
    cancelOutgoingCall: vi.fn(),
  },
  startTalk: vi.fn(),
}));

vi.mock("../src/helper-rpc.js", () => ({
  FaceTimeHelperActionError: class FaceTimeHelperActionError extends Error {},
  FaceTimeHelperAmbiguousError: class FaceTimeHelperAmbiguousError extends Error {},
  FaceTimeHelperUnavailableError: class FaceTimeHelperUnavailableError extends Error {},
  FaceTimeHelperSocketServer: class FaceTimeHelperSocketServer {
    constructor(params: NonNullable<typeof mocks.helperParams>) {
      mocks.helperParams = params;
      return mocks.helper;
    }
  },
}));

vi.mock("../src/helper-supervisor.js", () => ({
  FaceTimeHelperSupervisor: class FaceTimeHelperSupervisor {
    start() {}
    stop() {}
    status() {
      const connected = new Set(mocks.helper.connectedHelperBundles);
      return [
        {
          target: "FaceTime",
          connected:
            connected.has("com.apple.FaceTime") ||
            connected.has("com.apple.FaceTime.FTConversationService"),
        },
        {
          target: "Phone",
          connected:
            connected.has("com.apple.mobilephone") || connected.has("com.apple.TelephonyUtilities"),
        },
      ];
    }
    connected() {}
    disconnected() {}
    stale() {}
  },
}));

vi.mock("../src/plugin-paths.js", () => ({
  ensureCaptureBinary: vi.fn(async () => "/usr/bin/true"),
  ensureHelperArtifacts: vi.fn(async () => ({ buildId: "build", ipcKey: "key" })),
}));

vi.mock("../src/paired-audio-transport.js", () => ({
  assertPairedAudioTransport: vi.fn(async () => {}),
}));

vi.mock("../src/driver-setup.js", () => ({
  installFaceTimeDriver: vi.fn(async () => ({ changed: false })),
}));

vi.mock("../src/preflight.js", () => ({
  runFaceTimePreflight: vi.fn(async () => ({ ok: true, checks: [] })),
}));

vi.mock("../src/setup.js", () => ({
  runFaceTimeSetup: vi.fn(async () => ({ status: "ready", checks: [] })),
}));

vi.mock("../src/test-audio.js", () => ({
  playFaceTimeTestAudio: vi.fn(async () => ({ phrase: "test", deviceName: "OpenClaw-Feed" })),
}));

vi.mock("../src/talk-driver.js", () => ({
  startFaceTimeTalkDriver: mocks.startTalk,
}));

import { resolveFaceTimeConfig } from "../src/config.js";
import { createFaceTimeRuntime } from "../src/runtime.js";

function incomingCall(status = 4) {
  return {
    event: "ft-call-status-changed",
    data: {
      call_uuid: "call-1",
      call_status: status,
      is_outgoing: false,
      is_sending_audio: false,
      handle: { value: "owner@example.com" },
    },
  };
}

async function createRuntime() {
  return await createFaceTimeRuntime({
    config: resolveFaceTimeConfig({ whitelistHandles: ["owner@example.com"] }),
    fullConfig: {} as any,
    runtime: {
      system: {
        runCommandWithTimeout: vi.fn(),
      },
    } as any,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    },
    pluginRoot: "/plugin",
  });
}

function createTalkDriver(params: { readyForAudio?: () => Promise<void>; order?: string[] }) {
  let realtimeActive = false;
  return {
    callUUID: "call-1",
    recentTalkEvents: [],
    readyForAudio: vi.fn(async () => {
      params.order?.push("provider-and-route-readiness");
      await params.readyForAudio?.();
      realtimeActive = true;
    }),
    processOutputSuppressed: vi.fn(() => true),
    realtimeActive: vi.fn(() => realtimeActive),
    activate: vi.fn(() => {
      params.order?.push("activate");
    }),
    suspendMedia: vi.fn(async () => {
      realtimeActive = false;
    }),
    close: vi.fn(async () => {
      realtimeActive = false;
    }),
  };
}

describe("FaceTime runtime call sequencing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.helperParams = undefined;
    mocks.helper.connectedSockets = 2;
    mocks.helper.connectedHelperBundles = ["com.apple.FaceTime", "com.apple.mobilephone"];
  });

  it("answers muted after suppression, then waits for provider and route readiness", async () => {
    const order: string[] = [];
    let releaseReadiness = () => {};
    const talk = createTalkDriver({
      order,
      readyForAudio: () => new Promise<void>((resolve) => (releaseReadiness = resolve)),
    });
    mocks.startTalk.mockImplementationOnce(async () => {
      order.push("suppression-ready");
      return talk;
    });
    mocks.helper.answerCall.mockImplementationOnce(async () => {
      order.push("answer-muted");
      return {};
    });
    mocks.helper.setMuted.mockImplementationOnce(async () => {
      order.push("unmute");
      return {};
    });
    mocks.helper.startTransmission.mockImplementationOnce(async () => {
      order.push("start-transmission");
      return {};
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

  it("routes a realtime caller hangup request to the current carrier", async () => {
    const talk = createTalkDriver({});
    let requestHangup: (() => Promise<void>) | undefined;
    mocks.startTalk.mockImplementationOnce(
      async (params: { onHangupRequested(): Promise<void> }) => {
        requestHangup = params.onHangupRequested;
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
      () => new Promise<typeof talk>((resolve) => (releaseSuppression = () => resolve(talk))),
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

  it("keeps startup joined to carrier cleanup when an active call tap must be retained", async () => {
    vi.useFakeTimers();
    let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined;
    try {
      const startupError = new Error("capture failed during startup");
      let releaseStartup: Promise<boolean> | undefined;
      mocks.helper.leaveCall
        .mockRejectedValueOnce(new Error("carrier cleanup unavailable"))
        .mockResolvedValue({});
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

      await vi.advanceTimersByTimeAsync(1_000);
      await expect(releaseStartup).resolves.toBe(true);
      await vi.waitFor(async () => {
        expect((await runtime?.status())?.calls).toEqual([]);
      });

      expect(mocks.helper.leaveCall.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      await runtime?.stop();
      vi.useRealTimers();
    }
  });

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

  it("retains the safety bridge when a non-owner helper cannot find the call", async () => {
    const talk = createTalkDriver({});
    mocks.startTalk.mockResolvedValueOnce(talk);
    const runtime = await createRuntime();
    mocks.helperParams?.onMessage(incomingCall(1));
    await vi.waitFor(() => expect(talk.activate).toHaveBeenCalledOnce());
    vi.clearAllMocks();
    mocks.helper.connectedSockets = 1;
    mocks.helper.connectedHelperBundles = ["com.apple.mobilephone"];
    mocks.helper.leaveCall.mockRejectedValueOnce(new Error("Call not found!"));

    mocks.helperParams?.onDisconnect("com.apple.FaceTime");
    await vi.waitFor(() => expect(mocks.helper.leaveCall).toHaveBeenCalledWith("call-1"));

    expect((await runtime.status()).calls).toMatchObject([
      { callUUID: "call-1", carrierHangupPending: true },
    ]);
    expect(talk.close).not.toHaveBeenCalled();

    mocks.helper.connectedSockets = 2;
    mocks.helper.connectedHelperBundles = ["com.apple.mobilephone", "com.apple.FaceTime"];
    mocks.helperParams?.onConnect("com.apple.FaceTime");
    await vi.waitFor(async () => expect((await runtime.status()).calls).toEqual([]));
    expect(mocks.helper.leaveCall).toHaveBeenCalledTimes(2);
    expect(talk.close).toHaveBeenCalledWith("helper-reconnected");
    await runtime.stop();
  });

  it("treats a helper missing before call discovery as incomplete topology", async () => {
    const talk = createTalkDriver({});
    mocks.startTalk.mockResolvedValueOnce(talk);
    const runtime = await createRuntime();
    mocks.helper.connectedSockets = 1;
    mocks.helper.connectedHelperBundles = ["com.apple.mobilephone"];
    mocks.helperParams?.onDisconnect("com.apple.FaceTime");
    mocks.helperParams?.onMessage(incomingCall(1));
    await vi.waitFor(() => expect(talk.activate).toHaveBeenCalledOnce());
    mocks.helper.leaveCall.mockRejectedValueOnce(new Error("Call not found!"));

    await expect(runtime.hangup()).rejects.toThrow("carrier hangup pending");

    expect((await runtime.status()).calls).toMatchObject([
      { callUUID: "call-1", carrierHangupPending: true },
    ]);
    expect(talk.close).not.toHaveBeenCalled();

    mocks.helper.connectedSockets = 2;
    mocks.helper.connectedHelperBundles = ["com.apple.mobilephone", "com.apple.FaceTime"];
    mocks.helperParams?.onConnect("com.apple.FaceTime");
    await vi.waitFor(async () => expect((await runtime.status()).calls).toEqual([]));
    expect(mocks.helper.leaveCall).toHaveBeenCalledTimes(2);
    expect(talk.close).toHaveBeenCalledWith("helper-reconnected");
    await runtime.stop();
  });

  it("retries after a helper reconnects during an in-flight hangup", async () => {
    const talk = createTalkDriver({});
    mocks.startTalk.mockResolvedValueOnce(talk);
    const runtime = await createRuntime();
    mocks.helperParams?.onMessage(incomingCall(1));
    await vi.waitFor(() => expect(talk.activate).toHaveBeenCalledOnce());
    let rejectFirstHangup = (_error: Error) => {};
    mocks.helper.leaveCall.mockImplementationOnce(
      async () =>
        await new Promise<never>((_resolve, reject) => {
          rejectFirstHangup = reject;
        }),
    );
    mocks.helper.connectedSockets = 1;
    mocks.helper.connectedHelperBundles = ["com.apple.mobilephone"];
    mocks.helperParams?.onDisconnect("com.apple.FaceTime");
    await vi.waitFor(() => expect(mocks.helper.leaveCall).toHaveBeenCalledTimes(1));

    mocks.helper.connectedSockets = 2;
    mocks.helper.connectedHelperBundles = ["com.apple.mobilephone", "com.apple.FaceTime"];
    mocks.helperParams?.onConnect("com.apple.FaceTime");
    rejectFirstHangup(new Error("Call not found!"));

    await vi.waitFor(() => expect(mocks.helper.leaveCall).toHaveBeenCalledTimes(2), {
      timeout: 2_000,
    });
    await vi.waitFor(async () => expect((await runtime.status()).calls).toEqual([]));
    expect(talk.close).toHaveBeenCalled();
    await runtime.stop();
  });
});
