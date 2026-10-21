import { createCodeModeCatalogBindings } from "./code-mode-catalog.js";
import { activeRuns, resumingRunIds } from "./code-mode-state.js";
import { isToolExecutionAllowed } from "./tool-policy-shared.js";
import { compactToolSearchCatalogEntry } from "./tool-search-catalog.js";
import type { ToolSearchToolContext } from "./tool-search-types.js";
import { ToolInputError } from "./tools/common.js";

export function codeModeWaitRunUnavailableMessage(ctx: ToolSearchToolContext): string {
  const entries = ctx.catalogRef?.current?.entries ?? [];
  // Resolve the effective binding before selecting the core tool so client shadows win.
  const processTool =
    !ctx.toolExecutionAllow || isToolExecutionAllowed(ctx.toolExecutionAllow, "process")
      ? createCodeModeCatalogBindings(
          entries.map((entry) => compactToolSearchCatalogEntry(entry)),
        ).find((entry) => entry.id === "openclaw:core:process")
      : undefined;
  return (
    'code mode run is unavailable or expired. Only the top-level runId from a Code Mode result with status: "waiting" can be resumed. This ID is unknown or no longer resumable; review earlier exec/wait results before continuing. This error does not mean earlier actions had no effect.' +
    (processTool
      ? " If this is a background shell sessionId, poll that same session with " +
        processTool.callableName +
        ' using action: "poll" in a new exec.'
      : "")
  );
}

/** Resolves the parked run one wait may resume; only its own agent run and session may. */
export function resolveCodeModeWaitRun(runId: string, ctx: ToolSearchToolContext) {
  if (resumingRunIds.has(runId)) {
    throw new ToolInputError(
      "code mode run is already being resumed by another wait. Use that wait’s result before deciding the next step; do not issue another concurrent wait or replay earlier actions.",
    );
  }
  const state = activeRuns.get(runId);
  if (!state) {
    throw new ToolInputError(codeModeWaitRunUnavailableMessage(ctx));
  }
  if (state.ctx.runId && state.ctx.runId !== ctx.runId) {
    throw new ToolInputError("code mode run belongs to a different agent run.");
  }
  if (
    (state.ctx.sessionId && state.ctx.sessionId !== ctx.sessionId) ||
    (state.ctx.sessionKey && state.ctx.sessionKey !== ctx.sessionKey) ||
    (state.ctx.agentId && state.ctx.agentId !== ctx.agentId)
  ) {
    throw new ToolInputError("code mode run belongs to a different session.");
  }
  return state;
}
