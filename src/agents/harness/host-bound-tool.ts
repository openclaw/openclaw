import { copyAgentToolMetadata } from "../agent-tool-metadata.js";
import {
  attachInternalToolExecutionPreparer,
  getInternalToolExecutionPreparer,
} from "../runtime/internal-hooks.js";
import { registerTrustedToolNoStartError } from "../tool-result-error.js";
import type { AnyAgentTool } from "../tools/common.js";

export function gateBoundTool(
  tool: AnyAgentTool,
  assertActive: () => void,
  observeResult: (result: unknown) => void,
): AnyAgentTool {
  const execute = tool.execute;
  const sourcePreparer = getInternalToolExecutionPreparer(tool);
  if (!execute && !sourcePreparer) {
    return tool;
  }
  const gated: AnyAgentTool = {
    ...tool,
    ...(execute
      ? {
          execute: async (...args: Parameters<NonNullable<AnyAgentTool["execute"]>>) => {
            try {
              assertActive();
            } catch (error) {
              // This gate precedes dispatch; a revoked owner must not look like
              // a tool that started and failed in downstream terminal evidence.
              throw registerTrustedToolNoStartError(error);
            }
            const result = await execute(...args);
            assertActive();
            observeResult(result);
            return result;
          },
        }
      : {}),
  };
  copyAgentToolMetadata(tool, gated, (source) =>
    gateBoundTool(source, assertActive, observeResult),
  );
  if (sourcePreparer) {
    attachInternalToolExecutionPreparer(gated, async (preparationParams) => {
      assertActive();
      const prepared = await sourcePreparer(preparationParams);
      try {
        assertActive();
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
          assertActive();
          const result = await prepared.execute(onImplementationStart);
          assertActive();
          observeResult(result);
          return result;
        },
      };
    });
  }
  return gated;
}
