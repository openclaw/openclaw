import { afterEach, describe, expect, it, vi } from "vitest";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import type { PluginHookHandlerMap } from "../plugins/hook-types.js";
import { addTestHook, createMockPluginRegistry } from "../plugins/hooks.test-fixtures.js";
import {
  createAgentExecutionAttribution,
  resolveAgentExecutionIdentityAdmission,
} from "./agent-execution-attribution.js";
import {
  createApprovalAuthorityForAgentHarnessAttempt,
  createApprovalAuthorityForAgentHarnessSideQuestion,
} from "./agent-harness-approval-authority.js";
import { bindEmbeddedAttemptExecutionAttribution } from "./embedded-agent-runner/run/attempt-execution-attribution.js";
import type { EmbeddedRunAttemptParams } from "./embedded-agent-runner/run/types.js";
import { bindAgentHarnessSideQuestionExecutionAttribution } from "./harness/side-question-execution-attribution.js";
import type { AgentHarnessSideQuestionParams } from "./harness/types.js";
import { getGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";
import { callGatewayTool } from "./tools/gateway.js";

vi.mock("./tools/gateway.js", () => ({ callGatewayTool: vi.fn() }));

const mockCallGatewayTool = vi.mocked(callGatewayTool);

afterEach(() => {
  mockCallGatewayTool.mockReset();
  resetGlobalHookRunner();
});

function approvalRequest() {
  return {
    pluginId: "openclaw-codex-app-server",
    title: "Approval",
    description: "Approve this operation",
    severity: "warning" as const,
    toolName: "exec",
    timeoutMs: 1_000,
    gatewayTimeoutMs: 2_000,
  };
}

describe("agent harness approval authority", () => {
  it("resolves execution identity only from the exact admitted attempt", async () => {
    const attribution = createAgentExecutionAttribution({
      runId: "run-attempt",
      lifecycleGeneration: "generation-attempt",
      agentId: "agent-a",
      sessionKey: "agent:agent-a:main",
    });
    const attempt = {
      agentId: "agent-a",
      sessionKey: "agent:agent-a:main",
      config: { logging: { audit: { executionIdentity: true } } },
    } as EmbeddedRunAttemptParams;
    bindEmbeddedAttemptExecutionAttribution(attempt, attribution);
    const observed: Array<ReturnType<typeof getGatewayToolCallerIdentity>> = [];
    mockCallGatewayTool.mockImplementation(async () => {
      observed.push(getGatewayToolCallerIdentity());
      return { id: "approval-1" };
    });

    await createApprovalAuthorityForAgentHarnessAttempt(attempt).requestPluginApproval(
      approvalRequest(),
    );
    await createApprovalAuthorityForAgentHarnessAttempt({ ...attempt }).requestPluginApproval(
      approvalRequest(),
    );

    expect(observed[0]?.executionIdentity).toMatchObject({
      runId: attribution.runId,
      contextId: attribution.contextId,
      executionId: attribution.executionId,
    });
    expect(observed[1]).toEqual({ agentId: "agent-a", sessionKey: "agent:agent-a:main" });
  });

  it("resolves execution identity only from the exact admitted side question", async () => {
    const attribution = createAgentExecutionAttribution({
      runId: "run-side",
      lifecycleGeneration: "generation-side",
      agentId: "agent-b",
      sessionKey: "agent:agent-b:main",
    });
    const sideQuestion = bindAgentHarnessSideQuestionExecutionAttribution(
      {
        agentId: "agent-b",
        sessionKey: "agent:agent-b:main",
        cfg: { logging: { audit: { executionIdentity: true } } },
      } as AgentHarnessSideQuestionParams,
      attribution,
    );
    const observed: Array<ReturnType<typeof getGatewayToolCallerIdentity>> = [];
    mockCallGatewayTool.mockImplementation(async () => {
      observed.push(getGatewayToolCallerIdentity());
      return { id: "approval-1" };
    });

    await createApprovalAuthorityForAgentHarnessSideQuestion(sideQuestion).requestPluginApproval(
      approvalRequest(),
    );
    await createApprovalAuthorityForAgentHarnessSideQuestion({
      ...sideQuestion,
    }).requestPluginApproval(approvalRequest());

    expect(observed[0]?.executionIdentity).toMatchObject({
      runId: attribution.runId,
      contextId: attribution.contextId,
      executionId: attribution.executionId,
    });
    expect(observed[1]).toEqual({ agentId: "agent-b", sessionKey: "agent:agent-b:main" });

    const hookObserved: Array<{
      identity: ReturnType<typeof getGatewayToolCallerIdentity>;
      runId?: string;
    }> = [];
    const beforeToolCall: PluginHookHandlerMap["before_tool_call"] = async (_event, ctx) => {
      hookObserved.push({ identity: getGatewayToolCallerIdentity(), runId: ctx.runId });
    };
    const registry = createMockPluginRegistry([]);
    addTestHook({
      registry,
      pluginId: "approval-authority-test",
      hookName: "before_tool_call",
      handler: beforeToolCall,
    });
    initializeGlobalHookRunner(registry);
    const hookRequest = {
      toolName: "read",
      params: { path: "README.md" },
      ctx: { runId: "side-local-run" },
    };
    await createApprovalAuthorityForAgentHarnessSideQuestion(
      sideQuestion,
    ).runBeforeToolCallApproval(hookRequest);
    await createApprovalAuthorityForAgentHarnessSideQuestion({
      ...sideQuestion,
    }).runBeforeToolCallApproval(hookRequest);

    expect(hookObserved).toEqual([
      {
        identity: {
          agentId: "agent-b",
          sessionKey: "agent:agent-b:main",
          executionIdentity: resolveAgentExecutionIdentityAdmission(attribution).token,
        },
        runId: "side-local-run",
      },
      {
        identity: { agentId: "agent-b", sessionKey: "agent:agent-b:main" },
        runId: "side-local-run",
      },
    ]);
  });

  it("omits the execution pair when collection is disabled", async () => {
    const attribution = createAgentExecutionAttribution({
      runId: "run-disabled",
      lifecycleGeneration: "generation-disabled",
      agentId: "agent-disabled",
      sessionKey: "agent:disabled:main",
    });
    const attempt = {
      agentId: "agent-disabled",
      sessionKey: "agent:disabled:main",
      config: { logging: { audit: { executionIdentity: false } } },
    } as EmbeddedRunAttemptParams;
    bindEmbeddedAttemptExecutionAttribution(attempt, attribution);
    let observed: ReturnType<typeof getGatewayToolCallerIdentity>;
    mockCallGatewayTool.mockImplementation(async () => {
      observed = getGatewayToolCallerIdentity();
      return { id: "approval-1" };
    });

    await createApprovalAuthorityForAgentHarnessAttempt(attempt).requestPluginApproval(
      approvalRequest(),
    );

    expect(observed!).toEqual({
      agentId: "agent-disabled",
      sessionKey: "agent:disabled:main",
    });
  });
});
