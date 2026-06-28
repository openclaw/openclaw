// Imessage tests cover monitor.watch subscribe retry plugin behavior.
import type { waitForTransportReady } from "openclaw/plugin-sdk/transport-ready-runtime";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { createIMessageRpcClient, IMessageRpcClient } from "./client.js";
import { monitorIMessageProvider } from "./monitor.js";
import type { attachIMessageMonitorAbortHandler } from "./monitor/abort-handler.js";
import {
  describeIMessageInboundDropDiagnostic,
  shouldThrottleIMessageInboundDropDiagnostic,
} from "./monitor/monitor-provider.js";
import { clearIMessageRuntime } from "./runtime.js";

const waitForTransportReadyMock = vi.hoisted(() =>
  vi.fn<typeof waitForTransportReady>(async () => {}),
);
const createIMessageRpcClientMock = vi.hoisted(() => vi.fn<typeof createIMessageRpcClient>());
const attachIMessageMonitorAbortHandlerMock = vi.hoisted(() =>
  vi.fn<typeof attachIMessageMonitorAbortHandler>(() => () => {}),
);

vi.mock("openclaw/plugin-sdk/transport-ready-runtime", () => ({
  waitForTransportReady: waitForTransportReadyMock,
}));

vi.mock("./client.js", () => ({
  createIMessageRpcClient: createIMessageRpcClientMock,
}));

vi.mock("./monitor/abort-handler.js", () => ({
  attachIMessageMonitorAbortHandler: attachIMessageMonitorAbortHandlerMock,
}));

function createRuntime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
  };
}

type MockIMessageRpcClient = IMessageRpcClient & {
  request: ReturnType<typeof vi.fn<(method: string) => Promise<unknown>>>;
  waitForClose: ReturnType<typeof vi.fn<() => Promise<void>>>;
  stop: ReturnType<typeof vi.fn<() => Promise<void>>>;
};

function createRpcClient(overrides?: {
  request?: (method: string) => Promise<unknown>;
  waitForClose?: () => Promise<void>;
}): MockIMessageRpcClient {
  const client = {
    request: vi.fn(
      overrides?.request ??
        (async () => {
          return { subscription: 1 };
        }),
    ),
    waitForClose: vi.fn(
      overrides?.waitForClose ??
        (async () => {
          return undefined;
        }),
    ),
    stop: vi.fn(async () => {}),
  };
  return client as unknown as MockIMessageRpcClient;
}

describe("monitorIMessageProvider watch.subscribe startup retry", () => {
  beforeEach(() => {
    // Clear any iMessage runtime left behind by earlier tests in the same
    // non-isolated vitest worker. The runtime slot is registered on globalThis
    // (so duplicate plugin-sdk module instances share one runtime per plugin
    // id) and survives vi.resetModules between files. Without this clear,
    // loadIMessageRecoveryCursor("default") can return a rowid written by an
    // earlier test, and the monitor sends watch.subscribe with the leaked
    // `since_rowid` (and logs `since_rowid=<leaked>` instead of
    // `since_rowid=none`), reproducing #1095 in broad serial suite order.
    // We deliberately clear rather than install a fresh test runtime here so
    // the recovery-cursor read falls through to the catch path (returns null)
    // and the test stays decoupled from the plugin-state sqlite store, which
    // would otherwise interact badly with the fake timers this suite uses.
    clearIMessageRuntime();
    vi.useFakeTimers();
    waitForTransportReadyMock.mockReset().mockResolvedValue(undefined);
    createIMessageRpcClientMock.mockReset();
    attachIMessageMonitorAbortHandlerMock.mockReset().mockReturnValue(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(() => {
    vi.doUnmock("openclaw/plugin-sdk/transport-ready-runtime");
    vi.doUnmock("./client.js");
    vi.doUnmock("./monitor/abort-handler.js");
    vi.resetModules();
  });

  it("retries a transient watch.subscribe startup timeout without tearing down the monitor", async () => {
    const runtime = createRuntime();
    const firstClient = createRpcClient({
      request: async () => {
        throw new Error("imsg rpc timeout (watch.subscribe)");
      },
    });
    const secondClient = createRpcClient();

    createIMessageRpcClientMock
      .mockResolvedValueOnce(firstClient)
      .mockResolvedValueOnce(secondClient);

    const monitorPromise = monitorIMessageProvider({
      config: { channels: { imessage: {} } } as never,
      runtime: runtime as never,
    });

    await vi.runAllTimersAsync();
    await monitorPromise;

    expect(createIMessageRpcClientMock).toHaveBeenCalledTimes(2);
    expect(firstClient.stop).toHaveBeenCalledTimes(1);
    expect(secondClient.waitForClose).toHaveBeenCalledTimes(1);
    expect(secondClient.stop).toHaveBeenCalledTimes(1);
    expect(secondClient.request).toHaveBeenCalledWith(
      "watch.subscribe",
      { attachments: false, include_reactions: true },
      { timeoutMs: 10_000 },
    );
    expect(runtime.log).toHaveBeenCalledTimes(1);
    const retryLog = String(runtime.log.mock.calls[0]?.[0]);
    expect(retryLog).toContain("imessage: watch.subscribe startup failed attempt=1/3");
    expect(retryLog).toContain("account=default");
    expect(retryLog).toContain("cliPath=imsg");
    expect(retryLog).toContain("dbPath=default");
    expect(retryLog).toContain("timeoutMs=10000");
    expect(retryLog).toContain("since_rowid=none");
    expect(retryLog).toContain("attachments=false");
    expect(retryLog).toContain("retry_in_ms=1000");
    expect(retryLog).toContain("Error: imsg rpc timeout (watch.subscribe)");
    expect(
      runtime.error.mock.calls.some(([message]) =>
        String(message).includes("imessage: monitor failed"),
      ),
    ).toBe(false);
  });

  it("still fails after bounded startup retries are exhausted", async () => {
    const runtime = createRuntime();
    createIMessageRpcClientMock.mockImplementation(async () =>
      createRpcClient({
        request: async () => {
          throw new Error("imsg rpc timeout (watch.subscribe)");
        },
      }),
    );

    const monitorErrorPromise = monitorIMessageProvider({
      config: { channels: { imessage: {} } } as never,
      runtime: runtime as never,
    }).catch((error: unknown) => error);

    await vi.runAllTimersAsync();
    const monitorError = await monitorErrorPromise;

    expect(monitorError).toBeInstanceOf(Error);
    expect((monitorError as Error).message).toContain("imsg rpc timeout (watch.subscribe)");
    expect(createIMessageRpcClientMock).toHaveBeenCalledTimes(3);
    expect(runtime.error).toHaveBeenCalledTimes(1);
    const failureLog = String(runtime.error.mock.calls[0]?.[0]);
    expect(failureLog).toContain(
      "imessage: monitor failed: imessage: watch.subscribe startup failed attempt=3/3",
    );
    expect(failureLog).toContain("account=default");
    expect(failureLog).toContain("timeoutMs=10000");
    expect(failureLog).toContain("Error: imsg rpc timeout (watch.subscribe)");
  });
});

describe("describeIMessageInboundDropDiagnostic", () => {
  it("describes echo-style drops without message content or sender handles", () => {
    const diagnostic = describeIMessageInboundDropDiagnostic({
      accountId: "default",
      reason: "echo",
      message: {
        id: 42,
        chat_id: 123,
        guid: "p:0/secret-guid",
        is_group: false,
        created_at: "2026-06-09T10:00:00.000Z",
      },
    });

    expect(diagnostic).toBe(
      'imessage: dropped inbound message account=default reason="echo" chat_id=123 group=false message_id=42 guid=present created_at=2026-06-09T10:00:00.000Z',
    );
    expect(diagnostic).not.toContain("secret-guid");
    expect(diagnostic).not.toContain("+1555");
  });

  it("describes from-me drops and marks them for throttling", () => {
    const diagnostic = describeIMessageInboundDropDiagnostic({
      accountId: "default",
      reason: "from me",
      message: {
        id: 43,
        chat_id: 456,
        guid: "p:0/outbound-guid",
        is_group: true,
        created_at: "2026-06-09T10:01:00.000Z",
      },
    });

    expect(diagnostic).toBe(
      'imessage: dropped inbound message account=default reason="from me" chat_id=456 group=true message_id=43 guid=present created_at=2026-06-09T10:01:00.000Z',
    );
    expect(diagnostic).not.toContain("outbound-guid");
    expect(shouldThrottleIMessageInboundDropDiagnostic("from me")).toBe(true);
    expect(shouldThrottleIMessageInboundDropDiagnostic("echo")).toBe(false);
  });

  it("keeps normal policy drops quiet", () => {
    expect(
      describeIMessageInboundDropDiagnostic({
        accountId: "default",
        reason: "no mention",
        message: {
          id: 42,
          chat_id: 123,
          is_group: true,
        },
      }),
    ).toBeNull();
  });
});
