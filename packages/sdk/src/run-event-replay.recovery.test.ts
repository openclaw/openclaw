import { sleepWithAbort } from "@openclaw/retry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { SdkRunReplay } from "./run-event-replay.js";
import type { GatewayReconnectContext } from "./transport.js";

type Mode = "unavailable" | "active" | "queued" | "invalid" | "wait-error" | "history-error";
type Call = { method: string; runId?: string; timeoutMs?: number; at: number };

describe("SDK automatic recovery bounds", () => {
  const replays: SdkRunReplay[] = [];
  const recoveries: Promise<void>[] = [];
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.spyOn(Math, "random").mockReturnValue(0);
  });
  afterEach(async () => {
    for (const replay of replays.splice(0)) {
      replay.close();
    }
    await Promise.all(recoveries.splice(0));
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function fixture(runCount: number, initialMode: Mode) {
    const replay = new SdkRunReplay();
    replays.push(replay);
    let mode = initialMode;
    const calls: Call[] = [];
    for (let index = 0; index < runCount; index++) {
      replay.noteRunAcceptance(
        { sessionKey: `agent:main:run-${index}` },
        { runId: `run-${index}`, status: "started" },
      );
    }
    const request: GatewayReconnectContext["request"] = async (method, params, signal) => {
      const runId = typeof params.runId === "string" ? params.runId : undefined;
      const timeoutMs = typeof params.timeoutMs === "number" ? params.timeoutMs : undefined;
      calls.push({ method, runId, timeoutMs, at: Date.now() });
      if (method === "agent.wait") {
        if (mode === "invalid") {
          return {};
        }
        if (mode === "wait-error") {
          throw new Error("observation unavailable");
        }
        if (mode === "queued") {
          return { runId, status: "pending" };
        }
        await sleepWithAbort(timeoutMs ?? 0, signal);
        return { runId, status: "timeout" };
      }
      if (method !== "chat.history") {
        throw new Error(`Unexpected recovery method ${method}`);
      }
      if (mode === "history-error") {
        throw new Error("history unavailable");
      }
      return {
        sessionId: "physical-session",
        messages: [],
        ...(mode === "active" ? { sessionInfo: { activeRunIds: ["run-0"] } } : {}),
      };
    };
    return {
      replay,
      calls,
      setMode: (next: Mode) => {
        mode = next;
      },
      reconnect: () => {
        const epoch = { current: true };
        const controller = new AbortController();
        const task = replay.recover({ epoch, signal: controller.signal, request });
        recoveries.push(task);
        return {
          task,
          disconnect() {
            epoch.current = false;
            controller.abort();
          },
        };
      },
    };
  }

  it("stops unavailable RPCs and returns 150 unobserved runs to bounded replay", async () => {
    const { replay, calls, reconnect } = fixture(150, "unavailable");
    const recovery = reconnect();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(calls.filter((call) => call.method === "agent.wait")).toHaveLength(600);
    expect(calls.filter((call) => call.method === "chat.history")).toHaveLength(600);
    const retained = Array.from({ length: 150 }, (_, index) =>
      replay.snapshot(`run-${index}`),
    ).filter((events) => events.length > 0);
    expect(retained).toHaveLength(100);
    expect(
      retained.every(
        (events) =>
          events.at(-1)?.data && events.at(-1)?.type === "raw" && events.at(-1)?.raw === undefined,
      ),
    ).toBe(true);
    expect(retained.at(-1)?.at(-1)?.data).toEqual({
      recovery: { status: "unavailable", reason: "recovery-exhausted" },
    });
    await recovery.task;
    const release = replay.observeRun("run-149");
    await reconnect().task;
    await vi.advanceTimersByTimeAsync(300_000);
    expect(calls).toHaveLength(1_200);
    release();
    const final = {
      event: "chat",
      payload: {
        runId: "run-0",
        state: "final",
        message: { role: "assistant", content: "late authoritative answer" },
      },
    };
    replay.publish(final);
    expect(replay.snapshot("run-0")).toMatchObject([{ raw: final }]);
  });

  it("restarts reconciliation when a replacement reader attaches before cancellation unwinds", async () => {
    const replay = new SdkRunReplay();
    replays.push(replay);
    replay.noteRunAcceptance({ sessionKey: "agent:main:run" }, { runId: "run", status: "started" });
    const requestStarted = createDeferred();
    const releaseRequest = createDeferred();
    const request = vi.fn<GatewayReconnectContext["request"]>(async (_method, _params, signal) => {
      if (request.mock.calls.length === 1) {
        requestStarted.resolve();
        await releaseRequest.promise;
        signal.throwIfAborted();
      }
      return { status: "ok", terminalReply: { disposition: "silent" } };
    });
    const releaseFirst = replay.observeRun("run");
    const recovery = replay.recover({
      epoch: { current: true },
      signal: new AbortController().signal,
      request,
    });
    recoveries.push(recovery);
    await requestStarted.promise;
    releaseFirst();
    const releaseReplacement = replay.observeRun("run");
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(replay.snapshot("run").at(-1)).toMatchObject({
        type: "run.completed",
        data: { outputText: "", recovery: { status: "recovered" } },
      });
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      releaseRequest.resolve();
      releaseReplacement();
      await recovery;
    }
  });

  it("shares the finite unavailable budget across reconnects", async () => {
    const { replay, calls, reconnect } = fixture(1, "unavailable");
    for (let index = 0; index < 4; index++) {
      const recovery = reconnect();
      await vi.advanceTimersByTimeAsync(0);
      recovery.disconnect();
      await recovery.task;
    }
    expect(replay.snapshot("run-0").at(-1)?.data).toEqual({
      recovery: { status: "unavailable", reason: "recovery-exhausted" },
    });
    expect(calls).toHaveLength(11);
    await reconnect().task;
    expect(calls).toHaveLength(11);
  });

  it.each(["invalid", "wait-error", "history-error"] as const)(
    "releases recovery protection after %s",
    async (mode) => {
      const { replay, calls, reconnect } = fixture(1, mode);
      const recovery = reconnect();
      await vi.advanceTimersByTimeAsync(120_000);
      const expectedCalls = mode === "history-error" ? 8 : 1;
      expect(calls).toHaveLength(expectedCalls);
      await recovery.task;
      const release = replay.observeRun("run-0");
      await reconnect().task;
      expect(calls).toHaveLength(expectedCalls);
      expect(replay.snapshot("run-0").every((event) => event.type === "raw" && !event.raw)).toBe(
        true,
      );
      release();
    },
  );

  it("keeps confirmed active waits alive and resets an earlier unavailable observation", async () => {
    const { replay, calls, reconnect, setMode } = fixture(1, "unavailable");
    const recovery = reconnect();
    await vi.advanceTimersByTimeAsync(0);
    setMode("active");
    await vi.advanceTimersByTimeAsync(180_000);
    expect(calls.filter((call) => call.method === "agent.wait")).toHaveLength(8);
    expect(replay.snapshot("run-0")).toEqual([]);
    replay.publish({
      event: "chat",
      payload: {
        runId: "run-0",
        state: "final",
        message: { role: "assistant", content: "finished" },
      },
    });
    await recovery.task;
    const completedCalls = calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(calls).toHaveLength(completedCalls);
  });

  it("bounds unavailable recovery across 100 clients and spreads retries", async () => {
    let draw = 0;
    vi.spyOn(Math, "random").mockImplementation(() => (++draw % 101) / 101);
    const clients = Array.from({ length: 100 }, () => fixture(1, "unavailable"));
    const tasks = clients.map((client) => client.reconnect().task);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(clients.reduce((sum, client) => sum + client.calls.length, 0)).toBe(800);
    const retries = clients.map(
      (client) => client.calls.filter((call) => call.method === "agent.wait")[2]?.at,
    );
    expect(new Set(retries).size).toBeGreaterThan(50);
    await Promise.all(tasks);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(clients.reduce((sum, client) => sum + client.calls.length, 0)).toBe(800);
  });

  it("backs off 100 queued clients instead of polling at 100 requests per second", async () => {
    let draw = 0;
    vi.spyOn(Math, "random").mockImplementation(() => (++draw % 101) / 101);
    const clients = Array.from({ length: 100 }, () => fixture(1, "queued"));
    for (const client of clients) {
      client.reconnect();
    }
    await vi.advanceTimersByTimeAsync(60_000);
    const waits = clients.reduce(
      (sum, client) => sum + client.calls.filter((call) => call.method === "agent.wait").length,
      0,
    );
    expect(waits).toBeGreaterThanOrEqual(600);
    expect(waits).toBeLessThanOrEqual(700);
    expect(clients.every((client) => client.replay.snapshot("run-0").length === 0)).toBe(true);
  });
});
