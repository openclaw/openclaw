import { beforeEach, describe, expect, it, vi } from "vitest";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { requestExecApprovalDecision } from "./bash-tools.exec-approval-request.js";
import {
  __testing,
  wrapToolWithBeforeToolCallHook,
  type HookContext,
} from "./pi-tools.before-tool-call.js";

vi.mock("../plugins/hook-runner-global.js");
vi.mock("./bash-tools.exec-approval-request.js", () => ({
  requestExecApprovalDecision: vi.fn(),
}));

const mockGetGlobalHookRunner = vi.mocked(getGlobalHookRunner);
const mockRequestExecApprovalDecision = vi.mocked(requestExecApprovalDecision);

describe("before_tool_call approvals.tools", () => {
  beforeEach(() => {
    __testing.clearToolApprovalAllowAlwaysCache();
    mockRequestExecApprovalDecision.mockReset();
    mockGetGlobalHookRunner.mockReturnValue({
      hasHooks: vi.fn(() => false),
      runBeforeToolCall: vi.fn(),
    } as unknown as ReturnType<typeof getGlobalHookRunner>);
  });

  function wrapTool(
    name: string,
    execute = vi.fn().mockResolvedValue({ ok: true }),
    ctx?: HookContext,
  ) {
    return {
      wrapped: wrapToolWithBeforeToolCallHook(
        { name, execute } as unknown as Parameters<typeof wrapToolWithBeforeToolCallHook>[0],
        ctx,
      ),
      execute,
    };
  }

  it("requests approval for apply_patch and allows on allow-once", async () => {
    mockRequestExecApprovalDecision.mockResolvedValue("allow-once");
    const { wrapped, execute } = wrapTool("apply_patch", undefined, {
      agentId: "main",
      sessionKey: "agent:main:telegram:direct:123",
      approvals: {
        tools: { enabled: true },
        turnSourceChannel: "telegram",
        turnSourceTo: "123",
      },
    });

    await wrapped.execute(
      "tool-1",
      { input: "*** Begin Patch\n*** End Patch\n" },
      undefined,
      undefined,
    );

    expect(mockRequestExecApprovalDecision).toHaveBeenCalledTimes(1);
    expect(mockRequestExecApprovalDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "tool:apply_patch",
        host: "gateway",
        security: "full",
        ask: "always",
        turnSourceChannel: "telegram",
        turnSourceTo: "123",
      }),
    );
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("blocks on deny decision", async () => {
    mockRequestExecApprovalDecision.mockResolvedValue("deny");
    const { wrapped, execute } = wrapTool("apply_patch", undefined, {
      approvals: {
        tools: { enabled: true },
      },
    });

    await expect(
      wrapped.execute(
        "tool-2",
        { input: "*** Begin Patch\n*** End Patch\n" },
        undefined,
        undefined,
      ),
    ).rejects.toThrow("Tool call denied by operator");
    expect(execute).not.toHaveBeenCalled();
  });

  it("caches allow-always by tool action scope", async () => {
    mockRequestExecApprovalDecision.mockResolvedValue("allow-always");
    const { wrapped } = wrapTool("apply_patch", undefined, {
      agentId: "main",
      sessionKey: "agent:main:telegram:direct:123",
      approvals: {
        tools: { enabled: true, allowAlwaysTtlMs: 60_000 },
      },
    });

    await wrapped.execute(
      "tool-3",
      { input: "*** Begin Patch\n*** End Patch\n" },
      undefined,
      undefined,
    );
    await wrapped.execute(
      "tool-4",
      { input: "*** Begin Patch\n*** End Patch\n" },
      undefined,
      undefined,
    );

    expect(mockRequestExecApprovalDecision).toHaveBeenCalledTimes(1);
  });

  it("fails open when configured and approval request errors", async () => {
    mockRequestExecApprovalDecision.mockRejectedValue(new Error("gateway unavailable"));
    const { wrapped, execute } = wrapTool("apply_patch", undefined, {
      approvals: {
        tools: { enabled: true, failClosed: false },
      },
    });

    await wrapped.execute(
      "tool-5",
      { input: "*** Begin Patch\n*** End Patch\n" },
      undefined,
      undefined,
    );

    expect(execute).toHaveBeenCalledTimes(1);
  });
});
