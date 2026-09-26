import type { Turn as SDKTurn } from "openai/resources/beta/agents/sessions/turns";
import type { AgentHarnessAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it } from "vitest";
import type { AgentsApiEvent, AgentsApiItem } from "./agentsapi-client.js";
import { AgentsApiMessageProjection } from "./agentsapi-messages.js";

type AgentEvent = Parameters<NonNullable<AgentHarnessAttemptParamsV2["onAgentEvent"]>>[0];

describe("Agents API commentary projection", () => {
  it("completes commentary after an identical final delta without replaying completion", async () => {
    const { projection, events } = createProjection();
    const item: AgentsApiItem = {
      id: "commentary-fixture",
      type: "message",
      role: "assistant",
      phase: "commentary",
      status: "in_progress",
      turn_id: "turn-fixture",
      content: [{ type: "output_text", text: "" }],
    };
    const text = "Checking the command.";

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
        status: "completed",
        content: [{ type: "output_text", text }],
      },
    };
    await projection.observe(completed);
    await projection.observe(completed);

    expect(events).toEqual([
      {
        stream: "item",
        data: {
          itemId: "agentsapi:session-fixture:turn-fixture:commentary-fixture",
          kind: "preamble",
          title: "Preamble",
          phase: "update",
          progressText: text,
          source: "agentsapi",
        },
      },
      {
        stream: "item",
        data: {
          itemId: "agentsapi:session-fixture:turn-fixture:commentary-fixture",
          kind: "preamble",
          title: "Preamble",
          phase: "end",
          progressText: text,
          source: "agentsapi",
        },
      },
    ]);
  });
});

describe("Agents API final usage accounting", () => {
  it("retains completed-turn usage when final REST accounting returns no turns", async () => {
    const { projection } = createProjection();
    await projection.observe({
      type: "agent.session.turn.completed",
      turn: createTurn("turn-a", observedUsageA),
    });
    await projection.observe({
      type: "agent.session.turn.completed",
      turn: createTurn("turn-b", observedUsageB),
    });

    projection.recordUsage(usageModel, []);

    expect(projection.tokenUsage).toMatchObject({
      input: 120,
      output: 8,
      cacheRead: 30,
      reasoningTokens: 3,
      total: 158,
      contextUsage: { state: "unavailable" },
    });
    expect(projection.reply.assistantUsage).toMatchObject({
      input: 120,
      output: 8,
      cacheRead: 30,
      totalTokens: 158,
    });
  });

  it("replaces matching canonical usage while retaining omitted turns without counting them twice", async () => {
    const { projection } = createProjection();
    await projection.observe({
      type: "agent.session.turn.completed",
      turn: createTurn("turn-a", observedUsageA),
    });
    await projection.observe({
      type: "agent.session.turn.completed",
      turn: createTurn("turn-b", observedUsageB),
    });
    const canonicalTurn = createTurn("turn-a", {
      input_tokens: 120,
      input_tokens_details: { cached_tokens: 30 },
      output_tokens: 6,
      output_tokens_details: { reasoning_tokens: 2 },
      total_tokens: 126,
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

function createTurn(id: string, usage: typeof observedUsageA) {
  return {
    id,
    agent_id: "agent-fixture",
    session_id: "session-fixture",
    object: "agent.session.turn",
    created_at: 1,
    started_at: 1,
    completed_at: 2,
    status: "completed",
    subagent_id: null,
    error: null,
    usage,
  } satisfies SDKTurn;
}

const usageModel = {
  id: "model-fixture",
  name: "Fixture Model",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1024,
  maxTokens: 512,
} satisfies AgentHarnessAttemptParamsV2["model"];

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
