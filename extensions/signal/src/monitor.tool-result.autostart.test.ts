import { expectPairingReplyText } from "openclaw/plugin-sdk/channel-test-helpers";
import {
  PlatformMessageNotDispatchedError,
  toErrorObject as toLintErrorObject,
} from "openclaw/plugin-sdk/error-runtime";
import type { GetReplyOptions } from "openclaw/plugin-sdk/reply-runtime";
import { createNonExitingRuntime, waitForAbortSignal } from "openclaw/plugin-sdk/runtime-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SignalDaemonHandle } from "./daemon.js";
import {
  configureSignalToolResultTest as configure,
  receiveSignalPayloads,
  createMockSignalDaemonHandle,
  signalToolResultMocks,
  installSignalToolResultTestHooks,
  waitForSignalToolResultIngressDispatchIdle,
} from "./monitor.tool-result.test-harness.js";

installSignalToolResultTestHooks();

const { monitorSignalProvider: monitor } = await import("./monitor.js");

const {
  replyMock: reply,
  sendMock: send,
  signalRpcRequestMock: rpc,
  upsertPairingRequestMock: pair,
  waitForTransportReadyMock: waitUntilReady,
  assertSignalDaemonEndpointAvailableMock: probeEndpoint,
  signalCheckMock: checkSignal,
  spawnSignalDaemonMock: spawnDaemon,
  streamMock: stream,
  updateLastRouteMock,
  enqueueSystemEventMock,
} = signalToolResultMocks;

const SIGNAL_BASE_URL = "http://127.0.0.1:8080";
type MonitorOptions = NonNullable<Parameters<typeof monitor>[0]>;

async function rejectOnAbort(abortSignal?: AbortSignal | null) {
  await waitForAbortSignal(abortSignal ?? undefined);
  throw toLintErrorObject(abortSignal?.reason ?? new Error("aborted"), "Non-Error rejection");
}

function createAutoAbortController() {
  const controller = new AbortController();
  stream.mockImplementation(async () => controller.abort());
  return controller;
}

async function runMonitor(opts: MonitorOptions) {
  return monitor({
    runtime: { log: vi.fn(), error: vi.fn(), exit: createNonExitingRuntime().exit },
    ...opts,
  });
}

async function expectStartupFailure(error: string, opts: MonitorOptions) {
  await expect(runMonitor(opts)).rejects.toThrow(error);
  expect(spawnDaemon).not.toHaveBeenCalled();
}
function expectOptions(mock: typeof probeEndpoint, options: Record<string, unknown>) {
  expect(mock).toHaveBeenCalledWith(expect.objectContaining(options));
}
function runExternal(abortSignal: AbortSignal, opts: MonitorOptions = {}) {
  return monitor({ autoStart: false, baseUrl: SIGNAL_BASE_URL, abortSignal, ...opts });
}

describe("monitorSignalProvider autostart", () => {
  beforeEach(() => configure());
  it("uses the configured private socket for startup, readiness, and receive without HTTP", async () => {
    configure({
      transport: {
        kind: "managed-native",
        socketPath: "/private/signal/rpc",
        configPath: "~/.openclaw/signal-cli",
      },
    });
    waitUntilReady.mockImplementationOnce(async ({ check }: { check: () => Promise<unknown> }) => {
      await check();
    });
    const controller = createAutoAbortController();
    await runMonitor({ abortSignal: controller.signal });
    expectOptions(probeEndpoint, { socketPath: "/private/signal/rpc" });
    expectOptions(spawnDaemon, {
      socketPath: "/private/signal/rpc",
      configPath: "~/.openclaw/signal-cli",
    });
    expect(checkSignal).toHaveBeenCalledWith("unix:///private/signal/rpc", expect.any(Number));
    expectOptions(stream, { baseUrl: "unix:///private/signal/rpc" });
  });

  it("refuses HTTP overrides for an opted-in private transport", async () => {
    configure({ transport: { kind: "managed-native", socketPath: "/private/signal/rpc" } });
    await expectStartupFailure("cannot be combined with HTTP endpoint overrides", {
      baseUrl: SIGNAL_BASE_URL,
    });
  });
  it("normalizes an IPv6 override and reports an occupied endpoint before spawning", async () => {
    configure({ httpPort: 8181 });
    probeEndpoint.mockRejectedValueOnce(
      new Error("Signal managed native endpoint ::1:8181 is already in use."),
    );
    await expectStartupFailure("Signal managed native endpoint ::1:8181 is already in use.", {
      httpHost: "[::1]",
    });
    expectOptions(probeEndpoint, {
      httpHost: "::1",
      httpPort: 8181,
      abortSignal: expect.any(AbortSignal),
    });
    expect(waitUntilReady).not.toHaveBeenCalled();
  });

  it.each(["pending", "completed"] as const)(
    "does not spawn when monitoring aborts with a %s probe",
    async (phase) => {
      const controller = new AbortController();
      probeEndpoint.mockImplementationOnce(
        async ({ abortSignal }: { abortSignal: AbortSignal }) => {
          if (phase === "completed") {
            controller.abort();
          } else {
            queueMicrotask(() => controller.abort());
            await rejectOnAbort(abortSignal);
          }
        },
      );
      await expect(runMonitor({ abortSignal: controller.signal })).resolves.toBeUndefined();
      expect(spawnDaemon).not.toHaveBeenCalled();
    },
  );

  it.each(["while checking its endpoint", "before starting"] as const)(
    "enforces the startup deadline %s",
    async (phase) => {
      using now =
        phase === "before starting" ? vi.spyOn(Date, "now").mockReturnValue(1_000) : undefined;
      probeEndpoint.mockImplementationOnce(({ abortSignal }: { abortSignal: AbortSignal }) =>
        now ? Promise.resolve(void now.mockReturnValue(2_000)) : rejectOnAbort(abortSignal),
      );
      await expectStartupFailure(`signal daemon startup timed out after 1000ms ${phase}`, {
        startupTimeoutMs: 1_000,
      });
    },
  );

  it("bounds the final readiness request by the shared startup deadline", async () => {
    using now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const controller = createAutoAbortController();
    probeEndpoint.mockImplementationOnce(async () => void now.mockReturnValue(1_900));
    checkSignal.mockImplementationOnce(async () => {
      now.mockReturnValue(2_001);
      return { ok: true };
    });
    let readinessResult: unknown;
    waitUntilReady.mockImplementationOnce(async ({ check }: { check: () => Promise<unknown> }) => {
      readinessResult = await check();
    });
    await runMonitor({ abortSignal: controller.signal, startupTimeoutMs: 1_000 });
    expect(checkSignal).toHaveBeenCalledWith(SIGNAL_BASE_URL, 100);
    expect(readinessResult).toEqual({ ok: false, error: "startup deadline exceeded" });
  });

  it("fails fast when auto-started signal daemon exits during startup", async () => {
    const statusSink = vi.fn();
    spawnDaemon.mockReturnValueOnce(
      createMockSignalDaemonHandle({
        exited: Promise.resolve({ source: "process", code: 1, signal: null }),
      }),
    );
    waitUntilReady.mockImplementationOnce(({ abortSignal }: { abortSignal?: AbortSignal | null }) =>
      rejectOnAbort(abortSignal),
    );
    await expect(runMonitor({ statusSink })).rejects.toThrow(/signal daemon exited/i);
    expectOptions(statusSink, { lifecycle: "recovering", connected: false });
  });

  it.each([false, true])("joins daemon shutdown, including stop failure=%s", async (rejectStop) => {
    const controller = new AbortController();
    const exited = Promise.withResolvers<Awaited<SignalDaemonHandle["exited"]>>();
    const stopped = Promise.withResolvers<void>();
    const stopStarted = Promise.withResolvers<void>();
    spawnDaemon.mockReturnValueOnce(
      createMockSignalDaemonHandle({
        exited: exited.promise,
        stop: vi.fn(() => {
          exited.resolve({ source: "process", code: null, signal: "SIGTERM" });
          stopStarted.resolve();
          return stopped.promise;
        }),
      }),
    );
    stream.mockImplementationOnce(async () => {
      controller.abort(new Error("stop"));
    });
    // onAbort starts stop before ingress teardown has joined its rejection.
    void stopped.promise.catch(() => undefined);
    const stopError = new Error("daemon stop failed");
    const outcome = runMonitor({ abortSignal: controller.signal }).catch((error: unknown) => error);
    await stopStarted.promise;
    if (rejectStop) {
      stopped.reject(stopError);
    } else {
      stopped.resolve();
    }
    expect(await outcome).toBe(rejectStop ? stopError : undefined);
  });
});

function inboundPayload(dataMessage: Record<string, unknown>) {
  return { envelope: { sourceNumber: "+15550001111", timestamp: 1, dataMessage } };
}

function receiveEvent(message: string) {
  return { event: "receive", data: JSON.stringify(inboundPayload({ message })) };
}

describe("monitorSignalProvider tool results", () => {
  it("pairs UUID-only senders once while their pairing request remains pending", async () => {
    const uuid = "123e4567-e89b-12d3-a456-426614174000";
    configure({ autoStart: false, dmPolicy: "pairing", allowFrom: [] });
    pair
      .mockResolvedValueOnce({ code: "PAIRCODE", created: true })
      .mockResolvedValueOnce({ code: "PAIRCODE", created: false });
    await receiveSignalPayloads({
      payloads: [1, 2].map((timestamp) => ({
        envelope: {
          sourceUuid: uuid,
          sourceName: "Ada",
          timestamp,
          dataMessage: { message: "hello" },
        },
      })),
    });
    expect(reply).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toBe(`signal:${uuid}`);
    expectPairingReplyText(String(send.mock.calls[0]?.[1] ?? ""), {
      channel: "signal",
      idLine: `Your Signal sender id: uuid:${uuid}`,
      code: "PAIRCODE",
    });
  });

  it("drains an inline inbound message accepted before the monitor stops", async ({ signal }) => {
    const controller = new AbortController();
    const sendStarted = Promise.withResolvers<void>();
    const sendCompleted = Promise.withResolvers<void>();
    configure({ autoStart: false }, { visibleReplies: "automatic" });
    reply.mockResolvedValue({ text: "accepted reply" });
    send.mockImplementation(async () => {
      sendStarted.resolve();
      await sendCompleted.promise;
    });
    stream.mockImplementation(async ({ onEvent, abortSignal }) => {
      onEvent(receiveEvent("accepted message"));
      await waitForAbortSignal(abortSignal);
    });
    const monitorPromise = runExternal(AbortSignal.any([controller.signal, signal]));
    try {
      await Promise.race([
        sendStarted.promise,
        monitorPromise.then(() => {
          throw new Error("Signal monitor stopped before delivering the accepted reply");
        }),
      ]);
    } finally {
      controller.abort(new Error("monitor stopped"));
      sendCompleted.resolve();
      await monitorPromise;
    }
    expect(reply).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("+15550001111", "accepted reply", expect.anything());
  });

  it("does not dispatch a buffered inbound message after the monitor stops", async () => {
    vi.useFakeTimers();
    using _ = { [Symbol.dispose]: () => vi.useRealTimers() };
    const controller = new AbortController();
    configure({ autoStart: false }, { inbound: { debounceMs: 10 } });
    reply.mockResolvedValue({ text: "late reply" });
    stream.mockImplementation(async ({ onEvent }) => {
      onEvent(receiveEvent("wait for more"));
      controller.abort(new Error("monitor stopped"));
    });
    await runExternal(controller.signal);
    await vi.advanceTimersByTimeAsync(10);

    expect(reply).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("sizes attachment RPC response caps from mediaMaxMb", async () => {
    configure(
      { transport: { kind: "container", url: "http://container:8080" } },
      { visibleReplies: "automatic" },
    );
    reply.mockResolvedValue({ text: "ok" });
    rpc.mockResolvedValue({ data: "aGVsbG8=" });
    await receiveSignalPayloads({
      opts: { mediaMaxMb: 2, baseUrl: undefined },
      payloads: [
        inboundPayload({
          message: "",
          attachments: [{ id: "attachment-1", size: 1_500_000, contentType: "text/plain" }],
        }),
      ],
    });
    expect(rpc).toHaveBeenCalledWith(
      "getAttachment",
      { id: "attachment-1", recipient: "+15550001111" },
      expect.objectContaining({
        baseUrl: "http://container:8080",
        transportKind: "container",
        maxResponseBytes: 2_861_739,
      }),
    );
  });
});

const nativeQuote = {
  replyToId: "1700000000001",
  replyToAuthor: "+15550001111",
  replyToBody: "quote me",
};

function configureExternal(overrides: Record<string, unknown>) {
  configure({ autoStart: false, ...overrides });
}

function reaction(targetAuthor: string | undefined, extra = {}) {
  return { reactionMessage: { emoji: "✅", targetAuthor, targetSentTimestamp: 2, ...extra } };
}

function inboundEnvelope(envelope: Record<string, unknown>) {
  return { sourceNumber: "+15550001111", sourceName: "Ada", timestamp: 1, ...envelope };
}

const DEFAULT_ENVELOPE = { timestamp: 1700000000001, dataMessage: { message: "quote me" } };
function receiveSingleEnvelope(envelope: Record<string, unknown> = DEFAULT_ENVELOPE) {
  return receiveSignalPayloads({ payloads: [{ envelope: inboundEnvelope(envelope) }] });
}

function expectNoNativeQuote(options: unknown) {
  expect(options).not.toHaveProperty("replyToId");
  expect(options).not.toHaveProperty("replyToAuthor");
  expect(options).not.toHaveProperty("replyToBody");
}

function expectNoReplyDeliveryOrRouteUpdate() {
  expect(reply).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
  expect(updateLastRouteMock).not.toHaveBeenCalled();
}

function setReactionNotificationConfig(mode: "all" | "own", extra: Record<string, unknown> = {}) {
  configureExternal({ dmPolicy: "open", allowFrom: ["*"], reactionNotifications: mode, ...extra });
}

describe("monitor tool results", () => {
  it.each([true, false])("quotes final replies after a block (failed media=%s)", async (failed) => {
    configureExternal({ replyToMode: "first", streaming: { block: { enabled: true } } });
    send.mockResolvedValue({ messageId: "1700000000002" });
    if (failed) {
      send.mockRejectedValueOnce(
        new PlatformMessageNotDispatchedError("not dispatched", { cause: new Error("offline") }),
      );
    }
    reply.mockImplementation(async (_ctx, options: GetReplyOptions) => {
      await options.onBlockReply?.({
        text: "Streamed block",
        ...(failed ? { mediaUrl: "https://example.com/block.png" } : {}),
      });
      return { text: "Final answer" };
    });

    await receiveSingleEnvelope();

    expect(send.mock.calls.map((call) => call[1])).toEqual([
      "PFX Streamed block",
      "PFX Final answer",
    ]);
    expect(send.mock.calls[0]?.[2]).toMatchObject({
      ...nativeQuote,
      ...(failed ? { mediaUrl: "https://example.com/block.png" } : {}),
    });
    if (failed) {
      expect(send.mock.calls[1]?.[2]).toMatchObject(nativeQuote);
    } else {
      expect(send.mock.calls[1]?.[2]).not.toHaveProperty("replyToId");
    }
  });

  it("passes group inbound quote metadata through group reply mode overrides", async () => {
    configureExternal({
      groupPolicy: "open",
      replyToMode: "off",
      replyToModeByChatType: { group: "all" },
    });
    reply.mockResolvedValue({ text: "group reply" });
    await receiveSingleEnvelope({
      timestamp: 1700000000001,
      dataMessage: {
        message: "group quote me",
        groupInfo: { groupId: "signal-group-id", groupName: "Testing realm" },
      },
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toBe("group:signal-group-id");
    expect(send.mock.calls[0]?.[2]).toMatchObject({
      replyToId: "1700000000001",
      replyToAuthor: "+15550001111",
      replyToBody: "group quote me",
    });
  });

  it("keeps status notices outside the first quote slot", async () => {
    configureExternal({ replyToMode: "first" });
    reply.mockResolvedValue([{ text: "working", isStatusNotice: true }, { text: "final reply" }]);
    await receiveSingleEnvelope();
    expect(send.mock.calls.map((call) => call[1])).toEqual(["PFX working", "PFX final reply"]);
    for (const call of send.mock.calls) {
      expect(call[2]).toMatchObject(nativeQuote);
    }
  });

  it("keeps durable conversation events separate in batched reply mode", async ({ signal }) => {
    configure(
      { autoStart: false, replyToMode: "batched" },
      {
        visibleReplies: "automatic",
        inbound: { debounceMs: 10 },
      },
    );
    reply.mockResolvedValue({ text: "reply" });
    const abortController = new AbortController();
    const eventsAccepted = Promise.withResolvers<void>();
    const messages = ["first message", "second message"].map((message, index) => ({
      timestamp: 1700000000001 + index,
      message,
      delivered: Promise.withResolvers<void>(),
    }));
    send.mockImplementation(async () => {
      messages[send.mock.calls.length - 1]?.delivered.resolve();
    });
    stream.mockImplementation(async ({ onEvent, abortSignal }) => {
      for (const { timestamp, message } of messages) {
        await onEvent({
          event: "receive",
          data: JSON.stringify({
            envelope: inboundEnvelope({ timestamp, dataMessage: { message } }),
          }),
        });
      }
      eventsAccepted.resolve();
      await waitForAbortSignal(abortSignal);
    });

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const monitorPromise = runExternal(AbortSignal.any([abortController.signal, signal]));
    const monitorStopped = monitorPromise.then(() => {
      throw new Error("Signal monitor stopped before delivering both replies");
    });
    try {
      await Promise.race([eventsAccepted.promise, monitorStopped]);
      for (const [index, { timestamp, message, delivered }] of messages.entries()) {
        // Pump admission can finish before the handler schedules its debounce.
        await Promise.race([waitForSignalToolResultIngressDispatchIdle(), monitorStopped]);
        await vi.advanceTimersByTimeAsync(10);
        await Promise.race([delivered.promise, monitorStopped]);
        expect(reply.mock.calls[index]?.[0]).toMatchObject({
          MessageSid: String(timestamp),
          RawBody: message,
        });
      }
    } finally {
      abortController.abort();
      await monitorPromise.finally(() => vi.useRealTimers());
    }
    expect(reply).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(2);
    for (const call of send.mock.calls) {
      expectNoNativeQuote(call[2]);
    }
  });

  it.each([
    [{ replyToId: "1700000000999" }, undefined, false],
    [{ replyToCurrent: false }, undefined, false],
    [{ replyToCurrent: true }, "off", true],
  ] as const)("applies explicit native quote override %j", async (payload, mode, quoted) => {
    if (mode) {
      configureExternal({ replyToMode: mode });
    }
    reply.mockResolvedValue({ text: "final reply", ...payload });
    await receiveSingleEnvelope();
    expect(send).toHaveBeenCalledTimes(1);
    const options = send.mock.calls[0]?.[2];
    if (quoted) {
      expect(options).toMatchObject(nativeQuote);
    } else {
      expectNoNativeQuote(options);
    }
  });

  it("ignores reaction-only dataMessage.reaction events (don’t treat as broken attachments)", async () => {
    await receiveSingleEnvelope({
      dataMessage: {
        reaction: { emoji: "👍", targetAuthor: "+15550002222", targetSentTimestamp: 2 },
        attachments: [{}],
      },
    });
    expectNoReplyDeliveryOrRouteUpdate();
  });

  it("blocks reaction notifications from unauthorized senders", async () => {
    setReactionNotificationConfig("all", { dmPolicy: "allowlist", allowFrom: ["+15550007777"] });
    await receiveSingleEnvelope(reaction("+15550002222"));
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    expectNoReplyDeliveryOrRouteUpdate();
    expect(pair).not.toHaveBeenCalled();
  });

  it.each([
    ["UUID and phone", "+15550002222", undefined],
    ["UUID-only", undefined, "123e4567-e89b-12d3-a456-426614174000"],
  ] as const)(
    "notifies on own %s reactions from allowlisted senders",
    async (_name, targetAuthor, accountUuid) => {
      setReactionNotificationConfig("own", {
        account: "+15550002222",
        accountUuid,
        dmPolicy: "allowlist",
        allowFrom: ["+15550001111"],
      });
      await receiveSingleEnvelope(
        reaction(targetAuthor, { targetAuthorUuid: "123e4567-e89b-12d3-a456-426614174000" }),
      );
      expect(enqueueSystemEventMock).toHaveBeenCalledWith(
        expect.stringContaining("Signal reaction added"),
        expect.objectContaining({ sessionKey: "agent:main:main" }),
      );
      expectNoReplyDeliveryOrRouteUpdate();
      expect(pair).not.toHaveBeenCalled();
    },
  );

  it("processes messages when reaction metadata is present", async () => {
    reply.mockResolvedValue({ text: "pong" });
    await receiveSingleEnvelope({
      reactionMessage: { emoji: "👍", targetAuthor: "+15550002222", targetSentTimestamp: 2 },
      dataMessage: { message: "ping" },
    });
    expect(send).toHaveBeenCalledTimes(1);
  });
});
