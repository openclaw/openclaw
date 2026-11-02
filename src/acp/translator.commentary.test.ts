import { beforeEach, expect, it } from "vitest";
import { createPromptScenario } from "./translator.scenario.test-support.js";

async function createHarness() {
  const harness = createPromptScenario({ send: () => ({}) });
  const { result: prompt, sent } = harness.start();
  const runId = await sent;
  const send = (event: string, payload: Record<string, unknown>) =>
    harness.event(event, { runId, ...payload });
  const chat = (text: string, options: Record<string, unknown> = {}) =>
    send("chat", { state: "delta", message: { content: [{ type: "text", text }] }, ...options });
  const preamble = (itemId: string, progressText: string, options: Record<string, unknown> = {}) =>
    send("agent", {
      stream: "item",
      data: { kind: "preamble", itemId, progressText },
      preamble: { retainedText: "" },
      ...options,
    });
  const tool = (toolCallId: string, phase: "start" | "result") =>
    send("agent", { stream: "tool", data: { phase, name: "read", toolCallId } });
  const round = async (id = "read") => {
    await tool(id, "start");
    await tool(id, "result");
  };
  const finish = async (text = "Done.") => {
    await chat(text, { state: "final" });
    return prompt;
  };
  const answer = async (text: string) => {
    await chat(text);
    await chat("", { replace: true });
    return finish(text);
  };
  const updates = () =>
    harness.sessionUpdate.mock.calls.flatMap(([{ update }]) => {
      if (update.sessionUpdate === "agent_message_chunk") {
        return ["text" in update.content ? update.content.text : undefined];
      }
      return update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update"
        ? [`${update.toolCallId}:${update.status}`]
        : [];
    });
  return { answer, chat, preamble, tool, round, finish, updates };
}

let h: Awaited<ReturnType<typeof createHarness>>;
const readUpdates = ["read:in_progress", "read:completed"];
beforeEach(async () => {
  h = await createHarness();
});

it("preserves narration and the answer when the replacement is deferred", async () => {
  const answer = "OK.";
  const narration = "I will read the sample now.";
  await h.chat("I will");
  await h.preamble("commentary", narration);
  await h.preamble("commentary", narration);
  await h.round();
  await h.chat("", { replace: true });
  await h.answer(answer);
  expect(h.updates()).toEqual(["I will", " read the sample now.", ...readUpdates, answer]);
});

it("delivers the complete answer after two tool rounds", async () => {
  const answer = "Verified.";
  const expected: string[] = [];
  for (let round = 0; round < 2; round++) {
    const narration = round === 0 ? "I will read the sample now." : "Checking again.";
    await h.chat(narration);
    await h.chat("", { replace: true });
    await h.preamble(`commentary-${round}`, narration);
    // A completion echo must not retire another answer's baseline.
    await h.preamble(`commentary-${round}`, narration);
    await h.round(`read-${round}`);
    expected.push(narration, `read-${round}:in_progress`, `read-${round}:completed`);
  }
  await expect(h.answer(answer)).resolves.toEqual({ stopReason: "end_turn" });
  expect(h.updates()).toEqual([...expected, answer]);
});

it("streams preamble-only snapshots once per item before the tool", async () => {
  const pending = [
    h.preamble("first", "Checking"),
    h.preamble("first", "Checking again."),
    h.preamble("first", "Checking again."),
    h.tool("read-1", "start"),
    h.tool("read-1", "result"),
    h.preamble("second", "Checking again."),
    h.tool("read-2", "start"),
    h.tool("read-2", "result"),
  ];
  await Promise.all(pending);
  await h.finish();
  expect(h.updates()).toEqual([
    "Checking",
    " again.",
    "read-1:in_progress",
    "read-1:completed",
    "Checking again.",
    "read-2:in_progress",
    "read-2:completed",
    "Done.",
  ]);
});

it("resumes commentary from the last emitted snapshot after a divergent snapshot", async () => {
  await h.preamble("commentary", "Checking files");
  await h.preamble("commentary", "Reading files");
  await h.preamble("commentary", "Checking files now");
  await h.finish();
  expect(h.updates()).toEqual(["Checking files", " now", "Done."]);
});

it("advances an item's boundary within an already displayed multi-item preview", async () => {
  await h.chat("Checking files.\nReading config.");
  await h.preamble("first", "Checking");
  await h.preamble("first", "Checking files.", { preamble: {} });
  await h.preamble("second", "Reading config.", { preamble: {} });
  await h.finish();
  expect(h.updates()).toEqual(["Checking files.\nReading config.", "Done."]);
});

it.each([
  { deferred: false, held: false },
  { deferred: true, held: false },
  { deferred: false, held: true },
])(
  "keeps an earlier answer prefix (deferred=$deferred, held=$held)",
  async ({ deferred, held }) => {
    if (!held) {
      await h.chat("First answer.");
      await h.chat("First answer.\n\nChecking again.");
      if (!deferred) {
        await h.chat("First answer.", { replace: true });
      }
    }
    await h.preamble("commentary", "Checking again.", {
      preamble: { retainedText: "First answer." },
    });
    if (deferred && !held) {
      await h.chat("First answer.", { replace: true });
    }
    await h.round();
    await h.finish("First answer.\n\nDone.");
    const prefix = held
      ? ["First answer.\n\nChecking again."]
      : ["First answer.", "\n\nChecking again."];
    expect(h.updates()).toEqual([...prefix, ...readUpdates, "\n\nDone."]);
  },
);

it("keeps a distinct preamble with identical text and ignores unprojected or foreign events", async () => {
  await h.chat("Answer.");
  await h.chat("", { replace: true });
  await h.preamble("legacy", "Checking.", { preamble: undefined });
  await h.preamble("foreign", "Answer.", { runId: "other-run" });
  await h.preamble("unrelated", "Answer.", { preamble: {} });
  await h.finish("Answer.");
  expect(h.updates()).toEqual(["Answer.", "Answer."]);
});
