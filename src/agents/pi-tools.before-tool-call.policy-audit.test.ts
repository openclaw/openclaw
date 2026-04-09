import { beforeEach, describe, expect, it, vi } from "vitest";

const loggerMocks = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    debug: loggerMocks.debug,
    info: loggerMocks.info,
    warn: loggerMocks.warn,
    error: loggerMocks.error,
    child: () => ({
      debug: loggerMocks.debug,
      info: loggerMocks.info,
      warn: loggerMocks.warn,
      error: loggerMocks.error,
    }),
  }),
}));

describe("before_tool_call policy audit logging", () => {
  beforeEach(() => {
    vi.resetModules();
    loggerMocks.debug.mockClear();
    loggerMocks.info.mockClear();
    loggerMocks.warn.mockClear();
    loggerMocks.error.mockClear();
  });

  it("logs matched policy details before executing the wrapped tool", async () => {
    const { wrapToolWithBeforeToolCallHook } = await import("./pi-tools.before-tool-call.js");
    const execute = vi.fn().mockResolvedValue({ ok: true });
    const tool = wrapToolWithBeforeToolCallHook({ name: "exec", execute } as any, {
      runId: "run-1",
      toolPolicyAudit: {
        decision: "allow",
        matchedBy: "tools.profile (coding)",
        rule: "write",
      },
    });

    await tool.execute?.("call-1", { command: "ls" }, undefined, undefined);

    expect(loggerMocks.debug).toHaveBeenCalledWith(
      expect.stringContaining(
        'embedded run tool policy: runId=run-1 tool=exec toolCallId=call-1 decision=allow matchedBy=tools.profile (coding) rule="write"',
      ),
    );
  });
});
