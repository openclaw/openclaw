import fs from "node:fs/promises";
import {
  buildMultimodalChunkForIndexing,
  chunkMarkdown,
  createSubsystemLogger,
  enforceEmbeddingMaxInputTokens,
  estimateStructuredEmbeddingInputBytes,
  estimateUtf8Bytes,
  hasNonTextEmbeddingParts,
  hashText,
  parseEmbedding,
  remapChunkLines,
  type EmbeddingInput,
  type MemoryChunk,
  type MemoryFileEntry,
  type MemorySource,
  type SessionFileEntry,
} from "../engine-host-api.js";
import { MemoryManagerSyncOps } from "./manager-sync-ops.js";

const VECTOR_TABLE = "chunks_vec";
const FTS_TABLE = "chunks_fts";
const EMBEDDING_CACHE_TABLE = "embedding_cache";
const EMBEDDING_BATCH_MAX_TOKENS = 8000;
const EMBEDDING_INDEX_CONCURRENCY = 4;
const EMBEDDING_RETRY_MAX_ATTEMPTS = 3;
const EMBEDDING_RETRY_BASE_DELAY_MS = 500;
const EMBEDDING_RETRY_MAX_DELAY_MS = 8000;
const BATCH_FAILURE_LIMIT = 2;
const EMBEDDING_QUERY_TIMEOUT_REMOTE_MS = 60_000;
const EMBEDDING_QUERY_TIMEOUT_LOCAL_MS = 5 * 60_000;
const EMBEDDING_BATCH_TIMEOUT_REMOTE_MS = 2 * 60_000;
const EMBEDDING_BATCH_TIMEOUT_LOCAL_MS = 10 * 60_000;

const vectorToBlob = (embedding: number[]): Buffer =>
  Buffer.from(new Float32Array(embedding).buffer);

const log = createSubsystemLogger("memory");

export abstract class MemoryManagerEmbeddingOps extends MemoryManagerSyncOps {
  protected abstract batchFailureCount: number;
  protected abstract batchFailureLastError?: string;
  protected abstract batchFailureLastProvider?: string;
  protected abstract batchFailureLock: Promise<void>;

  private buildEmbeddingBatches(chunks: MemoryChunk[]): MemoryChunk[][] {
    const batches: MemoryChunk[][] = [];
    let current: MemoryChunk[] = [];
    let currentTokens = 0;

    for (const chunk of chunks) {
      const estimate = chunk.embeddingInput
        ? estimateStructuredEmbeddingInputBytes(chunk.embeddingInput)
        : estimateUtf8Bytes(chunk.text);
      const wouldExceed =
        current.length > 0 && currentTokens + estimate > EMBEDDING_BATCH_MAX_TOKENS;
      if (wouldExceed) {
        batches.push(current);
        current = [];
        currentTokens = 0;
      }
      if (current.length === 0 && estimate > EMBEDDING_BATCH_MAX_TOKENS) {
        batches.push([chunk]);
        continue;
      }
      current.push(chunk);
      currentTokens += estimate;
    }

    if (current.length > 0) {
      batches.push(current);
    }
    return batches;
  }

  private loadEmbeddingCache(hashes: string[]): Map<string, number[]> {
    if (!this.cache.enabled || !this.provider) {
      return new Map();
    }
    if (hashes.length === 0) {
      return new Map();
    }
    const unique: string[] = [];
    const seen = new Set<string>();
    for (const hash of hashes) {
      if (!hash) {
        continue;
      }
      if (seen.has(hash)) {
        continue;
      }
      seen.add(hash);
      unique.push(hash);
    }
    if (unique.length === 0) {
      return new Map();
    }

    const out = new Map<string, number[]>();
    const baseParams = [this.provider.id, this.provider.model, this.providerKey];
    const batchSize = 400;
    for (let start = 0; start < unique.length; start += batchSize) {
      const batch = unique.slice(start, start + batchSize);
      const placeholders = batch.map(() => "?").join(", ");
      const rows = this.db
        .prepare(
          `SELECT hash, embedding FROM ${EMBEDDING_CACHE_TABLE}\n` +
            ` WHERE provider = ? AND model = ? AND provider_key = ? AND hash IN (${placeholders})`,
        )
        .all(...baseParams, ...batch) as Array<{ hash: string; embedding: string }>;
      for (const row of rows) {
        out.set(row.hash, parseEmbedding(row.embedding));
      }
    }
    return out;
  }

  private upsertEmbeddingCache(entries: Array<{ hash: string; embedding: number[] }>): void {
    if (!this.cache.enabled || !this.provider) {
      return;
    }
    if (entries.length === 0) {
      return;
    }
    const now = Date.now();
    const stmt = this.db.prepare(
      `INSERT INTO ${EMBEDDING_CACHE_TABLE} (provider, model, provider_key, hash, embedding, dims, updated_at)\n` +
        ` VALUES (?, ?, ?, ?, ?, ?, ?)\n` +
        ` ON CONFLICT(provider, model, provider_key, hash) DO UPDATE SET\n` +
        `   embedding=excluded.embedding,\n` +
        `   dims=excluded.dims,\n` +
        `   updated_at=excluded.updated_at`,
    );
    for (const entry of entries) {
      const embedding = entry.embedding ?? [];
      stmt.run(
        this.provider.id,
        this.provider.model,
        this.providerKey,
        entry.hash,
        JSON.stringify(embedding),
        embedding.length,
        now,
      );
    }
  }

  protected pruneEmbeddingCacheIfNeeded(): void {
    if (!this.cache.enabled) {
      return;
    }
    const max = this.cache.maxEntries;
    if (!max || max <= 0) {
      return;
    }
    const row = this.db.prepare(`SELECT COUNT(*) as c FROM ${EMBEDDING_CACHE_TABLE}`).get() as
      | { c: number }
      | undefined;
    const count = row?.c ?? 0;
    if (count <= max) {
      return;
    }
    const excess = count - max;
    this.db
      .prepare(
        `DELETE FROM ${EMBEDDING_CACHE_TABLE}\n` +
          ` WHERE rowid IN (\n` +
          `   SELECT rowid FROM ${EMBEDDING_CACHE_TABLE}\n` +
          `   ORDER BY updated_at ASC\n` +
          `   LIMIT ?\n` +
          ` )`,
      )
      .run(excess);
  }

  private async embedChunksInBatches(chunks: MemoryChunk[]): Promise<number[][]> {
    if (chunks.length === 0) {
      return [];
    }
    const { embeddings, missing } = this.collectCachedEmbeddings(chunks);

    if (missing.length === 0) {
      return embeddings;
    }

    const missingChunks = missing.map((m) => m.chunk);
    const batches = this.buildEmbeddingBatches(missingChunks);
    const toCache: Array<{ hash: string; embedding: number[] }> = [];
    const provider = this.provider;
    if (!provider) {
      throw new Error("Cannot embed batch in FTS-only mode (no embedding provider)");
    }
    let cursor = 0;
    for (const batch of batches) {
      const inputs = batch.map((chunk) => chunk.embeddingInput ?? { text: chunk.text });
      const hasStructuredInputs = inputs.some((input) => hasNonTextEmbeddingParts(input));
      if (hasStructuredInputs && !provider.embedBatchInputs) {
        throw new Error(
          `Embedding provider "${provider.id}" does not support multimodal memory inputs.`,
        );
      }
      const batchEmbeddings = hasStructuredInputs
        ? await this.embedBatchInputsWithRetry(inputs)
        : await this.embedBatchWithRetry(batch.map((chunk) => chunk.text));
      for (let i = 0; i < batch.length; i += 1) {
        const item = missing[cursor + i];
        const embedding = batchEmbeddings[i] ?? [];
        if (item) {
          embeddings[item.index] = embedding;
          toCache.push({ hash: item.chunk.hash, embedding });
        }
      }
      cursor += batch.length;
    }
    this.upsertEmbeddingCache(toCache);
    return embeddings;
  }

  protected computeProviderKey(): string {
    // FTS-only mode: no provider, use a constant key
    if (!this.provider) {
      return hashText(JSON.stringify({ provider: "none", model: "fts-only" }));
    }
    if (this.providerRuntime?.cacheKeyData) {
      return hashText(JSON.stringify(this.providerRuntime.cacheKeyData));
    }
    return hashText(JSON.stringify({ provider: this.provider.id, model: this.provider.model }));
  }

  private buildBatchDebug(source: MemorySource, chunks: MemoryChunk[]) {
    return (message: string, data?: Record<string, unknown>) =>
      log.debug(
        message,
        data ? { ...data, source, chunks: chunks.length } : { source, chunks: chunks.length },
      );
  }

  private async embedChunksWithBatch(
    chunks: MemoryChunk[],
    _entry: MemoryFileEntry | SessionFileEntry,
    source: MemorySource,
  ): Promise<number[][]> {
    const batchEmbed = this.providerRuntime?.batchEmbed;
    if (!this.provider || !batchEmbed) {
      return this.embedChunksInBatches(chunks);
    }
    if (chunks.length === 0) {
      return [];
    }
    const { embeddings, missing } = this.collectCachedEmbeddings(chunks);
    if (missing.length === 0) {
      return embeddings;
    }

    const missingChunks = missing.map((item) => item.chunk);
    const batchResult = await this.runBatchWithFallback({
      provider: this.provider.id,
      run: async () =>
        await batchEmbed({
          agentId: this.agentId,
          chunks: missingChunks,
          wait: this.batch.wait,
          concurrency: this.batch.concurrency,
          pollIntervalMs: this.batch.pollIntervalMs,
          timeoutMs: this.batch.timeoutMs,
          debug: this.buildBatchDebug(source, chunks),
        }),
      fallback: async () => await this.embedChunksInBatches(chunks),
    });
    if (!batchResult) {
      return this.embedChunksInBatches(chunks);
    }
    const toCache: Array<{ hash: string; embedding: number[] }> = [];
    for (let index = 0; index < missing.length; index += 1) {
      const item = missing[index];
      const embedding = batchResult[index] ?? [];
      if (!item) {
        continue;
      }
      embeddings[item.index] = embedding;
      toCache.push({ hash: item.chunk.hash, embedding });
    }
    this.upsertEmbeddingCache(toCache);
    return embeddings;
  }

  private collectCachedEmbeddings(chunks: MemoryChunk[]): {
    embeddings: number[][];
    missing: Array<{ index: number; chunk: MemoryChunk }>;
  } {
    const cached = this.loadEmbeddingCache(chunks.map((chunk) => chunk.hash));
    const embeddings: number[][] = Array.from({ length: chunks.length }, () => []);
    const missing: Array<{ index: number; chunk: MemoryChunk }> = [];

    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i];
      const hit = chunk?.hash ? cached.get(chunk.hash) : undefined;
      if (hit && hit.length > 0) {
        embeddings[i] = hit;
      } else if (chunk) {
        missing.push({ index: i, chunk });
      }
    }

    return { embeddings, missing };
  }

  protected async embedBatchWithRetry(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }
    if (!this.provider) {
      throw new Error("Cannot embed batch in FTS-only mode (no embedding provider)");
    }
    let attempt = 0;
    let delayMs = EMBEDDING_RETRY_BASE_DELAY_MS;
    while (true) {
      try {
        const timeoutMs = this.resolveEmbeddingTimeout("batch");
        log.debug("memory embeddings: batch start", {
          provider: this.provider.id,
          items: texts.length,
          timeoutMs,
        });
        return await this.withTimeout(
          this.provider.embedBatch(texts),
          timeoutMs,
          `memory embeddings batch timed out after ${Math.round(timeoutMs / 1000)}s`,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!this.isRetryableEmbeddingError(message) || attempt >= EMBEDDING_RETRY_MAX_ATTEMPTS) {
          throw err;
        }
        await this.waitForEmbeddingRetry(delayMs, "retrying");
        delayMs *= 2;
        attempt += 1;
      }
    }
  }

  protected async embedBatchInputsWithRetry(inputs: EmbeddingInput[]): Promise<number[][]> {
    if (inputs.length === 0) {
      return [];
    }
    if (!this.provider?.embedBatchInputs) {
      return await this.embedBatchWithRetry(inputs.map((input) => input.text));
    }
    let attempt = 0;
    let delayMs = EMBEDDING_RETRY_BASE_DELAY_MS;
    while (true) {
      try {
        const timeoutMs = this.resolveEmbeddingTimeout("batch");
        log.debug("memory embeddings: structured batch start", {
          provider: this.provider.id,
          items: inputs.length,
          timeoutMs,
        });
        return await this.withTimeout(
          this.provider.embedBatchInputs(inputs),
          timeoutMs,
          `memory embeddings batch timed out after ${Math.round(timeoutMs / 1000)}s`,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!this.isRetryableEmbeddingError(message) || attempt >= EMBEDDING_RETRY_MAX_ATTEMPTS) {
          throw err;
        }
        await this.waitForEmbeddingRetry(delayMs, "retrying structured batch");
        delayMs *= 2;
        attempt += 1;
      }
    }
  }

  private async waitForEmbeddingRetry(delayMs: number, action: string): Promise<void> {
    const waitMs = Math.min(
      EMBEDDING_RETRY_MAX_DELAY_MS,
      Math.round(delayMs * (1 + Math.random() * 0.2)),
    );
    log.warn(`memory embeddings rate limited; ${action} in ${waitMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  private isRetryableEmbeddingError(message: string): boolean {
    return /(rate[_ ]limit|too many requests|429|resource has been exhausted|5\d\d|cloudflare|tokens per day)/i.test(
      message,
    );
  }

  private resolveEmbeddingTimeout(kind: "query" | "batch"): number {
    const isLocal = this.provider?.id === "local";
    if (kind === "query") {
      return isLocal ? EMBEDDING_QUERY_TIMEOUT_LOCAL_MS : EMBEDDING_QUERY_TIMEOUT_REMOTE_MS;
    }
    return isLocal ? EMBEDDING_BATCH_TIMEOUT_LOCAL_MS : EMBEDDING_BATCH_TIMEOUT_REMOTE_MS;
  }

  protected async embedQueryWithTimeout(text: string): Promise<number[]> {
    if (!this.provider) {
      throw new Error("Cannot embed query in FTS-only mode (no embedding provider)");
    }
    const timeoutMs = this.resolveEmbeddingTimeout("query");
    log.debug("memory embeddings: query start", { provider: this.provider.id, timeoutMs });
    return await this.withTimeout(
      this.provider.embedQuery(text),
      timeoutMs,
      `memory embeddings query timed out after ${Math.round(timeoutMs / 1000)}s`,
    );
  }

  protected async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    message: string,
  ): Promise<T> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return await promise;
    }
    let timer: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    });
    try {
      return (await Promise.race([promise, timeoutPromise])) as T;
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  private async withBatchFailureLock<T>(fn: () => Promise<T>): Promise<T> {
    let release: () => void;
    const wait = this.batchFailureLock;
    this.batchFailureLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await wait;
    try {
      return await fn();
    } finally {
      release!();
    }
  }

  private async resetBatchFailureCount(): Promise<void> {
    await this.withBatchFailureLock(async () => {
      if (this.batchFailureCount > 0) {
        log.debug("memory embeddings: batch recovered; resetting failure count");
      }
      this.batchFailureCount = 0;
      this.batchFailureLastError = undefined;
      this.batchFailureLastProvider = undefined;
    });
  }

  private async recordBatchFailure(params: {
    provider: string;
    message: string;
    attempts?: number;
    forceDisable?: boolean;
  }): Promise<{ disabled: boolean; count: number }> {
    return await this.withBatchFailureLock(async () => {
      if (!this.batch.enabled) {
        return { disabled: true, count: this.batchFailureCount };
      }
      const increment = params.forceDisable
        ? BATCH_FAILURE_LIMIT
        : Math.max(1, params.attempts ?? 1);
      this.batchFailureCount += increment;
      this.batchFailureLastError = params.message;
      this.batchFailureLastProvider = params.provider;
      const disabled = params.forceDisable || this.batchFailureCount >= BATCH_FAILURE_LIMIT;
      if (disabled) {
        this.batch.enabled = false;
      }
      return { disabled, count: this.batchFailureCount };
    });
  }

  private isBatchTimeoutError(message: string): boolean {
    return /timed out|timeout/i.test(message);
  }

  private async runBatchWithTimeoutRetry<T>(params: {
    provider: string;
    run: () => Promise<T>;
  }): Promise<T> {
    try {
      return await params.run();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (this.isBatchTimeoutError(message)) {
        log.warn(`memory embeddings: ${params.provider} batch timed out; retrying once`);
        try {
          return await params.run();
        } catch (retryErr) {
          (retryErr as { batchAttempts?: number }).batchAttempts = 2;
          throw retryErr;
        }
      }
      throw err;
    }
  }

  private async runBatchWithFallback<T>(params: {
    provider: string;
    run: () => Promise<T>;
    fallback: () => Promise<number[][]>;
  }): Promise<T | number[][]> {
    if (!this.batch.enabled) {
      return await params.fallback();
    }
    try {
      const result = await this.runBatchWithTimeoutRetry({
        provider: params.provider,
        run: params.run,
      });
      await this.resetBatchFailureCount();
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const attempts = (err as { batchAttempts?: number }).batchAttempts ?? 1;
      const forceDisable = /asyncBatchEmbedContent not available/i.test(message);
      const failure = await this.recordBatchFailure({
        provider: params.provider,
        message,
        attempts,
        forceDisable,
      });
      const suffix = failure.disabled ? "disabling batch" : "keeping batch enabled";
      log.warn(
        `memory embeddings: ${params.provider} batch failed (${failure.count}/${BATCH_FAILURE_LIMIT}); ${suffix}; falling back to non-batch embeddings: ${message}`,
      );
      return await params.fallback();
    }
  }

  protected getIndexConcurrency(): number {
    return this.batch.enabled ? this.batch.concurrency : EMBEDDING_INDEX_CONCURRENCY;
  }

  private clearIndexedFileData(pathname: string, source: MemorySource): void {
    if (this.vector.enabled) {
      try {
        this.db
          .prepare(
            `DELETE FROM ${VECTOR_TABLE} WHERE id IN (SELECT id FROM chunks WHERE path = ? AND source = ?)`,
          )
          .run(pathname, source);
      } catch {}
    }
    if (this.fts.enabled && this.fts.available && this.provider) {
      try {
        this.db
          .prepare(`DELETE FROM ${FTS_TABLE} WHERE path = ? AND source = ? AND model = ?`)
          .run(pathname, source, this.provider.model);
      } catch {}
    }
    this.db.prepare(`DELETE FROM chunks WHERE path = ? AND source = ?`).run(pathname, source);
  }

  private upsertFileRecord(entry: MemoryFileEntry | SessionFileEntry, source: MemorySource): void {
    this.db
      .prepare(
        `INSERT INTO files (path, source, hash, mtime, size) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           source=excluded.source,
           hash=excluded.hash,
           mtime=excluded.mtime,
           size=excluded.size`,
      )
      .run(entry.path, source, entry.hash, entry.mtimeMs, entry.size);
  }

  private deleteFileRecord(pathname: string, source: MemorySource): void {
    this.db.prepare(`DELETE FROM files WHERE path = ? AND source = ?`).run(pathname, source);
  }

  private isStructuredInputTooLargeError(message: string): boolean {
    return /(413|payload too large|request too large|input too large|too many tokens|input limit|request size)/i.test(
      message,
    );
  }

  protected async indexFile(
    entry: MemoryFileEntry | SessionFileEntry,
    options: { source: MemorySource; content?: string },
  ) {
    // FTS-only mode: skip indexing if no provider
    if (!this.provider) {
      log.debug("Skipping embedding indexing in FTS-only mode", {
        path: entry.path,
        source: options.source,
      });
      return;
    }

    let chunks: MemoryChunk[];
    let structuredInputBytes: number | undefined;
    if ("kind" in entry && entry.kind === "multimodal") {
      const multimodalChunk = await buildMultimodalChunkForIndexing(entry);
      if (!multimodalChunk) {
        this.clearIndexedFileData(entry.path, options.source);
        this.deleteFileRecord(entry.path, options.source);
        return;
      }
      structuredInputBytes = multimodalChunk.structuredInputBytes;
      chunks = [multimodalChunk.chunk];
    } else {
      const content = options.content ?? (await fs.readFile(entry.absPath, "utf-8"));
      chunks = enforceEmbeddingMaxInputTokens(
        this.provider,
        chunkMarkdown(content, this.settings.chunking).filter(
          (chunk) => chunk.text.trim().length > 0,
        ),
        EMBEDDING_BATCH_MAX_TOKENS,
      );
      if (options.source === "sessions" && "lineMap" in entry) {
        remapChunkLines(chunks, entry.lineMap);
      }
    }
    let embeddings: number[][];
    try {
      embeddings = this.batch.enabled
        ? await this.embedChunksWithBatch(chunks, entry, options.source)
        : await this.embedChunksInBatches(chunks);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (
        "kind" in entry &&
        entry.kind === "multimodal" &&
        this.isStructuredInputTooLargeError(message)
      ) {
        log.warn("memory embeddings: skipping multimodal file rejected as too large", {
          path: entry.path,
          bytes: structuredInputBytes,
          provider: this.provider.id,
          model: this.provider.model,
          error: message,
        });
        this.clearIndexedFileData(entry.path, options.source);
        this.upsertFileRecord(entry, options.source);
        return;
      }
      throw err;
    }
    const sample = embeddings.find((embedding) => embedding.length > 0);
    const vectorReady = sample ? await this.ensureVectorReady(sample.length) : false;
    const now = Date.now();
    this.clearIndexedFileData(entry.path, options.source);
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const embedding = embeddings[i] ?? [];
      const id = hashText(
        `${options.source}:${entry.path}:${chunk.startLine}:${chunk.endLine}:${chunk.hash}:${this.provider.model}`,
      );
      this.db
        .prepare(
          `INSERT INTO chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             hash=excluded.hash,
             model=excluded.model,
             text=excluded.text,
             embedding=excluded.embedding,
             updated_at=excluded.updated_at`,
        )
        .run(
          id,
          entry.path,
          options.source,
          chunk.startLine,
          chunk.endLine,
          chunk.hash,
          this.provider.model,
          chunk.text,
          JSON.stringify(embedding),
          now,
        );
      if (vectorReady && embedding.length > 0) {
        try {
          this.db.prepare(`DELETE FROM ${VECTOR_TABLE} WHERE id = ?`).run(id);
        } catch {}
        this.db
          .prepare(`INSERT INTO ${VECTOR_TABLE} (id, embedding) VALUES (?, ?)`)
          .run(id, vectorToBlob(embedding));
      }
      if (this.fts.enabled && this.fts.available) {
        this.db
          .prepare(
            `INSERT INTO ${FTS_TABLE} (text, id, path, source, model, start_line, end_line)\n` +
              ` VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            chunk.text,
            id,
            entry.path,
            options.source,
            this.provider.model,
            chunk.startLine,
            chunk.endLine,
          );
      }
    }
    this.upsertFileRecord(entry, options.source);
  }
}
