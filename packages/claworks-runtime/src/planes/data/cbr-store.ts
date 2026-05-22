/**
 * cbr-store.ts — Case-Based Reasoning 案例记忆
 *
 * 机器人从历史成功案例学习，遇到相似问题时复用解决方案。
 * 内存实现，基于关键词相似度匹配。
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
  add(problem: string, solution: string, meta?: Partial<CbrCase>): CbrCase;
  /** 关键词相似度匹配搜索 */
  search(query: string, limit?: number): CbrCase[];
  recordOutcome(caseId: string, outcome: CbrCase["outcome"]): void;
  getById(id: string): CbrCase | undefined;
  list(opts?: { limit?: number; minUseCount?: number }): CbrCase[];
  remove(id: string): boolean;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s,，。；：！？、\-_/\\|]+/)
    .filter((t) => t.length >= 2);
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
      const id = meta.id ?? randomUUID();
      const now = new Date();
      const keys = [...tokenize(problem), ...(meta.tags ?? []).flatMap(tokenize)];
      const entry: CbrCase = {
        id,
        problem,
        solution,
        outcome: meta.outcome ?? "success",
        similarity_keys: [...new Set(keys)],
        useCount: meta.useCount ?? 0,
        lastUsedAt: meta.lastUsedAt ?? now,
        createdAt: meta.createdAt ?? now,
        tags: meta.tags,
        playbookId: meta.playbookId,
        runId: meta.runId,
      };
      cases.set(id, entry);
      return entry;
    },

    search(query, limit = 5) {
      const queryTokens = tokenize(query);
      const scored = [...cases.values()]
        .map((c) => ({
          case: c,
          score: similarity(queryTokens, c.similarity_keys),
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
