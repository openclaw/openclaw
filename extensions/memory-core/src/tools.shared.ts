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
  purpose?: "default" | "status" | "cli";
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
  const isQuotaError = /insufficient_quota|quota|429/.test(normalizeLowercaseStringOrEmpty(reason));
  const warning =
    overrides?.warning ??
    (isQuotaError
      ? "Memory search is unavailable because the embedding provider quota is exhausted."
      : "Memory search is unavailable due to an embedding/provider error.");
  const action =
    overrides?.action ??
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
    debug: {
      warning,
      action,
      error: reason,
    },
  };
}

const DEFAULT_SUPPLEMENT_SEARCH_TIMEOUT_MS = 10_000;

function resolveSupplementSearchTimeoutMs(): number {
  const raw = process.env.OPENCLAW_MEMORY_SUPPLEMENT_SEARCH_TIMEOUT_MS;
  if (typeof raw !== "string" || raw.length === 0) {
    return DEFAULT_SUPPLEMENT_SEARCH_TIMEOUT_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_SUPPLEMENT_SEARCH_TIMEOUT_MS;
  }
  return parsed;
}

export class SupplementSearchTimeoutError extends Error {
  constructor(pluginId: string, timeoutMs: number) {
    super(`supplement "${pluginId}" search did not settle within ${timeoutMs}ms`);
    this.name = "SupplementSearchTimeoutError";
  }
}

async function searchSupplementWithTimeout(
  pluginId: string,
  search: Promise<MemoryCorpusSearchResult[]>,
  timeoutMs: number,
): Promise<MemoryCorpusSearchResult[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race<MemoryCorpusSearchResult[]>([
      search,
      new Promise<MemoryCorpusSearchResult[]>((_, reject) => {
        timer = setTimeout(() => {
          reject(new SupplementSearchTimeoutError(pluginId, timeoutMs));
        }, timeoutMs);
        if (typeof timer?.unref === "function") {
          timer.unref();
        }
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
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
  // Use allSettled with a per-supplement timeout so a single misbehaving or
  // hung supplement does not discard sibling results or block the whole call
  // indefinitely. Invariant: result ⊇ ⋃_{s settles in time} s.search(params).
  const timeoutMs = resolveSupplementSearchTimeoutMs();
  const settled = await Promise.allSettled(
    supplements.map((registration) =>
      searchSupplementWithTimeout(
        registration.pluginId,
        Promise.resolve().then(() => registration.supplement.search(params)),
        timeoutMs,
      ),
    ),
  );
  const results: MemoryCorpusSearchResult[] = [];
  for (let i = 0; i < settled.length; i++) {
    const outcome = settled[i];
    if (outcome.status === "fulfilled") {
      results.push(...outcome.value);
    } else {
      const pluginId = supplements[i]?.pluginId ?? "<unknown>";
      console.warn(
        `memory-core: corpus supplement "${pluginId}" search failed; sibling results preserved (${formatSupplementError(outcome.reason)}).`,
      );
    }
  }
  return results
    .toSorted((left, right) => {
      if (left.score !== right.score) {
        return right.score - left.score;
      }
      return left.path.localeCompare(right.path);
    })
    .slice(0, Math.max(1, params.maxResults ?? 10));
}

function formatSupplementError(reason: unknown): string {
  if (reason instanceof Error) {
    return reason.message || reason.name || "Error";
  }
  if (typeof reason === "string") {
    return reason;
  }
  try {
    return JSON.stringify(reason);
  } catch {
    return String(reason);
  }
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
