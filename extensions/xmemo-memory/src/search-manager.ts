import type {
  MemoryEmbeddingProbeResult,
  MemoryProviderStatus,
  MemoryReadResult,
  MemorySearchManager,
  MemorySearchResult,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import type { XMemoClient, XMemoRecallContextItem } from "./client.js";
import type { XMemoMemoryConfig } from "./config.js";

function memoryIdFromPath(relPath: string): string | undefined {
  // Accept paths like "bucket/id", "bucket/scope/id", or just "id".
  // XMemo ids may be UUIDs or arbitrary strings; take the final non-empty segment.
  const parts = relPath.split("/").filter(Boolean);
  const last = parts[parts.length - 1];
  return last;
}

export class XMemoSearchManager implements MemorySearchManager {
  private connected: boolean | undefined;
  private lastError: string | undefined;
  private lastProbeAtMs: number | undefined;

  constructor(
    private readonly client: XMemoClient,
    private readonly config: XMemoMemoryConfig,
  ) {}

  async search(
    query: string,
    opts: {
      maxResults?: number;
      minScore?: number;
      sessionKey?: string;
      signal?: AbortSignal;
      sources?: Array<"memory" | "sessions">;
    } = {},
  ): Promise<MemorySearchResult[]> {
    if (!this.client.isConfigured()) {
      return [];
    }

    const response = await this.client.recallContext(
      {
        query: query.slice(0, this.config.recallMaxChars),
        bucket: this.config.bucket,
        scope: this.config.scope ?? null,
        team_id: this.config.teamId ?? null,
        max_items: opts.maxResults ?? this.config.recallMaxItems,
        max_tokens: this.config.recallMaxTokens,
        prefer_working: true,
      },
      opts.signal,
    );

    this.connected = true;
    this.lastError = undefined;

    return (response.items ?? []).map((item: XMemoRecallContextItem, index: number) => {
      const score = item.score ?? Math.max(0.5, 0.95 - index * 0.05);
      // Encode the XMemo id into the path so readFile/forget tools can recover it.
      const path = item.path ? `${item.path}/${item.id}` : `${this.config.bucket}/${item.id}`;
      return {
        path,
        startLine: 1,
        endLine: 1,
        score,
        snippet: item.content ?? item.snippet ?? "",
        source: "memory" as const,
      };
    });
  }

  async readFile(
    {
      relPath,
      from,
      lines,
    }: {
      relPath: string;
      from?: number;
      lines?: number;
    },
    signal?: AbortSignal,
  ): Promise<MemoryReadResult> {
    if (!this.client.isConfigured()) {
      return { text: "", path: relPath, truncated: false, from: 1, lines: 0 };
    }

    const id = memoryIdFromPath(relPath);
    let text: string;
    let path = relPath;

    if (id) {
      const memory = await this.client.getMemory(id, signal);
      text = memory.content;
      path = memory.path ?? relPath;
    } else {
      const response = await this.client.searchMemory(
        {
          query: relPath,
          path: relPath,
          bucket: this.config.bucket,
          scope: this.config.scope ?? null,
          team_id: this.config.teamId ?? null,
          max_items: 10,
        },
        signal,
      );
      text = response.results.map((r) => r.content).join("\n\n---\n\n");
    }

    this.connected = true;
    this.lastError = undefined;

    const allLines = text.split("\n");
    const startFrom = Math.max(1, from ?? 1);
    const lineCount = lines ?? allLines.length;
    const sliced = allLines.slice(startFrom - 1, startFrom - 1 + lineCount);
    const resultText = sliced.join("\n");

    return {
      text: resultText,
      path,
      truncated: sliced.length < allLines.length,
      from: startFrom,
      lines: sliced.length,
    };
  }

  async probeConnectivity(signal?: AbortSignal): Promise<boolean> {
    if (!this.client.isConfigured()) {
      this.connected = false;
      this.lastError = "not configured";
      return false;
    }

    try {
      await this.client.validateToken(signal);
      this.connected = true;
      this.lastError = undefined;
      this.lastProbeAtMs = Date.now();
      return true;
    } catch (error: unknown) {
      this.connected = false;
      this.lastError = error instanceof Error ? error.message : String(error);
      this.lastProbeAtMs = Date.now();
      return false;
    }
  }

  status(): MemoryProviderStatus {
    return {
      backend: "xmemo",
      provider: "xmemo-memory",
      custom: {
        baseUrl: this.config.baseUrl,
        bucket: this.config.bucket,
        scope: this.config.scope,
        configured: this.client.isConfigured(),
        connected: this.connected ?? false,
        ...(this.lastError ? { lastError: this.lastError } : {}),
      },
    };
  }

  async sync(): Promise<void> {
    // XMemo is remote; there is no local index to sync.
  }

  getCachedEmbeddingAvailability(): MemoryEmbeddingProbeResult | null {
    if (this.connected === undefined) {
      return null;
    }
    return {
      ok: this.connected,
      error: this.lastError,
      checked: this.lastProbeAtMs !== undefined,
      cached: true,
      checkedAtMs: this.lastProbeAtMs,
    };
  }

  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    const ok = await this.probeConnectivity();
    return {
      ok,
      error: this.lastError,
      checked: true,
      cached: false,
      checkedAtMs: this.lastProbeAtMs,
    };
  }

  async probeVectorStoreAvailability(): Promise<boolean> {
    return await this.probeConnectivity();
  }

  async probeVectorAvailability(): Promise<boolean> {
    return await this.probeConnectivity();
  }

  async close(): Promise<void> {
    // HTTP client is stateless.
  }
}
