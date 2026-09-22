import { getEventListeners } from "node:events";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as terminalText from "openclaw/plugin-sdk/text-chunking";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexAppServerClient, isCodexAppServerIndeterminateTransportError } from "./client.js";
import { createClientHarness } from "./test-support.js";

type Harness = ReturnType<typeof createClientHarness>;
type RequestOptions = NonNullable<Parameters<CodexAppServerClient["request"]>[2]>;
type CatalogKey = NonNullable<RequestOptions["catalogListKey"]>;
type Page = { data: Array<{ id: string }> };

const harnesses: Harness[] = [];
const page: Page = { data: [{ id: "native-thread" }] };

function createHarness(options: Parameters<typeof createClientHarness>[0] = {}) {
  const harness = createClientHarness({ autoEmitExit: false, ...options });
  harnesses.push(harness);
  return harness;
}

function read(
  harness: Harness,
  catalogListKey: CatalogKey,
  options: RequestOptions = {},
  params: unknown = { limit: 1 },
) {
  const request = harness.client.request<Page>("thread/list", params, {
    timeoutMs: 1_000,
    ...options,
    catalogListKey,
  });
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

describe("Codex catalog request lifetime", () => {
  it("bounds catalog previews before delivery while preserving ordinary thread/list results", async () => {
    const sanitize = vi.spyOn(terminalText, "sanitizeTerminalText");
    const harness = createHarness();
    const preview = "x".repeat(1024 * 1024);
    type PreviewPage = { data: Array<{ id: string; preview: string }> };
    const catalog = harness.client.request<PreviewPage>(
      "thread/list",
      { limit: 1 },
      {
        timeoutMs: 1_000,
        catalogListKey: { scope: {}, key: "bounded-preview" },
      },
    );
    harness.send({ id: requestId(harness), result: { data: [{ id: "large-preview", preview }] } });
    expect((await catalog).data[0]?.preview).toBe("x".repeat(500));
    expect(Math.max(0, ...sanitize.mock.calls.map(([text]) => text.length))).toBeLessThanOrEqual(
      2_048,
    );

    const ordinary = harness.client.request<PreviewPage>(
      "thread/list",
      { limit: 1 },
      { timeoutMs: 1_000 },
    );
    harness.send({
      id: requestId(harness, 1),
      result: { data: [{ id: "large-preview", preview }] },
    });
    expect((await ordinary).data[0]?.preview).toBe(preview);
  });

  it.each([
    {
      name: "leading whitespace beyond the input prefix",
      preview: " \t\n".repeat(4096) + "visible",
      expected: "visible",
    },
    {
      name: "whitespace before ANSI removal",
      preview: "a \u001b[0m b",
      expected: "a  b",
    },
    {
      name: "space at the output boundary",
      preview: "x".repeat(499) + " " + "y".repeat(4096),
      expected: "x".repeat(499) + " ",
    },
    {
      name: "trailing whitespace beyond the input prefix",
      preview: "x".repeat(499) + " \n\t".repeat(4096),
      expected: "x".repeat(499),
    },
    {
      name: "surrogate pair across the output boundary",
      preview: "x".repeat(499) + "😀" + "y".repeat(4096),
      expected: "x".repeat(499),
    },
    {
      name: "surrogate pair fitting the output boundary",
      preview: "x".repeat(498) + "😀" + "y".repeat(4096),
      expected: "x".repeat(498) + "😀",
    },
    {
      name: "surrogate pair across the input prefix",
      preview: "x".repeat(2047) + "😀tail",
      expected: "x".repeat(500),
    },
    {
      name: "surrogate lookahead after whitespace normalization",
      preview: " ".repeat(1548) + "x".repeat(499) + "😀tail",
      expected: "x".repeat(499),
    },
    {
      name: "lone surrogate in a short preview",
      preview: "\ud800 visible",
      expected: "\ufffd visible",
    },
    {
      name: "lone surrogate at the output boundary",
      preview: "x".repeat(499) + "\ud800" + "y".repeat(4096),
      expected: "x".repeat(499) + "\ufffd",
    },
    {
      name: "C0 removal after whitespace normalization",
      preview: "a\u0000b \u007f c".repeat(400),
      expected: "ab  c".repeat(100),
    },
    {
      name: "OSC terminator beyond the input prefix",
      preview: "\u001b]0;" + "p".repeat(3000) + "\u0007visible",
      expected: "visible",
    },
    {
      name: "unterminated OSC payload",
      preview: "\u001b]0;" + "p".repeat(3000),
      expected: "]0;" + "p".repeat(497),
    },
    {
      name: "C1 CSI crossing the input prefix",
      preview: "\u009b" + "1;".repeat(1500) + "31mvisible",
      expected: "visible",
    },
    {
      name: "C1 OSC crossing the input prefix",
      preview: "\u009d" + "p".repeat(3000) + "\u009cvisible",
      expected: "visible",
    },
    {
      name: "escape introducer at the input boundary",
      preview: "x".repeat(2047) + "\u001b[31mTAIL",
      expected: "x".repeat(500),
    },
    {
      name: "controls only after the certified prefix",
      preview: "x".repeat(2048) + "\u001b]0;" + "p".repeat(4096),
      expected: "x".repeat(500),
    },
    {
      name: "C1 next-line is not JavaScript whitespace",
      preview: "a\u0085b" + "x".repeat(4096),
      expected: "ab" + "x".repeat(498),
    },
    {
      name: "Unicode whitespace",
      preview: "\u00a0\ufeff\u2028Unicode\u00a0\u2029text" + "x".repeat(4096),
      expected: "Unicode text" + "x".repeat(488),
    },
    {
      name: "formatting characters are preserved",
      preview: "\u200b\u202e" + "x".repeat(4096),
      expected: "\u200b\u202e" + "x".repeat(498),
    },
  ])("preserves $name in catalog previews", async ({ preview, expected }) => {
    const harness = createHarness();
    const request = harness.client.request<{ data: Array<{ id: string; preview: string }> }>(
      "thread/list",
      { limit: 1 },
      { timeoutMs: 1_000, catalogListKey: { scope: {}, key: "preview-formatting" } },
    );
    harness.send({ id: requestId(harness), result: { data: [{ id: "preview", preview }] } });
    await expect(request).resolves.toEqual({ data: [{ id: "preview", preview: expected }] });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps a retained read valid across a wall-clock jump", async () => {
    const harness = createHarness();
    const pending = read(harness, { scope: {}, key: "wall-clock-read" });
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
    const pending = read(harness, { scope: {}, key: "wall-clock-overload" });
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

  it("lets a fresh caller join a written request after its first waiter expires", async () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(10);
    const harness = createHarness();
    const key = { scope: {}, key: "home" };
    const controller = new AbortController();
    const expiredGuard = vi.fn();
    const first = read(harness, key, {
      timeoutMs: 100,
      signal: controller.signal,
      assertCurrent: expiredGuard,
    }).catch((error: unknown) => error);
    const id = requestId(harness);
    await vi.advanceTimersByTimeAsync(100);
    expect(await first).toMatchObject({ reason: "timed out", mayHaveWritten: true });
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    const oldGuardCalls = expiredGuard.mock.calls.length;

    clock.mockReturnValue(30);
    const attemptWaiterFinished = vi.fn();
    const second = read(harness, key, { timeoutMs: 500, attemptWaiterFinished });
    expect(harness.writes).toHaveLength(1);
    clock.mockReturnValue(90);
    harness.send({ id, result: page });
    await expect(second).resolves.toEqual(page);
    expect(await first).toMatchObject({ reason: "timed out" });
    expect(expiredGuard).toHaveBeenCalledTimes(oldGuardCalls);
    expect(harness.client.getCloseError()).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    expect(attemptWaiterFinished).toHaveBeenCalledExactlyOnceWith({
      clientInstanceId: harness.client.getInstanceId(),
      rpcId: id,
      waiterOrdinal: 2,
      disposition: "joined",
      overloadAttemptOrdinal: 1,
      attemptCreatedAtMs: 10,
      firstPossibleWriteAtMs: 10,
      waiterAttachedAtMs: 30,
      waiterSettledAtMs: 90,
      waiterOutcome: "resolved",
      wireOutcomeAtWaiterSettlement: "native-ok",
      wireObservedAtMs: 90,
    });
  });

  it("registers before an immediate reply and does not retain the completed result", async () => {
    const harness = createHarness({
      onWrite(line, send) {
        const request = JSON.parse(line) as { id: number };
        send({ id: request.id, result: page });
      },
    });
    const key = { scope: {}, key: "home" };
    const attemptWaiterFinished = vi.fn(() => {
      throw new Error("diagnostic sink failed");
    });
    await expect(read(harness, key, { attemptWaiterFinished })).resolves.toEqual(page);
    await expect(read(harness, key, { attemptWaiterFinished })).resolves.toEqual(page);
    expect(harness.writes).toHaveLength(2);
    expect(attemptWaiterFinished).toHaveBeenCalledTimes(2);
    expect(requestId(harness, 1)).not.toBe(requestId(harness));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("isolates denied and retired guards from another valid waiter", async () => {
    const harness = createHarness();
    const key = { scope: {}, key: "home" };
    const valid = read(harness, key);
    const denied = new Error("caller denied");
    const deniedObservation = vi.fn();
    await expect(
      read(harness, key, {
        attemptWaiterFinished: deniedObservation,
        assertCurrent: () => {
          throw denied;
        },
      }),
    ).rejects.toBe(denied);
    expect(deniedObservation).not.toHaveBeenCalled();
    let current = true;
    const retired = new Error("caller retired");
    const guardedObservation = vi.fn();
    const guarded = read(harness, key, {
      attemptWaiterFinished: guardedObservation,
      assertCurrent: () => {
        if (!current) {
          throw retired;
        }
      },
    }).catch((error: unknown) => error);
    current = false;
    harness.send({ id: requestId(harness), result: page });
    await expect(valid).resolves.toEqual(page);
    expect(await guarded).toBe(retired);
    expect(guardedObservation).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        waiterOutcome: "authority-rejected",
        wireOutcomeAtWaiterSettlement: "native-ok",
      }),
    );
    expect(harness.writes).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["timeout", "abort"] as const)(
    "detaches repeated %s waiters without growing listeners or timers",
    async (mode) => {
      const harness = createHarness();
      const key = { scope: {}, key: "home" };
      const sharedController = new AbortController();
      const attemptWaiterFinished = vi.fn();
      for (let index = 0; index < 4; index += 1) {
        const controller = mode === "timeout" ? sharedController : new AbortController();
        const waiterSignal = controller.signal;
        const waiting = read(harness, key, {
          timeoutMs: 100,
          signal: waiterSignal,
          attemptWaiterFinished,
        }).catch((error: unknown) => error);
        expect(getEventListeners(waiterSignal, "abort")).toHaveLength(1);
        if (mode === "abort") {
          controller.abort(new Error("poll cancelled"));
        } else {
          await vi.advanceTimersByTimeAsync(100);
        }
        expect(await waiting).toMatchObject({
          reason: mode === "abort" ? "aborted" : "timed out",
          mayHaveWritten: true,
        });
        expect(getEventListeners(waiterSignal, "abort")).toHaveLength(0);
        expect(vi.getTimerCount()).toBe(0);
      }
      expect(harness.writes).toHaveLength(1);
      harness.send({ id: requestId(harness), result: page });
      expect(attemptWaiterFinished).toHaveBeenCalledTimes(4);
      expect(attemptWaiterFinished.mock.calls.map(([summary]) => summary.waiterOutcome)).toEqual(
        Array(4).fill(mode === "abort" ? "aborted" : "timed-out"),
      );
      expect(
        attemptWaiterFinished.mock.calls.every(
          ([summary]) =>
            summary.wireOutcomeAtWaiterSettlement === "retained-pending" &&
            summary.wireObservedAtMs === null,
        ),
      ).toBe(true);
    },
  );

  it.each(["response", "overload"] as const)(
    "discards a late %s after all waiters detach without retrying",
    async (outcome) => {
      const harness = createHarness();
      const key = { scope: {}, key: "home" };
      const attemptWaiterFinished = vi.fn();
      const first = read(harness, key, { timeoutMs: 100, attemptWaiterFinished }).catch(
        (error: unknown) => error,
      );
      const oldId = requestId(harness);
      await vi.advanceTimersByTimeAsync(100);
      expect(await first).toMatchObject({ reason: "timed out" });
      harness.send(
        outcome === "response"
          ? { id: oldId, result: page }
          : { id: oldId, error: { code: -32001, message: "Server overloaded" } },
      );
      await vi.advanceTimersByTimeAsync(1_000);
      expect(harness.writes).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);

      const next = read(harness, key);
      const newId = requestId(harness, 1);
      expect(newId).not.toBe(oldId);
      harness.send({ id: oldId, result: { data: [{ id: "late-old" }] } });
      const joined = read(harness, key);
      expect(harness.writes).toHaveLength(2);
      harness.send({ id: newId, result: page });
      await expect(Promise.all([next, joined])).resolves.toEqual([page, page]);
      expect(attemptWaiterFinished).toHaveBeenCalledOnce();
    },
  );

  it.each(["response", "rpc-error"] as const)(
    "honors the deadline before a late %s even when its timer has not run",
    async (outcome) => {
      const harness = createHarness();
      const key = { scope: {}, key: "home" };
      const attemptWaiterFinished = vi.fn();
      const late = read(harness, key, { timeoutMs: 100, attemptWaiterFinished }).catch(
        (error: unknown) => error,
      );
      const valid = read(harness, key, { timeoutMs: 500 }).catch((error: unknown) => error);
      vi.spyOn(performance, "now").mockReturnValue(100);
      harness.send(
        outcome === "response"
          ? { id: requestId(harness), result: page }
          : { id: requestId(harness), error: { code: -32602, message: "Invalid query" } },
      );
      expect(await late).toMatchObject({ reason: "timed out", mayHaveWritten: true });
      expect(attemptWaiterFinished).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          waiterOutcome: "timed-out",
          wireOutcomeAtWaiterSettlement: outcome === "response" ? "native-ok" : "native-error",
        }),
      );
      expect(await valid).toEqual(
        outcome === "response"
          ? page
          : expect.objectContaining({
              name: "CodexAppServerRpcError",
              code: -32602,
              method: "thread/list",
            }),
      );
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(["response first", "close first"] as const)(
    "settles once when %s and allows an independent successor connection",
    async (order) => {
      const harness = createHarness();
      const key = { scope: {}, key: "home" };
      const controller = new AbortController();
      const attemptWaiterFinished = vi.fn();
      const first = read(harness, key, { signal: controller.signal, attemptWaiterFinished }).catch(
        (error: unknown) => error,
      );
      const id = requestId(harness);
      if (order === "response first") {
        harness.send({ id, result: page });
        harness.client.close();
        expect(await first).toEqual(page);
      } else {
        harness.client.close();
        harness.send({ id, result: page });
        expect(isCodexAppServerIndeterminateTransportError(await first)).toBe(true);
      }
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
      const successor = createHarness();
      const next = read(successor, key);
      harness.send({ id, result: { data: [{ id: "old-connection" }] } });
      successor.send({ id: requestId(successor), result: page });
      await expect(next).resolves.toEqual(page);
      expect(attemptWaiterFinished).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          clientInstanceId: harness.client.getInstanceId(),
          waiterOutcome: order === "response first" ? "resolved" : "client-closed",
          wireOutcomeAtWaiterSettlement:
            order === "response first" ? "native-ok" : "correlation-closed",
        }),
      );
      harness.emitExit();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(["deadline", "abort"] as const)(
    "rechecks %s after a delivery guard while preserving a valid sibling",
    async (change) => {
      const harness = createHarness();
      const key = { scope: {}, key: "home" };
      const controller = new AbortController();
      let delivering = false;
      const attemptWaiterFinished = vi.fn();
      const guarded = read(harness, key, {
        timeoutMs: 100,
        signal: controller.signal,
        attemptWaiterFinished,
        assertCurrent: () => {
          if (delivering) {
            if (change === "deadline") {
              vi.spyOn(performance, "now").mockReturnValue(100);
            } else {
              controller.abort(new Error("retired during guard"));
            }
          }
        },
      }).catch((error: unknown) => error);
      const sibling = read(harness, key, { timeoutMs: 500 });
      delivering = true;
      harness.send({ id: requestId(harness), result: page });
      expect(await guarded).toMatchObject({
        reason: change === "deadline" ? "timed out" : "aborted",
        mayHaveWritten: true,
      });
      await expect(sibling).resolves.toEqual(page);
      expect(attemptWaiterFinished).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          waiterOutcome: change === "deadline" ? "timed-out" : "aborted",
          wireOutcomeAtWaiterSettlement: "native-ok",
        }),
      );
      expect(harness.writes).toHaveLength(1);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(["scope", "key", "params", "client"] as const)(
    "does not share a request across different %s",
    async (partition) => {
      const harness = createHarness();
      const key = { scope: {}, key: "home" };
      const other = partition === "client" ? createHarness() : harness;
      const otherKey =
        partition === "scope"
          ? { ...key, scope: {} }
          : partition === "key"
            ? { ...key, key: "other-home" }
            : key;
      const first = read(harness, key);
      const second = read(
        other,
        otherKey,
        {},
        partition === "params" ? { limit: 2 } : { limit: 1 },
      );
      expect(harness.writes.length + (other === harness ? 0 : other.writes.length)).toBe(2);
      harness.send({ id: requestId(harness), result: page });
      const secondPage = { data: [{ id: "other-thread" }] };
      other.send({ id: requestId(other, other === harness ? 1 : 0), result: secondPage });
      await expect(Promise.all([first, second])).resolves.toEqual([page, secondPage]);
    },
  );

  it("retains a possibly written request after a callback error without closing its client", async () => {
    const harness = createHarness();
    const key = { scope: {}, key: "home" };
    const writeError = new Error("indeterminate write callback");
    let failWrite: ((error?: Error | null) => void) | undefined;
    const write = vi
      .spyOn(harness.process.stdin, "write")
      .mockImplementationOnce((chunk, encoding, callback) => {
        harness.writes.push(String(chunk));
        failWrite = typeof encoding === "function" ? encoding : callback;
        return false;
      });
    const attemptWaiterFinished = vi.fn();
    const first = read(harness, key, { attemptWaiterFinished }).catch((error: unknown) => error);
    const sibling = read(harness, key).catch((error: unknown) => error);
    expect(failWrite).toBeTypeOf("function");
    failWrite!(writeError);
    write.mockRestore();
    expect(isCodexAppServerIndeterminateTransportError(await first)).toBe(true);
    expect(isCodexAppServerIndeterminateTransportError(await sibling)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(harness.client.getCloseError()).toBeUndefined();
    const second = read(harness, key);
    expect(harness.writes).toHaveLength(1);
    harness.send({ id: requestId(harness), result: page });
    await expect(second).resolves.toEqual(page);
    expect(attemptWaiterFinished).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        waiterOutcome: "local-failed",
        wireOutcomeAtWaiterSettlement: "retained-pending",
        wireObservedAtMs: null,
      }),
    );

    const companion = harness.client.request("model/list", {}, { timeoutMs: 100 });
    const request = JSON.parse(harness.writes[1] ?? "{}") as { id: number; method: string };
    expect(request.method).toBe("model/list");
    harness.send({ id: request.id, result: { data: [] } });
    await expect(companion).resolves.toEqual({ data: [] });
  });

  it("lets only active callers retry overload and keeps an old id from clearing the retry", async () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(10);
    const harness = createHarness();
    const key = { scope: {}, key: "home" };
    const attemptWaiterFinished = vi.fn();
    const expiredObservation = vi.fn();
    const active = read(harness, key, { attemptWaiterFinished });
    const expired = read(harness, key, {
      timeoutMs: 5,
      attemptWaiterFinished: expiredObservation,
    }).catch((error: unknown) => error);
    const oldId = requestId(harness);
    clock.mockReturnValue(20);
    harness.send({ id: oldId, error: { code: -32001, message: "Server overloaded" } });
    await vi.advanceTimersByTimeAsync(5);
    expect(await expired).toMatchObject({ reason: "timed out", mayHaveWritten: false });
    clock.mockReturnValue(30);
    await vi.advanceTimersByTimeAsync(40);
    const newId = requestId(harness, 1);
    expect(newId).not.toBe(oldId);
    harness.send({ id: oldId, error: { code: -32001, message: "duplicate old reply" } });
    const joined = read(harness, key);
    expect(harness.writes).toHaveLength(2);
    harness.send({ id: newId, result: page });
    await expect(Promise.all([active, joined])).resolves.toEqual([page, page]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.writes).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
    expect(
      attemptWaiterFinished.mock.calls.map(([summary]) => [
        summary.rpcId,
        summary.overloadAttemptOrdinal,
        summary.firstPossibleWriteAtMs,
        summary.wireOutcomeAtWaiterSettlement,
      ]),
    ).toEqual([
      [oldId, 1, 10, "ingress-rejected"],
      [newId, 2, 30, "native-ok"],
    ]);
    expect(expiredObservation).toHaveBeenCalledOnce();
  });

  it("keeps ordinary thread/list requests independent", async () => {
    const harness = createHarness();
    const first = harness.client.request("thread/list", { limit: 1 }, { timeoutMs: 100 });
    const second = harness.client.request("thread/list", { limit: 1 }, { timeoutMs: 100 });
    expect(harness.writes).toHaveLength(2);
    harness.send({ id: requestId(harness), result: page });
    harness.send({ id: requestId(harness, 1), result: page });
    await expect(Promise.all([first, second])).resolves.toEqual([page, page]);
  });
});
