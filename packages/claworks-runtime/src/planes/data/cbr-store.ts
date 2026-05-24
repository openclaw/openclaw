/**
 * cbr-store.ts — Case-Based Reasoning 案例记忆
 *
 * 机器人从历史成功案例学习，遇到相似问题时复用解决方案。
 * 内存实现，基于 TF-IDF 加权余弦相似度，支持中英文分词。
 */

import { randomUUID } from "node:crypto";

export interface CbrCase {
  id: string;
  problem: string;
  solution: string;
  outcome: "success" | "partial" | "failed";
  similarity_keys: string[];
  useCount: number;
  lastUsedAt: Date;
  createdAt: Date;
  tags?: string[];
  playbookId?: string;
  runId?: string;
}

export interface CbrStore {
  add(
    problem: string,
    solution: string,
    meta?: Partial<CbrCase> & Record<string, unknown>,
  ): CbrCase;
  /** 关键词相似度匹配搜索 */
  search(query: string, limit?: number): CbrCase[];
  recordOutcome(caseId: string, outcome: CbrCase["outcome"]): void;
  getById(id: string): CbrCase | undefined;
  list(opts?: { limit?: number; minUseCount?: number }): CbrCase[];
  remove(id: string): boolean;
}

function tokenize(text: string): string[] {
  const words = text
    .toLowerCase()
    .split(/[\s,，。；：！？、\-_/\\|]+/)
    .filter((t) => t.length >= 2);
  // 对中文添加字符 bigrams，增强中文短语匹配能力
  const bigrams: string[] = [];
  const cjkText = text.replace(/[^\u4e00-\u9fa5]/g, "");
  for (let i = 0; i < cjkText.length - 1; i++) {
    bigrams.push(cjkText.slice(i, i + 2));
  }
  return [...words, ...bigrams];
}

/**
 * TF-IDF 加权余弦相似度
 *
 * queryTokens: 查询文本的 token 列表
 * caseTokens:  案例的 similarity_keys（已 tokenize）
 * allCases:    全部案例，用于计算 IDF
 */
export function tfidfSimilarity(
  queryTokens: string[],
  caseTokens: string[],
  allCases: Map<string, CbrCase>,
): number {
  if (queryTokens.length === 0 || caseTokens.length === 0) return 0;

  const N = allCases.size || 1;

  // 计算 query 的 TF（归一化词频）
  const queryTf = new Map<string, number>();
  for (const t of queryTokens) queryTf.set(t, (queryTf.get(t) ?? 0) + 1);

  // 计算 case 的 TF（归一化词频）
  const caseTf = new Map<string, number>();
  for (const t of caseTokens) caseTf.set(t, (caseTf.get(t) ?? 0) + 1);

  // 仅对两者共同出现的词计算（优化：只在共现词上做点积）
  const queryTerms = new Set(queryTf.keys());

  let dotProduct = 0;
  let queryMagSq = 0;
  let caseMagSq = 0;

  // 计算所有查询词和案例词的 IDF + TF 权重
  const allTerms = new Set([...queryTerms, ...caseTf.keys()]);
  for (const term of allTerms) {
    // IDF: log((N+1) / (df+1)) — 平滑处理，防止除零
    let df = 0;
    for (const c of allCases.values()) {
      if (c.similarity_keys.includes(term)) df++;
    }
    const idf = Math.log((N + 1) / (df + 1)) + 1;

    const qw = ((queryTf.get(term) ?? 0) / queryTokens.length) * idf;
    const cw = ((caseTf.get(term) ?? 0) / caseTokens.length) * idf;

    dotProduct += qw * cw;
    queryMagSq += qw * qw;
    caseMagSq += cw * cw;
  }

  if (queryMagSq === 0 || caseMagSq === 0) return 0;
  return dotProduct / (Math.sqrt(queryMagSq) * Math.sqrt(caseMagSq));
}

function similarity(queryTokens: string[], caseTokens: string[]): number {
  if (queryTokens.length === 0 || caseTokens.length === 0) {
    return 0;
  }
  const caseSet = new Set(caseTokens);
  const matches = queryTokens.filter((t) => caseSet.has(t)).length;
  return matches / Math.max(queryTokens.length, caseTokens.length);
}

export function createCbrStore(): CbrStore {
  const cases = new Map<string, CbrCase>();

  return {
    add(problem, solution, meta = {}) {
      const id = typeof meta.id === "string" ? meta.id : randomUUID();
      const now = new Date();
      const tags = Array.isArray(meta.tags)
        ? meta.tags.filter((t): t is string => typeof t === "string")
        : undefined;
      const keys = [...tokenize(problem), ...(tags ?? []).flatMap(tokenize)];
      const entry: CbrCase = {
        id,
        problem,
        solution,
        outcome:
          meta.outcome === "failed" || meta.outcome === "partial" || meta.outcome === "success"
            ? meta.outcome
            : "success",
        similarity_keys: [...new Set(keys)],
        useCount: typeof meta.useCount === "number" ? meta.useCount : 0,
        lastUsedAt: meta.lastUsedAt instanceof Date ? meta.lastUsedAt : now,
        createdAt: meta.createdAt instanceof Date ? meta.createdAt : now,
        tags,
        playbookId: typeof meta.playbookId === "string" ? meta.playbookId : undefined,
        runId: typeof meta.runId === "string" ? meta.runId : undefined,
      };
      cases.set(id, entry);
      return entry;
    },

    search(query, limit = 5) {
      const queryTokens = tokenize(query);
      // N >= 5 时使用 TF-IDF 余弦相似度；案例库较小时降级为关键词匹配（IDF 计算意义不大）
      const useTfidf = cases.size >= 5;
      const scored = [...cases.values()]
        .map((c) => ({
          case: c,
          score: useTfidf
            ? tfidfSimilarity(queryTokens, c.similarity_keys, cases)
            : similarity(queryTokens, c.similarity_keys),
        }))
        .filter((x) => x.score > 0)
        .toSorted((a, b) => b.score - a.score || b.case.useCount - a.case.useCount);

      const results = scored.slice(0, limit).map((x) => x.case);
      // 增加命中案例的使用次数
      for (const c of results) {
        c.useCount += 1;
        c.lastUsedAt = new Date();
      }
      return results;
    },

    recordOutcome(caseId, outcome) {
      const c = cases.get(caseId);
      if (c) {
        c.outcome = outcome;
      }
    },

    getById(id) {
      return cases.get(id);
    },

    list(opts = {}) {
      let result = [...cases.values()];
      if (opts.minUseCount !== undefined) {
        result = result.filter((c) => c.useCount >= (opts.minUseCount ?? 0));
      }
      result.sort((a, b) => b.useCount - a.useCount);
      if (opts.limit !== undefined) {
        result = result.slice(0, opts.limit);
      }
      return result;
    },

    remove(id) {
      return cases.delete(id);
    },
  };
}
