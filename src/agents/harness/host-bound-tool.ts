import type { SessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import { copyAgentToolMetadata } from "../agent-tool-metadata.js";
import {
  bindAgentToolSourceExecutionGuard,
  runWithAgentToolSourceExecutionScope,
} from "../agent-tool-source-execution-guard.js";
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
    assertActive: SessionSourceAssertion;
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
  assertActive: SessionSourceAssertion,
  observeResult: (result: unknown) => void,
  workspaceReadiness?: AgentWorkspaceReadiness,
): AnyAgentTool {
  const execute = tool.execute;
  const sourcePreparer = getInternalToolExecutionPreparer(tool);
  if (!execute && !sourcePreparer) {
    return tool;
  }
  const assertCurrent = () =>
    runWithAgentToolSourceExecutionScope(assertActive, async () => {
      assertActive();
      workspaceReadiness?.assertCurrent();
    });
  const acceptResult = <T>(result: T): T => {
    // Completed results keep their run binding; transcript changes fence the next effect.
    (assertActive.assertScopeCurrent ?? assertActive)();
    workspaceReadiness?.assertCurrent();
    observeResult(result);
    return result;
  };
  const awaitWorkspace = async () => {
    await assertCurrent();
    if (workspaceReadiness) {
      await workspaceReadiness.waitUntilReady();
      await assertCurrent();
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
                await assertCurrent();
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
        await assertCurrent();
      }
      const prepared = await sourcePreparer(preparationParams);
      try {
        await assertCurrent();
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
            await assertCurrent();
          }
          return acceptResult(await prepared.execute(onImplementationStart));
        },
      };
    });
  }
  return gated;
}
