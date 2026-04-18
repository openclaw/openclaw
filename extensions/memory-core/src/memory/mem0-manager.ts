import {
  createSubsystemLogger,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import type {
  MemoryEmbeddingProbeResult,
  MemoryProviderStatus,
  MemorySearchManager,
  MemorySearchResult,
  MemorySyncProgressUpdate,
  ResolvedMem0Config,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";

const log = createSubsystemLogger("memory");
const MAX_MEM0_RESULTS = 20;

type Mem0MemoryRecord = {
  id?: string;
  memory?: string;
  score?: number;
  metadata?: Record<string, unknown>;
};

function normalizeIdentitySegment(input: string): string {
  return input.replace(/\s+/g, "-").replace(/[^a-zA-Z0-9._:-]/g, "_");
}

function extractMem0Records(payload: unknown): Mem0MemoryRecord[] {
  if (!payload) {
    return [];
  }
  if (Array.isArray(payload)) {
    return payload.filter((entry): entry is Mem0MemoryRecord => typeof entry === "object");
  }
  if (typeof payload !== "object") {
    return [];
  }
  const typed = payload as { memories?: unknown; results?: unknown };
  if (Array.isArray(typed.memories)) {
    return typed.memories.filter(
      (entry): entry is Mem0MemoryRecord => !!entry && typeof entry === "object",
    );
  }
  if (Array.isArray(typed.results)) {
    return typed.results.filter(
      (entry): entry is Mem0MemoryRecord => !!entry && typeof entry === "object",
    );
  }
  return [];
}

function readTextFromUnknownMessage(message: unknown): string[] {
  if (!message || typeof message !== "object") {
    return [];
  }
  const typed = message as { role?: unknown; content?: unknown };
  if (typed.role !== "user") {
    return [];
  }
  if (typeof typed.content === "string") {
    return [typed.content];
  }
  if (!Array.isArray(typed.content)) {
    return [];
  }
  const texts: string[] = [];
  for (const block of typed.content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const typedBlock = block as { type?: unknown; text?: unknown };
    if (typedBlock.type === "text" && typeof typedBlock.text === "string") {
      texts.push(typedBlock.text);
    }
  }
  return texts;
}

export class Mem0MemoryManager implements MemorySearchManager {
  static async create(params: {
    cfg: OpenClawConfig;
    agentId: string;
    resolved: ResolvedMem0Config;
  }): Promise<Mem0MemoryManager | null> {
    if (!params.resolved.enabled) {
      return null;
    }
    return new Mem0MemoryManager(params);
  }

  private readonly agentId: string;
  private readonly mem0: ResolvedMem0Config;
  private readonly resultCache = new Map<string, string>();

  private constructor(params: {
    cfg: OpenClawConfig;
    agentId: string;
    resolved: ResolvedMem0Config;
  }) {
    this.agentId = params.agentId;
    this.mem0 = params.resolved;
  }

  async search(
    query: string,
    opts?: { maxResults?: number; minScore?: number; sessionKey?: string },
  ): Promise<MemorySearchResult[]> {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
      return [];
    }
    const scoped = this.buildScopedIds(opts?.sessionKey);
    const topK = Math.min(
      MAX_MEM0_RESULTS,
      Math.max(1, Math.floor(opts?.maxResults ?? this.mem0.topK)),
    );
    const threshold = Math.min(1, Math.max(0, opts?.minScore ?? this.mem0.threshold));
    const payload = await this.requestJson({
      path: this.mem0.searchPath,
      body: {
        query: trimmedQuery,
        top_k: topK,
        threshold,
        version: "v2",
        filters: {
          AND: [{ user_id: scoped.userId }, { agent_id: scoped.agentScopedId }],
        },
      },
    });
    const results: MemorySearchResult[] = [];
    for (const record of extractMem0Records(payload)) {
      const text = record.memory?.trim();
      if (!text) {
        continue;
      }
      const score = typeof record.score === "number" ? record.score : 0;
      if (score < threshold) {
        continue;
      }
      const memoryId = record.id?.trim() || this.fingerprintMemory(text);
      const virtualPath = `mem0/${memoryId}`;
      this.resultCache.set(virtualPath, text);
      const lineCount = text.split("\n").length;
      results.push({
        path: virtualPath,
        startLine: 1,
        endLine: lineCount,
        score,
        snippet: text,
        source: "memory",
      });
    }
    return results;
  }

  async readFile(params: { relPath: string; from?: number; lines?: number }): Promise<{
    text: string;
    path: string;
  }> {
    const relPath = params.relPath.trim();
    const cached = this.resultCache.get(relPath);
    if (!cached) {
      return { path: relPath, text: "" };
    }
    if (params.from === undefined && params.lines === undefined) {
      return { path: relPath, text: cached };
    }
    const lines = cached.split("\n");
    const start = Math.max(1, params.from ?? 1);
    const count = Math.max(1, params.lines ?? lines.length);
    return {
      path: relPath,
      text: lines.slice(start - 1, start - 1 + count).join("\n"),
    };
  }

  status(): MemoryProviderStatus {
    return {
      backend: "mem0",
      provider: "mem0",
      model: "mem0",
      requestedProvider: "mem0",
      files: this.resultCache.size,
      chunks: this.resultCache.size,
      dirty: false,
      sources: ["memory"],
      sourceCounts: [
        { source: "memory", files: this.resultCache.size, chunks: this.resultCache.size },
      ],
      custom: {
        mem0: {
          baseUrl: this.mem0.baseUrl,
          searchPath: this.mem0.searchPath,
          addPath: this.mem0.addPath,
        },
      },
    };
  }

  async sync(params?: {
    reason?: string;
    force?: boolean;
    sessionFiles?: string[];
    progress?: (update: MemorySyncProgressUpdate) => void;
  }): Promise<void> {
    params?.progress?.({ completed: 1, total: 1, label: "Mem0 backend is always online." });
  }

  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    return { ok: true };
  }

  async probeVectorAvailability(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {
    this.resultCache.clear();
  }

  async captureConversation(params: { sessionKey?: string; messages: unknown[] }): Promise<void> {
    const scoped = this.buildScopedIds(params.sessionKey);
    const userTexts = params.messages
      .flatMap((entry) => readTextFromUnknownMessage(entry))
      .slice(-8);
    if (userTexts.length === 0) {
      return;
    }
    await this.requestJson({
      path: this.mem0.addPath,
      body: {
        version: "v2",
        user_id: scoped.userId,
        agent_id: scoped.agentScopedId,
        messages: userTexts.map((text) => ({ role: "user", content: text })),
      },
    });
  }

  private buildScopedIds(sessionKey?: string): { userId: string; agentScopedId: string } {
    const normalizedAgentId = normalizeIdentitySegment(this.agentId || "default");
    const rawSessionKey = sessionKey?.trim() || "default";
    const normalizedSessionKey = normalizeIdentitySegment(rawSessionKey);
    return {
      userId: `${this.mem0.userIdPrefix}:${normalizedSessionKey}`,
      agentScopedId: `${this.mem0.agentIdPrefix}:${normalizedAgentId}`,
    };
  }

  private async requestJson<T = unknown>(params: {
    path: string;
    body: Record<string, unknown>;
  }): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.mem0.timeoutMs);
    try {
      const response = await fetch(`${this.mem0.baseUrl}${params.path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.mem0.apiKey ? { Authorization: `Token ${this.mem0.apiKey}` } : {}),
        },
        body: JSON.stringify(params.body),
        signal: controller.signal,
      });
      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        throw new Error(
          `Mem0 request failed (${response.status}): ${errorText || response.statusText}`,
        );
      }
      return (await response.json()) as T;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn(`mem0 request failed: ${message}`);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private fingerprintMemory(text: string): string {
    const hash = Array.from(text).reduce(
      (value, char) => (value * 31 + char.charCodeAt(0)) >>> 0,
      0,
    );
    return `mem-${hash.toString(16)}`;
  }
}
