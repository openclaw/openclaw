/**
 * embedding.ts — 離線向量化 + 語義搜尋
 *
 * 三層 fallback 策略：
 *   1. Ollama embeddings HTTP API（推薦生產環境，零費用）
 *      → 啟動 Ollama：ollama pull nomic-embed-text
 *   2. @xenova/transformers（WebAssembly，完全離線）
 *      → 安裝：pnpm add @xenova/transformers
 *   3. TF-IDF 近似（純 Node.js，無依賴，啟動即用）
 *
 * 向量維度：
 *   - Ollama nomic-embed-text：768d
 *   - Xenova bge-small-en-v1.5：384d
 *   - TF-IDF：動詞彙表大小（可變）
 *
 * 用法：
 *   const emb = await getEmbedder()
 *   const vec = await emb.embed("你的文字")
 *   const similar = await emb.topK(queryVec, candidates, k)
 */

// ── 公開型別 ──────────────────────────────────────────────────────────────────

export interface Embedder {
  /** 後端名稱，用於日誌 */
  backend: "ollama" | "xenova" | "tfidf";
  /** 向量維度 */
  dimension: number;
  /** 文字 → 向量 */
  embed(text: string): Promise<number[]>;
  /** 計算 cosine 相似度 */
  similarity(a: number[], b: number[]): number;
  /** 從 candidates 中找出最近 k 個（返回 [index, score] 降序） */
  topK(query: number[], candidates: number[][], k: number): Array<[number, number]>;
}

export interface EmbedderOptions {
  ollamaUrl?: string; // 預設 http://localhost:11434
  ollamaModel?: string; // 預設 nomic-embed-text
  xenovaModel?: string; // 預設 Xenova/bge-small-en-v1.5
  preferBackend?: "ollama" | "xenova" | "tfidf";
}

// ── Cosine 相似度 ──────────────────────────────────────────────────────────────

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) {
    return 0;
  }
  let dot = 0,
    normA = 0,
    normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export function topKSimilar(
  query: number[],
  candidates: number[][],
  k: number,
  similarityFn: (a: number[], b: number[]) => number = cosineSimilarity,
): Array<[number, number]> {
  return candidates
    .map((vec, idx): [number, number] => [idx, similarityFn(query, vec)])
    .toSorted((a, b) => b[1] - a[1])
    .slice(0, k);
}

// ── Backend 1：Ollama HTTP API ─────────────────────────────────────────────────

async function ollamaEmbed(text: string, url: string, model: string): Promise<number[]> {
  const res = await fetch(`${url}/api/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt: text }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`Ollama HTTP ${res.status}: ${await res.text()}`);
  }
  const json = (await res.json()) as { embedding?: number[] };
  if (!Array.isArray(json.embedding)) {
    throw new Error("Ollama: 回應缺少 embedding 欄位");
  }
  return json.embedding;
}

async function createOllamaEmbedder(ollamaUrl: string, ollamaModel: string): Promise<Embedder> {
  // 先 ping 確認可用
  const testVec = await ollamaEmbed("test", ollamaUrl, ollamaModel);
  const dimension = testVec.length;

  return {
    backend: "ollama",
    dimension,
    embed: (text) => ollamaEmbed(text, ollamaUrl, ollamaModel),
    similarity: cosineSimilarity,
    topK: (query, candidates, k) => topKSimilar(query, candidates, k),
  };
}

// ── Backend 2：@xenova/transformers（WebAssembly，條件載入）─────────────────────

async function createXenovaEmbedder(modelName: string): Promise<Embedder> {
  // 動態 import，若未安裝則拋出 → 由 getEmbedder 捕獲並 fallback
  // pnpm add @xenova/transformers
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { pipeline } = await import("@xenova/transformers" as any);
  const extractor = await pipeline("feature-extraction", modelName, { quantized: true });

  // 先跑一次確認維度
  const testOut = await extractor("test", { pooling: "mean", normalize: true });
  const testData = Array.from(testOut.data);
  const dimension = testData.length;

  return {
    backend: "xenova",
    dimension,
    async embed(text) {
      const out = await extractor(text, { pooling: "mean", normalize: true });
      return Array.from(out.data);
    },
    similarity: cosineSimilarity,
    topK: (query, candidates, k) => topKSimilar(query, candidates, k),
  };
}

// ── Backend 3：TF-IDF 近似（純 Node.js，零依賴）──────────────────────────────

/** 簡易中英文分詞（去標點 + 空格分割 + 2-gram）*/
function tokenize(text: string): string[] {
  const cleaned = text.toLowerCase().replace(/[^\w\s一-鿿]/g, " ");
  const words = cleaned.split(/\s+/).filter((w) => w.length >= 1);
  const bigrams: string[] = [];
  for (let i = 0; i < words.length - 1; i++) {
    bigrams.push(`${words[i]}_${words[i + 1]}`);
  }
  return [...words, ...bigrams];
}

class TfIdfEmbedder implements Embedder {
  backend = "tfidf" as const;
  dimension: number;
  private vocab: Map<string, number>;
  private idf: Map<string, number>;

  constructor(documents: string[]) {
    // 建立詞彙表（所有 doc 的 union）
    const allTokens = new Set<string>();
    const docTokenSets: Set<string>[] = [];

    for (const doc of documents) {
      const tokens = new Set(tokenize(doc));
      docTokenSets.push(tokens);
      for (const t of tokens) {
        allTokens.add(t);
      }
    }

    this.vocab = new Map();
    let idx = 0;
    for (const t of allTokens) {
      this.vocab.set(t, idx++);
    }
    this.dimension = this.vocab.size || 1;

    // IDF = log(N / df + 1)
    const N = Math.max(documents.length, 1);
    this.idf = new Map();
    for (const token of this.vocab.keys()) {
      let df = 0;
      for (const s of docTokenSets) {
        if (s.has(token)) {
          df++;
        }
      }
      this.idf.set(token, Math.log((N + 1) / (df + 1)) + 1);
    }
  }

  embed(text: string): Promise<number[]> {
    const tokens = tokenize(text);
    const tf = new Map<string, number>();
    for (const t of tokens) {
      tf.set(t, (tf.get(t) ?? 0) + 1);
    }
    const total = tokens.length || 1;

    const vec = Array.from({ length: this.dimension }, () => 0);
    for (const [token, count] of tf) {
      const i = this.vocab.get(token);
      if (i !== undefined) {
        vec[i] = (count / total) * (this.idf.get(token) ?? 1);
      }
    }
    return Promise.resolve(vec);
  }

  similarity(a: number[], b: number[]): number {
    return cosineSimilarity(a, b);
  }

  topK(query: number[], candidates: number[][], k: number): Array<[number, number]> {
    return topKSimilar(query, candidates, k);
  }
}

/**
 * 從 SQLite patterns 取 context 文字建立 TF-IDF 嵌入器
 */
export function createTfIdfEmbedder(patternContexts: string[]): Embedder {
  return new TfIdfEmbedder(patternContexts);
}

// ── 主要導出：getEmbedder（帶 fallback 鏈）──────────────────────────────────

let cachedEmbedder: Embedder | null = null;

/**
 * 取得（或重用快取的）Embedder 實例。
 * 按 preferBackend → ollama → xenova → tfidf 依序嘗試。
 *
 * @param opts 選項，若不傳則用環境變數 OLLAMA_URL / OLLAMA_EMBED_MODEL
 * @param corpusForTfIdf TF-IDF fallback 的語料（patterns context 文字陣列）
 */
export async function getEmbedder(
  opts: EmbedderOptions = {},
  corpusForTfIdf: string[] = [],
): Promise<Embedder> {
  if (cachedEmbedder) {
    return cachedEmbedder;
  }

  const ollamaUrl = opts.ollamaUrl ?? process.env.OLLAMA_URL ?? "http://localhost:11434";
  const ollamaModel = opts.ollamaModel ?? process.env.OLLAMA_EMBED_MODEL ?? "nomic-embed-text";
  const xenovaModel = opts.xenovaModel ?? "Xenova/bge-small-en-v1.5";
  const prefer = opts.preferBackend;

  const tryOrder: Array<() => Promise<Embedder>> =
    prefer === "xenova"
      ? [
          () => createXenovaEmbedder(xenovaModel),
          () => createOllamaEmbedder(ollamaUrl, ollamaModel),
          () => Promise.resolve(createTfIdfEmbedder(corpusForTfIdf)),
        ]
      : prefer === "tfidf"
        ? [() => Promise.resolve(createTfIdfEmbedder(corpusForTfIdf))]
        : [
            () => createOllamaEmbedder(ollamaUrl, ollamaModel),
            () => createXenovaEmbedder(xenovaModel),
            () => Promise.resolve(createTfIdfEmbedder(corpusForTfIdf)),
          ];

  for (const factory of tryOrder) {
    try {
      cachedEmbedder = await factory();
      console.log(`🧠 Embedder 後端：${cachedEmbedder.backend}（${cachedEmbedder.dimension}d）`);
      return cachedEmbedder;
    } catch (err) {
      // 靜默 fallback 到下一個後端
      void err;
    }
  }

  // 絕對 fallback（不應到達）
  cachedEmbedder = createTfIdfEmbedder(corpusForTfIdf);
  return cachedEmbedder;
}

/** 清除快取（測試用） */
export function resetEmbedderCache(): void {
  cachedEmbedder = null;
}

// ── 向量化工具函數 ─────────────────────────────────────────────────────────────

/**
 * 批次向量化多段文字（最多 20 個）
 */
export async function embedBatch(texts: string[], embedder: Embedder): Promise<number[][]> {
  return Promise.all(texts.map((t) => embedder.embed(t)));
}

/**
 * 語義搜尋：從 patterns 資料庫找出最相關的 top-k 個 pattern slug。
 *
 * @param queryText 查詢文字
 * @param candidates { slug, text }[] — 待搜尋的 pattern 語料
 * @param k 回傳幾個
 * @param embedder 可傳入已初始化的 Embedder，否則自動建立
 */
export async function semanticSearchPatterns(
  queryText: string,
  candidates: Array<{ slug: string; text: string }>,
  k: number,
  embedder?: Embedder,
): Promise<Array<{ slug: string; score: number }>> {
  if (candidates.length === 0) {
    return [];
  }

  const emb =
    embedder ??
    (await getEmbedder(
      {},
      candidates.map((c) => c.text),
    ));
  const queryVec = await emb.embed(queryText);
  const candidateVecs = await embedBatch(
    candidates.map((c) => c.text),
    emb,
  );

  return emb.topK(queryVec, candidateVecs, Math.min(k, candidates.length)).map(([idx, score]) => ({
    slug: candidates[idx].slug,
    score,
  }));
}
