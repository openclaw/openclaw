import { Type } from "@sinclair/typebox";
import {
  extractUserIdFromSessionKey,
  listMemoryCorpusSupplements,
  parseAgentSessionKey,
  resolveMemorySearchConfig,
  resolveSessionAgentId,
  type MemoryCorpusGetResult,
  type MemoryCorpusSearchResult,
  type AnyAgentTool,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";

const VALID_PLATFORMS = new Set([
  "discord",
  "telegram",
  "whatsapp",
  "signal",
  "slack",
  "msteams",
  "webchat",
  "line",
  "kakaotalk",
  "zalo",
  "matrix",
  "mattermost",
  "irc",
  "feishu",
  "googlechat",
  "nextcloud-talk",
  "nostr",
  "synology-chat",
  "tlon",
  "twitch",
  "imessage",
]);

function extractPlatformFromSessionKey(sessionKey: string | undefined | null): string | null {
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed?.rest) {
    return null;
  }
  const tokens = parsed.rest.split(":").filter(Boolean);
  const firstToken = tokens[0];
  if (!firstToken) {
    return null;
  }
  const baseName = firstToken.replace(/-dev$/, "");
  if (VALID_PLATFORMS.has(baseName)) {
    return firstToken;
  }
  return null;
}

function addPlatformPrefixToSenderId(params: {
  senderId: string | undefined | null;
  sessionKey: string | undefined | null;
}): string | undefined {
  const { senderId, sessionKey } = params;
  if (!senderId) {
    return undefined;
  }
  const prefixMatch = senderId.match(/^([a-z0-9-]+):(.+)$/i);
  if (prefixMatch) {
    const [, prefix, id] = prefixMatch;
    const baseName = prefix.replace(/-dev$/, "");
    if (VALID_PLATFORMS.has(baseName.toLowerCase())) {
      return senderId;
    }
    return id ? `${prefix.toLowerCase()}:${id}` : senderId;
  }
  const platform = extractPlatformFromSessionKey(sessionKey);
  if (platform) {
    return `${platform}:${senderId}`;
  }
  return senderId;
}

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
  corpus: Type.Optional(
    Type.Union([Type.Literal("memory"), Type.Literal("wiki"), Type.Literal("all")]),
  ),
});

export const MemoryGetSchema = Type.Object({
  path: Type.String(),
  from: Type.Optional(Type.Number()),
  lines: Type.Optional(Type.Number()),
  corpus: Type.Optional(
    Type.Union([Type.Literal("memory"), Type.Literal("wiki"), Type.Literal("all")]),
  ),
});

export function resolveMemoryToolContext(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
  senderId?: string;
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
  const rawUserId = extractUserIdFromSessionKey(options.agentSessionKey);
  const userId = rawUserId
    ? addPlatformPrefixToSenderId({
        senderId: rawUserId,
        sessionKey: options.agentSessionKey,
      })
    : options.senderId
      ? addPlatformPrefixToSenderId({
          senderId: options.senderId,
          sessionKey: options.agentSessionKey,
        })
      : undefined;
  return { cfg, agentId, userId };
}

export async function getMemoryManagerContext(params: {
  cfg: OpenClawConfig;
  agentId: string;
  userId?: string;
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
  userId?: string;
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
    userId: params.userId,
    purpose: params.purpose,
  });
  return manager ? { manager } : { error };
}

export function createMemoryTool(params: {
  options: {
    config?: OpenClawConfig;
    agentSessionKey?: string;
    senderId?: string;
  };
  label: string;
  name: string;
  description: string;
  parameters: typeof MemorySearchSchema | typeof MemoryGetSchema;
  execute: (ctx: {
    cfg: OpenClawConfig;
    agentId: string;
    userId?: string;
  }) => AnyAgentTool["execute"];
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
  const isQuotaError = /insufficient_quota|quota|429/.test(normalizeLowercaseStringOrEmpty(reason));
  const warning = isQuotaError
    ? "Memory search is unavailable because the embedding provider quota is exhausted."
    : "Memory search is unavailable due to an embedding/provider error.";
  const action = isQuotaError
    ? "Top up or switch embedding provider, then retry memory_search."
    : "Check embedding provider configuration and retry memory_search.";
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
  corpus?: "memory" | "wiki" | "all";
}): Promise<MemoryCorpusSearchResult[]> {
  if (params.corpus === "memory") {
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
  corpus?: "memory" | "wiki" | "all";
}): Promise<MemoryCorpusGetResult | null> {
  if (params.corpus === "memory") {
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
