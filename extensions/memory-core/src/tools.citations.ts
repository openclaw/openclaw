import { stripMemoryAnnotationCarriers } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  parseAgentSessionKey,
  type MemoryCitationsMode,
  type MemoryCorpusSearchResult,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import type { MemorySearchResult } from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

export type MemorySearchToolResult = MemorySearchResult | MemoryCorpusSearchResult;

export function resolveMemoryCitationsMode(cfg: OpenClawConfig): MemoryCitationsMode {
  const mode = cfg.memory?.citations;
  if (mode === "on" || mode === "off" || mode === "auto") {
    return mode;
  }
  return "auto";
}

export function buildMemorySearchPresentation(
  results: MemorySearchResult[],
  include: boolean,
): Map<MemorySearchToolResult, MemorySearchResult> {
  const presentation = new Map<MemorySearchToolResult, MemorySearchResult>();
  for (const entry of results) {
    const presented = {
      ...entry,
      corpus: entry.source,
      snippet: stripMemoryAnnotationCarriers(entry.snippet),
    };
    presented.citation = include ? formatCitation(presented) : undefined;
    if (include) {
      presented.snippet = `${presented.snippet.trimEnd()}\n\nSource: ${presented.citation}`;
    }
    presentation.set(entry, presented);
  }
  return presentation;
}

function formatCitation(entry: MemorySearchResult): string {
  const lineRange =
    entry.startLine === entry.endLine
      ? `#L${entry.startLine}`
      : `#L${entry.startLine}-L${entry.endLine}`;
  return `${entry.path}${lineRange}`;
}

export function shouldIncludeCitations(params: {
  mode: MemoryCitationsMode;
  sessionKey?: string;
}): boolean {
  if (params.mode === "on") {
    return true;
  }
  if (params.mode === "off") {
    return false;
  }
  return deriveChatTypeFromSessionKey(params.sessionKey) === "direct";
}

function deriveChatTypeFromSessionKey(sessionKey?: string): "direct" | "group" | "channel" {
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed?.rest) {
    return "direct";
  }
  const tokens = new Set(normalizeLowercaseStringOrEmpty(parsed.rest).split(":").filter(Boolean));
  if (tokens.has("channel")) {
    return "channel";
  }
  if (tokens.has("group")) {
    return "group";
  }
  return "direct";
}
