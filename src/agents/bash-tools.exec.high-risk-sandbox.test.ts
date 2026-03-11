import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: vi.fn(),
}));

let callGatewayTool: typeof import("./tools/gateway.js").callGatewayTool;
let createExecTool: typeof import("./bash-tools.exec.js").createExecTool;

describe("exec sandbox high-risk confirmation", () => {
  beforeAll(async () => {
    ({ callGatewayTool } = await import("./tools/gateway.js"));
    ({ createExecTool } = await import("./bash-tools.exec.js"));
  });

  beforeEach(() => {
    vi.mocked(callGatewayTool).mockReset();
  });

  it("returns approval-pending and writes rejected audit logs on denial", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-risk-sandbox-"));
    const auditPath = path.join(dir, "safety.log");
    const gatewayCalls: string[] = [];
    vi.mocked(callGatewayTool).mockImplementation(async (method, _opts, params) => {
      gatewayCalls.push(method);
      if (method === "exec.approval.request") {
        return { status: "accepted", id: (params as { id?: string })?.id };
      }
      if (method === "exec.approval.waitDecision") {
        return { decision: "deny" };
      }
      return { ok: true };
    });

    const tool = createExecTool({
      security: "full",
      ask: "off",
      approvalRunningNoticeMs: 0,
      highRiskConfirmation: {
        enabled: true,
        audit: {
          enabled: true,
          file: auditPath,
          mode: "minimal",
        },
      },
    });

    const result = await tool.execute("call-risk-sandbox", { command: "rm -rf ./tmp" });
    expect(result.details.status).toBe("approval-pending");
    expect(gatewayCalls).toContain("exec.approval.request");
    expect(gatewayCalls).toContain("exec.approval.waitDecision");

    await expect
      .poll(async () => {
        try {
          const raw = await fs.readFile(auditPath, "utf-8");
          return raw.includes('"decision":"rejected"');
        } catch {
          return false;
        }
      })
      .toBe(true);
  });
});
