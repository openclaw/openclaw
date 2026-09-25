import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexAppServerClient } from "./client.js";
import { createClientHarness } from "./test-support.js";

type Harness = ReturnType<typeof createClientHarness>;
type RequestOptions = NonNullable<Parameters<CodexAppServerClient["request"]>[2]>;
type Page = { data: Array<{ id: string }> };

const harnesses: Harness[] = [];
const page: Page = { data: [{ id: "native-thread" }] };

function createHarness(options: Parameters<typeof createClientHarness>[0] = {}) {
  const harness = createClientHarness({ autoEmitExit: false, ...options });
  harnesses.push(harness);
  return harness;
}

function read(harness: Harness, options: RequestOptions = {}) {
  const request = harness.client.request<Page>(
    "thread/list",
    { limit: 1 },
    {
      timeoutMs: 1_000,
      ...options,
    },
  );
  // Teardown closes all fixture clients even if an assertion fails before a reply.
  void request.catch(() => undefined);
  return request;
}

function requestId(harness: Harness, index = 0): number {
  const request = JSON.parse(harness.writes[index] ?? "{}") as { id: number; method: string };
  expect(request.method).toBe("thread/list");
  expect(request.id).toBeTypeOf("number");
  return request.id;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  vi.spyOn(Math, "random").mockReturnValue(0);
});

afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    harness.client.close();
    harness.emitExit();
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Codex request timing", () => {
  it("prepares fresh authority for every wire attempt and releases before response", async () => {
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
    harness.send({ id: requestId(harness), error: { code: -32001, message: "Server overloaded" } });
    await vi.advanceTimersByTimeAsync(50);
    expect(withCurrent).toHaveBeenCalledTimes(2);
    expect(assertCurrent).toHaveBeenCalledTimes(2);
    expect(retained).toBe(false);
    harness.send({ id: requestId(harness, 1), result: page });
    await expect(pending).resolves.toEqual(page);
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
      const pending = harness.client.request(
        method,
        method === "turn/start" ? { threadId: "held-turn", input: [] } : { limit: 1 },
        {
          timeoutMs: 1_000,
          signal: controller.signal,
          withCurrent: async (write) => {
            try {
              await resume.promise;
              write();
            } finally {
              released.resolve();
            }
          },
        },
      );
      void pending.catch(() => undefined);
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

  it("rejects failed authority preparation without writing", async () => {
    const harness = createHarness();
    await expect(
      read(harness, {
        withCurrent: async () => {
          throw new Error("session superseded");
        },
      }),
    ).rejects.toThrow("session superseded");
    expect(harness.writes).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps a pending read valid across a wall-clock jump", async () => {
    const harness = createHarness();
    const pending = read(harness);
    vi.setSystemTime(Date.now() + 300_100);
    harness.send({ id: requestId(harness), result: page });
    await expect(pending).resolves.toEqual(page);
    expect(harness.writes).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps a deferred guard budget across a wall-clock jump", async () => {
    const entered = createDeferred<void>();
    const resume = createDeferred<void>();
    const release = vi.fn();
    const harness = createHarness({
      onWrite(line, send) {
        const frame = JSON.parse(line) as { id: number };
        send({ id: frame.id, result: { thread: { id: "wall-clock-thread" } } });
      },
    });
    harness.client.setThreadSessionRequestGuard(async () => {
      entered.resolve();
      await resume.promise;
      return release;
    });
    const pending = harness.client.request("thread/start", {}, { timeoutMs: 1_000 });
    void pending.catch(() => undefined);
    await entered.promise;
    vi.setSystemTime(Date.now() + 300_100);
    resume.resolve();
    await expect(pending).resolves.toEqual({ thread: { id: "wall-clock-thread" } });
    expect(harness.writes).toHaveLength(1);
    expect(release).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries overload within its budget across a wall-clock jump", async () => {
    const harness = createHarness();
    const pending = read(harness);
    vi.setSystemTime(Date.now() + 300_100);
    harness.send({
      id: requestId(harness),
      error: { code: -32001, message: "Server overloaded" },
    });
    await vi.advanceTimersByTimeAsync(50);
    expect(harness.writes).toHaveLength(2);
    harness.send({ id: requestId(harness, 1), result: page });
    await expect(pending).resolves.toEqual(page);
    expect(vi.getTimerCount()).toBe(0);
  });

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
