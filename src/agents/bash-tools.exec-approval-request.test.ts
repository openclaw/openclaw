import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isExecApprovalRunAbortedError,
  registerExecApprovalRequestForHostOrThrow,
  resolveRegisteredExecApprovalDecision,
} from "./bash-tools.exec-approval-request.js";
import { DEFAULT_APPROVAL_TIMEOUT_MS } from "./bash-tools.exec-runtime.js";
import { callGatewayTool } from "./tools/gateway.js";

vi.mock("./bash-tools.exec-approval-request.runtime.js", () => ({
  resolveExecApprovalCommandSpans: async (command: string) =>
    command.startsWith("pwsh ") || command.startsWith("cmd.exe ")
      ? undefined
      : command.startsWith("node ")
        ? [{ startIndex: 0, endIndex: 4 }]
        : [
            { startIndex: 0, endIndex: 2 },
            { startIndex: 0, endIndex: 4 },
            { startIndex: 5, endIndex: 9 },
            { startIndex: 20, endIndex: 26 },
          ],
}));
vi.mock("./tools/gateway.js", () => ({ callGatewayTool: vi.fn() }));

function register(
  overrides: Partial<Parameters<typeof registerExecApprovalRequestForHostOrThrow>[0]> = {},
) {
  return registerExecApprovalRequestForHostOrThrow({
    approvalId: "approval-id",
    command: "echo hi",
    workdir: "/tmp/project",
    host: "node",
    security: "allowlist",
    ask: "always",
    ...overrides,
  });
}
function payload() {
  expect(vi.mocked(callGatewayTool).mock.calls[0]?.[0]).toBe("exec.approval.request");
  return vi.mocked(callGatewayTool).mock.calls[0]?.[2];
}
beforeEach(() => {
  vi.mocked(callGatewayTool).mockReset().mockResolvedValue({ id: "approval-id" });
});
afterEach(() => vi.restoreAllMocks());

describe("exec approval registration", () => {
  it("uses the run-bound transport for registration and the decision without local Gateway RPC", async () => {
    const approvalTransport = {
      request: vi.fn(async () => ({ id: "worker-approval", expiresAtMs: 123_456 })),
      waitDecision: vi.fn(async () => ({ decision: "allow-once" })),
    };
    const registration = await register({ host: "gateway", approvalTransport });
    expect(registration).toEqual({ id: "worker-approval", expiresAtMs: 123_456 });
    expect(approvalTransport.request).toHaveBeenCalledWith(
      expect.objectContaining({ command: "echo hi", cwd: "/tmp/project", twoPhase: true }),
    );
    await expect(
      resolveRegisteredExecApprovalDecision({
        approvalId: registration.id,
        preResolvedDecision: registration.finalDecision,
        approvalTransport,
      }),
    ).resolves.toBe("allow-once");
    expect(approvalTransport.waitDecision).toHaveBeenCalledWith({ id: "worker-approval" });
    expect(callGatewayTool).not.toHaveBeenCalled();
  });

  it("does not fall back to localhost when the run-bound transport fails", async () => {
    const approvalTransport = {
      request: vi.fn(async (): Promise<never> => {
        throw new Error("worker fenced");
      }),
      waitDecision: vi.fn(async (): Promise<never> => {
        throw new Error("worker fenced");
      }),
    };
    await expect(register({ host: "gateway", approvalTransport })).rejects.toThrow("worker fenced");
    await expect(
      resolveRegisteredExecApprovalDecision({
        approvalId: "worker-approval",
        preResolvedDecision: undefined,
        approvalTransport,
      }),
    ).rejects.toThrow("worker fenced");
    expect(callGatewayTool).not.toHaveBeenCalled();
  });

  it("preserves run cancellation delivered by a remote approval transport", async () => {
    const approvalTransport = {
      request: vi.fn(async () => ({ id: "worker-approval", expiresAtMs: 123_456 })),
      waitDecision: vi.fn(async () => ({ decision: null, terminalReason: "run-aborted" })),
    };
    await expect(
      resolveRegisteredExecApprovalDecision({
        approvalId: "worker-approval",
        preResolvedDecision: undefined,
        approvalTransport,
      }),
    ).rejects.toSatisfy(isExecApprovalRunAbortedError);
    expect(callGatewayTool).not.toHaveBeenCalled();
  });

  it("distinguishes run cancellation from timeout fallback", async () => {
    vi.mocked(callGatewayTool)
      .mockResolvedValueOnce({ decision: null, terminalReason: "timeout" })
      .mockResolvedValueOnce({ decision: null, terminalReason: "run-aborted" });
    const request = { approvalId: "approval-id", preResolvedDecision: undefined };
    await expect(resolveRegisteredExecApprovalDecision(request)).resolves.toBeNull();
    await expect(resolveRegisteredExecApprovalDecision(request)).rejects.toSatisfy(
      isExecApprovalRunAbortedError,
    );
  });

  it.each([
    { now: Number.NaN, expiresAtMs: undefined, expected: 0 },
    {
      now: 1_800_000_000_000,
      expiresAtMs: Number.MAX_VALUE,
      expected: 1_800_000_000_000 + DEFAULT_APPROVAL_TIMEOUT_MS,
    },
  ])(
    "bounds invalid registration expiry with clock $now",
    async ({ now, expiresAtMs, expected }) => {
      vi.spyOn(Date, "now").mockReturnValue(now);
      vi.mocked(callGatewayTool).mockResolvedValue({ id: "approval-id", expiresAtMs });
      await expect(register({ host: "gateway" })).resolves.toMatchObject({ expiresAtMs: expected });
    },
  );

  it("registers command spans with the originating run and reviewer", async () => {
    await register({
      command: 'ls | grep "stuff" | python -c \'print("hi")\'',
      commandHighlighting: true,
      sessionId: "session-1",
      runId: "run-1",
      toolCallId: "tool-1",
      approvalReviewerDeviceIds: ["device-ios-reviewer"],
    });
    expect(payload()).toMatchObject({
      sessionId: "session-1",
      runId: "run-1",
      toolCallId: "tool-1",
      approvalReviewerDeviceIds: ["device-ios-reviewer"],
      commandSpans: [
        { startIndex: 0, endIndex: 2 },
        { startIndex: 0, endIndex: 4 },
        { startIndex: 5, endIndex: 9 },
        { startIndex: 20, endIndex: 26 },
      ],
    });
  });

  it("highlights the prepared system run command when raw command is absent", async () => {
    await register({
      command: undefined,
      systemRunPlan: {
        argv: ["node", "-e", "console.log(1)"],
        cwd: "/tmp/project",
        commandText: 'node -e "console.log(1)"',
        agentId: null,
        sessionKey: null,
      },
      commandHighlighting: true,
    });
    expect(payload()).toMatchObject({ commandSpans: [{ startIndex: 0, endIndex: 4 }] });
  });

  it("keeps explicit command spans", async () => {
    await register({ commandSpans: [{ startIndex: 0, endIndex: 4 }], commandHighlighting: true });
    expect(payload()).toMatchObject({ commandSpans: [{ startIndex: 0, endIndex: 4 }] });
  });
});
