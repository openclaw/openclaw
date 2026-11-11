import { expect, it } from "vitest";
import { buildKnowledgeMemoryPrompt } from "./memory-prompt.js";

const prompt = (tools: string[]) =>
  buildKnowledgeMemoryPrompt({ availableTools: new Set(tools) } as never).join("\n");

it("asks for the page State to be kept current only when the agent can edit pages", () => {
  const remember = ["knowledge_grep", "knowledge_remember"];
  const pages = [
    ...remember,
    "knowledge_record",
    "knowledge_save_page",
    "knowledge_status",
    "knowledge_ontology",
  ];
  const stateRule = /alters what an existing page's State says, also rewrite that State in place/;
  expect(prompt(pages)).toMatch(stateRule);
  expect(prompt(remember)).not.toMatch(stateRule);
});
