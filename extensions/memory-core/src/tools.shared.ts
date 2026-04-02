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
  return await getMemoryManagerContextWithPurpose({ ...params, purpose: undefined });
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

export function buildMemorySearchUnavailableResult(error: string | undefined) {
  const reason = (error ?? "memory search unavailable").trim() || "memory search unavailable";
  const lowerReason = reason.toLowerCase();
  const isQuotaError = /insufficient_quota|quota|429/.test(lowerReason);
  const isSqliteError = /node:sqlite|missing.*sqlite|sqlite.*unavailable/.test(lowerReason);

  let warning: string;
  let action: string;
  if (isQuotaError) {
    warning = "Memory search is unavailable because the embedding provider quota is exhausted.";
    action = "Top up or switch embedding provider, then retry memory_search.";
  } else if (isSqliteError) {
    warning = "Memory search is unavailable because the Node.js runtime is missing node:sqlite support.";
    action = "Upgrade to Node.js 22.5.0+ (which includes node:sqlite) or use a Node build with SQLite enabled, then restart OpenClaw.";
  } else {
    warning = "Memory search is unavailable due to an embedding/provider error.";
    action = "Check embedding provider configuration and retry memory_search.";
  }

  return {
    results: [],
    disabled: true,
    unavailable: true,
    error: reason,
    warning,
    action,
  };
}
