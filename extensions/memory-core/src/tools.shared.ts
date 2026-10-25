import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import type { AnyAgentTool } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  resolveMemoryToolContext,
  type MemoryToolContract,
  type MemoryToolOptions,
} from "./memory-tool-contract.js";
import { DEFAULT_MEMORY_SEARCH_TIMEOUT_MS } from "./memory/search-deadline.js";

// Core owns this session-store error; Memory Core must preserve its exact code
// without importing a core-internal module across the plugin boundary.
const SESSION_CANONICAL_KEY_MIGRATION_REQUIRED = "SESSION_CANONICAL_KEY_MIGRATION_REQUIRED";
const SESSION_CANONICAL_KEY_MIGRATION_WARNING =
  "Memory search is unavailable because the session catalog requires session-key migration.";
const SESSION_CANONICAL_KEY_MIGRATION_ACTION =
  "Stop the Gateway and run openclaw doctor --fix, then restart the Gateway and retry memory_search.";

type MemorySearchManagerResult = Awaited<
  ReturnType<(typeof import("./memory/index.js"))["getMemorySearchManager"]>
>;
export const loadMemoryToolRuntime = createLazyRuntimeModule(() => import("./tools.runtime.js"));

export async function getMemoryManagerContextWithPurpose(
  params: Parameters<(typeof import("./memory/index.js"))["getMemorySearchManager"]>[0],
): Promise<
  | {
      manager: NonNullable<MemorySearchManagerResult["manager"]>;
      debug: MemorySearchManagerResult["debug"];
    }
  | { error: string | undefined; code?: string }
> {
  const { getMemorySearchManager } = await loadMemoryToolRuntime();
  const { manager, debug, error, code } = await getMemorySearchManager(params);
  return manager ? { manager, debug } : { error, code };
}

export function createMemoryTool(params: {
  options: MemoryToolOptions;
  contract: MemoryToolContract;
  execute: (
    ctx: NonNullable<ReturnType<typeof resolveMemoryToolContext>>,
  ) => AnyAgentTool["execute"];
}): AnyAgentTool | null {
  const ctx = resolveMemoryToolContext(params.options);
  if (!ctx) {
    return null;
  }
  return {
    label: params.contract.label,
    name: params.contract.name,
    description: params.contract.describe(ctx.sources),
    parameters: params.contract.parameters,
    prepareArguments: params.contract.prepareArguments,
    execute: async (toolCallId, toolParams, signal, onUpdate) => {
      const latestCtx = params.options.getConfig ? resolveMemoryToolContext(params.options) : ctx;
      // A live getter makes missing or disabled current config a revocation.
      // The captured context is valid only for fixed-snapshot callers.
      if (!latestCtx) {
        throw new Error(
          "Memory is disabled for this agent. Enable memory search for this agent, then retry.",
        );
      }
      return await params.execute(latestCtx)(toolCallId, toolParams, signal, onUpdate);
    },
  };
}

export function buildMemorySearchUnavailableResult(
  error: string | undefined,
  overrides?: {
    warning?: string;
    action?: string;
    agentId?: string;
    deadline?: boolean;
    code?: string;
  },
) {
  const reason = (error ?? "memory search unavailable").trim() || "memory search unavailable";
  const normalizedReason = normalizeLowercaseStringOrEmpty(reason);
  const isQuotaError = /insufficient_quota|quota|429/.test(normalizedReason);
  const isMissingNodeSqlite = /missing node:sqlite|no such built-?in module: node:sqlite/.test(
    normalizedReason,
  );
  // Provenance from the deadline owner, never the message text: a provider
  // error can read exactly like this tool's timeout.
  const isSearchDeadline = overrides?.deadline === true;
  const deadlineAction = overrides?.agentId
    ? `Retry memory_search after a short wait: a memory-corpus timeout pauses retries for up to a minute. If memory-corpus timeouts persist, run: openclaw memory status --deep --agent ${overrides.agentId}, and rebuild with openclaw memory index --force --agent ${overrides.agentId} only if it reports the index dirty or incomplete`
    : "Retry memory_search after a short wait. If memory-corpus timeouts persist, inspect this agent's memory index before rebuilding it.";
  const [defaultWarning, defaultAction]: [string, string] =
    overrides?.code === SESSION_CANONICAL_KEY_MIGRATION_REQUIRED
      ? [SESSION_CANONICAL_KEY_MIGRATION_WARNING, SESSION_CANONICAL_KEY_MIGRATION_ACTION]
      : overrides?.code === "SQLITE_READONLY_WORKER_SCOPE_CLOSED"
        ? [
            "Memory search is unavailable because its storage scope closed.",
            "Run openclaw plugins reload memory-core, or restart the Gateway, then retry memory_search.",
          ]
        : isQuotaError
          ? [
              "Memory search is unavailable because the embedding provider quota is exhausted.",
              "Top up or switch embedding provider, then retry memory_search.",
            ]
          : isMissingNodeSqlite
            ? [
                "Memory search is unavailable because this OpenClaw Node runtime does not provide SQLite support.",
                "Run OpenClaw with a Node runtime that includes node:sqlite, then retry memory_search.",
              ]
            : isSearchDeadline
              ? ["Memory search did not finish within its time limit.", deadlineAction]
              : [
                  "Memory search is unavailable due to an embedding/provider error.",
                  "Check embedding provider configuration and retry memory_search.",
                ];
  const warning = overrides?.warning ?? defaultWarning;
  const action = overrides?.action ?? defaultAction;
  return {
    results: [],
    disabled: true,
    unavailable: true,
    ...(isSearchDeadline ? { timedOut: true, timeoutMs: DEFAULT_MEMORY_SEARCH_TIMEOUT_MS } : {}),
    error: reason,
    warning,
    action,
    debug: {
      warning,
      action,
      error: reason,
    },
  };
}
