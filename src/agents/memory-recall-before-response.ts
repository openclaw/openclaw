import type { OpenClawConfig } from "../config/config.js";
import { getMemorySearchManager } from "../memory/index.js";
import type { MemorySearchResult } from "../memory/types.js";
import {
  resolveMemoryRecallBeforeResponseConfig,
  resolveMemorySearchConfig,
} from "./memory-search.js";

const RECALL_HEADER = [
  "[Runtime-Enforced Memory Recall]",
  "Apply recalled memory snippets below before generating your response.",
].join("\n");

export type MemoryRecallBeforeResponseResult = {
  enabled: boolean;
  enforced: boolean;
  checked: boolean;
  injected: boolean;
  systemPromptAddition?: string;
  error?: string;
};

export async function buildMemoryRecallBeforeResponse(params: {
  config?: OpenClawConfig;
  agentId: string;
  sessionKey?: string;
  prompt: string;
}): Promise<MemoryRecallBeforeResponseResult> {
  if (!params.config) {
    return {
      enabled: false,
      enforced: false,
      checked: false,
      injected: false,
    };
  }

  const recall = resolveMemoryRecallBeforeResponseConfig(params.config, params.agentId);
  if (!recall.enabled) {
    return {
      enabled: false,
      enforced: false,
      checked: false,
      injected: false,
    };
  }

  let resolved: ReturnType<typeof resolveMemorySearchConfig> = null;
  try {
    resolved = resolveMemorySearchConfig(params.config, params.agentId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      enabled: true,
      enforced: recall.mode === "enforce",
      checked: false,
      injected: false,
      error: message.trim() || "memory search config invalid",
    };
  }
  if (!resolved) {
    return {
      enabled: true,
      enforced: recall.mode === "enforce",
      checked: false,
      injected: false,
      error: "memory_search_disabled",
    };
  }

  const query = params.prompt.trim();
  if (!query) {
    return {
      enabled: true,
      enforced: recall.mode === "enforce",
      checked: false,
      injected: false,
      error: "empty_prompt",
    };
  }

  const { manager, error } = await getMemorySearchManager({
    cfg: params.config,
    agentId: params.agentId,
  });
  if (!manager) {
    return {
      enabled: true,
      enforced: recall.mode === "enforce",
      checked: false,
      injected: false,
      error: (error ?? "memory search unavailable").trim() || "memory search unavailable",
    };
  }

  try {
    const results = await manager.search(query, {
      maxResults: recall.maxResults,
      minScore: recall.minScore,
      sessionKey: params.sessionKey,
    });
    const systemPromptAddition = buildRecallSystemPromptAddition({
      results,
      maxChars: recall.maxChars,
    });

    return {
      enabled: true,
      enforced: recall.mode === "enforce",
      checked: true,
      injected: Boolean(systemPromptAddition),
      systemPromptAddition,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      enabled: true,
      enforced: recall.mode === "enforce",
      checked: false,
      injected: false,
      error: message.trim() || "memory recall failed",
    };
  }
}

export function buildRecallSystemPromptAddition(params: {
  results: MemorySearchResult[];
  maxChars: number;
}): string | undefined {
  if (!params.results.length || params.maxChars <= RECALL_HEADER.length + 16) {
    return undefined;
  }

  let out = `${RECALL_HEADER}\n`;
  let includedEntries = 0;
  for (const [index, entry] of params.results.entries()) {
    const citation = formatCitation(entry);
    const snippet = normalizeSnippet(entry.snippet);
    if (!snippet) {
      continue;
    }

    const itemPrefix = `${index + 1}. ${citation} (score ${entry.score.toFixed(2)})\n`;
    const nextChunk = `${itemPrefix}${snippet}\n\n`;
    if (out.length + nextChunk.length <= params.maxChars) {
      out += nextChunk;
      includedEntries += 1;
      continue;
    }

    const remaining = params.maxChars - out.length - itemPrefix.length - 4;
    if (remaining <= 8) {
      break;
    }
    const truncated = `${snippet.slice(0, remaining).trimEnd()}...`;
    out += `${itemPrefix}${truncated}\n`;
    includedEntries += 1;
    break;
  }

  return includedEntries > 0 ? out.trimEnd() : undefined;
}

function normalizeSnippet(snippet: string): string {
  return snippet.replace(/\s+/g, " ").trim();
}

function formatCitation(entry: MemorySearchResult): string {
  const lineRange =
    entry.startLine === entry.endLine
      ? `#L${entry.startLine}`
      : `#L${entry.startLine}-L${entry.endLine}`;
  return `${entry.path}${lineRange}`;
}
