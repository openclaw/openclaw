import { describe, expect, it } from "vitest";
import { buildPageContradictionClusters } from "./claim-health.js";
import type { WikiPageSummary } from "./markdown.js";

function createPage(params: {
  relativePath: string;
  title: string;
  contradictions: string[];
}): WikiPageSummary {
  return {
    absolutePath: params.relativePath,
    relativePath: params.relativePath,
    kind: "entity",
    title: params.title,
    sourceIds: [],
    linkTargets: [],
    claims: [],
    contradictions: params.contradictions,
    questions: [],
  };
}

describe("buildPageContradictionClusters", () => {
  it("keeps distinct CJK-only contradiction notes distinct", () => {
    const clusters = buildPageContradictionClusters([
      createPage({
        relativePath: "entities/llm.md",
        title: "LLM",
        contradictions: ["大语言模型概述"],
      }),
      createPage({
        relativePath: "entities/circuit-breaker.md",
        title: "Circuit Breaker",
        contradictions: ["断路器自动恢复"],
      }),
    ]);

    expect(clusters).toContainEqual(
      expect.objectContaining({
        key: "大语言模型概述",
        label: "大语言模型概述",
      }),
    );
    expect(clusters).toContainEqual(
      expect.objectContaining({
        key: "断路器自动恢复",
        label: "断路器自动恢复",
      }),
    );
    expect(clusters).toHaveLength(2);
  });

  it("preserves mixed ASCII and CJK contradiction notes while normalizing ASCII case", () => {
    const clusters = buildPageContradictionClusters([
      createPage({
        relativePath: "entities/alpha.md",
        title: "Alpha",
        contradictions: ["LLM 架构分析"],
      }),
      createPage({
        relativePath: "entities/beta.md",
        title: "Beta",
        contradictions: ["llm 架构分析"],
      }),
    ]);

    expect(clusters).toEqual([
      expect.objectContaining({
        key: "llm 架构分析",
        label: "LLM 架构分析",
        entries: [
          expect.objectContaining({ pagePath: "entities/alpha.md", note: "LLM 架构分析" }),
          expect.objectContaining({ pagePath: "entities/beta.md", note: "llm 架构分析" }),
        ],
      }),
    ]);
  });
});
