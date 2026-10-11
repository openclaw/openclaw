import { copyAgentToolMetadata } from "../agent-tool-metadata.js";
import {
  attachInternalToolExecutionPreparer,
  getInternalToolExecutionPreparer,
} from "../runtime/internal-hooks.js";
import { registerTrustedToolNoStartError } from "../tool-result-error.js";
import type { AnyAgentTool } from "../tools/common.js";
import type { AgentWorkspaceReadiness } from "../workspace-readiness.js";

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
