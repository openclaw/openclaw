import { createSubsystemLogger } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import type {
  MemoryEmbeddingProbeResult,
  MemoryProviderStatus,
  MemorySearchManager,
  MemorySearchResult,
  MemorySyncProgressUpdate,
  ResolvedHybridConfig,
  ResolvedHybridRouteRule,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";

const log = createSubsystemLogger("memory");

type ConversationCaptureManager = MemorySearchManager & {
  captureConversation?: (params: { sessionKey?: string; messages: unknown[] }) => Promise<void>;
};

type RouteScope = "read" | "write";
type RouteSource = "query" | "conversation" | "knowledge";
type RoutePriority = "normal" | "critical";
type RouteTarget = "qmd" | "mem0" | "both";

function normalizeText(input: string): string {
  return input.trim().toLowerCase();
}

function tokenize(input: string): string[] {
  return Array.from(
    new Set(
      input
        .toLowerCase()
        .split(/[\s,.;:!?()[\]{}"'`，。！？、]+/g)
        .map((token) => token.trim())
        .filter(Boolean),
    ),
  );
}

function mergeUniqueResults(params: {
  groups: MemorySearchResult[][];
  maxResults: number;
  dedupe: boolean;
}): MemorySearchResult[] {
  const output: MemorySearchResult[] = [];
  const seen = new Set<string>();
  for (const group of params.groups) {
    for (const entry of group) {
      const key = `${entry.path}\u0000${entry.startLine}\u0000${entry.endLine}\u0000${entry.snippet}`;
      if (params.dedupe && seen.has(key)) {
        continue;
      }
      seen.add(key);
      output.push(entry);
      if (output.length >= params.maxResults) {
        return output;
      }
    }
  }
  return output;
}

export class HybridMemoryManager implements MemorySearchManager {
  constructor(
    private readonly deps: {
      config: ResolvedHybridConfig;
      qmd: MemorySearchManager | null;
      mem0: ConversationCaptureManager | null;
      fallback: MemorySearchManager | null;
    },
  ) {}

  async search(
    query: string,
    opts?: { maxResults?: number; minScore?: number; sessionKey?: string },
  ): Promise<MemorySearchResult[]> {
    const trimmed = query.trim();
    if (!trimmed) {
      return [];
    }
    const priority: RoutePriority = /critical|urgent|緊急|重要/.test(trimmed.toLowerCase())
      ? "critical"
      : "normal";
    const target = this.resolveTarget({
      scope: "read",
      source: "query",
      priority,
      text: trimmed,
      tags: tokenize(trimmed),
      fallbackTarget: "both",
    });
    const requestedMax = opts?.maxResults ?? this.deps.config.maxResults;
    const maxResults = Math.max(1, Math.floor(requestedMax));
    if (target === "mem0") {
      return await this.runSingleSearch("mem0", trimmed, { ...opts, maxResults });
    }
    if (target === "qmd") {
      return await this.runSingleSearch("qmd", trimmed, { ...opts, maxResults });
    }
    const groups: MemorySearchResult[][] = [];
    for (const backend of this.deps.config.readOrder) {
      const results = await this.runSingleSearch(backend, trimmed, { ...opts, maxResults });
      groups.push(results);
    }
    if (this.deps.fallback && groups.every((group) => group.length === 0)) {
      groups.push(await this.deps.fallback.search(trimmed, { ...opts, maxResults }));
    }
    return mergeUniqueResults({
      groups,
      maxResults,
      dedupe: this.deps.config.dedupe,
    });
  }

  async readFile(params: { relPath: string; from?: number; lines?: number }): Promise<{
    text: string;
    path: string;
  }> {
    const relPath = params.relPath.trim();
    if (relPath.startsWith("mem0/") && this.deps.mem0) {
      return await this.deps.mem0.readFile(params);
    }
    if (this.deps.qmd) {
      return await this.deps.qmd.readFile(params);
    }
    if (this.deps.mem0) {
      return await this.deps.mem0.readFile(params);
    }
    if (this.deps.fallback) {
      return await this.deps.fallback.readFile(params);
    }
    return { path: relPath, text: "" };
  }

  status(): MemoryProviderStatus {
    return {
      backend: "hybrid",
      provider: "hybrid",
      model: "hybrid",
      requestedProvider: "hybrid",
      custom: {
        hybrid: {
          readMode: this.deps.config.readMode,
          writeMode: this.deps.config.writeMode,
          successPolicy: this.deps.config.successPolicy,
          readOrder: this.deps.config.readOrder,
          qmdAvailable: Boolean(this.deps.qmd),
          mem0Available: Boolean(this.deps.mem0),
        },
        qmd: this.deps.qmd?.status(),
        mem0: this.deps.mem0?.status(),
      },
    };
  }

  async sync(params?: {
    reason?: string;
    force?: boolean;
    sessionFiles?: string[];
    progress?: (update: MemorySyncProgressUpdate) => void;
  }): Promise<void> {
    const target = this.resolveTarget({
      scope: "write",
      source: "knowledge",
      priority: "normal",
      text: params?.reason ?? "",
      tags: [],
      fallbackTarget: this.deps.config.writeMode === "dual" ? "both" : "qmd",
    });
    await this.runWriteTarget(target, async (manager) => {
      await manager.sync?.(params);
    });
  }

  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    const checks = await Promise.all([
      this.deps.qmd?.probeEmbeddingAvailability?.(),
      this.deps.mem0?.probeEmbeddingAvailability?.(),
      this.deps.fallback?.probeEmbeddingAvailability?.(),
    ]);
    const available = checks.filter((item): item is MemoryEmbeddingProbeResult => Boolean(item));
    if (available.length === 0) {
      return { ok: false, error: "hybrid memory unavailable" };
    }
    if (this.deps.config.successPolicy === "all") {
      const failed = available.find((item) => !item.ok);
      return failed ?? { ok: true };
    }
    const succeeded = available.find((item) => item.ok);
    return succeeded ?? available[0];
  }

  async probeVectorAvailability(): Promise<boolean> {
    const checks = await Promise.all([
      this.deps.qmd?.probeVectorAvailability?.(),
      this.deps.mem0?.probeVectorAvailability?.(),
      this.deps.fallback?.probeVectorAvailability?.(),
    ]);
    const available = checks.filter((item): item is boolean => typeof item === "boolean");
    if (available.length === 0) {
      return false;
    }
    return this.deps.config.successPolicy === "all"
      ? available.every(Boolean)
      : available.some(Boolean);
  }

  async close(): Promise<void> {
    return;
  }

  async captureConversation(params: { sessionKey?: string; messages: unknown[] }): Promise<void> {
    const recentTexts = params.messages
      .flatMap((entry) => {
        if (!entry || typeof entry !== "object") {
          return [];
        }
        const typed = entry as { role?: unknown; content?: unknown };
        if (typed.role !== "user" || typeof typed.content !== "string") {
          return [];
        }
        return [typed.content];
      })
      .slice(-3);
    const joined = recentTexts.join("\n");
    const priority: RoutePriority = /critical|urgent|緊急|重要/.test(joined.toLowerCase())
      ? "critical"
      : "normal";
    const target = this.resolveTarget({
      scope: "write",
      source: "conversation",
      priority,
      text: joined,
      tags: tokenize(joined),
      fallbackTarget: this.deps.config.writeMode === "dual" ? "both" : "mem0",
    });
    await this.runWriteTarget(target, async (manager, backend) => {
      if (backend === "mem0" && manager.captureConversation) {
        await manager.captureConversation(params);
        return;
      }
      if (backend === "qmd") {
        await manager.sync?.({ reason: "hybrid-capture-conversation" });
      }
    });
  }

  private async runSingleSearch(
    backend: "qmd" | "mem0",
    query: string,
    opts: { maxResults?: number; minScore?: number; sessionKey?: string },
  ): Promise<MemorySearchResult[]> {
    const manager = backend === "qmd" ? this.deps.qmd : this.deps.mem0;
    if (!manager) {
      return [];
    }
    try {
      return await manager.search(query, opts);
    } catch (error) {
      log.warn(`hybrid ${backend} search failed: ${String(error)}`);
      return [];
    }
  }

  private async runWriteTarget(
    target: RouteTarget,
    handler: (manager: ConversationCaptureManager, backend: "qmd" | "mem0") => Promise<void>,
  ): Promise<void> {
    const tasks: Array<Promise<{ backend: "qmd" | "mem0"; ok: boolean; error?: string }>> = [];
    const pushTask = (backend: "qmd" | "mem0", manager: ConversationCaptureManager | null) => {
      if (!manager) {
        return;
      }
      tasks.push(
        (async () => {
          try {
            await handler(manager, backend);
            return { backend, ok: true };
          } catch (error) {
            return { backend, ok: false, error: String(error) };
          }
        })(),
      );
    };
    if (target === "qmd" || target === "both") {
      pushTask("qmd", this.deps.qmd as ConversationCaptureManager | null);
    }
    if (target === "mem0" || target === "both") {
      pushTask("mem0", this.deps.mem0);
    }
    const results = await Promise.all(tasks);
    if (results.length === 0) {
      return;
    }
    const okCount = results.filter((entry) => entry.ok).length;
    const failed = results.filter((entry) => !entry.ok);
    if (failed.length === 0) {
      return;
    }
    const failureSummary = failed
      .map((entry) => `${entry.backend}: ${entry.error ?? "unknown"}`)
      .join("; ");
    if (this.deps.config.successPolicy === "all" || okCount === 0) {
      throw new Error(`hybrid write failed (${failureSummary})`);
    }
    log.warn(`hybrid partial write failure (${failureSummary})`);
  }

  private resolveTarget(params: {
    scope: RouteScope;
    source: RouteSource;
    priority: RoutePriority;
    text: string;
    tags: string[];
    fallbackTarget: RouteTarget;
  }): RouteTarget {
    if (params.scope === "read" && this.deps.config.readMode === "dual") {
      return "both";
    }
    if (params.scope === "write" && this.deps.config.writeMode === "dual") {
      return "both";
    }
    for (const rule of this.deps.config.routing) {
      if (!this.ruleMatches(rule, params)) {
        continue;
      }
      return rule.target;
    }
    return params.fallbackTarget;
  }

  private ruleMatches(
    rule: ResolvedHybridRouteRule,
    params: {
      scope: RouteScope;
      source: RouteSource;
      priority: RoutePriority;
      text: string;
      tags: string[];
    },
  ): boolean {
    if (rule.scope !== "both" && rule.scope !== params.scope) {
      return false;
    }
    if (rule.source !== params.source) {
      return false;
    }
    if (rule.priority !== params.priority && rule.priority !== "normal") {
      return false;
    }
    if (rule.tags.length > 0 && !rule.tags.some((tag) => params.tags.includes(tag))) {
      return false;
    }
    const normalizedText = normalizeText(params.text);
    if (
      rule.queryIncludes.length > 0 &&
      !rule.queryIncludes.some((keyword) => normalizedText.includes(keyword))
    ) {
      return false;
    }
    return true;
  }
}
