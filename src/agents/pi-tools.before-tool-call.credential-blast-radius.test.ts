import { beforeEach, describe, expect, it, vi } from "vitest";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { runBeforeToolCallHook, __testing } from "./pi-tools.before-tool-call.js";
import { callGatewayTool } from "./tools/gateway.js";

vi.mock("../plugins/hook-runner-global.js", async () => {
  const actual = await vi.importActual<typeof import("../plugins/hook-runner-global.js")>(
    "../plugins/hook-runner-global.js",
  );
  return {
    ...actual,
    getGlobalHookRunner: vi.fn(),
  };
});

vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: vi.fn(),
}));

const mockGetGlobalHookRunner = vi.mocked(getGlobalHookRunner);
const mockCallGateway = vi.mocked(callGatewayTool);

describe("before_tool_call credential blast-radius guard", () => {
  beforeEach(() => {
    mockGetGlobalHookRunner.mockReturnValue({
      hasHooks: vi.fn().mockReturnValue(false),
      runBeforeToolCall: vi.fn(),
    } as never);
    mockCallGateway.mockReset();
  });

  it("keeps names-only credential inventory and never emits values", () => {
    const snapshot = __testing.buildCredentialBlastRadiusApprovalMetadata({
      SUPABASE_SERVICE_ROLE_KEY: "super-secret-service-role-value",
      ACME_PRIVATE_TOKEN: "another-secret-value",
      PATH: "/usr/bin",
    });

    expect(snapshot.credentials.map((credential) => credential.name).toSorted()).toEqual([
      "ACME_PRIVATE_TOKEN",
      "SUPABASE_SERVICE_ROLE_KEY",
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("super-secret-service-role-value");
    expect(JSON.stringify(snapshot)).not.toContain("another-secret-value");
  });

  it("routes require-approval destructive operations through approval metadata", async () => {
    const previousSecret = process.env.ACME_PRIVATE_TOKEN;
    process.env.ACME_PRIVATE_TOKEN = "secret-value-that-must-not-leak";
    try {
      mockCallGateway.mockResolvedValueOnce({ id: "approval-1", status: "accepted" });
      mockCallGateway.mockResolvedValueOnce({ id: "approval-1", decision: "allow-once" });

      const result = await runBeforeToolCallHook({
        toolName: "exec",
        params: { command: "psql -c 'DROP TABLE temp_review'" },
        toolCallId: "tool-1",
        ctx: { agentId: "rex", sessionKey: "session-1" },
      });

      expect(result).toEqual({
        blocked: false,
        params: { command: "psql -c 'DROP TABLE temp_review'" },
      });
      expect(mockCallGateway).toHaveBeenCalledTimes(2);
      const approvalPayload = mockCallGateway.mock.calls[0]?.[2];
      expect(approvalPayload).toMatchObject({
        pluginId: "credential-blast-radius-guard",
        toolName: "exec",
        toolCallId: "tool-1",
        agentId: "rex",
        sessionKey: "session-1",
        twoPhase: true,
      });
      expect(JSON.stringify(approvalPayload)).toContain("sql/drop-table");
      expect(JSON.stringify(approvalPayload)).toContain("ACME_PRIVATE_TOKEN");
      expect(JSON.stringify(approvalPayload)).not.toContain("secret-value-that-must-not-leak");
    } finally {
      if (previousSecret === undefined) {
        delete process.env.ACME_PRIVATE_TOKEN;
      } else {
        process.env.ACME_PRIVATE_TOKEN = previousSecret;
      }
    }
  });

  it("blocks only unambiguous block-severity destructive operations", async () => {
    const result = await runBeforeToolCallHook({
      toolName: "exec",
      params: {
        command:
          'curl https://backboard.railway.com/graphql -d \'{"query":"mutation { volumeDelete(id: \\"vol_123\\") }"}\'',
      },
      ctx: { agentId: "rex", sessionKey: "session-1" },
    });

    expect(result.blocked).toBe(true);
    expect(result).toHaveProperty(
      "reason",
      "Destructive action blocked by credential blast-radius guard: railway/volumeDelete",
    );
    expect(mockCallGateway).not.toHaveBeenCalled();
  });

  it.each([
    "rm -rf $HOME/*",
    'rm -rf "$HOME"/*',
    "rm -rf ${HOME:?}/*",
    "rm -rf / --no-preserve-root",
  ])("blocks catastrophic shell deletion: %s", async (command) => {
    const result = await runBeforeToolCallHook({
      toolName: "exec",
      params: { command },
      ctx: { agentId: "rex", sessionKey: "session-1" },
    });

    expect(result).toEqual({
      blocked: true,
      reason: "Destructive action blocked by credential blast-radius guard: shell/rm-rf-root",
    });
    expect(mockCallGateway).not.toHaveBeenCalled();
  });

  it("does not block specific absolute-path cleanup", async () => {
    const result = await runBeforeToolCallHook({
      toolName: "exec",
      params: { command: "rm -rf /tmp/openclaw-build" },
      ctx: { agentId: "rex", sessionKey: "session-1" },
    });

    expect(result).toEqual({
      blocked: false,
      params: { command: "rm -rf /tmp/openclaw-build" },
    });
    expect(mockCallGateway).not.toHaveBeenCalled();
  });

  it("fails closed as unavailable when approval request returns no route", async () => {
    mockCallGateway.mockResolvedValueOnce({ id: "approval-1", decision: null });

    const result = await runBeforeToolCallHook({
      toolName: "exec",
      params: { command: "psql -c 'DROP TABLE temp_review'" },
      toolCallId: "tool-1",
      ctx: { agentId: "rex", sessionKey: "session-1" },
    });

    expect(result).toEqual({
      blocked: true,
      reason: "Credential blast-radius approval unavailable",
    });
    expect(mockCallGateway).toHaveBeenCalledTimes(1);
  });

  it("leaves safe read-only calls unaffected", async () => {
    const result = await runBeforeToolCallHook({
      toolName: "exec",
      params: { command: "git status --short && ls src/agents" },
      ctx: { agentId: "rex", sessionKey: "session-1" },
    });

    expect(result).toEqual({
      blocked: false,
      params: { command: "git status --short && ls src/agents" },
    });
    expect(mockCallGateway).not.toHaveBeenCalled();
  });
});
