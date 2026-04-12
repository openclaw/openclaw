import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { monitorIMessageProvider } from "./monitor.js";

const waitForTransportReadyMock = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<void>>(async () => {}),
);
const createIMessageRpcClientMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => unknown>());
const attachIMessageMonitorAbortHandlerMock = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => () => void>(() => () => {}),
);

vi.mock("openclaw/plugin-sdk/infra-runtime", () => ({
  waitForTransportReady: (...args: unknown[]) => waitForTransportReadyMock(...args),
}));

vi.mock("./client.js", () => ({
  createIMessageRpcClient: (...args: unknown[]) => createIMessageRpcClientMock(...args),
}));

vi.mock("./monitor/abort-handler.js", () => ({
  attachIMessageMonitorAbortHandler: (...args: unknown[]) =>
    attachIMessageMonitorAbortHandlerMock(...args),
}));

function createRuntime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
  };
}

function createRpcClient(overrides?: {
  request?: (method: string) => Promise<unknown>;
  waitForClose?: () => Promise<void>;
}) {
  return {
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
}

describe("monitorIMessageProvider watch.subscribe startup retry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    waitForTransportReadyMock.mockReset().mockResolvedValue(undefined);
    createIMessageRpcClientMock.mockReset();
    attachIMessageMonitorAbortHandlerMock.mockReset().mockReturnValue(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
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
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("watch.subscribe startup failed"),
    );
    expect(runtime.error).not.toHaveBeenCalledWith(
      expect.stringContaining("imessage: monitor failed"),
    );
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
    }).catch((error) => error);

    await vi.runAllTimersAsync();
    const monitorError = await monitorErrorPromise;

    expect(monitorError).toBeInstanceOf(Error);
    expect((monitorError as Error).message).toContain("imsg rpc timeout (watch.subscribe)");
    expect(createIMessageRpcClientMock).toHaveBeenCalledTimes(3);
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("imessage: monitor failed"));
  });
});
