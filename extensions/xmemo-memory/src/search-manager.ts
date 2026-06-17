import type {
  MemoryEmbeddingProbeResult,
  MemoryProviderStatus,
  MemoryReadResult,
  MemorySearchManager,
  MemorySearchResult,
} from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import type { XMemoClient, XMemoRecallContextItem } from "./client.js";
import type { XMemoMemoryConfig } from "./config.js";

function memoryIdFromPath(relPath: string): string | undefined {
  // XMemo memory ids are UUIDs. Accept paths like "bucket/uuid" or just "uuid".
  const parts = relPath.split("/");
  const last = parts[parts.length - 1];
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(last ?? "")) {
    return last;
  }
  return undefined;
}

export class XMemoSearchManager implements MemorySearchManager {
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

    const response = await this.client.recallContext({
      query: query.slice(0, this.config.recallMaxChars),
      bucket: this.config.bucket,
      scope: this.config.scope ?? null,
      team_id: this.config.teamId ?? null,
      max_items: opts.maxResults ?? this.config.recallMaxItems,
      max_tokens: this.config.recallMaxTokens,
      prefer_working: true,
    });

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

  async readFile({ relPath, from, lines }: { relPath: string; from?: number; lines?: number }): Promise<MemoryReadResult> {
    if (!this.client.isConfigured()) {
      return { text: "", path: relPath, truncated: false, from: 1, lines: 0 };
    }

    const id = memoryIdFromPath(relPath);
    let text: string;
    let path = relPath;

    if (id) {
      const memory = await this.client.getMemory(id);
      text = memory.content;
      path = memory.path ?? relPath;
    } else {
      const response = await this.client.searchMemory({
        query: relPath,
        path: relPath,
        bucket: this.config.bucket,
        scope: this.config.scope ?? null,
        team_id: this.config.teamId ?? null,
        max_items: 10,
      });
      text = response.results.map((r) => r.content).join("\n\n---\n\n");
    }

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

  status(): MemoryProviderStatus {
    return {
      backend: "builtin",
      provider: "xmemo-memory",
      custom: {
        baseUrl: this.config.baseUrl,
        bucket: this.config.bucket,
        scope: this.config.scope,
        configured: this.client.isConfigured(),
      },
    } as MemoryProviderStatus;
  }

  async sync(): Promise<void> {
    // XMemo is remote; there is no local index to sync.
  }

  getCachedEmbeddingAvailability(): MemoryEmbeddingProbeResult | null {
    return { ok: true, checked: true };
  }

  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    return { ok: true, checked: true };
  }

  async probeVectorStoreAvailability(): Promise<boolean> {
    return true;
  }

  async probeVectorAvailability(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {
    // HTTP client is stateless.
  }
}
