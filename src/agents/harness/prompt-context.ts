import path from "node:path";
import { truncateWithMarker } from "@openclaw/normalization-core/utf16-slice";
import type { SessionModelContextLimits } from "../../config/sessions/session-accessor.sqlite-model-context.js";
import type { OpenClawConfig } from "../../config/types.js";
import { resolveAgentWorkspaceDir } from "../agent-scope-config.js";
import { appendCurrentInboundContext } from "../embedded-agent-runner/run/runtime-context-prompt.js";
import { buildAgentInternalEventContext } from "../internal-events.js";
import { projectRuntimeContextFragments } from "../internal-runtime-context.js";
import type { AgentHarnessAttemptParamsV2 } from "./types.js";

// Match the native transcript preview scale without capping instructions or event metadata.
const COMPLETION_DATA_PREVIEW_MAX_CHARS = 10_000;
const COMPLETION_DATA_PREVIEW_MARKER =
  "\n[Completion preview truncated; the originating harness retains the full result.]";

/** Native plugins consume turn context; the built-in harness owns its own event projection. */
export function preparePluginHarnessRuntimeContext(
  params: AgentHarnessAttemptParamsV2,
): AgentHarnessAttemptParamsV2 {
  const dataCount =
    (params.internalEvents?.length ?? 0) +
    (params.runtimeContextFragments?.filter((fragment) => fragment.kind === "conversation-data")
      .length ?? 0);
  const dataBudget = Math.floor(COMPLETION_DATA_PREVIEW_MAX_CHARS / Math.max(1, dataCount));
  const marker =
    dataBudget >= COMPLETION_DATA_PREVIEW_MARKER.length
      ? COMPLETION_DATA_PREVIEW_MARKER
      : dataBudget > 0
        ? "…"
        : "";
  const preview = (text: string) =>
    truncateWithMarker(text, dataBudget, {
      marker,
      reserve: marker.length,
      trimEnd: false,
    });
  const fragments = buildAgentInternalEventContext(
    params.internalEvents?.map((event) => ({ ...event, result: preview(event.result) })),
    params.runtimeContextFragments?.map((fragment) =>
      fragment.kind === "conversation-data"
        ? { ...fragment, text: preview(fragment.text) }
        : fragment,
    ),
  );
  if (!fragments.length) {
    return params;
  }
  return {
    ...params,
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
