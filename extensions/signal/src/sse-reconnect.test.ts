import { beforeEach, describe, expect, it, vi } from "vitest";

const { streamSignalEventsMock, sleepWithAbortMock } = vi.hoisted(() => ({
  streamSignalEventsMock: vi.fn(),
  sleepWithAbortMock: vi.fn(),
}));

vi.mock("./client.js", () => ({
  streamSignalEvents: streamSignalEventsMock,
}));

vi.mock("../infra/backoff.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/backoff.js")>("../infra/backoff.js");
  return {
    ...actual,
    sleepWithAbort: sleepWithAbortMock,
  };
});

describe("runSignalSseLoop status hooks", () => {
  beforeEach(() => {
    streamSignalEventsMock.mockReset();
    sleepWithAbortMock.mockReset();
  });

  it("publishes open and disconnect hooks across reconnect attempts", async () => {
    const { runSignalSseLoop } = await import("./sse-reconnect.js");
    const runtime = { error: vi.fn(), log: vi.fn(), exit: vi.fn() } as const;
    const onOpen = vi.fn();
    const onDisconnect = vi.fn();
    const onEvent = vi.fn();
    const abort = new AbortController();

    streamSignalEventsMock
      .mockImplementationOnce(async ({ onOpen: notifyOpen, onEvent: notifyEvent }) => {
        notifyOpen?.();
        notifyEvent({ event: "message", data: "{}" });
      })
      .mockImplementationOnce(async ({ onOpen: notifyOpen }) => {
        notifyOpen?.();
        throw new Error("network lost");
      });

    let sleepCalls = 0;
    sleepWithAbortMock.mockImplementation(async () => {
      sleepCalls += 1;
      if (sleepCalls >= 2) {
        abort.abort();
      }
    });

    await runSignalSseLoop({
      baseUrl: "http://127.0.0.1:8080",
      abortSignal: abort.signal,
      runtime,
      onOpen,
      onDisconnect,
      onEvent,
    });

    expect(onOpen).toHaveBeenCalledTimes(2);
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onDisconnect).toHaveBeenCalledTimes(2);
    expect(onDisconnect).toHaveBeenNthCalledWith(1, { reconnectAttempts: 1 });
    expect(onDisconnect).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ reconnectAttempts: 2, error: expect.any(Error) }),
    );
  });
});
