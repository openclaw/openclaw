import type { Turn as SDKTurn } from "openai/resources/beta/agents/sessions/turns";
import type { AgentHarnessAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it } from "vitest";
import type { AgentsApiEvent, AgentsApiItem } from "./agentsapi-client.js";
import { AgentsApiMessageProjection } from "./agentsapi-messages.js";
import { createModel, createTurn } from "./agentsapi.test-support.js";

type AgentEvent = Parameters<NonNullable<AgentHarnessAttemptParamsV2["onAgentEvent"]>>[0];

describe("Agents API commentary projection", () => {
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
      const preamble = {
        itemId,
        kind: "preamble",
        title: "Preamble",
        progressText: text,
        source: "agentsapi",
      };
      expect(events).toEqual([
        ...(phaseKnownAt === "added"
          ? [{ stream: "item", data: { ...preamble, phase: "update" } }]
          : [
              {
                stream: "assistant",
                data: { itemId, text, delta: "", replaceable: true, replace: true },
              },
              { stream: "assistant", data: { itemId, text: "", delta: "", replace: true } },
            ]),
        { stream: "item", data: { ...preamble, phase: "end" } },
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
      expect(events.at(-1)).toEqual({
        stream: "assistant",
        data: {
          itemId: "agentsapi:session-fixture:turn-fixture:final-fixture",
          text: "Done.",
          delta: "",
          replaceable: true,
          replace: true,
        },
      });
    },
  );
});

describe("Agents API final usage accounting", () => {
  it("replaces matching canonical usage while retaining omitted turns without counting them twice", async () => {
    const { projection } = createProjection();
    const observedTurn = { ...createTurn(), error: null };
    await projection.observe({
      type: "agent.session.turn.completed",
      turn: { ...observedTurn, id: "turn-a", usage: observedUsageA },
    });
    await projection.observe({
      type: "agent.session.turn.completed",
      turn: { ...observedTurn, id: "turn-b", usage: observedUsageB },
    });
    const canonicalTurn = createTurn({
      id: "turn-a",
      usage: {
        input_tokens: 120,
        input_tokens_details: { cached_tokens: 30 },
        output_tokens: 6,
        output_tokens_details: { reasoning_tokens: 2 },
        total_tokens: 126,
      },
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

const observedUsageA = {
  input_tokens: 100,
  input_tokens_details: { cached_tokens: 20 },
  output_tokens: 5,
  output_tokens_details: { reasoning_tokens: 1 },
  total_tokens: 105,
} satisfies NonNullable<SDKTurn["usage"]>;

const observedUsageB = {
  input_tokens: 50,
  input_tokens_details: { cached_tokens: 10 },
  output_tokens: 3,
  output_tokens_details: { reasoning_tokens: 2 },
  total_tokens: 53,
} satisfies NonNullable<SDKTurn["usage"]>;
