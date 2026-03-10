/**
 * Integration tests: rtk rewrite wiring in bash-tools.exec.ts
 *
 * Verifies that tryRtkRewrite is called (or skipped) under the right conditions
 * and that the rewritten command is forwarded to runExecProcess.
 *
 * NOTE: vi.mock hoists above imports. Static top-level await import() is used
 * so that mocks are in place before module evaluation.
 */
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- Mock: rtk-rewrite (fully controlled) ---
vi.mock("./rtk-rewrite.js", () => ({
  initRtkDetection: vi.fn(),
  tryRtkRewrite: vi.fn().mockResolvedValue(null),
  resetRtkDetection: vi.fn(),
}));

// --- Mock: processGatewayAllowlist (avoid real approval socket) ---
vi.mock("./bash-tools.exec-host-gateway.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./bash-tools.exec-host-gateway.js")>();
  return {
    ...mod,
    processGatewayAllowlist: vi.fn().mockResolvedValue({
      pendingResult: undefined,
      execCommandOverride: undefined,
    }),
  };
});

// --- Mock: executeNodeHostCommand (avoid real node routing) ---
vi.mock("./bash-tools.exec-host-node.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./bash-tools.exec-host-node.js")>();
  return {
    ...mod,
    executeNodeHostCommand: vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "node result" }],
      details: { status: "completed", exitCode: 0, durationMs: 5, aggregated: "node result" },
    }),
  };
});

// --- Mock: shell-env (avoid login-shell process spawn) ---
vi.mock("../infra/shell-env.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../infra/shell-env.js")>();
  return {
    ...mod,
    getShellPathFromLoginShell: vi.fn().mockReturnValue(null),
    resolveShellEnvFallbackTimeoutMs: vi.fn().mockReturnValue(1000),
  };
});

// --- Mock: runExecProcess (avoid real process spawning) ---
vi.mock("./bash-tools.exec-runtime.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./bash-tools.exec-runtime.js")>();
  return {
    ...mod,
    runExecProcess: vi.fn().mockImplementation(() => {
      const session = {
        id: "test-session-001",
        pid: 12345,
        cwd: "/tmp",
        tail: "",
        backgrounded: false,
      };
      return Promise.resolve({
        session,
        startedAt: Date.now(),
        kill: vi.fn(),
        promise: Promise.resolve({
          status: "completed" as const,
          exitCode: 0,
          durationMs: 10,
          aggregated: "ok",
          reason: undefined,
        }),
      });
    }),
  };
});

// Static imports — mocks are already hoisted at this point
const { createExecTool } = await import("./bash-tools.exec.js");
const { tryRtkRewrite } = await import("./rtk-rewrite.js");
const { processGatewayAllowlist } = await import("./bash-tools.exec-host-gateway.js");
const { runExecProcess } = await import("./bash-tools.exec-runtime.js");
const { executeNodeHostCommand } = await import("./bash-tools.exec-host-node.js");

// Convenience aliases for typed mocks
const tryRtkRewriteMock = tryRtkRewrite as unknown as Mock;
const processGatewayAllowlistMock = processGatewayAllowlist as unknown as Mock;
const runExecProcessMock = runExecProcess as unknown as Mock;
const executeNodeHostCommandMock = executeNodeHostCommand as unknown as Mock;

/** Shared defaults for all gateway tests. `allowBackground: false` avoids yieldTimer complexity. */
const GATEWAY_DEFAULTS = {
  host: "gateway" as const,
  security: "full" as const,
  ask: "off" as const,
  allowBackground: false,
};

describe("bash-tools.exec rtk integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: processGatewayAllowlist returns no pending result and no override
    processGatewayAllowlistMock.mockResolvedValue({
      pendingResult: undefined,
      execCommandOverride: undefined,
    });

    // Default: tryRtkRewrite returns null (no rewrite)
    tryRtkRewriteMock.mockResolvedValue(null);

    // Default: runExecProcess returns a completed session
    runExecProcessMock.mockImplementation(() => {
      const session = {
        id: "test-session-001",
        pid: 12345,
        cwd: "/tmp",
        tail: "",
        backgrounded: false,
      };
      return Promise.resolve({
        session,
        startedAt: Date.now(),
        kill: vi.fn(),
        promise: Promise.resolve({
          status: "completed" as const,
          exitCode: 0,
          durationMs: 10,
          aggregated: "ok",
          reason: undefined,
        }),
      });
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // Case 1: Gateway + rtk available → execCommand is rewritten
  it("case 1: gateway + rtk available → execCommand is rewritten before runExecProcess", async () => {
    tryRtkRewriteMock.mockResolvedValue("rtk ls -la");

    const tool = createExecTool(GATEWAY_DEFAULTS);
    await tool.execute("call-1", { command: "ls -la" });

    expect(tryRtkRewriteMock).toHaveBeenCalledOnce();
    expect(tryRtkRewriteMock).toHaveBeenCalledWith("ls -la", expect.any(Object));

    expect(runExecProcessMock).toHaveBeenCalledOnce();
    expect(runExecProcessMock).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "ls -la", // original preserved for display/logging
        execCommand: "rtk ls -la", // rewritten command passed as override
      }),
    );
  });

  // Case 2: Gateway + rtk unavailable → original command unchanged
  it("case 2: gateway + rtk unavailable → original command passed to runExecProcess unchanged", async () => {
    tryRtkRewriteMock.mockResolvedValue(null);

    const tool = createExecTool(GATEWAY_DEFAULTS);
    await tool.execute("call-2", { command: "git log --oneline -10" });

    expect(tryRtkRewriteMock).toHaveBeenCalledOnce();
    expect(tryRtkRewriteMock).toHaveBeenCalledWith("git log --oneline -10", expect.any(Object));

    expect(runExecProcessMock).toHaveBeenCalledOnce();
    expect(runExecProcessMock).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "git log --oneline -10",
        execCommand: undefined, // no override when rtk returns null
      }),
    );
  });

  // Case 3: Gateway + compactOutput="off" → tryRtkRewrite never called
  it("case 3: gateway + compactOutput=off → tryRtkRewrite is never called", async () => {
    const tool = createExecTool({ ...GATEWAY_DEFAULTS, compactOutput: "off" });
    await tool.execute("call-3", { command: "ls -la" });

    expect(tryRtkRewriteMock).not.toHaveBeenCalled();

    // Command runs unchanged
    expect(runExecProcessMock).toHaveBeenCalledOnce();
    expect(runExecProcessMock).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "ls -la",
        execCommand: undefined,
      }),
    );
  });

  // Case 4: Sandbox host → rtk skipped
  it("case 4: sandbox host → rtk block is skipped entirely", async () => {
    // Default host is "sandbox" when defaults.host is not set
    const tool = createExecTool({
      security: "full" as const,
      ask: "off" as const,
      allowBackground: false,
      // no host → defaults to "sandbox"
    });

    await tool.execute("call-4", { command: "echo hello" });

    // tryRtkRewrite must not be called (host !== "gateway")
    expect(tryRtkRewriteMock).not.toHaveBeenCalled();

    // processGatewayAllowlist must not be called either
    expect(processGatewayAllowlistMock).not.toHaveBeenCalled();

    // Command still reaches runExecProcess unchanged
    expect(runExecProcessMock).toHaveBeenCalledOnce();
    expect(runExecProcessMock).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "echo hello",
        execCommand: undefined,
      }),
    );
  });

  // Case 5: Node host → rtk skipped (returns early via executeNodeHostCommand)
  it("case 5: node host → executeNodeHostCommand is used and rtk is never called", async () => {
    executeNodeHostCommandMock.mockResolvedValue({
      content: [{ type: "text", text: "node output" }],
      details: { status: "completed", exitCode: 0, durationMs: 5, aggregated: "node output" },
    });

    const tool = createExecTool({
      host: "node" as const,
      security: "full" as const,
      ask: "off" as const,
      allowBackground: false,
    });

    await tool.execute("call-5", { command: "ls -la" });

    // executeNodeHostCommand is called, rtk is never reached
    expect(executeNodeHostCommandMock).toHaveBeenCalledOnce();
    expect(tryRtkRewriteMock).not.toHaveBeenCalled();

    // runExecProcess is never called (early return via node path)
    expect(runExecProcessMock).not.toHaveBeenCalled();
  });

  // Case 6: Elevated command → rtk skipped
  it("case 6: elevated command → rtk block is skipped (elevatedRequested=true)", async () => {
    const tool = createExecTool({
      ...GATEWAY_DEFAULTS,
      elevated: { enabled: true, allowed: true, defaultLevel: "on" },
    });

    // elevated: true in params → elevatedRequested=true → rtk block skipped
    await tool.execute("call-6", { command: "apt-get install vim", elevated: true });

    expect(tryRtkRewriteMock).not.toHaveBeenCalled();

    // processGatewayAllowlist IS called (bypassApprovals=false for defaultLevel:"on")
    expect(processGatewayAllowlistMock).toHaveBeenCalledOnce();

    // runExecProcess is still called (elevated path doesn't skip it)
    expect(runExecProcessMock).toHaveBeenCalledOnce();
  });

  // Case 7: SafeBins + rtk → rtk rewrites the safeBins-resolved command
  it("case 7: safeBins resolved command → rtk rewrites the override, not the original", async () => {
    const safeBinsResolvedCmd = "/usr/local/bin/git log --oneline -10";
    const rtkRewrite = "rtk /usr/local/bin/git log --oneline -10";

    // processGatewayAllowlist returns a safeBins-resolved execCommandOverride
    processGatewayAllowlistMock.mockResolvedValue({
      pendingResult: undefined,
      execCommandOverride: safeBinsResolvedCmd,
    });

    // rtk rewrites the safeBins-resolved command
    tryRtkRewriteMock.mockResolvedValue(rtkRewrite);

    const tool = createExecTool(GATEWAY_DEFAULTS);
    await tool.execute("call-7", { command: "git log --oneline -10" });

    // tryRtkRewrite must receive the safeBins override, not the original params.command
    expect(tryRtkRewriteMock).toHaveBeenCalledOnce();
    expect(tryRtkRewriteMock).toHaveBeenCalledWith(safeBinsResolvedCmd, expect.any(Object));

    // runExecProcess receives the rtk-rewritten command as execCommand
    expect(runExecProcessMock).toHaveBeenCalledOnce();
    expect(runExecProcessMock).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "git log --oneline -10", // original preserved
        execCommand: rtkRewrite, // rtk result wins
      }),
    );
  });
});
