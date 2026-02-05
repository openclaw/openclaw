import type { MeridiaDbBackend, RecordQueryResult } from "./meridia/db/backend.js";

// Types duck-typed to match core MemorySearchManager interface

type MemorySearchResult = {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  source: "memory";
  citation?: string;
};

type MemoryProviderStatus = {
  backend: "builtin" | "qmd";
  provider: string;
  custom?: Record<string, unknown>;
};

type MemoryEmbeddingProbeResult = { ok: boolean; error?: string };

function buildMeridiaSnippet(result: RecordQueryResult): string {
  const r = result.record;
  const parts: string[] = [];
  if (r.content?.topic) {
    parts.push(r.content.topic);
  }
  if (r.content?.summary) {
    parts.push(r.content.summary);
  }
  if (r.content?.context) {
    parts.push(r.content.context);
  }
  if (parts.length === 0 && r.kind) {
    parts.push(`[${r.kind}]`);
  }
  return parts.join(" — ").slice(0, 700);
}

export class MeridiaSearchAdapter {
  constructor(private backend: MeridiaDbBackend) {}

  async search(
    query: string,
    opts?: { maxResults?: number; minScore?: number; sessionKey?: string },
  ): Promise<MemorySearchResult[]> {
    const results = this.backend.searchRecords(query, {
      limit: opts?.maxResults ?? 6,
      minScore: opts?.minScore,
    });
    return results.map((r) => ({
      path: `meridia://${r.record.id}`,
      startLine: 0,
      endLine: 0,
      score: r.rank ?? r.record.capture.score ?? 0.5,
      snippet: buildMeridiaSnippet(r),
      source: "memory" as const,
      citation: `[meridia:${r.record.id}]`,
    }));
  }

  async readFile(_params: {
    relPath: string;
    from?: number;
    lines?: number;
  }): Promise<{ text: string; path: string }> {
    return { text: "", path: "" };
  }

  status(): MemoryProviderStatus {
    const stats = this.backend.getStats();
    return {
      backend: "builtin",
      provider: "meridia",
      custom: {
        type: "meridia",
        recordCount: stats.recordCount,
        traceCount: stats.traceCount,
        sessionCount: stats.sessionCount,
      },
    };
  }

  async sync(): Promise<void> {
    // no-op
  }

  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    return { ok: true };
  }

  async probeVectorAvailability(): Promise<boolean> {
    return false;
  }

  async close(): Promise<void> {
    this.backend.close();
  }
}
