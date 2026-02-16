import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AnyAgentTool } from "./tools/common.js";
import {
  onDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticToolLoopEvent,
} from "../infra/diagnostic-events.js";
import { resetDiagnosticSessionStateForTest } from "../logging/diagnostic-session-state.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { wrapToolWithBeforeToolCallHook } from "./pi-tools.before-tool-call.js";
import { CRITICAL_THRESHOLD, GLOBAL_CIRCUIT_BREAKER_THRESHOLD } from "./tool-loop-detection.js";

vi.mock("../plugins/hook-runner-global.js");

const mockGetGlobalHookRunner = vi.mocked(getGlobalHookRunner);

describe("before_tool_call loop detection behavior", () => {
  let hookRunner: {
    hasHooks: ReturnType<typeof vi.fn>;
    runBeforeToolCall: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    resetDiagnosticSessionStateForTest();
    resetDiagnosticEventsForTest();
    hookRunner = {
      hasHooks: vi.fn(),
      runBeforeToolCall: vi.fn(),
    };
    // oxlint-disable-next-line typescript/no-explicit-any
    mockGetGlobalHookRunner.mockReturnValue(hookRunner as any);
    hookRunner.hasHooks.mockReturnValue(false);
  });

  it("blocks known poll loops when no progress repeats", async () => {
    const execute = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "(no new output)\n\nProcess still running." }],
      details: { status: "running", aggregated: "steady" },
    });
    // oxlint-disable-next-line typescript/no-explicit-any
    const tool = wrapToolWithBeforeToolCallHook({ name: "process", execute } as any, {
      agentId: "main",
      sessionKey: "main",
    });
    const params = { action: "poll", sessionId: "sess-1" };

    for (let i = 0; i < CRITICAL_THRESHOLD; i += 1) {
      await expect(tool.execute(`poll-${i}`, params, undefined, undefined)).resolves.toBeDefined();
    }

    await expect(
      tool.execute(`poll-${CRITICAL_THRESHOLD}`, params, undefined, undefined),
    ).rejects.toThrow("CRITICAL");
  });

  it("does not block known poll loops when output progresses", async () => {
    const execute = vi.fn().mockImplementation(async (toolCallId: string) => {
      return {
        content: [{ type: "text", text: `output ${toolCallId}` }],
        details: { status: "running", aggregated: `output ${toolCallId}` },
      };
    });
    // oxlint-disable-next-line typescript/no-explicit-any
    const tool = wrapToolWithBeforeToolCallHook({ name: "process", execute } as any, {
      agentId: "main",
      sessionKey: "main",
    });
    const params = { action: "poll", sessionId: "sess-2" };

    for (let i = 0; i < CRITICAL_THRESHOLD + 5; i += 1) {
      await expect(
        tool.execute(`poll-progress-${i}`, params, undefined, undefined),
      ).resolves.toBeDefined();
    }
  });

  it("keeps generic repeated calls warn-only below global breaker", async () => {
    const execute = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "same output" }],
      details: { ok: true },
    });
    // oxlint-disable-next-line typescript/no-explicit-any
    const tool = wrapToolWithBeforeToolCallHook({ name: "read", execute } as any, {
      agentId: "main",
      sessionKey: "main",
    });
    const params = { path: "/tmp/file" };

    for (let i = 0; i < CRITICAL_THRESHOLD + 5; i += 1) {
      await expect(tool.execute(`read-${i}`, params, undefined, undefined)).resolves.toBeDefined();
    }
  });

  it("blocks generic repeated no-progress calls at global breaker threshold", async () => {
    const execute = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "same output" }],
      details: { ok: true },
    });
    // oxlint-disable-next-line typescript/no-explicit-any
    const tool = wrapToolWithBeforeToolCallHook({ name: "read", execute } as any, {
      agentId: "main",
      sessionKey: "main",
    });
    const params = { path: "/tmp/file" };

    for (let i = 0; i < GLOBAL_CIRCUIT_BREAKER_THRESHOLD; i += 1) {
      await expect(tool.execute(`read-${i}`, params, undefined, undefined)).resolves.toBeDefined();
    }

    await expect(
      tool.execute(`read-${GLOBAL_CIRCUIT_BREAKER_THRESHOLD}`, params, undefined, undefined),
    ).rejects.toThrow("global circuit breaker");
  });

  it("coalesces repeated generic warning events into threshold buckets", async () => {
    const emitted: DiagnosticToolLoopEvent[] = [];
    const stop = onDiagnosticEvent((evt) => {
      if (evt.type === "tool.loop" && evt.level === "warning") {
        emitted.push(evt);
      }
    });
    try {
      const execute = vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "same output" }],
        details: { ok: true },
      });
      // oxlint-disable-next-line typescript/no-explicit-any
      const tool = wrapToolWithBeforeToolCallHook({ name: "read", execute } as any, {
        agentId: "main",
        sessionKey: "main",
      });
      const params = { path: "/tmp/file" };

      for (let i = 0; i < 21; i += 1) {
        await tool.execute(`read-bucket-${i}`, params, undefined, undefined);
      }

      const genericWarns = emitted.filter((evt) => evt.detector === "generic_repeat");
      expect(genericWarns.map((evt) => evt.count)).toEqual([10, 20]);
    } finally {
      stop();
    }
  });

  it("emits structured warning diagnostic events for ping-pong loops", async () => {
    const emitted: DiagnosticToolLoopEvent[] = [];
    const stop = onDiagnosticEvent((evt) => {
      if (evt.type === "tool.loop") {
        emitted.push(evt);
      }
    });
    try {
      const readExecute = vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "read ok" }],
        details: { ok: true },
      });
      const listExecute = vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "list ok" }],
        details: { ok: true },
      });
      const readTool = wrapToolWithBeforeToolCallHook(
        { name: "read", execute: readExecute } as unknown as AnyAgentTool,
        {
          agentId: "main",
          sessionKey: "main",
        },
      );
      const listTool = wrapToolWithBeforeToolCallHook(
        { name: "list", execute: listExecute } as unknown as AnyAgentTool,
        {
          agentId: "main",
          sessionKey: "main",
        },
      );

      for (let i = 0; i < 9; i += 1) {
        if (i % 2 === 0) {
          await readTool.execute(`read-${i}`, { path: "/a.txt" }, undefined, undefined);
        } else {
          await listTool.execute(`list-${i}`, { dir: "/workspace" }, undefined, undefined);
        }
      }

      await listTool.execute("list-9", { dir: "/workspace" }, undefined, undefined);
      await readTool.execute("read-10", { path: "/a.txt" }, undefined, undefined);
      await listTool.execute("list-11", { dir: "/workspace" }, undefined, undefined);

      const pingPongWarns = emitted.filter(
        (evt) => evt.level === "warning" && evt.detector === "ping_pong",
      );
      expect(pingPongWarns).toHaveLength(1);
      const loopEvent = pingPongWarns[0];
      expect(loopEvent?.type).toBe("tool.loop");
      expect(loopEvent?.level).toBe("warning");
      expect(loopEvent?.action).toBe("warn");
      expect(loopEvent?.detector).toBe("ping_pong");
      expect(loopEvent?.count).toBe(10);
      expect(loopEvent?.toolName).toBe("list");
    } finally {
      stop();
    }
  });

  it("blocks ping-pong loops at critical threshold and emits critical diagnostic events", async () => {
    const emitted: DiagnosticToolLoopEvent[] = [];
    const stop = onDiagnosticEvent((evt) => {
      if (evt.type === "tool.loop") {
        emitted.push(evt);
      }
    });
    try {
      const readExecute = vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "read ok" }],
        details: { ok: true },
      });
      const listExecute = vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "list ok" }],
        details: { ok: true },
      });
      const readTool = wrapToolWithBeforeToolCallHook(
        { name: "read", execute: readExecute } as unknown as AnyAgentTool,
        {
          agentId: "main",
          sessionKey: "main",
        },
      );
      const listTool = wrapToolWithBeforeToolCallHook(
        { name: "list", execute: listExecute } as unknown as AnyAgentTool,
        {
          agentId: "main",
          sessionKey: "main",
        },
      );

      for (let i = 0; i < CRITICAL_THRESHOLD - 1; i += 1) {
        if (i % 2 === 0) {
          await readTool.execute(`read-${i}`, { path: "/a.txt" }, undefined, undefined);
        } else {
          await listTool.execute(`list-${i}`, { dir: "/workspace" }, undefined, undefined);
        }
      }

      await expect(
        listTool.execute(
          `list-${CRITICAL_THRESHOLD - 1}`,
          { dir: "/workspace" },
          undefined,
          undefined,
        ),
      ).rejects.toThrow("CRITICAL");

      const loopEvent = emitted.at(-1);
      expect(loopEvent?.type).toBe("tool.loop");
      expect(loopEvent?.level).toBe("critical");
      expect(loopEvent?.action).toBe("block");
      expect(loopEvent?.detector).toBe("ping_pong");
      expect(loopEvent?.count).toBe(CRITICAL_THRESHOLD);
      expect(loopEvent?.toolName).toBe("list");
    } finally {
      stop();
    }
  });

  it("does not block ping-pong at critical threshold when outcomes are progressing", async () => {
    const emitted: DiagnosticToolLoopEvent[] = [];
    const stop = onDiagnosticEvent((evt) => {
      if (evt.type === "tool.loop") {
        emitted.push(evt);
      }
    });
    try {
      const readExecute = vi.fn().mockImplementation(async (toolCallId: string) => ({
        content: [{ type: "text", text: `read ${toolCallId}` }],
        details: { ok: true },
      }));
      const listExecute = vi.fn().mockImplementation(async (toolCallId: string) => ({
        content: [{ type: "text", text: `list ${toolCallId}` }],
        details: { ok: true },
      }));
      const readTool = wrapToolWithBeforeToolCallHook(
        { name: "read", execute: readExecute } as unknown as AnyAgentTool,
        {
          agentId: "main",
          sessionKey: "main",
        },
      );
      const listTool = wrapToolWithBeforeToolCallHook(
        { name: "list", execute: listExecute } as unknown as AnyAgentTool,
        {
          agentId: "main",
          sessionKey: "main",
        },
      );

      for (let i = 0; i < CRITICAL_THRESHOLD - 1; i += 1) {
        if (i % 2 === 0) {
          await readTool.execute(`read-${i}`, { path: "/a.txt" }, undefined, undefined);
        } else {
          await listTool.execute(`list-${i}`, { dir: "/workspace" }, undefined, undefined);
        }
      }

      await expect(
        listTool.execute(
          `list-${CRITICAL_THRESHOLD - 1}`,
          { dir: "/workspace" },
          undefined,
          undefined,
        ),
      ).resolves.toBeDefined();

      const criticalPingPong = emitted.find(
        (evt) => evt.level === "critical" && evt.detector === "ping_pong",
      );
      expect(criticalPingPong).toBeUndefined();
      const warningPingPong = emitted.find(
        (evt) => evt.level === "warning" && evt.detector === "ping_pong",
      );
      expect(warningPingPong).toBeTruthy();
    } finally {
      stop();
    }
  });

  it("emits structured critical diagnostic events when blocking loops", async () => {
    const emitted: DiagnosticToolLoopEvent[] = [];
    const stop = onDiagnosticEvent((evt) => {
      if (evt.type === "tool.loop") {
        emitted.push(evt);
      }
    });
    try {
      const execute = vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "(no new output)\n\nProcess still running." }],
        details: { status: "running", aggregated: "steady" },
      });
      // oxlint-disable-next-line typescript/no-explicit-any
      const tool = wrapToolWithBeforeToolCallHook({ name: "process", execute } as any, {
        agentId: "main",
        sessionKey: "main",
      });
      const params = { action: "poll", sessionId: "sess-crit" };

      for (let i = 0; i < CRITICAL_THRESHOLD; i += 1) {
        await tool.execute(`poll-${i}`, params, undefined, undefined);
      }

      await expect(
        tool.execute(`poll-${CRITICAL_THRESHOLD}`, params, undefined, undefined),
      ).rejects.toThrow("CRITICAL");

      const loopEvent = emitted.at(-1);
      expect(loopEvent?.type).toBe("tool.loop");
      expect(loopEvent?.level).toBe("critical");
      expect(loopEvent?.action).toBe("block");
      expect(loopEvent?.detector).toBe("known_poll_no_progress");
      expect(loopEvent?.count).toBe(CRITICAL_THRESHOLD);
      expect(loopEvent?.toolName).toBe("process");
    } finally {
      stop();
    }
  });
});
