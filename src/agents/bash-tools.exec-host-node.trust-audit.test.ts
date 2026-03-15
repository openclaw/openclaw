import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrustWindow } from "../infra/exec-approvals.js";
import { buildSystemRunPreparePayload } from "../test-utils/system-run-prepare-payload.js";

const callGatewayTool = vi.fn();
const tryAppendTrustAuditEntry = vi.fn();

vi.mock("./tools/gateway.js", () => ({
  callGatewayTool,
}));

vi.mock("./tools/nodes-utils.js", () => ({
  listNodes: vi.fn(async () => [
    { nodeId: "node-1", commands: ["system.run"], platform: "darwin" },
  ]),
  resolveNodeIdFromList: vi.fn((nodes: Array<{ nodeId: string }>) => nodes[0]?.nodeId ?? "node-1"),
}));

vi.mock("../infra/exec-obfuscation-detect.js", () => ({
  detectCommandObfuscation: vi.fn(() => ({
    detected: false,
    reasons: [],
    matchedPatterns: [],
  })),
}));

vi.mock("../infra/trust-audit.js", () => ({
  tryAppendTrustAuditEntry,
}));

vi.mock("../infra/exec-approvals.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../infra/exec-approvals.js")>();
  const now = Date.now();
  const trustWindow: TrustWindow = {
    status: "active",
    expiresAt: now + 60_000,
    grantedAt: now,
    security: "full",
    ask: "off",
  };
  return {
    ...mod,
    getTrustWindow: vi.fn(() => trustWindow),
    isTrustWindowActive: vi.fn(() => true),
  };
});

const { executeNodeHostCommand } = await import("./bash-tools.exec-host-node.js");

function buildPreparedSystemRunPayload(rawInvokeParams: unknown) {
  const invoke = (rawInvokeParams ?? {}) as {
    params?: {
      command?: unknown;
      rawCommand?: unknown;
      cwd?: unknown;
      agentId?: unknown;
      sessionKey?: unknown;
    };
  };
  return buildSystemRunPreparePayload(invoke.params ?? {});
}

function baseParams() {
  return {
    command: "echo hi",
    workdir: process.cwd(),
    env: {},
    security: "full" as const,
    ask: "off" as const,
    defaultTimeoutSec: 30,
    approvalRunningNoticeMs: 0,
    warnings: [] as string[],
  };
}

describe("node-host trust audit integration", () => {
  beforeEach(() => {
    callGatewayTool.mockReset();
    tryAppendTrustAuditEntry.mockReset();
  });

  it("appends trust audit entry when node invoke errors", async () => {
    const originalError = new Error("node invoke failed");
    callGatewayTool.mockImplementation(async (method: string, _opts: unknown, params: unknown) => {
      if (method !== "node.invoke") {
        return { ok: true };
      }
      const invoke = params as { command?: string };
      if (invoke.command === "system.run.prepare") {
        return buildPreparedSystemRunPayload(params);
      }
      if (invoke.command === "system.run") {
        throw originalError;
      }
      return { payload: {} };
    });

    await expect(executeNodeHostCommand(baseParams())).rejects.toThrow("node invoke failed");
    expect(tryAppendTrustAuditEntry).toHaveBeenCalledTimes(1);
  });

  it("appends trust audit entry on successful node exec", async () => {
    callGatewayTool.mockImplementation(async (method: string, _opts: unknown, params: unknown) => {
      if (method !== "node.invoke") {
        return { ok: true };
      }
      const invoke = params as { command?: string };
      if (invoke.command === "system.run.prepare") {
        return buildPreparedSystemRunPayload(params);
      }
      if (invoke.command === "system.run") {
        return { payload: { success: true, stdout: "ok", exitCode: 0 } };
      }
      return { payload: {} };
    });

    const result = await executeNodeHostCommand(baseParams());
    const text = result.content.find((part) => part.type === "text")?.text ?? "";

    expect(result.details.status).toBe("completed");
    expect(text).toContain("ok");
    expect(tryAppendTrustAuditEntry).toHaveBeenCalledTimes(1);
  });
});
