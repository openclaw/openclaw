import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, expect, it, vi } from "vitest";
import { useClientHarnesses } from "./client-harness.test-support.js";
type Harness = ReturnType<ReturnType<typeof useClientHarnesses>>;
type RequestOptions = NonNullable<Parameters<Harness["client"]["request"]>[2]>;

const createHarness = useClientHarnesses();
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
