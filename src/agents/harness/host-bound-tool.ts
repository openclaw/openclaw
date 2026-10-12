import { copyAgentToolMetadata } from "../agent-tool-metadata.js";
import { bindAgentToolSourceExecutionGuard } from "../agent-tool-source-execution-guard.js";
import { wrapToolWithAbortSignal } from "../agent-tools.abort.js";
import { rewrapToolWithBeforeToolCallHook } from "../agent-tools.before-tool-call.js";
import {
  attachInternalToolExecutionPreparer,
  getInternalToolExecutionPreparer,
} from "../runtime/internal-hooks.js";
import { registerTrustedToolNoStartError } from "../tool-result-error.js";
import type { AnyAgentTool } from "../tools/common.js";
import { wrapToolWithGatewayCallerIdentity } from "../tools/gateway-caller-context.js";
import type { AgentWorkspaceReadiness } from "../workspace-readiness.js";
import { isWorkspaceTool } from "./host-capability-workspace.js";

/** Assemble each host tool's policy, caller and readiness gates in their execution order. */
export function bindHostToolSurface(
  tools: AnyAgentTool[],
  params: {
    assertActive: () => void;
    observeResult: (result: unknown) => void;
    hookContext: Parameters<typeof rewrapToolWithBeforeToolCallHook>[1];
    callerIdentity: Parameters<typeof wrapToolWithGatewayCallerIdentity>[1] | undefined;
    abortSignal: AbortSignal;
    workspaceReadiness?: AgentWorkspaceReadiness;
  },
): AnyAgentTool[] {
  params.assertActive();
  return tools
    .map((tool) => bindAgentToolSourceExecutionGuard(tool, params.assertActive))
    .map((tool) => rewrapToolWithBeforeToolCallHook(tool, params.hookContext))
    .map((tool) =>
      params.callerIdentity ? wrapToolWithGatewayCallerIdentity(tool, params.callerIdentity) : tool,
    )
    .map((tool) => wrapToolWithAbortSignal(tool, params.abortSignal))
    .map((tool) =>
      gateBoundTool(
        tool,
        params.assertActive,
        params.observeResult,
        isWorkspaceTool(tool) ? params.workspaceReadiness : undefined,
      ),
    );
}

export function gateBoundTool(
  tool: AnyAgentTool,
  assertActive: () => void,
  observeResult: (result: unknown) => void,
  workspaceReadiness?: AgentWorkspaceReadiness,
): AnyAgentTool {
  const execute = tool.execute;
  const sourcePreparer = getInternalToolExecutionPreparer(tool);
  if (!execute && !sourcePreparer) {
    return tool;
  }
  const acceptResult = <T>(result: T): T => {
    assertActive();
    workspaceReadiness?.assertCurrent();
    observeResult(result);
    return result;
  };
  const awaitWorkspace = async () => {
    assertActive();
    if (workspaceReadiness) {
      workspaceReadiness.assertCurrent();
      await workspaceReadiness.waitUntilReady();
      assertActive();
      workspaceReadiness.assertCurrent();
    }
  };
  const gated: AnyAgentTool = {
    ...tool,
    ...(execute
      ? {
          execute: async (...args: Parameters<NonNullable<AnyAgentTool["execute"]>>) => {
            try {
              if (workspaceReadiness) {
                await awaitWorkspace();
              } else {
                assertActive();
              }
            } catch (error) {
              // This gate precedes dispatch; a revoked owner must not look like
              // a tool that started and failed in downstream terminal evidence.
              throw registerTrustedToolNoStartError(error);
            }
            return acceptResult(await execute(...args));
          },
        }
      : {}),
  };
  copyAgentToolMetadata(tool, gated, (source) =>
    gateBoundTool(source, assertActive, observeResult, workspaceReadiness),
  );
  if (sourcePreparer) {
    attachInternalToolExecutionPreparer(gated, async (preparationParams) => {
      if (workspaceReadiness) {
        await awaitWorkspace();
      } else {
        assertActive();
      }
      const prepared = await sourcePreparer(preparationParams);
      try {
        assertActive();
        workspaceReadiness?.assertCurrent();
      } catch (error) {
        prepared.dispose();
        throw error;
      }
      if (prepared.kind === "immediate") {
        if (prepared.outcome.kind === "result") {
          observeResult(prepared.outcome.result);
        }
        return prepared;
      }
      return {
        ...prepared,
        execute: async (onImplementationStart) => {
          if (workspaceReadiness) {
            await awaitWorkspace();
          } else {
            assertActive();
          }
          return acceptResult(await prepared.execute(onImplementationStart));
        },
      };
    });
  }
  return gated;
}
