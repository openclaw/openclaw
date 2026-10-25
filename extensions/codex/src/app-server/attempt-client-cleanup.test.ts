import { setImmediate } from "node:timers/promises";
import { AgentHarnessPreflightError } from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, expect, it, vi } from "vitest";
import {
  closeCodexStartupClientBestEffort,
  interruptCodexTurnAndWaitBestEffort,
  unsubscribeCodexThreadBestEffort,
  terminateCodexBackgroundTerminals,
  shouldRetireCodexStartupClient,
} from "./attempt-client-cleanup.js";
import { CodexAppServerStartupError } from "./attempt-timeouts.js";
import { isCodexAppServerIndeterminateTransportError } from "./client.js";
import {
  CodexAppServerScopedRequestRejectedError,
  codexPrewriteRejectionCause,
} from "./rpc-error.js";
import { createClientHarness } from "./test-support.js";
import { getCodexAppServerTurnRouter } from "./turn-router.js";

type Harness = ReturnType<typeof createClientHarness>;
const harnesses: Harness[] = [];
function trackedHarness() {
  const harness = createClientHarness();
  harnesses.push(harness);
  return harness;
}
afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    harness.client.close();
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function interrupt(
  harness: Harness,
  timeoutMs = 100,
  extra: Partial<Parameters<typeof interruptCodexTurnAndWaitBestEffort>[1]> = {},
) {
  return interruptCodexTurnAndWaitBestEffort(harness.client, {
    threadId: "thread-1",
    turnId: "turn-1",
    timeoutMs,
    ...extra,
  });
}
function lastRequest(harness: Harness) {
  return JSON.parse(harness.writes.at(-1) ?? "{}") as { id: number };
}
function sendTurn(
  harness: Harness,
  method: "started" | "completed",
  turnId = "turn-1",
  threadId = "thread-1",
  status = method === "started" ? "inProgress" : "completed",
) {
  harness.send({
    method: `turn/${method}`,
    params: {
      threadId,
      turn: { id: turnId, status, ...(method === "completed" ? { items: [] } : {}) },
    },
  });
}
function rejectInterrupt(harness: Harness, id = lastRequest(harness).id) {
  harness.send({ id, error: { code: -32_600, message: "no active turn to interrupt" } });
}
function beginInterrupt(timeoutMs = 100, extra: Parameters<typeof interrupt>[2] = {}) {
  const harness = trackedHarness();
  return { harness, completion: interrupt(harness, timeoutMs, extra) };
}

it.each([
  [new CodexAppServerStartupError("timed_out"), true],
  [new AgentHarnessPreflightError("preflight refused"), false],
] as const)("preserves %s only for definite pre-write rejection", async (cause, retireBefore) => {
  const harness = trackedHarness();
  const signal = new AbortController().signal;
  const refuse = () => {
    throw cause;
  };
  const request = (options: Parameters<typeof harness.client.request>[2]) =>
    harness.client.request("thread/start", {}, options).catch((error: unknown) => error);
  const before = await request({ assertCurrent: refuse });
  expect(before).toBeInstanceOf(CodexAppServerScopedRequestRejectedError);
  expect(codexPrewriteRejectionCause(before)).toBe(cause);
  expect(shouldRetireCodexStartupClient(before, undefined, signal)).toBe(retireBefore);
  expect(harness.writes).toHaveLength(0);

  const after = await request({
    withCurrent: async (write) => {
      write();
      refuse();
    },
  });
  expect(isCodexAppServerIndeterminateTransportError(after)).toBe(true);
  expect(codexPrewriteRejectionCause(after)).not.toBe(cause);
  expect(shouldRetireCodexStartupClient(after, undefined, signal)).toBe(true);
  expect(harness.writes).toHaveLength(1);
});

it.each([
  { oneShot: false, remains: false },
  { oneShot: true, remains: false },
  { oneShot: false, remains: true },
])(
  "drains native terminals without claiming OS cleanup ($oneShot, $remains)",
  async ({ oneShot, remains }) => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ data: [{ processId: "10" }, { processId: "20" }] })
      .mockResolvedValueOnce({ terminated: !remains })
      .mockResolvedValueOnce({ terminated: !remains })
      .mockResolvedValueOnce({ data: remains ? [{ processId: "10" }] : [] });
    const cleanup = terminateCodexBackgroundTerminals({ request } as never, "thread-1", oneShot);
    if (oneShot || remains) {
      await expect(cleanup).rejects.toThrow("Codex background-terminal cleanup failed");
    } else {
      await expect(cleanup).resolves.toBeUndefined();
    }
    expect(request.mock.calls.map(([method, params]) => [method, params])).toEqual([
      ["thread/backgroundTerminals/list", { threadId: "thread-1" }],
      ["thread/backgroundTerminals/terminate", { threadId: "thread-1", processId: "10" }],
      ["thread/backgroundTerminals/terminate", { threadId: "thread-1", processId: "20" }],
      ["thread/backgroundTerminals/list", { threadId: "thread-1", limit: 1 }],
    ]);
  },
);

it("keeps strict startup retirement failures visible to lifecycle owners", async () => {
  const closeAndWait = vi.fn().mockRejectedValue(new Error("strict client retirement failed"));

  await expect(closeCodexStartupClientBestEffort({ closeAndWait } as never)).rejects.toThrow(
    "strict client retirement failed",
  );
});

it("does not retry interruption after its requester expires during overload backoff", async () => {
  vi.useFakeTimers();
  let current = true;
  const { harness, completion } = beginInterrupt(5_000, {
    assertCurrent: () => {
      if (!current) {
        throw new Error("Requester expired");
      }
    },
  });
  await vi.advanceTimersByTimeAsync(0);
  const first = JSON.parse(harness.writes[0] ?? "{}");
  harness.send({ id: first.id, error: { code: -32_001, message: "Server overloaded" } });
  await vi.advanceTimersByTimeAsync(0);
  current = false;
  await vi.advanceTimersByTimeAsync(1_000);
  expect(await completion).toBe(false);
  expect(harness.writes).toHaveLength(1);
  expect(harness.client.getCloseError()).toBeUndefined();
});

it.each([
  { name: "after native activation", startBeforeError: true, releaseRoute: false },
  { name: "after subscription release", startBeforeError: false, releaseRoute: true },
])(
  "cancels an acknowledged turn when activation races an early interrupt ($name)",
  async ({ startBeforeError, releaseRoute }) => {
    const harness = trackedHarness();
    const route = getCodexAppServerTurnRouter(harness.client).reserveThread({
      threadId: "thread-1",
      onNotification: vi.fn(),
    });
    const completion = interrupt(harness, 1_000);
    const settled = vi.fn();
    void completion.then(settled);
    if (startBeforeError) {
      sendTurn(harness, "started");
    }
    rejectInterrupt(harness);
    await setImmediate();
    expect(settled).not.toHaveBeenCalled();
    if (releaseRoute) {
      route.release();
    }

    sendTurn(harness, "started", "peer-turn", "peer-thread");
    await setImmediate();
    expect(harness.writes).toHaveLength(startBeforeError ? 2 : 1);
    if (!startBeforeError) {
      sendTurn(harness, "started");
    }
    await vi.waitFor(() => expect(harness.writes).toHaveLength(2));
    const second = lastRequest(harness);
    expect(second).toMatchObject({
      method: "turn/interrupt",
      params: { threadId: "thread-1", turnId: "turn-1" },
    });
    harness.send({ id: second.id, result: {} });
    await setImmediate();
    expect(settled).not.toHaveBeenCalled();
    sendTurn(harness, "completed", "turn-other", "thread-1", "interrupted");
    await setImmediate();
    expect(settled).not.toHaveBeenCalled();
    sendTurn(harness, "completed", "turn-1", "thread-1", "interrupted");
    await expect(completion).resolves.toBe(true);
    expect(harness.client.getCloseError()).toBeUndefined();
  },
);

it("preserves a terminal receipt that precedes an interrupt rejection: expected active turn id turn-1 but found turn-2", async () => {
  const { harness, completion } = beginInterrupt();
  const { id } = lastRequest(harness);
  sendTurn(harness, "started", "turn-1", "thread-1");
  sendTurn(harness, "completed", "turn-1", "thread-1", "completed");
  sendTurn(harness, "started", "turn-2", "thread-1");
  harness.send({
    id,
    error: { code: -32_600, message: "expected active turn id turn-1 but found turn-2" },
  });
  await expect(completion).resolves.toBe(true);
  expect(harness.writes).toHaveLength(1);
  expect(harness.client.getCloseError()).toBeUndefined();
});

it("does not interrupt after its deadline when timeout callbacks are delayed", async () => {
  vi.useFakeTimers();
  vi.spyOn(performance, "now").mockImplementation(() => Date.now());
  const { harness, completion } = beginInterrupt();
  sendTurn(harness, "started");
  vi.setSystemTime(Date.now() + 100);
  rejectInterrupt(harness);
  await vi.advanceTimersByTimeAsync(0);
  expect(harness.writes).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(100);
  await expect(completion).resolves.toBe(false);
  expect(harness.writes).toHaveLength(1);
});

it("keeps the interrupt deadline bounded when the wall clock rewinds", async () => {
  vi.useFakeTimers();
  const harness = trackedHarness();
  const requestSpy = vi.spyOn(harness.client, "request");
  const completion = interrupt(harness, 100);
  rejectInterrupt(harness);
  await vi.advanceTimersByTimeAsync(60);
  vi.setSystemTime(Date.now() - 300_000);
  sendTurn(harness, "started");
  await vi.advanceTimersByTimeAsync(0);
  expect(harness.writes).toHaveLength(2);
  const rpcTimeoutMs = requestSpy.mock.calls.findLast(
    ([method]) => method === "turn/interrupt",
  )?.[2]?.timeoutMs;
  expect(rpcTimeoutMs).toBeLessThanOrEqual(40);
  expect(rpcTimeoutMs).toBeGreaterThan(0);
  const rpcRejected = vi.fn();
  void Promise.resolve(requestSpy.mock.results.at(-1)?.value).catch(rpcRejected);
  await vi.advanceTimersByTimeAsync(40);
  await expect(completion).resolves.toBe(false);
  expect(rpcRejected).toHaveBeenCalledOnce();
});

it("does not act on queued activation after its physical client closes", async () => {
  const { harness, completion } = beginInterrupt();
  sendTurn(harness, "started");
  harness.client.close();
  rejectInterrupt(harness);
  await expect(completion).resolves.toBe(false);
  expect(harness.writes).toHaveLength(1);
});

it("uses retained bound-turn completion after a later cleanup request", async () => {
  const harness = trackedHarness();
  const route = getCodexAppServerTurnRouter(harness.client).reserveThread({
    threadId: "thread-1",
    onNotification: vi.fn(),
  });
  route.armTurn();
  await route.bindTurn("turn-1");
  sendTurn(harness, "completed");
  const completion = interrupt(harness, 100);
  await expect(completion).resolves.toBe(true);
  expect(harness.writes).toHaveLength(0);
  route.release();
});

it("swallows unsubscribe cleanup failures", async () => {
  await expect(
    unsubscribeCodexThreadBestEffort(
      { request: vi.fn().mockRejectedValue(new Error("already gone")) } as never,
      {
        threadId: "thread-1",
        timeoutMs: 123,
      },
    ),
  ).resolves.toBe(false);
});
