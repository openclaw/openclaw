import { INVALID_PROJECT_ANNOTATION_KEY } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { describe, expect, it, vi } from "vitest";
import { mergeHybridResults } from "./hybrid.js";
import { applyProjectRanking, prepareActiveProjectKeys } from "./project-ranking.js";

describe("hybrid project ranking", () => {
  it("prepares active membership once across exact scoring and diverse reranking", async () => {
    const activeProjectKeys = Array.from({ length: 1_000 }, (_, index) => `active-${index}`);
    const vector = Array.from({ length: 200 }, (_, index) => ({
      id: `candidate-${index}`,
      path: `memory/${index.toString().padStart(3, "0")}.md`,
      startLine: 1,
      endLine: 2,
      source: "memory",
      snippet: index < 2 ? "shared" : `distinct${index}`,
      vectorScore: 0.8,
      projectKey: index < 100 ? `active-${index}` : `foreign-${index}`,
      exactPathSpecificity: 2 as const,
    }));
    const before = structuredClone({ vector, activeProjectKeys });
    const iterate = activeProjectKeys[Symbol.iterator].bind(activeProjectKeys);
    let yieldedKeys = 0;
    const iterator = vi.spyOn(activeProjectKeys, Symbol.iterator).mockImplementation(function* () {
      for (const key of iterate()) {
        yieldedKeys += 1;
        yield key;
      }
      return undefined;
    });
    let result: Awaited<ReturnType<typeof mergeHybridResults>>;
    try {
      result = await mergeHybridResults({
        vector,
        keyword: [],
        vectorWeight: 1,
        textWeight: 0,
        activeProjectKeys,
        mmr: { enabled: true, lambda: 0.7 },
      });
    } finally {
      iterator.mockRestore();
    }
    const order = [
      0,
      ...Array.from({ length: 98 }, (_, index) => index + 2),
      1,
      ...Array.from({ length: 100 }, (_, index) => index + 100),
    ];
    expect(result).toEqual(
      order.map((index) => ({
        path: `memory/${index.toString().padStart(3, "0")}.md`,
        startLine: 1,
        endLine: 2,
        source: "memory",
        snippet: index < 2 ? "shared" : `distinct${index}`,
        vectorScore: 0.8,
        textScore: 0,
        score: index < 100 ? 1.15 : 0.9,
        projectKey: index < 100 ? `active-${index}` : `foreign-${index}`,
        importance: undefined,
        triggers: undefined,
      })),
    );
    expect({ vector, activeProjectKeys }).toEqual(before);
    expect(yieldedKeys).toBeLessThanOrEqual(activeProjectKeys.length);
  });

  it("reads active membership after temporal decay and refreshes it for each call", async () => {
    const nowMs = Date.UTC(2026, 0, 1);
    const activeProjectKeys = ["old"];
    const vector = ["old", "new"].map((key) => ({
      id: key,
      path: `sessions/${key}`,
      startLine: 1,
      endLine: 1,
      source: "sessions",
      snippet: key,
      projectKey: key,
      vectorScore: 0.8,
      exactPathSpecificity: 2 as const,
    }));
    const before = structuredClone(vector);
    const mtimes = new Map(vector.map((entry) => [entry.path, nowMs]));
    const reads = vi.spyOn(mtimes, "get");
    try {
      for (const next of ["new", "old"]) {
        reads.mockClear();
        const pending = mergeHybridResults({
          vector,
          keyword: [],
          vectorWeight: 1,
          textWeight: 0,
          activeProjectKeys,
          sessionSourceMtimes: mtimes,
          temporalDecay: { enabled: true, halfLifeDays: 30 },
          nowMs,
        });
        expect(reads).toHaveBeenCalledTimes(2);
        activeProjectKeys[0] = next;
        expect((await pending).map((entry) => [entry.projectKey, entry.score])).toEqual([
          [next, 1.15],
          [next === "new" ? "old" : "new", 0.9],
        ]);
      }
    } finally {
      reads.mockRestore();
    }
    expect(vector).toEqual(before);
  });

  it.each([
    { active: ["one", "two"], stored: " one ; two ", multiplier: 1.15 },
    { active: ["one"], stored: "one;two", multiplier: 0.9 },
    { active: [" one "], stored: "one", multiplier: 0.9 },
    { active: ["One"], stored: "one", multiplier: 0.9 },
    { active: ["one"], stored: " ; ", multiplier: 1.15 },
  ])(
    "preserves stored and active key semantics: $active / $stored",
    ({ active, stored, multiplier }) => {
      const entry = { score: 0.8, projectKey: stored };
      expect(applyProjectRanking([entry], prepareActiveProjectKeys(active))).toEqual([
        { ...entry, score: 0.8 * multiplier },
      ]);
      expect(entry.score).toBe(0.8);
    },
  );

  it.each([undefined, [], ["one"]])(
    "filters invalid tags and preserves entry ownership for %j",
    (active) => {
      const global = { score: 0.8 };
      const tagged = { score: 0.8, projectKey: "one" };
      const invalid = { score: 0.8, projectKey: `one; ${INVALID_PROJECT_ANNOTATION_KEY} ` };
      const input = [global, tagged, invalid];
      const before = structuredClone(input);
      const result = applyProjectRanking(input, prepareActiveProjectKeys(active));
      expect(result).toEqual([global, { ...tagged, score: active?.length ? 0.8 * 1.15 : 0.8 }]);
      expect(result).not.toBe(input);
      for (const [index, entry] of [global, tagged].entries()) {
        expect(result[index] === entry).toBe(!active?.length);
      }
      expect(input).toEqual(before);
    },
  );
});
