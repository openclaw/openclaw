import { createAgentHarnessAttemptDeadlineController } from "openclaw/plugin-sdk/agent-harness-attempt-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TURN_TERMINAL_SETTLEMENT_TIMEOUT_MS } from "./attempt-timeouts.js";
import { useClientHarnesses } from "./client-harness.test-support.js";
import { createWebSocketPeer } from "./client-websocket.test-support.js";
import {
  CodexAppServerClient,
  isCodexAppServerIndeterminateRequestCancellationError,
  isCodexAppServerIndeterminateTransportError,
  isCodexAppServerPrewriteRequestCancellationError,
  isCodexAppServerRequestTimeoutError,
} from "./client.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

const clients: CodexAppServerClient[] = [];
const makeHarness = useClientHarnesses();
const phases = ["before request", "pending request", "overload backoff"] as const;
function createHarness(options?: Parameters<typeof makeHarness>[0]) {
  vi.useFakeTimers();
  return makeHarness(options);
}

const cancellation = (client: CodexAppServerClient, signal: AbortSignal) =>
  client.request("turn/start", {}, { signal }).catch((error: unknown) => error);
afterEach(() => {
  clients.splice(0).forEach((client) => client.close());
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it.each(phases)("preserves %s cancellation certainty", async (phase) => {
  const harness = createHarness();
  const controller = new AbortController();
  const message = "receiver execution budget timed out";
  const reason = phase === "pending request" ? message : new Error(message);
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
  expect(formatErrorMessage(error)).toContain(message);
  const written = phase === "pending request";
  expect(isCodexAppServerIndeterminateRequestCancellationError(error)).toBe(written);
  expect(isCodexAppServerPrewriteRequestCancellationError(error)).toBe(!written);
  expect(isCodexAppServerRequestTimeoutError(error)).toBe(false);
  expect(isCodexAppServerIndeterminateTransportError(error)).toBe(false);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(harness.writes).toHaveLength(phase === "before request" ? 0 : 1);
  expect(harness.client.getCloseError()).toBeUndefined();
});

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
  const client = await CodexAppServerClient.start({ transport: "websocket", url: peer.url });
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

it("classifies the local request timer separately from cancellation", async () => {
  const { client } = createHarness();
  const timedOut = client
    .request("turn/start", {}, { timeoutMs: 100 })
    .catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(100);
  expect(await timedOut).toMatchObject({ message: "turn/start timed out", reason: "timed out" });
  expect(isCodexAppServerRequestTimeoutError(await timedOut)).toBe(true);
});

describe("request timing", () => {
  type Harness = ReturnType<typeof createHarness>;
  type RequestOptions = NonNullable<Parameters<Harness["client"]["request"]>[2]>;

  const page = { data: [{ id: "native-thread" }] };

  function read(harness: Harness, options: RequestOptions = {}, method = "thread/list") {
    const request = harness.client.request(
      method,
      method === "turn/start" ? { threadId: "held-turn", input: [] } : { limit: 1 },
      { timeoutMs: 1_000, ...options },
    );
    // Teardown closes all fixture clients even if an assertion fails before a reply.
    void request.catch(() => undefined);
    return request;
  }

  function requestId(harness: Harness, index = 0): number {
    const request = JSON.parse(harness.writes[index] ?? "{}") as { id: number; method: string };
    expect(request).toMatchObject({ method: "thread/list", id: expect.any(Number) });
    return request.id;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    vi.spyOn(Math, "random").mockReturnValue(0);
  });

  it("refreshes and releases wire authority across overload retry and a wall-clock jump", async () => {
    const harness = createHarness();
    let retained = false;
    const withCurrent = vi.fn(async (write: () => void) => {
      retained = true;
      try {
        write();
      } finally {
        retained = false;
      }
    });
    const assertCurrent = vi.fn(() => expect(retained).toBe(true));
    const pending = read(harness, { withCurrent, assertCurrent });
    expect(withCurrent).toHaveBeenCalledTimes(1);
    expect(retained).toBe(false);
    vi.setSystemTime(Date.now() + 300_100);
    harness.send({ id: requestId(harness), error: { code: -32001, message: "Server overloaded" } });
    await vi.advanceTimersByTimeAsync(50);
    expect(harness.writes).toHaveLength(2);
    expect(withCurrent).toHaveBeenCalledTimes(2);
    expect(assertCurrent).toHaveBeenCalledTimes(2);
    expect(retained).toBe(false);
    harness.send({ id: requestId(harness, 1), result: page });
    await expect(pending).resolves.toEqual(page);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(
    (["thread/list", "turn/start"] as const).flatMap((method) =>
      (["abort", "timeout", "close"] as const).map((reason) => ({ method, reason })),
    ),
  )(
    "settles $method $reason during authority preparation and refuses a late wire grant",
    async ({ method, reason }) => {
      const harness = createHarness();
      const resume = createDeferred<void>();
      const released = createDeferred<void>();
      const controller = new AbortController();
      const pending = read(
        harness,
        {
          signal: controller.signal,
          withCurrent: (write) => resume.promise.then(write).finally(() => released.resolve()),
        },
        method,
      );
      const rejected = expect(pending).rejects.toThrow(
        reason === "abort" ? "aborted" : reason === "timeout" ? "timed out" : "closed",
      );
      if (reason === "abort") {
        controller.abort();
      } else if (reason === "timeout") {
        await vi.advanceTimersByTimeAsync(1_000);
      } else {
        harness.client.close();
      }
      await rejected;
      if (reason !== "close") {
        await expect(pending).rejects.toMatchObject({
          reason: reason === "abort" ? "aborted" : "timed out",
          mayHaveWritten: false,
          code: "CODEX_APP_SERVER_LOCAL_REQUEST_CANCELLED",
        });
      }
      expect(harness.writes).toHaveLength(0);
      resume.resolve();
      await released.promise;
      expect(harness.writes).toHaveLength(0);
    },
  );

  it("registers before an immediate reply and does not retain the completed result", async () => {
    const harness = createHarness({
      onWrite(line, send) {
        const request = JSON.parse(line) as { id: number };
        send({ id: request.id, result: page });
      },
    });
    const attemptWaiterFinished = vi.fn(() => {
      throw new Error("diagnostic sink failed");
    });
    await expect(read(harness, { attemptWaiterFinished })).resolves.toEqual(page);
    await expect(read(harness, { attemptWaiterFinished })).resolves.toEqual(page);
    expect(harness.writes).toHaveLength(2);
    expect(attemptWaiterFinished).toHaveBeenCalledTimes(2);
    expect(requestId(harness, 1)).not.toBe(requestId(harness));
    expect(vi.getTimerCount()).toBe(0);
  });
});
