import type { Turn as SDKTurn } from "openai/resources/beta/agents/sessions/turns";
import type { AgentHarnessAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import { expect, it } from "vitest";
import type { AgentsApiEvent, AgentsApiItem } from "./agentsapi-client.js";
import { AgentsApiMessageProjection } from "./agentsapi-messages.js";
import { createModel, createTurn } from "./agentsapi.test-support.js";

type AgentEvent = Parameters<NonNullable<AgentHarnessAttemptParamsV2["onAgentEvent"]>>[0];

it.each(["added", "done"])(
  "hands off commentary identified at item.%s once",
  async (phaseKnownAt) => {
    const { projection, events } = createProjection();
    const item: AgentsApiItem = {
      id: "commentary-fixture",
      type: "message",
      role: "assistant",
      phase: phaseKnownAt === "added" ? "commentary" : null,
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
    const completed: AgentsApiEvent = {
      type: "agent.session.turn.item.done",
      item: {
        ...item,
        phase: "commentary",
        status: "completed",
        content: [{ type: "output_text", text }],
      },
    };
    await projection.observe(completed);
    await projection.observe(completed);

    const itemId = "agentsapi:session-fixture:turn-fixture:commentary-fixture";
    const preamble = (phase: string) => ({
      stream: "item",
      data: {
        itemId,
        kind: "preamble",
        title: "Preamble",
        progressText: text,
        source: "agentsapi",
        phase,
      },
    });
    const assistant = (outputText: string, id: string, replaceable = true) => ({
      stream: "assistant",
      data: {
        itemId: id,
        text: outputText,
        delta: "",
        replace: true,
        ...(replaceable ? { replaceable: true } : {}),
      },
    });
    expect(events).toEqual([
      ...(phaseKnownAt === "added"
        ? [preamble("update")]
        : [assistant(text, itemId), assistant("", itemId, false)]),
      preamble("end"),
    ]);

    await projection.observe({
      type: "agent.session.turn.item.done",
      item: {
        ...item,
        id: "final-fixture",
        phase: "final_answer",
        status: "completed",
        content: [{ type: "output_text", text: "Done." }],
      },
    });
    expect(events.at(-1)).toEqual(
      assistant("Done.", "agentsapi:session-fixture:turn-fixture:final-fixture"),
    );
  },
);
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
  const canonicalTurn = createTurn({
    id: "turn-a",
    usage: makeUsage(120, 30, 6, 2),
  });

  projection.recordUsage(usageModel, [canonicalTurn, canonicalTurn]);

  const expected = {
    input: 130,
    output: 9,
    cacheRead: 40,
    reasoningTokens: 4,
    total: 179,
    contextUsage: { state: "unavailable" },
  };
  expect(projection.tokenUsage).toMatchObject(expected);
  expect(projection.reply.assistantUsage).toMatchObject({
    input: 130,
    output: 9,
    cacheRead: 40,
    totalTokens: 179,
  });

  projection.recordUsage(usageModel, [canonicalTurn, canonicalTurn]);
  expect(projection.tokenUsage).toMatchObject(expected);
  expect(projection.reply.assistantUsage).toMatchObject({ totalTokens: 179 });
});

function createProjection() {
  const events: AgentEvent[] = [];
  // Observation needs no auth or transcript operations; final accounting receives the model.
  const params = {} as AgentHarnessAttemptParamsV2;
  const projection = new AgentsApiMessageProjection(
    params,
    "session-fixture",
    (event) => {
      events.push(event);
    },
    () => {},
  );
  return { projection, events };
}

const usageModel = createModel({ id: "model-fixture", reasoning: true });

function makeUsage(
  input: number,
  cached: number,
  output: number,
  reasoning: number,
): NonNullable<SDKTurn["usage"]> {
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: cached },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: reasoning },
    total_tokens: input + output,
  };
}
