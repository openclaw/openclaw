import { expect, it } from "vitest";
import { buildKnowledgeLearnGuidance, KNOWLEDGE_LEARN_TOOL_NAMES } from "./learn-guidance.js";

it("learn guidance needs page and claim writes and offers supersession only with correct", () => {
  const all = new Set<string>(KNOWLEDGE_LEARN_TOOL_NAMES);
  const full = buildKnowledgeLearnGuidance({ availableTools: all }).join("\n");
  expect(full).toContain("knowledge-ingest");
  expect(full).toContain("knowledge_correct");

  all.delete("knowledge_correct");
  expect(buildKnowledgeLearnGuidance({ availableTools: all }).join("\n")).not.toContain(
    "knowledge_correct",
  );
  all.delete("knowledge_create_claim");
  expect(buildKnowledgeLearnGuidance({ availableTools: all })).toStrictEqual([]);
});
