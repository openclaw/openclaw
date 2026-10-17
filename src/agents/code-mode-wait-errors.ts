import { createCodeModeCatalogBindings } from "./code-mode-catalog.js";
import { isToolExecutionAllowed } from "./tool-policy-shared.js";
import { compactToolSearchCatalogEntry } from "./tool-search-catalog.js";
import type { ToolSearchToolContext } from "./tool-search-types.js";

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
