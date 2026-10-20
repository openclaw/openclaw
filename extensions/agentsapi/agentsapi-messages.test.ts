import type { AgentHarnessAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import { expect, it } from "vitest";
import { createAttemptParams } from "./agentsapi-attempt.test-helpers.js";
import type { AgentsApiEvent, AgentsApiItem } from "./agentsapi-client.js";
import { AgentsApiMessageProjection } from "./agentsapi-messages.js";
import { createModel, createTurn } from "./agentsapi.test-support.js";

type AgentEvent = Parameters<NonNullable<AgentHarnessAttemptParamsV2["onAgentEvent"]>>[0];

it.each(["added", "done"])("projects commentary discovered at %s once", async (knownAt) => {
  const { projection, events } = createProjection();
  const item: AgentsApiItem = {
    id: "commentary-fixture",
    type: "message",
    role: "assistant",
    phase: knownAt === "added" ? "commentary" : null,
    status: "in_progress",
    turn_id: "turn-fixture",
    content: [{ type: "output_text", text: "" }],
  };
  const text = "Checking the command.\n\n    pwd";

  await projection.observe({ type: "agent.session.turn.item.added", item });
  await projection.observe({
    type: "agent.session.turn.output_text.delta",
    item_id: item.id,
    turn_id: "turn-fixture",
    content_index: 0,
    delta: text,
  });
  const completed = {
    type: "agent.session.turn.item.done",
    item: {
      ...item,
      phase: "commentary",
      status: "completed",
      content: [{ type: "output_text", text }],
    },
  } satisfies AgentsApiEvent;
  await projection.observe(completed);
  await projection.observe(completed);

  const itemId = "agentsapi:session-fixture:turn-fixture:commentary-fixture";
  const preamble = {
    itemId,
    kind: "preamble",
    title: "Preamble",
    progressText: text,
    source: "agentsapi",
  };
  const itemEvent = (phase: string) => ({ stream: "item", data: { ...preamble, phase } });
  const assistant = (outputText: string, id = itemId) => ({
    stream: "assistant",
    data: { itemId: id, text: outputText, delta: "", replace: true, replaceable: true },
  });
  expect(events).toEqual([
    ...(knownAt === "added"
      ? [itemEvent("update")]
      : [
          assistant(text),
          { stream: "assistant", data: { itemId, text: "", delta: "", replace: true } },
        ]),
    itemEvent("end"),
  ]);

  await projection.observe({
    ...completed,
    item: {
      ...completed.item,
      id: "final-fixture",
      phase: "final_answer",
      content: [{ type: "output_text", text: "Done." }],
    },
  });
  expect(events.at(-1)).toEqual(
    assistant("Done.", "agentsapi:session-fixture:turn-fixture:final-fixture"),
  );
});
it("replaces matching canonical usage while retaining omitted turns without counting them twice", async () => {
  const { projection } = createProjection();
  for (const [id, usage] of [
    ["turn-a", makeUsage(100, 20, 5, 1)],
    ["turn-b", makeUsage(50, 10, 3, 2)],
  ] as const) {
    await projection.observe({
      type: "agent.session.turn.completed",
      turn: createTurn({ id, usage }),
    });
  }
  const canonicalTurn = createTurn({ id: "turn-a", usage: makeUsage(120, 30, 6, 2) });

  const totals = { input: 130, output: 9, cacheRead: 40 };
  for (let pass = 0; pass < 2; pass++) {
    projection.recordUsage(usageModel, [canonicalTurn, canonicalTurn]);
    expect(projection.tokenUsage).toMatchObject({
      ...totals,
      reasoningTokens: 4,
      total: 179,
      contextUsage: { state: "unavailable" },
    });
    expect(projection.reply.assistantUsage).toMatchObject({ ...totals, totalTokens: 179 });
  }
});

function createProjection() {
  const events: AgentEvent[] = [];
  const emit = (event: AgentEvent) => void events.push(event);
  const params = createAttemptParams();
  const projection = new AgentsApiMessageProjection(params, "session-fixture", emit, () => {});
  return { projection, events };
}

const usageModel = createModel({ id: "model-fixture", reasoning: true });

function makeUsage(input: number, cached: number, output: number, reasoning: number) {
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: cached },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: reasoning },
    total_tokens: input + output,
  };
}
