import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRuntimeSpies } from "../../test-support/runtime-spies.js";
import { cleanupFeishuMonitorStateForTests } from "./monitor.cleanup.test-helpers.js";
import { botOpenIds } from "./monitor.state.js";
import { monitorWebSocket } from "./monitor.transport.js";
import type { ResolvedFeishuAccount } from "./types.js";

const createFeishuWSClientMock = vi.hoisted(() => vi.fn());
vi.mock("./client.js", () => ({ createFeishuWSClient: createFeishuWSClientMock }));

const createWsClient = () => ({ start: vi.fn(), close: vi.fn() });
async function startMonitor(accountId: string, ...clients: ReturnType<typeof createWsClient>[]) {
  clients.forEach((client) => createFeishuWSClientMock.mockResolvedValueOnce(client));
  const abortController = new AbortController();
  const runtime = createRuntimeSpies();
  botOpenIds.set(accountId, "ou_bot");
  const monitor = monitorWebSocket({
    account: {
      accountId,
      enabled: true,
      configured: true,
      domain: "feishu",
      config: { enabled: true, connectionMode: "websocket" },
    } as ResolvedFeishuAccount,
    accountId,
    runtime,
    abortSignal: abortController.signal,
    eventDispatcher: {} as never,
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(clients[0]?.start).toHaveBeenCalledTimes(1);
  return {
    runtime,
    async stop() {
      abortController.abort();
      await monitor;
      expect(botOpenIds.has(accountId)).toBe(false);
      expect(createFeishuWSClientMock).toHaveBeenCalledTimes(clients.length);
      for (const client of clients) {
        expect(client.close).toHaveBeenCalledTimes(1);
      }
    },
    async reportError(message: string) {
      const callbacks = createFeishuWSClientMock.mock.calls[0]?.[1];
      expect(callbacks).toMatchObject({ onError: expect.any(Function) });
      (callbacks as { onError?: (error: Error) => void }).onError?.(new Error(message));
      await vi.advanceTimersByTimeAsync(0);
    },
  };
}
function errorMessage(runtime: ReturnType<typeof createRuntimeSpies>, ...fragments: string[]) {
  const message = String(runtime.error.mock.calls[0]?.[0] ?? "");
  expect(message).not.toMatch(/\n|token_abc/);
  for (const fragment of fragments) {
    expect(message).toContain(fragment);
  }
  return message;
}

beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  vi.useRealTimers();
  await cleanupFeishuMonitorStateForTests();
  vi.clearAllMocks();
});
afterAll(() => {
  vi.doUnmock("./client.js");
  vi.resetModules();
});

it.each(["start rejection", "SDK exhaustion"])("retries after %s", async (failure) => {
  const failed = createWsClient();
  const startRejected = failure === "start rejection";
  if (startRejected) {
    failed.start.mockRejectedValueOnce(
      new Error("connect failed\nAuthorization: Bearer token_abc appSecret=secret_abc"),
    );
  }
  const recovered = createWsClient();
  const monitor = await startMonitor("retry", failed, recovered);
  if (!startRejected) {
    await monitor.reportError("WebSocket reconnect exhausted after 3 attempts\nBearer token_abc");
    expect(botOpenIds.get("retry")).toBe("ou_bot");
  }
  expect(failed.close).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(recovered.start).toHaveBeenCalledTimes(1);
  await monitor.stop();
  expect(monitor.runtime.error).toHaveBeenCalledTimes(1);
  const message = errorMessage(
    monitor.runtime,
    startRejected
      ? "WebSocket start failed, retrying in 1000ms"
      : "WebSocket connection ended, recreating client in 1000ms",
    "Bearer [redacted]",
  );
  if (startRejected) {
    expect(message).toContain("Authorization: Bearer [redacted]");
    expect(message).toContain("appSecret=[redacted]");
    expect(message).not.toContain("secret_abc");
  }
});

it.each([false, true])("handles callback errors with terminal=%s", async (terminal) => {
  const client = createWsClient();
  const monitor = await startMonitor("callback", client);
  await monitor.reportError(
    terminal
      ? "WebSocket reconnect exhausted after 3 attempts"
      : "temporary callback failure\nBearer token_abc",
  );
  if (!terminal) {
    await vi.advanceTimersByTimeAsync(1_000);
    errorMessage(monitor.runtime, "WebSocket SDK reported recoverable error", "Bearer [redacted]");
  }
  expect(createFeishuWSClientMock).toHaveBeenCalledTimes(1);
  expect(client.close).toHaveBeenCalledTimes(terminal ? 1 : 0);
  await monitor.stop();
});

it("redacts close errors and truncates them without splitting surrogate pairs", async () => {
  const prefix = "access_token=[redacted] ";
  const padding = "x".repeat(499 - prefix.length);
  const client = createWsClient();
  client.close.mockImplementationOnce(() => {
    throw new Error(`access_token=secret_token\n${padding}😀tail`);
  });
  const monitor = await startMonitor("close-error", client);
  await monitor.stop();
  expect(errorMessage(monitor.runtime)).toBe(
    `feishu[close-error]: error closing WebSocket client: ${prefix}${padding}...`,
  );
});
