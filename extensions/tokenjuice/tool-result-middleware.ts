import process from "node:process";
import type {
  AgentToolResultMiddleware,
  AgentToolResultMiddlewareEvent,
  OpenClawAgentToolResult,
} from "openclaw/plugin-sdk/agent-harness";
import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { createTokenjuiceOpenClawEmbeddedExtension } from "./runtime-api.js";

// Match the pinned adapter, including OpenClaw's named Codex dynamic shell tools.
const shellToolNames = new Set(["exec", "bash", "gateway_exec", "node_exec"]);
// Tokenjuice's process-wide rule cache has one entry per cwd and no eviction.
const retainedRuleScopes = new Set<string>();

type TokenjuiceToolResultHandler = (
  event: {
    toolName: string;
    input: Record<string, unknown>;
    content: OpenClawAgentToolResult["content"];
    details: unknown;
    isError?: boolean;
  },
  ctx: { cwd: string },
) => Promise<Partial<OpenClawAgentToolResult> | void> | Partial<OpenClawAgentToolResult> | void;

function normalizeDetails(
  event: AgentToolResultMiddlewareEvent,
  details: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (event.toolName !== "exec" && event.toolName !== "bash") {
    return details;
  }
  const metadata = { ...details };
  // Tokenjuice reads text content when `aggregated` is absent, then merges details
  // into its response. Drop the duplicate raw copy or compaction can exceed host limits.
  delete metadata.aggregated;
  // A concrete status is already canonical. Other terminal hints are preserved below
  // while supplying only the completed/failed status Tokenjuice requires.
  if (typeof metadata.status === "string" && metadata.status.trim()) {
    return metadata;
  }
  const rawExitCode = metadata.exitCode;
  const failed =
    event.isError === true ||
    metadata.ok === false ||
    metadata.success === false ||
    metadata.timedOut === true ||
    Boolean(metadata.error) ||
    (typeof rawExitCode === "number" && Number.isFinite(rawExitCode) && rawExitCode !== 0);
  const exitCode =
    typeof rawExitCode === "number" && Number.isFinite(rawExitCode) ? rawExitCode : failed ? 1 : 0;
  metadata.status = failed ? "failed" : "completed";
  metadata.exitCode = exitCode;
  return metadata;
}

export function createTokenjuiceAgentToolResultMiddleware(
  logger: Pick<PluginLogger, "warn">,
): AgentToolResultMiddleware {
  let handler: TokenjuiceToolResultHandler | undefined;
  let warned = false;
  createTokenjuiceOpenClawEmbeddedExtension()({
    on(event, registeredHandler) {
      if (event === "tool_result") {
        handler = registeredHandler as TokenjuiceToolResultHandler;
      }
    },
  });

  return async (event) => {
    const { args, result: current, toolName } = event;
    if (
      !handler ||
      !shellToolNames.has(toolName) ||
      "code" in args ||
      typeof args.command !== "string" ||
      !args.command.trim()
    ) {
      return undefined;
    }
    const originalDetails = isRecord(current.details) ? current.details : undefined;
    // Keep the host's retry guidance and spill recovery separate from compacted output.
    if (
      originalDetails?.timedOut === true ||
      originalDetails?.noOutputTimedOut === true ||
      typeof originalDetails?.fullOutputPath === "string"
    ) {
      return undefined;
    }
    const details = normalizeDetails(event, originalDetails);
    if (details?.status !== "completed" && details?.status !== "failed") {
      return undefined;
    }
    const { workdir } = args;
    const detailsCwd = details.cwd;
    // Match Tokenjuice's cwd precedence; ignored fallbacks must not evict rules.
    const cwd =
      typeof workdir === "string" && workdir.trim()
        ? workdir
        : typeof detailsCwd === "string" && detailsCwd.trim()
          ? detailsCwd
          : event.cwd?.trim()
            ? event.cwd
            : process.cwd();
    try {
      let next;
      try {
        next = await handler(
          { toolName, input: args, content: current.content, details, isError: event.isError },
          { cwd },
        );
      } finally {
        // Count possible rule loads; a keep decision does not reveal whether rules were loaded.
        retainedRuleScopes.add(cwd);
        if (retainedRuleScopes.size >= 128) {
          const { clearRuleCache } = await import("tokenjuice");
          clearRuleCache();
          retainedRuleScopes.clear();
        }
      }
      if (!next) {
        return undefined;
      }
      const nextDetails = next.details ?? details;
      return {
        result: Object.assign({}, current, {
          content: next.content ?? current.content,
          // Code Mode returns shell details rather than content. Mirror only the
          // delivered compacted text, never the raw aggregate removed above.
          details:
            next.content && isRecord(nextDetails)
              ? {
                  ...nextDetails,
                  aggregated: next.content
                    .filter((block) => block.type === "text")
                    .map((block) => block.text)
                    .join("\n"),
                }
              : nextDetails,
        }),
      };
    } catch {
      // The reducer is optional; other middleware still sees the admitted result.
      if (!warned) {
        warned = true;
        logger.warn("Tokenjuice could not compact shell output; keeping the original result.");
      }
      return undefined;
    }
  };
}
