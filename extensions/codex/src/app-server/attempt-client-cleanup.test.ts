// Codex tests cover attempt client cleanup plugin behavior.
import { setImmediate } from "node:timers/promises";
import { AgentHarnessPreflightError } from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  closeCodexStartupClientBestEffort,
  interruptCodexTurnAndWaitBestEffort,
  unsubscribeCodexThreadBestEffort,
  terminateCodexBackgroundTerminals,
  shouldRetireCodexStartupClient,
} from "./attempt-client-cleanup.js";
import { CodexAppServerStartupError, isCodexAppServerStartupError } from "./attempt-timeouts.js";
import { isCodexAppServerIndeterminateTransportError } from "./client.js";
import {
  CodexAppServerScopedRequestRejectedError,
  codexPrewriteRejectionCause,
} from "./rpc-error.js";
import { createClientHarness } from "./test-support.js";
import { getCodexAppServerTurnRouter } from "./turn-router.js";

describe("Codex app-server attempt client cleanup", () => {
  it.each([
    {
      name: "startup timeout",
      cause: new CodexAppServerStartupError("timed_out"),
      matches: isCodexAppServerStartupError,
      retireBefore: true,
    },
    {
      name: "model-independent preflight",
      cause: new AgentHarnessPreflightError("preflight refused"),
      matches: (error: unknown) =>
        codexPrewriteRejectionCause(error) instanceof AgentHarnessPreflightError,
      retireBefore: false,
    },
  ])(
    "preserves $name only for definite pre-write rejection",
    async ({ cause, matches, retireBefore }) => {
      const harness = createClientHarness();
      const signal = new AbortController().signal;
      try {
        const before = await harness.client
          .request(
            "thread/start",
            {},
            {
              assertCurrent: () => {
                throw cause;
              },
            },
          )
          .catch((error: unknown) => error);
        expect(before).toBeInstanceOf(CodexAppServerScopedRequestRejectedError);
        expect(before).toMatchObject({ cause });
        expect(matches(before)).toBe(true);
        expect(shouldRetireCodexStartupClient(before, undefined, signal)).toBe(retireBefore);
        expect(harness.writes).toHaveLength(0);

        const after = await harness.client
          .request(
            "thread/start",
            {},
            {
              withCurrent: async (write) => {
                write();
                throw cause;
              },
            },
          )
          .catch((error: unknown) => error);
        expect(isCodexAppServerIndeterminateTransportError(after)).toBe(true);
        expect(matches(after)).toBe(false);
        expect(shouldRetireCodexStartupClient(after, undefined, signal)).toBe(true);
        expect(harness.writes).toHaveLength(1);
      } finally {
        harness.client.close();
      }
    },
  );

  it.each([
    { terminated: true, oneShot: false },
    { terminated: true, oneShot: true },
  ])(
    "drains native terminals without claiming OS cleanup (terminated=$terminated, oneShot=$oneShot)",
    async ({ terminated, oneShot }) => {
      const request = vi
        .fn()
        .mockResolvedValueOnce({
          data: [{ processId: "10" }, { processId: "20" }],
          nextCursor: null,
        })
        .mockResolvedValueOnce({ terminated })
        .mockResolvedValueOnce({ terminated: true })
        .mockResolvedValueOnce({ data: [], nextCursor: null });
      const cleanup = terminateCodexBackgroundTerminals({ request } as never, "thread-1", oneShot);
      if (oneShot) {
        await expect(cleanup).rejects.toThrow("Codex background-terminal cleanup");
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

  it("reports a terminal that remains running after termination", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ data: [{ processId: "10" }], nextCursor: null })
      .mockResolvedValueOnce({ terminated: false })
      .mockResolvedValueOnce({ data: [{ processId: "10" }], nextCursor: null });
    await expect(
      terminateCodexBackgroundTerminals({ request } as never, "thread-1"),
    ).rejects.toThrow("Codex background-terminal cleanup failed");
  });

  it("keeps strict startup retirement failures visible to lifecycle owners", async () => {
    const closeAndWait = vi.fn(async () => {
      throw new Error("strict client retirement failed");
    });

    await expect(closeCodexStartupClientBestEffort({ closeAndWait } as never)).rejects.toThrow(
      "strict client retirement failed",
    );
  });

  it("retains the startup interrupt acknowledgement contract", async () => {
    const request = vi.fn(async () => ({}));

    await expect(
      interruptCodexTurnAndWaitBestEffort({ request } as never, {
        threadId: "thread-1",
        turnId: "",
        timeoutMs: 123,
      }),
    ).resolves.toBe(true);

    expect(request).toHaveBeenCalledWith(
      "turn/interrupt",
      { threadId: "thread-1", turnId: "" },
      { timeoutMs: 123 },
    );
  });

  it.each([
    { name: "after native activation", startBeforeError: true, releaseRoute: false },
    { name: "after subscription release", startBeforeError: false, releaseRoute: true },
  ])(
    "cancels an acknowledged turn when activation races an early interrupt ($name)",
    async ({ startBeforeError, releaseRoute }) => {
      const harness = createClientHarness();
      try {
        const route = getCodexAppServerTurnRouter(harness.client).reserveThread({
          threadId: "thread-1",
          onNotification: vi.fn(),
        });
        const completion = interruptCodexTurnAndWaitBestEffort(harness.client, {
          threadId: "thread-1",
          turnId: "turn-1",
          timeoutMs: 1_000,
        });
        const settled = vi.fn();
        void completion.then(settled);
        const first = JSON.parse(harness.writes.at(-1) ?? "{}") as { id: number };
        const start = {
          method: "turn/started",
          params: { threadId: "thread-1", turn: { id: "turn-1", status: "inProgress" } },
        };
        if (startBeforeError) {
          harness.send(start);
        }
        harness.send({
          id: first.id,
          error: { code: -32_600, message: "no active turn to interrupt" },
        });
        await setImmediate();
        expect(settled).not.toHaveBeenCalled();
        if (releaseRoute) {
          route.release();
        }

        harness.send({
          method: "turn/started",
          params: { threadId: "peer-thread", turn: { id: "peer-turn", status: "inProgress" } },
        });
        await setImmediate();
        expect(harness.writes).toHaveLength(startBeforeError ? 2 : 1);
        if (!startBeforeError) {
          harness.send(start);
        }
        await vi.waitFor(() => expect(harness.writes).toHaveLength(2));
        const second = JSON.parse(harness.writes.at(-1) ?? "{}") as { id: number };
        expect(second).toMatchObject({
          method: "turn/interrupt",
          params: { threadId: "thread-1", turnId: "turn-1" },
        });
        harness.send({ id: second.id, result: {} });
        await setImmediate();
        expect(settled).not.toHaveBeenCalled();
        harness.send({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-other", status: "interrupted", items: [] },
          },
        });
        await setImmediate();
        expect(settled).not.toHaveBeenCalled();
        harness.send({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "interrupted", items: [] },
          },
        });
        await expect(completion).resolves.toBe(true);
        expect(harness.client.getCloseError()).toBeUndefined();
      } finally {
        harness.client.close();
      }
    },
  );

  it("preserves a terminal receipt that precedes an interrupt rejection: expected active turn id turn-1 but found turn-2", async () => {
    const harness = createClientHarness();
    try {
      const completion = interruptCodexTurnAndWaitBestEffort(harness.client, {
        threadId: "thread-1",
        turnId: "turn-1",
        timeoutMs: 100,
      });
      const first = JSON.parse(harness.writes.at(-1) ?? "{}") as { id: number };
      harness.send({
        method: "turn/started",
        params: { threadId: "thread-1", turn: { id: "turn-1", status: "inProgress" } },
      });
      harness.send({
        method: "turn/completed",
        params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } },
      });
      harness.send({
        method: "turn/started",
        params: { threadId: "thread-1", turn: { id: "turn-2", status: "inProgress" } },
      });
      harness.send({
        id: first.id,
        error: { code: -32_600, message: "expected active turn id turn-1 but found turn-2" },
      });
      await expect(completion).resolves.toBe(true);
      expect(harness.writes).toHaveLength(1);
      expect(harness.client.getCloseError()).toBeUndefined();
    } finally {
      harness.client.close();
    }
  });

  it("does not interrupt after its deadline when timeout callbacks are delayed", async () => {
    vi.useFakeTimers();
    vi.spyOn(performance, "now").mockImplementation(() => Date.now());
    const harness = createClientHarness();
    try {
      const completion = interruptCodexTurnAndWaitBestEffort(harness.client, {
        threadId: "thread-1",
        turnId: "turn-1",
        timeoutMs: 100,
      });
      const first = JSON.parse(harness.writes.at(-1) ?? "{}") as { id: number };
      harness.send({
        method: "turn/started",
        params: { threadId: "thread-1", turn: { id: "turn-1", status: "inProgress" } },
      });
      vi.setSystemTime(Date.now() + 100);
      harness.send({
        id: first.id,
        error: { code: -32_600, message: "no active turn to interrupt" },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.writes).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(100);
      await expect(completion).resolves.toBe(false);
      expect(harness.writes).toHaveLength(1);
    } finally {
      harness.client.close();
      vi.useRealTimers();
    }
  });

  it("keeps the interrupt deadline bounded when the wall clock rewinds", async () => {
    vi.useFakeTimers();
    // Decouple the clocks: performance.now() (driven by advanceTimersByTime)
    // stays monotonic while Date.now() (driven by setSystemTime) can jump.
    const harness = createClientHarness();
    const requestSpy = vi.spyOn(harness.client, "request");
    try {
      const completion = interruptCodexTurnAndWaitBestEffort(harness.client, {
        threadId: "thread-1",
        turnId: "turn-1",
        timeoutMs: 100,
      });
      const first = JSON.parse(harness.writes.at(-1) ?? "{}") as { id: number };
      harness.send({
        id: first.id,
        error: { code: -32_600, message: "no active turn to interrupt" },
      });
      // Advance 60ms monotonic; both clocks move together so far.
      await vi.advanceTimersByTimeAsync(60);
      // A clock correction rewinds the wall clock by 300s. A wall-clock-based
      // remaining budget would compute ~360s; the monotonic deadline must still
      // report only the ~40ms that actually remain.
      vi.setSystemTime(Date.now() - 300_000);
      harness.send({
        method: "turn/started",
        params: { threadId: "thread-1", turn: { id: "turn-1", status: "inProgress" } },
      });
      await vi.advanceTimersByTimeAsync(0);
      // The re-interrupt RPC was sent; its timeoutMs must reflect the monotonic
      // remaining budget (~40ms), not the wall-clock-rewound ~360s. The
      // re-interrupt call carries a `signal` (the settledSignal), unlike the
      // first interrupt call which only passes timeoutMs.
      expect(harness.writes).toHaveLength(2);
      const reinterruptCall = requestSpy.mock.calls
        .toReversed()
        .find((c) => c[0] === "turn/interrupt");
      const rpcTimeoutMs = (reinterruptCall?.[2] as { timeoutMs?: number } | undefined)?.timeoutMs;
      expect(rpcTimeoutMs).toBeLessThanOrEqual(40);
      expect(rpcTimeoutMs).toBeGreaterThan(0);
      const rpcRejected = vi.fn();
      void Promise.resolve(requestSpy.mock.results.at(-1)?.value).catch(rpcRejected);
      // Cross the 100ms monotonic budget; the completion settles as failed.
      await vi.advanceTimersByTimeAsync(40);
      await expect(completion).resolves.toBe(false);
      expect(rpcRejected).toHaveBeenCalledOnce();
    } finally {
      harness.client.close();
      vi.useRealTimers();
    }
  });

  it("does not act on queued activation after its physical client closes", async () => {
    const harness = createClientHarness();
    try {
      const completion = interruptCodexTurnAndWaitBestEffort(harness.client, {
        threadId: "thread-1",
        turnId: "turn-1",
        timeoutMs: 100,
      });
      const first = JSON.parse(harness.writes.at(-1) ?? "{}") as { id: number };
      harness.send({
        method: "turn/started",
        params: { threadId: "thread-1", turn: { id: "turn-1", status: "inProgress" } },
      });
      harness.client.close();
      harness.send({
        id: first.id,
        error: { code: -32_600, message: "no active turn to interrupt" },
      });
      await expect(completion).resolves.toBe(false);
      expect(harness.writes).toHaveLength(1);
    } finally {
      harness.client.close();
    }
  });

  it("uses retained bound-turn completion after a later cleanup request", async () => {
    const harness = createClientHarness();
    try {
      const route = getCodexAppServerTurnRouter(harness.client).reserveThread({
        threadId: "thread-1",
        onNotification: vi.fn(),
      });
      route.armTurn();
      await route.bindTurn("turn-1");
      harness.send({
        method: "turn/completed",
        params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } },
      });
      const completion = interruptCodexTurnAndWaitBestEffort(harness.client, {
        threadId: "thread-1",
        turnId: "turn-1",
        timeoutMs: 100,
      });
      await expect(completion).resolves.toBe(true);
      expect(harness.writes).toHaveLength(0);
      route.release();
    } finally {
      harness.client.close();
    }
  });

  it("swallows unsubscribe cleanup failures", async () => {
    const request = vi.fn(async () => {
      throw new Error("already gone");
    });

    await expect(
      unsubscribeCodexThreadBestEffort({ request } as never, {
        threadId: "thread-1",
        timeoutMs: 123,
      }),
    ).resolves.toBe(false);

    expect(request).toHaveBeenCalledWith(
      "thread/unsubscribe",
      { threadId: "thread-1" },
      { timeoutMs: 123 },
    );
  });
});
