import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodexAttemptPreparationTiming } from "./attempt-preparation-timing.js";

afterEach(() => vi.restoreAllMocks());

describe("Codex attempt preparation timing", () => {
  it.each(["success", "error"] as const)(
    "records a pending native start and its actual %s without profiler or private data",
    async (outcome) => {
      let nowMs = 100;
      vi.spyOn(Date, "now").mockImplementation(() => nowMs);
      const info = vi.spyOn(embeddedAgentLog, "info").mockImplementation(() => {});
      vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => {});
      const preparation = createCodexAttemptPreparationTiming({
        runId: "run-1",
        sessionId: "session-1",
      });
      const pending = Promise.withResolvers<void>();
      const failure = new Error("private native error");
      const measured = preparation.measure("turn-start", () => pending.promise);
      preparation.ready();
      expect(info.mock.calls).toEqual([
        [
          "run phase",
          expect.objectContaining({ name: "turn-start", status: "entry", startedAt: 100 }),
        ],
      ]);
      nowMs = 700;
      if (outcome === "success") {
        pending.resolve();
        await measured;
      } else {
        pending.reject(failure);
        await expect(measured).rejects.toBe(failure);
      }
      expect(info.mock.calls[1]).toEqual([
        "run phase",
        expect.objectContaining({
          owner: "codex",
          runId: "run-1",
          sessionId: "session-1",
          name: "turn-start",
          status: outcome,
          startedAt: 100,
          endedAt: 700,
          durationMs: 600,
        }),
      ]);
      expect(info).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(info.mock.calls)).not.toContain(failure.message);
    },
  );

  it.each([
    { flags: [], stageMs: 5_000, totalMs: 11_000 },
    { flags: ["codex.profiler"], stageMs: 500, totalMs: 1_100 },
  ])(
    "reports slow stages and the native handoff with flags=$flags",
    async ({ flags, stageMs, totalMs }) => {
      let nowMs = 0;
      vi.spyOn(Date, "now").mockImplementation(() => nowMs);
      const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => {});
      const params = {
        runId: "run-1",
        sessionId: "session-1",
        sessionKey: "agent:main:test",
        prompt: "private prompt",
        config: { diagnostics: { flags } },
      };
      const preparation = createCodexAttemptPreparationTiming(params);

      await preparation.measure("connection", async () => {
        nowMs += stageMs;
      });
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0]?.[1]).toEqual({
        runId: "run-1",
        sessionId: "session-1",
        sessionKey: "agent:main:test",
        stage: "connection",
        outcome: "completed",
        totalMs: stageMs,
        stages: [{ name: "connection", durationMs: stageMs, elapsedMs: stageMs }],
      });

      for (const stage of ["tools", "prompt"]) {
        await preparation.measure(stage, async () => {
          nowMs += (totalMs - stageMs) / 2;
        });
      }
      expect(warn).toHaveBeenCalledOnce();
      preparation.ready();
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls[1]?.[1]).toMatchObject({
        stage: "native-turn-handoff",
        outcome: "ready",
        totalMs,
      });
      expect(JSON.stringify(warn.mock.calls)).not.toContain(params.prompt);
    },
  );

  it.each([
    { precedingMs: 0, failingMs: 7_000 },
    { precedingMs: 4_000, failingMs: 4_000 },
  ])(
    "retains slow failed preparation ($precedingMs/$failingMs) without replacing its error",
    async ({ precedingMs, failingMs }) => {
      let nowMs = 0;
      vi.spyOn(Date, "now").mockImplementation(() => nowMs);
      const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => {});
      const preparation = createCodexAttemptPreparationTiming({
        runId: "run-1",
        sessionId: "session-1",
      });
      const failure = new Error("private failure detail");
      for (const stage of ["connection", "runtime"]) {
        await preparation.measure(stage, () => {
          nowMs += precedingMs;
        });
      }

      await expect(
        preparation.measure("tools", async () => {
          nowMs += failingMs;
          throw failure;
        }),
      ).rejects.toBe(failure);
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0]?.[1]).toMatchObject({
        stage: "tools",
        outcome: "error",
        totalMs: precedingMs * 2 + failingMs,
      });
      expect(JSON.stringify(warn.mock.calls)).not.toContain(failure.message);
    },
  );
});
