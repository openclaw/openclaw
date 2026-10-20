import { createAgentHarnessAttemptDeadlineController } from "openclaw/plugin-sdk/agent-harness-attempt-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TURN_TERMINAL_SETTLEMENT_TIMEOUT_MS } from "./attempt-timeouts.js";
import { createWebSocketPeer } from "./client-websocket.test-support.js";
import {
  CodexAppServerClient,
  isCodexAppServerIndeterminateRequestCancellationError,
  isCodexAppServerIndeterminateTransportError,
  isCodexAppServerPrewriteRequestCancellationError,
  isCodexAppServerRequestTimeoutError,
} from "./client.js";
import { createClientHarness } from "./test-support.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

const clients: CodexAppServerClient[] = [];
function createHarness() {
  vi.useFakeTimers();
  const harness = createClientHarness();
  clients.push(harness.client);
  return harness;
}

const cancellation = (client: CodexAppServerClient, signal: AbortSignal) =>
  client
    .request("turn/start", { threadId: "receiver" }, { signal })
    .catch((error: unknown) => error);
afterEach(() => {
  for (const client of clients.splice(0)) {
    client.close();
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Codex app-server cancellation diagnostics", () => {
  it.each(["before request", "pending request", "overload backoff"] as const)(
    "preserves cancellation cause and write certainty: %s",
    async (phase) => {
      const harness = createHarness();
      const controller = new AbortController();
      const reason = new Error("receiver execution budget timed out");
      if (phase === "before request") {
        controller.abort(reason);
      }
      const result = cancellation(harness.client, controller.signal);
      if (phase === "overload backoff") {
        const sent = JSON.parse(await harness.waitForWrite(0));
        harness.send({ id: sent.id, error: { code: -32001, message: "Server overloaded" } });
        await vi.advanceTimersByTimeAsync(0);
      }
      controller.abort(reason);
      const error = await result;
      expect(error).toMatchObject({
        name: "CodexAppServerLocalRequestCancellationError",
        code: "CODEX_APP_SERVER_LOCAL_REQUEST_CANCELLED",
        reason: "aborted",
        cause: reason,
      });
      expect(formatErrorMessage(error)).toContain(reason.message);
      const written = phase === "pending request";
      expect(isCodexAppServerIndeterminateRequestCancellationError(error)).toBe(written);
      expect(isCodexAppServerPrewriteRequestCancellationError(error)).toBe(!written);
      expect(isCodexAppServerRequestTimeoutError(error)).toBe(false);
      expect(isCodexAppServerIndeterminateTransportError(error)).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(harness.writes).toHaveLength(phase === "before request" ? 0 : 1);
      expect(harness.client.getCloseError()).toBeUndefined();
    },
  );

  it("projects an elapsed receiver deadline through a real WebSocket request", async () => {
    const controller = new AbortController();
    const reason = new Error("codex app-server execution budget timed out");
    let releaseLateReply = () => {};
    const turnReceived = createDeferred<void>();
    const peer = await createWebSocketPeer((request, reply) => {
      if (request.method === "initialize") {
        reply({ userAgent: `openclaw/${CODEX_APP_SERVER_VERSION}` });
      } else if (request.method === "turn/start") {
        releaseLateReply = () => reply({ turn: { id: "late-turn" } });
        turnReceived.resolve();
      } else if (request.method === "model/list") {
        reply({ data: [] });
      }
    });
    const client = await CodexAppServerClient.start({
      transport: "websocket",
      url: peer.url,
    });
    clients.push(client);
    try {
      await client.initialize();
      const result = cancellation(client, controller.signal);
      await turnReceived.promise;
      const onTimeout = vi.fn(() => controller.abort(reason));
      const deadline = createAgentHarnessAttemptDeadlineController({
        startedAtMs: Date.now() - 15_000,
        startedAtMonotonicMs: performance.now() - 15_000,
        timeoutMs: 1_000,
        settlementTimeoutMs: TURN_TERMINAL_SETTLEMENT_TIMEOUT_MS,
        signal: controller.signal,
        onTimeout,
      });
      try {
        const error = await result;
        expect(onTimeout).toHaveBeenCalledExactlyOnceWith({
          kind: "execution",
          elapsedMs: expect.any(Number),
          timeoutMs: 1_000,
        });
        expect(formatErrorMessage(error)).toBe(
          "turn/start aborted: codex app-server execution budget timed out",
        );
        expect(isCodexAppServerIndeterminateRequestCancellationError(error)).toBe(true);
        releaseLateReply();
        await expect(client.request("model/list", {})).resolves.toEqual({ data: [] });
        expect(peer.methods).toEqual(["initialize", "initialized", "turn/start", "model/list"]);
      } finally {
        deadline.dispose();
      }
    } finally {
      client.close();
      await peer.close();
    }
  });

  it("keeps explicit cancellation distinct from the local request timer", async () => {
    const harness = createHarness();
    const controller = new AbortController();
    const cancelled = cancellation(harness.client, controller.signal);
    controller.abort("operator cancelled this run");
    expect(formatErrorMessage(await cancelled)).toContain("operator cancelled this run");
    expect(isCodexAppServerRequestTimeoutError(await cancelled)).toBe(false);
    const timedOut = harness.client
      .request("turn/start", {}, { timeoutMs: 100 })
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(100);
    expect(await timedOut).toMatchObject({ message: "turn/start timed out", reason: "timed out" });
    expect(isCodexAppServerRequestTimeoutError(await timedOut)).toBe(true);
  });
});
