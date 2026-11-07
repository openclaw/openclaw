import { describe, expect, it } from "vitest";
import { buildAgentHarnessUserInputAnswers } from "./user-input-bridge.js";
import type { AgentHarnessUserInputQuestion } from "./user-input-types.js";

const question = (
  id: string,
  header: string,
  labels: string[] = [],
): AgentHarnessUserInputQuestion => ({
  id,
  header,
  question: `${header}?`,
  isOther: true,
  options: labels.map((label) => ({ label })),
});

const decision = [
  question("ruling", "Ruling", ["Deny", "Allow"]),
  question("authorization", "Authorization", ["Approved", "Deferred"]),
];

describe("buildAgentHarnessUserInputAnswers", () => {
  it.each([
    {
      name: "binds numbered reply lines to their questions",
      questions: decision,
      reply: "1. Deny\n2. Approved",
      expected: { ruling: ["Deny"], authorization: ["Approved"] },
    },
    {
      name: "does not reuse a numbered line as another question's answer",
      questions: decision,
      reply: "2. Approved",
      expected: { ruling: [], authorization: ["Approved"] },
    },
    {
      name: "leaves the second question unanswered for a lone option number",
      questions: decision,
      reply: "2",
      expected: { ruling: ["Allow"], authorization: [] },
    },
    {
      name: "keeps decimal answers positional",
      questions: [question("cpu", "CPU"), question("memory", "Memory")],
      reply: "1.5\n2.5",
      expected: { cpu: ["1.5"], memory: ["2.5"] },
    },
    {
      name: "keys dotted headers at the colon",
      questions: [question("runtime", "Node.js"), question("region", "U.S. region")],
      reply: "U.S. region: East\nNode.js: 22",
      expected: { runtime: ["22"], region: ["East"] },
    },
  ])("$name", ({ questions, reply, expected }) => {
    expect(buildAgentHarnessUserInputAnswers(questions, reply).answers).toEqual(
      Object.fromEntries(Object.entries(expected).map(([id, answers]) => [id, { answers }])),
    );
  });
});
