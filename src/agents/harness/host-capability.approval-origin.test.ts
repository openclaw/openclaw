import { afterEach, expect, it, vi } from "vitest";
import { resetAgentRunRegistryForTest } from "../../infra/agent-run-registry.js";
import { runBeforeToolCallHook } from "../agent-tools.before-tool-call.js";
import { getGatewayToolCallerIdentity } from "../tools/gateway-caller-context.js";
import { createAdmittedHostCapabilityTestFixture } from "./host-capability.test-support.js";

vi.mock("../agent-tools.before-tool-call.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agent-tools.before-tool-call.js")>()),
  runBeforeToolCallHook: vi.fn(async ({ params }) => ({ blocked: false, params })),
}));

afterEach(() => {
  resetAgentRunRegistryForTest();
  vi.clearAllMocks();
});

it.each([
  { sourceThreadId: undefined, expectedPluginThreadId: null },
  { sourceThreadId: "1700000000.000001", expectedPluginThreadId: "1700000000.000001" },
])(
  "keeps generic tool routing while capturing plugin origin $sourceThreadId",
  async ({ sourceThreadId, expectedPluginThreadId }) => {
    const fixture = await createAdmittedHostCapabilityTestFixture({
      runId: `approval-thread-${sourceThreadId ?? "root"}`,
      agentId: "main",
      sessionKey: "agent:main:approval-thread",
      messageChannel: "slack",
      currentThreadTs: "1700000001.000002",
      messageThreadId: sourceThreadId,
      approvalSource: { channel: "slack", senderId: "U123", conversationKind: "direct" },
    });
    try {
      vi.mocked(runBeforeToolCallHook).mockImplementationOnce(async ({ ctx, params }) => {
        expect(ctx?.turnSourceThreadId).toBe("1700000001.000002");
        expect(getGatewayToolCallerIdentity()?.pluginApprovalOriginThreadId).toBe(
          expectedPluginThreadId,
        );
        return { blocked: false, params };
      });
      await fixture.hostCapabilities.runBeforeToolCall({ toolName: "read", params: {} });
    } finally {
      fixture.closeHost();
      fixture.closeAdmission();
    }
  },
);
