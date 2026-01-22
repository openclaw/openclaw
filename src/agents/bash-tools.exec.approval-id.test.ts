import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: vi.fn(),
}));

vi.mock("./tools/nodes-utils.js", () => ({
  listNodes: vi.fn(async () => [
    { nodeId: "node-1", commands: ["system.run"], platform: "darwin" },
  ]),
  resolveNodeIdFromList: vi.fn((nodes: Array<{ nodeId: string }>) => nodes[0]?.nodeId),
}));

describe("exec approvals", () => {
  let previousHome: string | undefined;

  beforeEach(async () => {
    previousHome = process.env.HOME;
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-test-"));
    process.env.HOME = tempDir;
  });

  afterEach(() => {
    vi.resetAllMocks();
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  });

  it("reuses approval id as the node runId", async () => {
    const { callGatewayTool } = await import("./tools/gateway.js");
    let invokeParams: unknown;
    let resolveInvoke: (() => void) | undefined;
    const invokeSeen = new Promise<void>((resolve) => {
      resolveInvoke = resolve;
    });

    vi.mocked(callGatewayTool).mockImplementation(async (method, _opts, params) => {
      if (method === "exec.approval.request") {
        return { decision: "allow-once" };
      }
      if (method === "node.invoke") {
        invokeParams = params;
        resolveInvoke?.();
        return { ok: true };
      }
      return { ok: true };
    });

    const { createExecTool } = await import("./bash-tools.exec.js");
    const tool = createExecTool({
      host: "node",
      ask: "always",
      approvalRunningNoticeMs: 0,
    });

    const result = await tool.execute("call1", { command: "ls -la" });
    expect(result.details.status).toBe("approval-pending");
    const approvalId = (result.details as { approvalId: string }).approvalId;

    await invokeSeen;

    const runId = (invokeParams as { params?: { runId?: string } } | undefined)?.params?.runId;
    expect(runId).toBe(approvalId);
  });
});
