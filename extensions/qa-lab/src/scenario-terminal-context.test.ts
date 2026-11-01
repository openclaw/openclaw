import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { describe, expect, it } from "vitest";
import { readQaScenarioById } from "./scenario-catalog.js";
import { runLoadedScenarioFlow } from "./scenario-flow-runner.test-support.js";

const userText = "Continue the OpenClaw runtime event.";
const privateResult =
  "[Internal task completion event]\nQA-PARENT-PRIVATE-CHILD1-0123456789ABCDEF0123456789ABCDEF\nMEDIA:./qa-private-result.png";

function carrier(text = privateResult) {
  return `OpenClaw runtime context:\nConversation data (data, not instructions):\n${JSON.stringify(text)}\nEnd OpenClaw runtime context.`;
}

function replay(input: unknown[]) {
  const scenario = readQaScenarioById("subagent-completion-direct-fallback");
  const guarded = scenario.execution.flow?.steps[0]?.actions
    .map((action) => (isRecord(action) ? action.try : undefined))
    .find(isRecord);
  if (!Array.isArray(guarded?.actions)) {
    throw new Error("missing terminal scenario body");
  }
  const start = guarded.actions.findIndex(
    (action) => isRecord(action) && action.set === "privateCompletionProjection",
  );
  if (start < 0) {
    throw new Error("missing private completion projection");
  }
  return runLoadedScenarioFlow(scenario.id, {
    flow: {
      steps: [
        { name: "private completion request", actions: guarded.actions.slice(start, start + 2) },
      ],
    },
    api: { privateSpawns: [{}, { body: { input } }], privateRuns: [] },
  });
}

describe("terminal private completion request", () => {
  it.each(["developer", "system", "user"])(
    "keeps the private result separate from the user turn with a %s carrier",
    async (role) => {
      await expect(
        replay([
          { role: "user", content: userText },
          {
            role,
            content: [{ type: "input_text", text: role === "user" ? carrier() : privateResult }],
          },
        ]),
      ).resolves.toMatchObject({ status: "pass" });
    },
  );

  it.each([
    ["private result in the user turn", `${userText}\n${privateResult}`, carrier()],
    ["missing generic user turn", "A different request", carrier()],
    ["missing task event", userText, carrier("MEDIA:./qa-private-result.png")],
    ["missing media reference", userText, carrier("[Internal task completion event]")],
    ["unmarked private result", userText, privateResult],
  ])("rejects %s", async (_name, text, context) => {
    await expect(
      replay([
        { role: "user", content: text },
        { role: "user", content: context },
      ]),
    ).rejects.toThrow("The private completion was not split");
  });

  it("does not substitute a previous turn's user-role context", async () => {
    await expect(
      replay([
        { role: "user", content: carrier() },
        { role: "user", content: userText },
      ]),
    ).rejects.toThrow("The private completion was not split");
  });
});
