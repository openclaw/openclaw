import { describe, expect, it, vi } from "vitest";

const gatewayMocks = vi.hoisted(() => ({
  callGatewayTool: vi.fn(),
}));

vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: gatewayMocks.callGatewayTool,
}));

const { waitForResume, wrapToolWithPauseForApproval, __testing } =
  await import("./pi-tools.pause-for-approval.js");

describe("pause-for-approval wrapper", () => {
  it("passes through non-paused results", async () => {
    gatewayMocks.callGatewayTool.mockReset();
    const result = {
      content: [{ type: "text", text: "ok" }],
      details: { status: "completed" },
    };
    const base = {
      name: "demo",
      execute: vi.fn(async () => result),
    } as const;
    const wrapped = wrapToolWithPauseForApproval(base as never, {
      runId: "run-1",
      sessionKey: "agent:main:main",
    });
    await expect(wrapped.execute?.("call-1", {}, undefined, undefined)).resolves.toEqual(result);
    expect(gatewayMocks.callGatewayTool).not.toHaveBeenCalled();
  });

  it("waits for resume and returns resumed tool result", async () => {
    gatewayMocks.callGatewayTool.mockReset().mockResolvedValue({
      status: "resumed",
      approvalRequestId: "approval-1",
      result: {
        content: [{ type: "text", text: "approved" }],
        details: { status: "completed" },
      },
    });

    const wrapped = wrapToolWithPauseForApproval(
      {
        name: "demo",
        execute: vi.fn(async () => ({
          content: [{ type: "text", text: "paused" }],
          details: {
            status: "paused_for_approval",
            approval_request_id: "approval-1",
            interrupt: { type: "approval", reason: "confirm" },
            timeout_ms: 12_345,
          },
        })),
      } as never,
      {
        runId: "run-1",
        sessionKey: "agent:main:main",
      },
    );

    await expect(wrapped.execute?.("tool-call-1", { a: 1 }, undefined, undefined)).resolves.toEqual(
      {
        content: [{ type: "text", text: "approved" }],
        details: { status: "completed" },
      },
    );
    expect(gatewayMocks.callGatewayTool).toHaveBeenCalledWith(
      "tool.interrupt.emit",
      expect.objectContaining({ timeoutMs: 27_345 }),
      expect.objectContaining({
        approvalRequestId: "approval-1",
        runId: "run-1",
        sessionKey: "agent:main:main",
        toolCallId: "tool-call-1",
        toolName: "demo",
        normalizedArgsHash: __testing.hashToolArgs({ a: 1 }),
        interrupt: { type: "approval", reason: "confirm" },
        timeoutMs: 12_345,
      }),
      { expectFinal: true },
    );
  });

  it("fails paused flow without run context binding", async () => {
    gatewayMocks.callGatewayTool.mockReset();
    const wrapped = wrapToolWithPauseForApproval(
      {
        name: "demo",
        execute: vi.fn(async () => ({
          details: {
            status: "paused_for_approval",
            approval_request_id: "approval-2",
            interrupt: { type: "approval" },
          },
        })),
      } as never,
      { sessionKey: "agent:main:main" },
    );
    await expect(wrapped.execute?.("call-1", {}, undefined, undefined)).rejects.toThrow(
      "paused_for_approval requires runId, sessionKey, and toolCallId",
    );
    expect(gatewayMocks.callGatewayTool).not.toHaveBeenCalled();
  });

  it("wraps non-tool-result resume payloads", async () => {
    gatewayMocks.callGatewayTool.mockReset().mockResolvedValue({
      status: "resumed",
      result: { ok: true },
    });
    await expect(
      waitForResume({
        runId: "run-1",
        sessionKey: "agent:main:main",
        toolCallId: "tool-1",
        toolName: "demo",
        normalizedArgsHash: "a".repeat(64),
        approvalRequestId: "approval-1",
        interrupt: { type: "approval" },
      }),
    ).resolves.toMatchObject({
      content: [{ type: "text" }],
      details: { ok: true },
    });
  });
});
