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
  it.each([
    {
      name: "top-level Slack DM",
      currentThreadTs: "1700000001.000002",
      messageThreadId: undefined,
    },
    {
      name: "threaded Slack DM",
      currentThreadTs: "1700000001.000002",
      messageThreadId: "1700000000.000001",
    },
  ])(
    "keeps the reply anchor and plugin origin distinct for a $name",
    async ({ name, currentThreadTs, messageThreadId }) => {
      const runId = `gateway-source-${name}`;
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
        await withPreparedEmbeddedGatewayTools(
          {
            admittedRunContext,
            agentId: "main",
            sessionId: "session-1",
            sessionKey: "agent:main:test",
            agentHarnessId: "openclaw",
            messageChannel: "slack",
            currentMessagingTarget: "user:U123",
            currentThreadTs,
            messageThreadId,
            approvalSource: { channel: "slack", senderId: "U123", conversationKind: "direct" },
            disableTools: true,
          },
          () => true,
          async () => {
            const caller = getGatewayToolCallerIdentity();
            expect(caller).toBeDefined();
            expect(caller?.turnSourceThreadId).toBe(currentThreadTs);
            expect(caller?.pluginApprovalOriginThreadId).toBe(messageThreadId ?? null);
          },
        );
      } finally {
        admission.close();
      }
    },
  );
});
