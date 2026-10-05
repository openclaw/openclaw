import path from "node:path";
import type { SessionModelContextLimits } from "../../config/sessions/session-accessor.sqlite-model-context.js";
import type { OpenClawConfig } from "../../config/types.js";
import { resolveAgentWorkspaceDir } from "../agent-scope-config.js";
import { appendCurrentInboundContext } from "../embedded-agent-runner/run/runtime-context-prompt.js";
import { buildAgentInternalEventContext } from "../internal-events.js";
import { projectRuntimeContextFragments } from "../internal-runtime-context.js";
import type { AgentHarnessAttemptParamsV2 } from "./types.js";

/** Native plugins consume turn context; the built-in harness owns its own event projection. */
export function preparePluginHarnessRuntimeContext(
  params: AgentHarnessAttemptParamsV2,
): AgentHarnessAttemptParamsV2 {
  const fragments = buildAgentInternalEventContext(
    params.internalEvents,
    params.runtimeContextFragments,
  );
  if (!fragments.length) {
    return params;
  }
  return {
    ...params,
    internalEvents: undefined,
    runtimeContextFragments: undefined,
    currentInboundContext: appendCurrentInboundContext(
      params.currentInboundContext,
      fragments,
      projectRuntimeContextFragments(fragments),
    ),
  };
}

/** Bound transcript reads to the model budget while preserving complete messages. */
export function resolveAgentHarnessHistoryLimits(
  contextTokenBudget?: number,
): SessionModelContextLimits {
  return {
    maxBytes: Math.min(
      64 * 1024 * 1024,
      Math.max(1024, Math.floor((contextTokenBudget ?? 128_000) * 8)),
    ),
    maxEvents: 10_000,
    toolResultOverflow: "omit",
  };
}

export function shouldIncludeAgentHarnessRuntimeContext(
  params: Pick<AgentHarnessAttemptParamsV2, "bootstrapContextMode" | "bootstrapContextRunKind">,
): boolean {
  // Lightweight cron runs can be exact commands; preserve their user input byte-for-byte.
  return !(
    params.bootstrapContextMode === "lightweight" && params.bootstrapContextRunKind === "cron"
  );
}

/** The backend selects the prompt workspace and supplies its admitted tool names. */
export function resolveAgentWorkspaceMemoryRouting(params: {
  config: OpenClawConfig | undefined;
  agentId: string | undefined;
  workspaceDir: string;
  toolNames: ReadonlySet<string>;
}): { memoryToolNames: string[]; memoryToolRouted: boolean } {
  const memoryToolNames = ["memory_search", "memory_get"].filter((name) =>
    params.toolNames.has(name),
  );
  return {
    memoryToolNames,
    memoryToolRouted:
      memoryToolNames.length > 0 &&
      params.config !== undefined &&
      params.agentId !== undefined &&
      path.resolve(resolveAgentWorkspaceDir(params.config, params.agentId)) ===
        path.resolve(params.workspaceDir),
  };
}
