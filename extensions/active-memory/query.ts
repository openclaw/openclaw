import {
  DEFAULT_PROVIDER,
  parseModelRef,
  resolveAgentEffectiveModelPrimary,
  resolveDefaultModelForAgent,
} from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { asOptionalObjectRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import {
  ACTIVE_MEMORY_CLOSE_TAG,
  ACTIVE_MEMORY_OPEN_TAG,
  ACTIVE_MEMORY_CONTEXT_HEADER,
  MAX_ACTIVE_MEMORY_SEARCH_QUERY_CHARS,
  RECALLED_CONTEXT_LINE_PATTERNS,
  type ActiveRecallRecentTurn,
  type ResolvedActiveRecallPluginConfig,
} from "./types.js";

export function buildQuery(params: {
  latestUserMessage: string;
  recentTurns?: ActiveRecallRecentTurn[];
  config: ResolvedActiveRecallPluginConfig;
}): string {
  const latest = params.latestUserMessage.trim();
  if (params.config.queryMode === "message") {
    return latest;
  }
  if (params.config.queryMode === "full") {
    const allTurns = (params.recentTurns ?? []).map(
      (turn) => `${turn.role}: ${turn.text.trim().replace(/\s+/g, " ")}`,
    );
    if (allTurns.length === 0) {
      return latest;
    }
    return ["Full conversation context:", ...allTurns, "", "Latest user message:", latest].join(
      "\n",
    );
  }
  const remaining = {
    user: params.config.recentUserTurns,
    assistant: params.config.recentAssistantTurns,
  };
  const selected: ActiveRecallRecentTurn[] = [];
  for (let index = (params.recentTurns ?? []).length - 1; index >= 0; index -= 1) {
    const turn = params.recentTurns?.[index];
    if (!turn || remaining[turn.role] <= 0) {
      continue;
    }
    remaining[turn.role] -= 1;
    selected.push({
      role: turn.role,
      text: truncateUtf16Safe(
        turn.text.trim().replace(/\s+/g, " "),
        turn.role === "user" ? params.config.recentUserChars : params.config.recentAssistantChars,
      ),
    });
  }
  const recentTurns = selected.toReversed().filter((turn) => turn.text.length > 0);
  if (recentTurns.length === 0) {
    return latest;
  }
  return [
    "Recent conversation tail:",
    ...recentTurns.map((turn) => `${turn.role}: ${turn.text}`),
    "",
    "Latest user message:",
    latest,
  ].join("\n");
}

function normalizeSearchQueryText(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) =>
        line &&
        line !== ACTIVE_MEMORY_CONTEXT_HEADER &&
        !/^(conversation info|sender|untrusted context)\b/i.test(line) &&
        !/^(source: external|---|untrusted discord message body)$/i.test(line) &&
        !/^⚠️?\s*Agent couldn't generate a response/i.test(line) &&
        !/^Please try again\.?$/i.test(line),
    )
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function clampSearchQuery(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > MAX_ACTIVE_MEMORY_SEARCH_QUERY_CHARS
    ? truncateUtf16Safe(normalized, MAX_ACTIVE_MEMORY_SEARCH_QUERY_CHARS).trim()
    : normalized;
}

export function buildSearchQuery(params: {
  latestUserMessage: string;
  recentTurns?: ActiveRecallRecentTurn[];
}): string {
  const latest = clampSearchQuery(
    normalizeSearchQueryText(
      params.latestUserMessage
        .replace(
          /<<<EXTERNAL_UNTRUSTED_CONTENT\b[^>]*>>>[\s\S]*?<<<END_EXTERNAL_UNTRUSTED_CONTENT\b[^>]*>>>/g,
          " ",
        )
        .replace(/```(?:json)?\s*[\s\S]*?```/gi, " ")
        .replace(/<active_memory_plugin>[\s\S]*?<\/active_memory_plugin>/gi, " "),
    ),
  );
  if (latest.length >= 12 || !params.recentTurns?.length) {
    return latest || clampSearchQuery(params.latestUserMessage);
  }
  const previousUser = params.recentTurns
    .toReversed()
    .find((turn) => turn.role === "user" && turn.text.trim() !== params.latestUserMessage.trim());
  if (!previousUser) {
    return latest || clampSearchQuery(params.latestUserMessage);
  }
  const context = truncateUtf16Safe(
    clampSearchQuery(normalizeSearchQueryText(stripRecalledContextNoise(previousUser.text))),
    120,
  ).trim();
  return clampSearchQuery(context ? `${context} ${latest}` : latest);
}

export function extractTextContentParts(content: unknown): string[] {
  if (typeof content === "string") {
    return content.trim() ? [content] : [];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  const parts: string[] = [];
  for (const item of content) {
    if (typeof item === "string") {
      parts.push(item);
      continue;
    }
    const typed = asOptionalObjectRecord(item);
    if (!typed) {
      continue;
    }
    if (typeof typed.text === "string") {
      parts.push(typed.text);
      continue;
    }
    if (typed.type === "text" && typeof typed.content === "string") {
      parts.push(typed.content);
    }
  }
  return parts.map((part) => part.trim()).filter(Boolean);
}

export function extractTextContent(content: unknown): string {
  return extractTextContentParts(content).join(" ").trim();
}

function stripRecalledContextNoise(text: string, injectedPrefixOnly = false): string {
  const lines = text.split("\n").map((line) => line.trim());
  const cleanedLines: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!line) {
      continue;
    }
    const blockStart = line === ACTIVE_MEMORY_CONTEXT_HEADER ? index + 1 : index;
    if (
      (!injectedPrefixOnly || line === ACTIVE_MEMORY_CONTEXT_HEADER) &&
      lines[blockStart] === ACTIVE_MEMORY_OPEN_TAG
    ) {
      const closeIndex = lines.indexOf(ACTIVE_MEMORY_CLOSE_TAG, blockStart + 1);
      if (closeIndex !== -1) {
        index = closeIndex;
        continue;
      }
    }
    if (
      !injectedPrefixOnly &&
      (line === ACTIVE_MEMORY_CONTEXT_HEADER ||
        line === ACTIVE_MEMORY_CLOSE_TAG ||
        RECALLED_CONTEXT_LINE_PATTERNS.some((pattern) => pattern.test(line)))
    ) {
      continue;
    }
    cleanedLines.push(line);
  }
  return cleanedLines.join(" ").replace(/\s+/g, " ").trim();
}

export function extractRecentTurns(messages: unknown[]): ActiveRecallRecentTurn[] {
  const turns: ActiveRecallRecentTurn[] = [];
  for (const message of messages) {
    const typed = asOptionalObjectRecord(message);
    if (!typed) {
      continue;
    }
    const role = typed.role === "user" || typed.role === "assistant" ? typed.role : undefined;
    if (!role) {
      continue;
    }
    const rawText = extractTextContent(typed.content);
    const text = stripRecalledContextNoise(rawText, role === "user");
    if (!text) {
      continue;
    }
    turns.push({ role, text });
  }
  return turns;
}

export function getModelRef(
  runtimeConfig: OpenClawConfig,
  agentId: string,
  config: ResolvedActiveRecallPluginConfig,
  ctx?: {
    modelProviderId?: string;
    modelId?: string;
  },
): { provider: string; model: string } | undefined {
  const currentRunModel =
    ctx?.modelProviderId && ctx?.modelId ? `${ctx.modelProviderId}/${ctx.modelId}` : undefined;
  const configuredDefaultModel = resolveAgentEffectiveModelPrimary(runtimeConfig, agentId)
    ? resolveDefaultModelForAgent({ cfg: runtimeConfig, agentId })
    : undefined;
  const defaultProvider = configuredDefaultModel?.provider ?? DEFAULT_PROVIDER;
  const candidates = [
    config.model,
    currentRunModel,
    configuredDefaultModel
      ? `${configuredDefaultModel.provider}/${configuredDefaultModel.model}`
      : undefined,
    config.modelFallback,
  ];
  for (const candidate of candidates) {
    if (candidate) {
      return (
        parseModelRef(candidate, defaultProvider) ?? { provider: defaultProvider, model: candidate }
      );
    }
  }
  return undefined;
}
