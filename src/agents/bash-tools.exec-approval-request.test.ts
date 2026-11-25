import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  isExecApprovalRunAbortedError as isAborted,
  registerExecApprovalRequestForHostOrThrow as registerRequest,
  resolveRegisteredExecApprovalDecision as resolveDecision,
} from "./bash-tools.exec-approval-request.js";
import { DEFAULT_APPROVAL_TIMEOUT_MS } from "./bash-tools.exec-runtime.js";
import { callGatewayTool } from "./tools/gateway.js";

// mock-isolation: Fixed command spans keep approval registration independent of native parsing.
vi.mock("./bash-tools.exec-approval-request.runtime.js", () => ({
  resolveExecApprovalCommandSpans: async (command: string) =>
    command === "node"
      ? [{ startIndex: 0, endIndex: 4 }]
      : command === "ls foo"
        ? [
            { startIndex: 0, endIndex: 2 },
            { startIndex: 3, endIndex: 6 },
          ]
        : undefined,
}));
vi.mock("./tools/gateway.js", () => ({ callGatewayTool: vi.fn() }));

function register(overrides: Partial<Parameters<typeof registerRequest>[0]> = {}) {
  return registerRequest({
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
afterEach(vi.restoreAllMocks);

it("distinguishes run cancellation from timeout fallback", async () => {
  vi.mocked(callGatewayTool)
    .mockResolvedValueOnce({ decision: null, terminalReason: "timeout" })
    .mockResolvedValueOnce({ decision: null, terminalReason: "run-aborted" });
  const request = { approvalId: "approval-id", preResolvedDecision: undefined };
  await expect(resolveDecision(request)).resolves.toBeNull();
  await expect(resolveDecision(request)).rejects.toSatisfy(isAborted);
});

it.each([
  [Number.NaN, undefined, 0],
  [1_800_000_000_000, Number.MAX_VALUE, 1_800_000_000_000 + DEFAULT_APPROVAL_TIMEOUT_MS],
] as const)(
  "bounds invalid registration expiry with clock %s",
  async (now, expiresAtMs, expected) => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    vi.mocked(callGatewayTool).mockResolvedValue({ id: "approval-id", expiresAtMs });
    await expect(register({ host: "gateway" })).resolves.toMatchObject({ expiresAtMs: expected });
  },
);

it("registers command spans with the originating run and reviewer", async () => {
  const origin = { sessionId: "s", runId: "r", toolCallId: "t", approvalReviewerDeviceIds: ["d"] };
  await register({ ...origin, command: "ls foo", commandHighlighting: true });
  expect(payload()).toMatchObject({
    ...origin,
    commandSpans: [
      { startIndex: 0, endIndex: 2 },
      { startIndex: 3, endIndex: 6 },
    ],
  });
});

const plan = { argv: ["node"], cwd: "/tmp", commandText: "node", agentId: null, sessionKey: null };
it.each([
  {
    name: "prepared system run command when raw command is absent",
    command: undefined,
    systemRunPlan: plan,
  },
  { name: "explicit command spans", commandSpans: [{ startIndex: 0, endIndex: 4 }] },
])("highlights $name", async ({ name: _name, ...params }) => {
  await register({ ...params, commandHighlighting: true });
  expect(payload()).toMatchObject({ commandSpans: [{ startIndex: 0, endIndex: 4 }] });
});
