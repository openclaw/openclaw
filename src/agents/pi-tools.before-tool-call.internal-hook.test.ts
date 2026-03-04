import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearInternalHooks, registerInternalHook } from "../hooks/internal-hooks.js";
import { resetDiagnosticSessionStateForTest } from "../logging/diagnostic-session-state.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import {
  __testing as beforeToolCallTesting,
  runBeforeToolCallHook,
  wrapToolWithBeforeToolCallHook,
} from "./pi-tools.before-tool-call.js";

vi.mock("../plugins/hook-runner-global.js");

const mockGetGlobalHookRunner = vi.mocked(getGlobalHookRunner);

function installNoOpHookRunner() {
  const hookRunner = {
    hasHooks: vi.fn(() => false),
    runBeforeToolCall: vi.fn(),
  };
  // oxlint-disable-next-line typescript/no-explicit-any
  mockGetGlobalHookRunner.mockReturnValue(hookRunner as any);
  return hookRunner;
}

describe("tool:before internal hook emission (#32460)", () => {
  beforeEach(() => {
    resetDiagnosticSessionStateForTest();
    beforeToolCallTesting.adjustedParamsByToolCallId.clear();
    clearInternalHooks();
    installNoOpHookRunner();
  });

  it("fires tool:before internal hook for native tool calls", async () => {
    const received: unknown[] = [];
    registerInternalHook("tool:before", async (event) => {
      received.push(event);
    });

    await runBeforeToolCallHook({
      toolName: "exec",
      params: { command: "ls" },
      toolCallId: "call-1",
      ctx: {
        agentId: "main",
        sessionKey: "test-session",
        runId: "run-1",
      },
    });

    // Wait for the fire-and-forget promise to resolve
    await vi.waitFor(() => expect(received).toHaveLength(1));

    const event = received[0] as Record<string, unknown>;
    expect(event.type).toBe("tool");
    expect(event.action).toBe("before");
    expect(event.sessionKey).toBe("test-session");
    const context = event.context as Record<string, unknown>;
    expect(context.toolName).toBe("exec");
    expect(context.params).toEqual({ command: "ls" });
    expect(context.toolCallId).toBe("call-1");
    expect(context.runId).toBe("run-1");
    expect(context.agentId).toBe("main");
  });

  it("fires tool:before with empty session key when ctx is omitted", async () => {
    const received: unknown[] = [];
    registerInternalHook("tool:before", async (event) => {
      received.push(event);
    });

    await runBeforeToolCallHook({
      toolName: "read",
      params: { path: "/tmp/file" },
    });

    await vi.waitFor(() => expect(received).toHaveLength(1));

    const event = received[0] as Record<string, unknown>;
    expect(event.type).toBe("tool");
    expect(event.action).toBe("before");
    expect(event.sessionKey).toBe("");
  });

  it("fires tool:before through wrapToolWithBeforeToolCallHook", async () => {
    const received: unknown[] = [];
    registerInternalHook("tool:before", async (event) => {
      received.push(event);
    });

    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    // oxlint-disable-next-line typescript/no-explicit-any
    const tool = wrapToolWithBeforeToolCallHook({ name: "process", execute } as any, {
      agentId: "agent-1",
      sessionKey: "session-1",
      runId: "run-1",
    });

    await tool.execute("call-2", { command: "test" }, undefined, {} as never);

    await vi.waitFor(() => expect(received).toHaveLength(1));

    const event = received[0] as Record<string, unknown>;
    expect(event.type).toBe("tool");
    expect(event.action).toBe("before");
    expect(event.sessionKey).toBe("session-1");
    const context = event.context as Record<string, unknown>;
    expect(context.toolName).toBe("process");
  });

  it("does not block tool execution if internal hook throws", async () => {
    registerInternalHook("tool:before", async () => {
      throw new Error("hook failure");
    });

    const result = await runBeforeToolCallHook({
      toolName: "exec",
      params: { command: "ls" },
      ctx: { sessionKey: "test" },
    });

    expect(result.blocked).toBe(false);
  });

  it("fires tool event for registerHook('tool', ...) handlers (type-level match)", async () => {
    const received: unknown[] = [];
    // Register on the type level (matches all tool:* events)
    registerInternalHook("tool", async (event) => {
      received.push(event);
    });

    await runBeforeToolCallHook({
      toolName: "read",
      params: { path: "/tmp/x" },
      ctx: { sessionKey: "test" },
    });

    await vi.waitFor(() => expect(received).toHaveLength(1));

    const event = received[0] as Record<string, unknown>;
    expect(event.type).toBe("tool");
    expect(event.action).toBe("before");
  });
});
