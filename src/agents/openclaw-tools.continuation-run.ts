// Per-run continuation tool parameters for createOpenClawTools (inventory stub opts + forwarding).
// openclaw-tools.ts calls createOpenClawContinuationTools itself: the Project 84 topology contract
// requires that edge to stay direct.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { createOpenClawContinuationTools } from "./openclaw-tools.continuation.js";
import type { OpenClawToolsOptions } from "./openclaw-tools.types.js";
import { buildInventoryContinuationToolOpts } from "./tools/continuation-inventory-opts.js";

export function resolveOpenClawContinuationToolParamsForRun(params: {
  resolvedConfig?: OpenClawConfig;
  options?: OpenClawToolsOptions;
}): Parameters<typeof createOpenClawContinuationTools>[0] {
  const { resolvedConfig, options } = params;
  const inventoryContinuationOpts = options?.beforeToolCallHookContext?.skillCommand
    ? buildInventoryContinuationToolOpts(resolvedConfig)
    : {};
  return {
    config: resolvedConfig,
    agentSessionKey: options?.agentSessionKey,
    runSessionKey: options?.runSessionKey,
    sessionId: options?.sessionId,
    runId: options?.runId,
    drainsContinuationDelegateQueue: options?.drainsContinuationDelegateQueue,
    disableContinuationTools: options?.disableContinuationTools,
    fixedToolListing: options?.fixedToolListing,
    continueWorkOpts: options?.continueWorkOpts ?? inventoryContinuationOpts.continueWorkOpts,
    requestCompactionOpts:
      options?.requestCompactionOpts ?? inventoryContinuationOpts.requestCompactionOpts,
  };
}
