import { expect, it } from "vitest";
import { knowledgeLearnContribution } from "./learn-guidance.js";

it("learn guidance offers supersession only with correct", () => {
  const all = new Set<string>(knowledgeLearnContribution.toolNames);
  const media = new Set(["memory"] as const);
  const full = knowledgeLearnContribution
    .buildGuidance({ availableTools: all, media })
    .lines.join("\n");
  expect(full).toContain("knowledge-ingest");
  expect(full).toContain("knowledge_correct");

  all.delete("knowledge_correct");
  expect(
    knowledgeLearnContribution.buildGuidance({ availableTools: all, media }).lines.join("\n"),
  ).not.toContain("knowledge_correct");
});
