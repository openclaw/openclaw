/**
 * Keyword Context Injector
 *
 * Injects reference documents into agent context when the user's message
 * contains matching keywords. Documents are loaded on-demand with TTL-based
 * unloading — if the keyword isn't mentioned for N turns, the document is
 * removed from context. This replaces static boot-time loading with surgical,
 * conversation-driven context injection.
 *
 * Configuration:
 *   mapPath         — path to keyword-map.json (default: {workspaceDir}/keyword-map.json)
 *   docsRoot        — root directory for reference docs (default: workspaceDir)
 *   maxTotalChars   — budget cap for injected content (~15K tokens at 60K chars)
 *   maxConcurrentDocs — max documents injected per turn
 *   mapReloadMs     — how often to check for map changes
 *
 * Keyword map format (keyword-map.json):
 *   {
 *     "entries": [
 *       {
 *         "id": "project-x",
 *         "keywords": ["project x", "projectx"],
 *         "path": "docs/project-x.md",
 *         "ttlTurns": 10,
 *         "maxChars": 5000,
 *         "priority": 5
 *       }
 *     ]
 *   }
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import fs from "node:fs";
import path from "node:path";

// ── Types ──────────────────────────────────────────────────────────────

interface KeywordEntry {
  id: string;
  keywords: string[];
  path: string;
  ttlTurns: number;
  maxChars: number;
  priority: number;
}

interface KeywordMap {
  entries: KeywordEntry[];
}

interface ActiveInjection {
  entry: KeywordEntry;
  remainingTurns: number;
  content: string;
}

interface PluginConfig {
  mapPath?: string;
  docsRoot?: string;
  maxTotalChars?: number;
  maxConcurrentDocs?: number;
  mapReloadMs?: number;
}

// ── Plugin ─────────────────────────────────────────────────────────────

export default function register(api: OpenClawPluginApi) {
  const config = (api.config ?? {}) as PluginConfig;
  const workspaceDir = api.workspaceDir ?? process.cwd();

  const mapPath = config.mapPath
    ? path.resolve(workspaceDir, config.mapPath)
    : path.join(workspaceDir, "keyword-map.json");

  const docsRoot = config.docsRoot
    ? path.resolve(workspaceDir, config.docsRoot)
    : workspaceDir;

  const maxTotalChars = config.maxTotalChars ?? 60_000;
  const maxConcurrentDocs = config.maxConcurrentDocs ?? 5;
  const mapReloadMs = config.mapReloadMs ?? 60_000;

  // ── State ──────────────────────────────────────────────────────────

  let keywordMap: KeywordMap = { entries: [] };
  let mapLastLoaded = 0;
  const sessionState = new Map<string, Map<string, ActiveInjection>>();

  // ── Helpers ────────────────────────────────────────────────────────

  function loadMap(): void {
    if (Date.now() - mapLastLoaded < mapReloadMs && keywordMap.entries.length > 0) {
      return;
    }
    try {
      if (!fs.existsSync(mapPath)) {
        return;
      }
      const raw = fs.readFileSync(mapPath, "utf-8");
      const parsed = JSON.parse(raw) as KeywordMap;
      if (Array.isArray(parsed.entries)) {
        keywordMap = parsed;
        mapLastLoaded = Date.now();
      }
    } catch {
      // Non-fatal — keep existing map
    }
  }

  function buildRegex(keyword: string): RegExp {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escaped}\\b`, "i");
  }

  function findMatches(text: string): KeywordEntry[] {
    const matched: KeywordEntry[] = [];
    for (const entry of keywordMap.entries) {
      for (const kw of entry.keywords) {
        if (buildRegex(kw).test(text)) {
          matched.push(entry);
          break;
        }
      }
    }
    return matched;
  }

  function readDoc(entry: KeywordEntry): string | null {
    try {
      const fullPath = path.resolve(docsRoot, entry.path);
      // Security: ensure the resolved path stays within docsRoot
      if (!fullPath.startsWith(docsRoot)) {
        api.logger.warn(`[keyword-context] path traversal blocked: ${entry.path}`);
        return null;
      }
      if (!fs.existsSync(fullPath)) {
        return null;
      }
      const content = fs.readFileSync(fullPath, "utf-8");
      if (content.length > entry.maxChars) {
        return (
          content.substring(0, entry.maxChars) +
          `\n\n[... truncated at ${entry.maxChars} chars]`
        );
      }
      return content;
    } catch {
      return null;
    }
  }

  function getInjections(sessionKey: string): Map<string, ActiveInjection> {
    let injections = sessionState.get(sessionKey);
    if (!injections) {
      injections = new Map();
      sessionState.set(sessionKey, injections);
    }
    return injections;
  }

  function enforceBudget(injections: Map<string, ActiveInjection>): void {
    // Phase 1: cap concurrent docs
    while (injections.size > maxConcurrentDocs) {
      const lowest = findLowestPriority(injections);
      if (!lowest) break;
      injections.delete(lowest);
    }

    // Phase 2: cap total chars
    let totalChars = 0;
    for (const inj of injections.values()) {
      totalChars += inj.content.length;
    }
    while (totalChars > maxTotalChars && injections.size > 0) {
      const lowest = findLowestPriority(injections);
      if (!lowest) break;
      const evicted = injections.get(lowest);
      if (evicted) {
        totalChars -= evicted.content.length;
      }
      injections.delete(lowest);
    }
  }

  function findLowestPriority(injections: Map<string, ActiveInjection>): string | null {
    let lowestKey: string | null = null;
    let lowestPriority = Infinity;
    let lowestTTL = Infinity;
    for (const [key, inj] of injections) {
      if (
        inj.entry.priority < lowestPriority ||
        (inj.entry.priority === lowestPriority && inj.remainingTurns < lowestTTL)
      ) {
        lowestKey = key;
        lowestPriority = inj.entry.priority;
        lowestTTL = inj.remainingTurns;
      }
    }
    return lowestKey;
  }

  function extractUserText(messages: Array<{ role: string; content: unknown }>): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role !== "user") continue;
      const content = messages[i].content;
      if (typeof content === "string") return content;
      if (Array.isArray(content)) {
        return content
          .filter((c: { type?: string }) => c.type === "text")
          .map((c: { text?: string }) => c.text ?? "")
          .join(" ");
      }
    }
    return "";
  }

  // ── Initial load ──────────────────────────────────────────────────

  loadMap();
  if (keywordMap.entries.length > 0) {
    api.logger.info(
      `[keyword-context] Loaded ${keywordMap.entries.length} keyword entries from ${mapPath}`,
    );
  } else {
    api.logger.info(
      `[keyword-context] No keyword map found at ${mapPath} — create one to enable context injection`,
    );
  }

  // ── Hook: before_prompt_build ─────────────────────────────────────

  api.on(
    "before_prompt_build",
    (event: { sessionKey?: string; messages?: Array<{ role: string; content: unknown }> }) => {
      loadMap();
      if (keywordMap.entries.length === 0) return {};

      const sessionKey = event.sessionKey ?? "default";
      const messages = event.messages ?? [];
      const userText = extractUserText(messages);
      if (!userText) return {};

      const injections = getInjections(sessionKey);
      const matched = findMatches(userText);

      // Update TTLs: refresh matched, decrement unmatched
      for (const [key, inj] of injections) {
        const isMatched = matched.some((m) => m.id === key);
        if (isMatched) {
          inj.remainingTurns = inj.entry.ttlTurns;
        } else {
          inj.remainingTurns--;
          if (inj.remainingTurns <= 0) {
            injections.delete(key);
          }
        }
      }

      // Add new matches
      for (const entry of matched) {
        if (!injections.has(entry.id)) {
          const content = readDoc(entry);
          if (content) {
            injections.set(entry.id, {
              entry,
              remainingTurns: entry.ttlTurns,
              content,
            });
          }
        }
      }

      enforceBudget(injections);

      if (injections.size === 0) return {};

      // Build context block
      const parts: string[] = [
        "## Keyword-Injected Reference Context",
        "*Loaded on keyword match. Auto-unloads after turns of non-mention.*\n",
      ];

      const sorted = [...injections.values()].sort(
        (a, b) => b.entry.priority - a.entry.priority,
      );

      for (const inj of sorted) {
        parts.push(`### [${inj.entry.id}] (TTL: ${inj.remainingTurns} turns)`);
        parts.push(inj.content);
        parts.push("");
      }

      return { prependContext: parts.join("\n") };
    },
  );
}
