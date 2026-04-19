import { afterEach, describe, expect, it } from "vitest";
import {
  installRuntimeTaskDeliveryMock,
  resetRuntimeTaskTestState,
} from "../plugins/runtime/runtime-task-test-harness.js";
import { createRuntimeTaskFlow } from "../plugins/runtime/runtime-taskflow.js";
import { getTaskFlowById } from "../tasks/task-flow-registry.js";
import { ensureAcpManagedFlow } from "./acp-taskflow-orchestrator.js";

afterEach(() => {
  resetRuntimeTaskTestState({ persist: false });
});

describe("acp taskflow orchestrator", () => {
  it("creates a managed flow bound to the owner session and requester origin", async () => {
    installRuntimeTaskDeliveryMock();

    const ownerKey = "agent:main:discord:channel:1491082684791918722";
    const requesterOrigin = {
      channel: "discord",
      accountId: "default",
      to: "channel:1491082684791918722",
      threadId: "1493151001098584226",
    } as const;
    const taskFlow = createRuntimeTaskFlow().bindSession({
      sessionKey: ownerKey,
      requesterOrigin,
    });

    const flow = ensureAcpManagedFlow({
      taskFlow,
      controllerId: "agents/acp-spawn",
      goal: "Investigate flaky tests",
      currentStep: "spawn-acp-child",
      routeSnapshot: requesterOrigin,
      workflowIntent: {
        kind: "acp_parent_spawn",
        mode: "run",
        streamTo: "parent",
      },
    });

    expect(flow).toMatchObject({
      syncMode: "managed",
      ownerKey,
      controllerId: "agents/acp-spawn",
      requesterOrigin,
      currentStep: "spawn-acp-child",
      stateJson: {
        route: requesterOrigin,
        workflowIntent: {
          kind: "acp_parent_spawn",
          mode: "run",
          streamTo: "parent",
        },
      },
    });
    expect(getTaskFlowById(flow.flowId)).toMatchObject({
      flowId: flow.flowId,
      ownerKey,
      syncMode: "managed",
    });
  });
});
