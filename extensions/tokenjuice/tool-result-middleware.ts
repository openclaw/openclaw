import process from "node:process";
import type {
  AgentToolResultMiddleware,
  AgentToolResultMiddlewareEvent,
  OpenClawAgentToolResult,
} from "openclaw/plugin-sdk/agent-harness";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { createTokenjuiceOpenClawEmbeddedExtension } from "./runtime-api.js";

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
  current: OpenClawAgentToolResult,
): unknown {
  if (
    (event.toolName !== "exec" && event.toolName !== "bash") ||
    typeof event.args.command !== "string" ||
    !event.args.command
  ) {
    return current.details;
  }
  const metadata = isRecord(current.details) ? { ...current.details } : {};
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

export function createTokenjuiceAgentToolResultMiddleware(): AgentToolResultMiddleware {
  let handler: TokenjuiceToolResultHandler | undefined;
  createTokenjuiceOpenClawEmbeddedExtension()({
    on(event, registeredHandler) {
      if (event === "tool_result") {
        handler = registeredHandler as TokenjuiceToolResultHandler;
      }
    },
  });

  return async (event) => {
    const current = event.result;
    const workdir = event.args.workdir;
    const details = normalizeDetails(event, current);
    const detailsCwd = isRecord(details) ? details.cwd : undefined;
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
      const next = await handler?.(
        {
          toolName: event.toolName,
          input: event.args,
          content: current.content,
          details,
          isError: event.isError,
        },
        { cwd },
      );
      return next
        ? {
            result: Object.assign({}, current, {
              content: next.content ?? current.content,
              details: next.details ?? current.details,
            }),
          }
        : undefined;
    } finally {
      retainedRuleScopes.add(cwd);
      if (retainedRuleScopes.size >= 128) {
        const { clearRuleCache } = await import("tokenjuice");
        clearRuleCache();
        retainedRuleScopes.clear();
      }
    }
  };
}
