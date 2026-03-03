import {
  formatInboundFromLabel as formatInboundFromLabelShared,
  resolveThreadSessionKeys as resolveThreadSessionKeysShared,
  type BotConfig,
} from "bot/plugin-sdk";
export { createDedupeCache, rawDataToString } from "bot/plugin-sdk";

export type ResponsePrefixContext = {
  model?: string;
  modelFull?: string;
  provider?: string;
  thinkingLevel?: string;
  identityName?: string;
};

export function extractShortModelName(fullModel: string): string {
  const slash = fullModel.lastIndexOf("/");
  const modelPart = slash >= 0 ? fullModel.slice(slash + 1) : fullModel;
  return modelPart.replace(/-\d{8}$/, "").replace(/-latest$/, "");
}

export const formatInboundFromLabel = formatInboundFromLabelShared;

function normalizeAgentId(value: string | undefined | null): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) {
    return "main";
  }
  if (/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(trimmed)) {
    return trimmed;
  }
  return (
    trimmed
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+/, "")
      .replace(/-+$/, "")
      .slice(0, 64) || "main"
  );
}

type AgentEntry = NonNullable<NonNullable<BotConfig["agents"]>["list"]>[number];

function listAgents(cfg: BotConfig): AgentEntry[] {
  const list = cfg.agents?.list;
  if (!Array.isArray(list)) {
    return [];
  }
  return list.filter((entry): entry is AgentEntry => Boolean(entry && typeof entry === "object"));
}

function resolveAgentEntry(cfg: BotConfig, agentId: string): AgentEntry | undefined {
  const id = normalizeAgentId(agentId);
  return listAgents(cfg).find((entry) => normalizeAgentId(entry.id) === id);
}

export function resolveIdentityName(cfg: BotConfig, agentId: string): string | undefined {
  const entry = resolveAgentEntry(cfg, agentId);
  return entry?.identity?.name?.trim() || undefined;
}

export function resolveThreadSessionKeys(params: {
  baseSessionKey: string;
  threadId?: string | null;
  parentSessionKey?: string;
  useSuffix?: boolean;
}): { sessionKey: string; parentSessionKey?: string } {
  return resolveThreadSessionKeysShared({
    ...params,
    normalizeThreadId: (threadId) => threadId,
  });
}
