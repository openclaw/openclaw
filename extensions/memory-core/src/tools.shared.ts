// Memory Core plugin module implements tools.shared behavior.
import { optionalFiniteNumberSchema, stringEnum } from "openclaw/plugin-sdk/channel-actions";
import {
  listMemoryCorpusSupplements,
  resolveMemorySearchConfig,
  resolveSessionAgentIds,
  type MemoryCorpusSearchResult,
  type AnyAgentTool,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { Type } from "typebox";

type MemoryToolRuntime = typeof import("./tools.runtime.js");
type MemorySearchManagerResult = Awaited<
  ReturnType<(typeof import("./memory/index.js"))["getMemorySearchManager"]>
>;
type MemoryToolOptions = {
  config?: OpenClawConfig;
  getConfig?: () => OpenClawConfig | undefined;
  agentId?: string;
  agentSessionKey?: string;
  oneShotCliRun?: boolean;
};

let memoryToolRuntimePromise: Promise<MemoryToolRuntime> | null = null;

export async function loadMemoryToolRuntime(): Promise<MemoryToolRuntime> {
  memoryToolRuntimePromise ??= import("./tools.runtime.js");
  return await memoryToolRuntimePromise;
}

export const MemorySearchSchema = Type.Object({
  query: Type.String(),
  maxResults: Type.Optional(Type.Integer({ minimum: 1 })),
  minScore: optionalFiniteNumberSchema(),
  corpus: Type.Optional(stringEnum(["memory", "wiki", "all", "sessions"])),
});

export const MemoryGetSchema = Type.Object({
  path: Type.String(),
  from: Type.Optional(Type.Integer()),
  lines: Type.Optional(Type.Integer()),
  corpus: Type.Optional(stringEnum(["memory", "wiki", "all"])),
});

function resolveMemoryToolContext(options: MemoryToolOptions) {
  const cfg = options.getConfig?.() ?? options.config;
  if (!cfg) {
    return null;
  }
  const { sessionAgentId: agentId } = resolveSessionAgentIds({
    sessionKey: options.agentSessionKey,
    config: cfg,
    agentId: options.agentId,
  });
  if (!resolveMemorySearchConfig(cfg, agentId)) {
    return null;
  }
  return { cfg, agentId };
}

export async function getMemoryManagerContextWithPurpose(params: {
  cfg: OpenClawConfig;
  agentId: string;
  purpose?: "default" | "status" | "cli";
}): Promise<
  | {
      manager: NonNullable<MemorySearchManagerResult["manager"]>;
<<<<<<< HEAD
      debug?: NonNullable<MemorySearchManagerResult["debug"]>;
=======
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
    }
  | {
      error: string | undefined;
    }
> {
  const { getMemorySearchManager } = await loadMemoryToolRuntime();
<<<<<<< HEAD
  const startedAt = Date.now();
  const { manager, debug, error } = await getMemorySearchManager({
=======
  const { manager, error } = await getMemorySearchManager({
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
    cfg: params.cfg,
    agentId: params.agentId,
    purpose: params.purpose,
  });
<<<<<<< HEAD
  return manager
    ? {
        manager,
        debug: {
          ...debug,
          managerMs: debug?.managerMs ?? Math.max(0, Date.now() - startedAt),
        },
      }
    : { error };
=======
  return manager ? { manager } : { error };
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
}

export function createMemoryTool(params: {
  options: MemoryToolOptions;
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
    execute: async (toolCallId, toolParams) => {
      const latestCtx = resolveMemoryToolContext(params.options) ?? ctx;
      return await params.execute(latestCtx)(toolCallId, toolParams);
    },
  };
}

export function buildMemorySearchUnavailableResult(
  error: string | undefined,
  overrides?: {
    warning?: string;
    action?: string;
  },
) {
  const reason = (error ?? "memory search unavailable").trim() || "memory search unavailable";
<<<<<<< HEAD
  const normalizedReason = normalizeLowercaseStringOrEmpty(reason);
  const isQuotaError = /insufficient_quota|quota|429/.test(normalizedReason);
  const isMissingNodeSqlite = /missing node:sqlite|no such built-?in module: node:sqlite/.test(
    normalizedReason,
  );
=======
  const isQuotaError = /insufficient_quota|quota|429/.test(normalizeLowercaseStringOrEmpty(reason));
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  const warning =
    overrides?.warning ??
    (isQuotaError
      ? "Memory search is unavailable because the embedding provider quota is exhausted."
<<<<<<< HEAD
      : isMissingNodeSqlite
        ? "Memory search is unavailable because this OpenClaw Node runtime does not provide SQLite support."
        : "Memory search is unavailable due to an embedding/provider error.");
=======
      : "Memory search is unavailable due to an embedding/provider error.");
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  const action =
    overrides?.action ??
    (isQuotaError
      ? "Top up or switch embedding provider, then retry memory_search."
<<<<<<< HEAD
      : isMissingNodeSqlite
        ? "Run OpenClaw with a Node runtime that includes node:sqlite, then retry memory_search."
        : "Check embedding provider configuration and retry memory_search.");
=======
      : "Check embedding provider configuration and retry memory_search.");
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  return {
    results: [],
    disabled: true,
    unavailable: true,
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

export async function searchMemoryCorpusSupplements(params: {
  query: string;
  maxResults?: number;
  agentSessionKey?: string;
  corpus?: "memory" | "wiki" | "all" | "sessions";
}): Promise<MemoryCorpusSearchResult[]> {
  if (params.corpus === "memory" || params.corpus === "sessions") {
    return [];
  }
  const supplements = listMemoryCorpusSupplements();
  if (supplements.length === 0) {
    return [];
  }
  const results = (
    await Promise.all(
      supplements.map(async (registration) => await registration.supplement.search(params)),
    )
  ).flat();
  return results
    .toSorted((left, right) => {
      if (left.score !== right.score) {
        return right.score - left.score;
      }
      return left.path.localeCompare(right.path);
    })
    .slice(0, Math.max(1, params.maxResults ?? 10));
}

export async function getMemoryCorpusSupplementResult(params: {
  lookup: string;
  fromLine?: number;
  lineCount?: number;
  agentSessionKey?: string;
  corpus?: "memory" | "wiki" | "all" | "sessions";
}) {
  if (params.corpus === "memory" || params.corpus === "sessions") {
    return null;
  }
  for (const registration of listMemoryCorpusSupplements()) {
    const result = await registration.supplement.get(params);
    if (result) {
      return result;
    }
  }
  return null;
}
