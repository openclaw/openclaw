import { describe, expect, it, vi } from "vitest";

vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: vi.fn(),
}));

describe("exec elevated defaults", () => {
  it("does not trigger approval flow when elevated mode is enabled but default level is off", async () => {
    const { callGatewayTool } = await import("./tools/gateway.js");
    const calls: string[] = [];
    vi.mocked(callGatewayTool).mockImplementation(async (method) => {
      calls.push(method);
      return { ok: true };
    });

    const { createExecTool } = await import("./bash-tools.exec.js");
    const tool = createExecTool({
      ask: "on-miss",
      security: "allowlist",
      approvalRunningNoticeMs: 0,
      elevated: { enabled: true, allowed: true, defaultLevel: "off" },
    });

    const result = await tool.execute("call-default-off", { command: "echo ok" });
    expect(result.details.status).toBe("completed");
    expect(calls).not.toContain("exec.approval.request");
    expect(calls).not.toContain("exec.approval.waitDecision");
  });
});
