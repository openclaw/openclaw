import { afterEach, describe, expect, it } from "vitest";
import { resetAgentRunRegistryForTest } from "../../../infra/agent-run-registry.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../../admitted-run-context.js";
import { getGatewayToolCallerIdentity } from "../../tools/gateway-caller-context.js";
import { withPreparedEmbeddedGatewayTools } from "./attempt-gateway-tools.js";

afterEach(() => {
  resetAgentRunRegistryForTest();
});

describe("embedded Gateway tool caller source", () => {
  it("retains requester context through embedded Gateway tools", async () => {
    const runId = "gateway-approval-source";
    const currentThreadTs = "1700000001.000002";
    const approvalSource = {
      channel: "slack",
      senderId: "U123",
      conversationKind: "direct" as const,
      userMessageExcerpt: "Please review this image",
    };
    const admission = prepareAgentRunAdmission({
      cfg: {},
      operationalRunInstance: createOperationalRunInstanceRef(runId),
      facts: {
        runId,
        agentId: "main",
        ingress: { kind: "system", state: "present", boundary: "gateway-source-test" },
      },
    });
    try {
      const admittedRunContext = await admission.admit("embedded");
      const caller = await withPreparedEmbeddedGatewayTools(
        {
          admittedRunContext,
          agentId: "main",
          sessionId: "session-1",
          sessionKey: "agent:main:test",
          agentHarnessId: "openclaw",
          messageChannel: "slack",
          currentMessagingTarget: "user:U123",
          currentThreadTs,
          approvalSource,
          disableTools: true,
        },
        () => true,
        async () => getGatewayToolCallerIdentity(),
      );
      expect(caller).toMatchObject({ turnSourceThreadId: currentThreadTs, approvalSource });
    } finally {
      admission.close();
    }
  });
});
