import { Type } from "@sinclair/typebox";
import {
  resolveMemorySearchConfig,
  resolveSessionAgentId,
  type AnyAgentTool,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";

type MemoryToolRuntime = typeof import("./tools.runtime.js");
type MemorySearchManagerResult = Awaited<
  ReturnType<(typeof import("./memory/index.js"))["getMemorySearchManager"]>
>;

let memoryToolRuntimePromise: Promise<MemoryToolRuntime> | null = null;

export async function loadMemoryToolRuntime(): Promise<MemoryToolRuntime> {
  memoryToolRuntimePromise ??= import("./tools.runtime.js");
  return await memoryToolRuntimePromise;
}

export const MemorySearchSchema = Type.Object({
  query: Type.String(),
  maxResults: Type.Optional(Type.Number()),
  minScore: Type.Optional(Type.Number()),
});

export const MemoryGetSchema = Type.Object({
  path: Type.String(),
  from: Type.Optional(Type.Number()),
  lines: Type.Optional(Type.Number()),
});

export function resolveMemoryToolContext(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}) {
  const cfg = options.config;
  if (!cfg) {
    return null;
  }
  const agentId = resolveSessionAgentId({
    sessionKey: options.agentSessionKey,
    config: cfg,
  });
  if (!resolveMemorySearchConfig(cfg, agentId)) {
    return null;
  }
  return { cfg, agentId };
}

export async function getMemoryManagerContext(params: {
  cfg: OpenClawConfig;
  agentId: string;
}): Promise<
  | {
      manager: NonNullable<MemorySearchManagerResult["manager"]>;
    }
  | {
      error: string | undefined;
    }
> {
  return await getMemoryManagerContextWithPurpose({
    ...params,
    purpose: undefined,
  });
}

export async function getMemoryManagerContextWithPurpose(params: {
  cfg: OpenClawConfig;
  agentId: string;
  purpose?: "default" | "status";
}): Promise<
  | {
      manager: NonNullable<MemorySearchManagerResult["manager"]>;
    }
  | {
      error: string | undefined;
    }
> {
  const { getMemorySearchManager } = await loadMemoryToolRuntime();
  const { manager, error } = await getMemorySearchManager({
    cfg: params.cfg,
    agentId: params.agentId,
    purpose: params.purpose,
  });
  return manager ? { manager } : { error };
}

export function createMemoryTool(params: {
  options: {
    config?: OpenClawConfig;
    agentSessionKey?: string;
  };
  label: string;
  name: string;
  description: string;
  parameters: typeof MemorySearchSchema | typeof MemoryGetSchema;
  execute: (ctx: { cfg: OpenClawConfig; agentId: string }) => AnyAgentTool["execute"];
}): AnyAgentTool | null {
  const ctx = resolveMemoryToolContext(params.options);
  if (!ctx) {
    return null;
  }
  return {
    label: params.label,
    name: params.name,
    description: params.description,
    parameters: params.parameters,
    execute: params.execute(ctx),
  };
}

/**
 * Detect the kind of embedding error from an error message.
 * Shared utility to prevent drift between tool and CLI error handling.
 */
function resolveEmbeddingErrorKind(
  error: string | undefined,
): "leaked" | "quota" | "invalid_key" | null {
  if (!error) {
    return null;
  }
  const lower = error.toLowerCase();

  // Leaked key detection
  if (lower.includes("leaked")) {
    return "leaked";
  }

  // Quota/rate limit exhaustion
  if (lower.includes("quota") || lower.includes("rate limit") || lower.includes("429")) {
    return "quota";
  }

  // Invalid/unauthorized key
  if (
    lower.includes("401") ||
    lower.includes("unauthorized") ||
    lower.includes("invalid key") ||
    lower.includes("invalid_key")
  ) {
    return "invalid_key";
  }

  return null;
}

/**
 * Return actionable remediation hint for common embedding errors.
 * Helps users/agents fix broken memory search without reading source code.
 */
function resolveEmbeddingErrorHint(error: string | undefined): string | undefined {
  const kind = resolveEmbeddingErrorKind(error);

  switch (kind) {
    case "leaked":
      return "The embedding API key was flagged as leaked by the provider. Generate a new key, update it via `openclaw configure`, and restart the gateway.";
    case "quota":
      return "Embedding provider quota exhausted. Wait and retry, or switch provider via `openclaw configure`.";
    case "invalid_key":
      return "API key is invalid or expired. Update it via `openclaw configure`.";
    default:
      return undefined;
  }
}

export function buildMemorySearchUnavailableResult(error: string | undefined) {
  const reason = (error ?? "memory search unavailable").trim() || "memory search unavailable";
  // Use resolveEmbeddingErrorKind for consistent classification across warning and action
  const kind = resolveEmbeddingErrorKind(reason);
  const isQuotaError = kind === "quota";
  const warning = isQuotaError
    ? "Memory search is unavailable because the embedding provider quota is exhausted."
    : "Memory search is unavailable due to an embedding/provider error.";
  const hint = resolveEmbeddingErrorHint(reason);
  const action =
    hint ||
    (isQuotaError
      ? "Top up or switch embedding provider, then retry memory_search."
      : "Check embedding provider configuration and retry memory_search.");
  return {
    results: [],
    disabled: true,
    unavailable: true,
    error: reason,
    warning,
    action,
  };
}
