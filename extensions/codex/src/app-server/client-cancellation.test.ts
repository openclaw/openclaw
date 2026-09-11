import { once } from "node:events";
import { formatErrorMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { createCodexAttemptDeadlineController } from "./attempt-deadlines.js";
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
afterEach(() => {
  for (const client of clients.splice(0)) {
    client.close();
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Codex app-server cancellation diagnostics", () => {
  it.each(["before request", "pending request", "overload backoff", "config fence"] as const)(
    "preserves the cancellation cause and write certainty during %s",
    async (phase) => {
      vi.useFakeTimers();
      const harness = createClientHarness();
      clients.push(harness.client);
      const controller = new AbortController();
      const reason = new Error("receiver execution budget timed out");
      if (phase === "before request") {
        controller.abort(reason);
      }
      if (phase === "config fence") {
        harness.client.setThreadSessionRequestGuard(
          ({ abortMessage }) =>
            new Promise((_resolve, reject) => {
              controller.signal.addEventListener("abort", () => reject(new Error(abortMessage)), {
                once: true,
              });
            }),
        );
      }
      const method = phase === "config fence" ? "thread/resume" : "turn/start";
      const result = harness.client
        .request(method, { threadId: "receiver" }, { signal: controller.signal })
        .catch((error: unknown) => error);
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
      expect(harness.writes).toHaveLength(
        phase === "pending request" || phase === "overload backoff" ? 1 : 0,
      );
      expect(harness.client.getCloseError()).toBeUndefined();
    },
  );

  it("projects an elapsed receiver deadline through a real WebSocket request", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    const controller = new AbortController();
    const reason = new Error("codex app-server execution budget timed out");
    const requests: string[] = [];
    let releaseLateReply = () => {};
    let receivedTurn: () => void = () => {};
    const turnReceived = new Promise<void>((resolve) => {
      receivedTurn = resolve;
    });
    server.on("connection", (socket) => {
      socket.on("message", (data) => {
        if (!Buffer.isBuffer(data)) {
          throw new Error("expected a WebSocket Buffer");
        }
        const request = JSON.parse(data.toString("utf8"));
        requests.push(request.method);
        if (request.method === "initialize") {
          socket.send(
            JSON.stringify({
              id: request.id,
              result: { userAgent: `openclaw/${CODEX_APP_SERVER_VERSION}` },
            }),
          );
        } else if (request.method === "turn/start") {
          releaseLateReply = () =>
            socket.send(JSON.stringify({ id: request.id, result: { turn: { id: "late-turn" } } }));
          receivedTurn();
        } else if (request.method === "model/list") {
          socket.send(JSON.stringify({ id: request.id, result: { data: [] } }));
        }
      });
    });
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected loopback test port");
    }
    const client = await CodexAppServerClient.start({
      transport: "websocket",
      url: `ws://127.0.0.1:${address.port}`,
    });
    clients.push(client);
    try {
      await client.initialize();
      const result = client
        .request("turn/start", { threadId: "receiver" }, { signal: controller.signal })
        .catch((error: unknown) => error);
      await turnReceived;
      const onTimeout = vi.fn(() => controller.abort(reason));
      const deadline = createCodexAttemptDeadlineController({
        startedAtMs: Date.now() - 15_000,
        timeoutMs: 1_000,
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
        expect(requests).toEqual(["initialize", "initialized", "turn/start", "model/list"]);
      } finally {
        deadline.dispose();
      }
    } finally {
      client.close();
      for (const socket of server.clients) {
        socket.terminate();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("keeps explicit cancellation distinct from the local request timer", async () => {
    vi.useFakeTimers();
    const harness = createClientHarness();
    clients.push(harness.client);
    const controller = new AbortController();
    const cancelled = harness.client
      .request("turn/start", {}, { signal: controller.signal })
      .catch((error: unknown) => error);
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
