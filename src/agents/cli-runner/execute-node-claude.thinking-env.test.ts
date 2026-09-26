/** Paired-node thinking env forwarding through the real CLI execution entry point. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { invokeNodeClaudeCliRun } from "../../gateway/node-agent-cli-runtime.js";
import { buildPreparedCliRunContext } from "../cli-runner.test-helpers.js";
import { executePreparedCliRun as executePreparedCliRunImpl } from "./execute.js";
import {
  setCliRunnerExecuteTestDeps,
  supervisorSpawnMock,
  wrapPreparedCliRunWithTestAdmission,
} from "./execute.test-support.js";

vi.mock("../bash-tools.exec-approval-request.js", () => ({
  registerExecApprovalRequestForHostOrThrow: vi.fn(),
  resolveRegisteredExecApprovalDecision: vi.fn(),
}));

const executePreparedCliRun = wrapPreparedCliRunWithTestAdmission(executePreparedCliRunImpl);
const CLAUDE_OK_JSONL = `${JSON.stringify({ type: "result", result: "ok" })}\n`;

type NodeInvocation = Parameters<typeof invokeNodeClaudeCliRun>[0];

function installNodeInvokeMock() {
  const invokeNode = vi.fn(async (params: NodeInvocation) => {
    params.onProgress(CLAUDE_OK_JSONL);
    return {
      ok: true,
      payloadJSON: JSON.stringify({ exitCode: 0, stderrTail: "", truncated: false }),
    };
  });
  setCliRunnerExecuteTestDeps({ invokeNodeClaudeCliRun: invokeNode });
  return invokeNode;
}

function nodeInvocation(invokeNode: ReturnType<typeof installNodeInvokeMock>): NodeInvocation {
  const call = invokeNode.mock.calls.at(0);
  if (!call) {
    throw new Error("expected exactly one paired-node invocation");
  }
  return call[0];
}

beforeEach(() => {
  supervisorSpawnMock.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("paired-node thinking env forwarding", () => {
  it("forwards MAX_THINKING_TOKENS=0 so /think off survives the node hop", async () => {
    const invokeNode = installNodeInvokeMock();
    const context = buildPreparedCliRunContext({
      thinkLevel: "off",
      preparedEnv: { MAX_THINKING_TOKENS: "0" },
      backend: { clearEnv: ["MAX_THINKING_TOKENS"] },
      sessionEntry: {
        sessionId: "openclaw-session",
        updatedAt: 1,
        execHost: "node",
        execNode: "node-a",
      },
    });

    await expect(executePreparedCliRun(context)).resolves.toMatchObject({ text: "ok" });

    expect(invokeNode).toHaveBeenCalledOnce();
    expect(supervisorSpawnMock).not.toHaveBeenCalled();
    const invocation = nodeInvocation(invokeNode);
    expect(invocation.env?.MAX_THINKING_TOKENS).toBe("0");
    expect(invocation.clearEnv).toContain("MAX_THINKING_TOKENS");
  });

  it("forwards the fixed-budget pair for a positive thinking level", async () => {
    const invokeNode = installNodeInvokeMock();
    const context = buildPreparedCliRunContext({
      thinkLevel: "high",
      preparedEnv: { CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: "1", MAX_THINKING_TOKENS: "16384" },
      backend: { clearEnv: ["CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING", "MAX_THINKING_TOKENS"] },
      sessionEntry: {
        sessionId: "openclaw-session",
        updatedAt: 1,
        execHost: "node",
        execNode: "node-a",
      },
    });

    await expect(executePreparedCliRun(context)).resolves.toMatchObject({ text: "ok" });

    const invocation = nodeInvocation(invokeNode);
    expect(invocation.env).toMatchObject({
      CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: "1",
      MAX_THINKING_TOKENS: "16384",
    });
    expect(invocation.clearEnv).toEqual(
      expect.arrayContaining(["CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING", "MAX_THINKING_TOKENS"]),
    );
  });

  it("keeps non-allowlisted backend env off the paired-node request", async () => {
    const invokeNode = installNodeInvokeMock();
    const context = buildPreparedCliRunContext({
      preparedEnv: { CLAUDE_CODE_SOME_UNRELATED_KEY: "1", MAX_THINKING_TOKENS: "0" },
      backend: { clearEnv: ["MAX_THINKING_TOKENS"] },
      sessionEntry: {
        sessionId: "openclaw-session",
        updatedAt: 1,
        execHost: "node",
        execNode: "node-a",
      },
    });

    await expect(executePreparedCliRun(context)).resolves.toMatchObject({ text: "ok" });

    const invocation = nodeInvocation(invokeNode);
    expect(invocation.env?.MAX_THINKING_TOKENS).toBe("0");
    expect(invocation.env).not.toHaveProperty("CLAUDE_CODE_SOME_UNRELATED_KEY");
  });
});
