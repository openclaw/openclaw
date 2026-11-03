import { expect, it } from "vitest";
import { buildKnowledgeLearnGuidance, KNOWLEDGE_LEARN_TOOL_NAMES } from "./learn-guidance.js";

it("learn guidance offers supersession only with correct", () => {
  const all = new Set<string>(KNOWLEDGE_LEARN_TOOL_NAMES);
  const media = new Set(["memory"] as const);
  const full = buildKnowledgeLearnGuidance({ availableTools: all, media }).lines.join("\n");
  expect(full).toContain("knowledge-ingest");
  expect(full).toContain("knowledge_correct");

  all.delete("knowledge_correct");
  expect(
    buildKnowledgeLearnGuidance({ availableTools: all, media }).lines.join("\n"),
  ).not.toContain("knowledge_correct");
});
