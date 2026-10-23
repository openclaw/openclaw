// A `canDeliverSourceReply` tool that authored a final reply ends the turn once the
// whole tool batch settles; progress replies, errors and ordinary tools keep the
// model turn going. These tests drive the real agent loop and count provider requests.
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model,
} from "openclaw/plugin-sdk/llm";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { MessagingToolSourceReplyPayload } from "../../embedded-agent-messaging.types.js";
import { Agent, type AgentTool } from "../../runtime/index.js";
import {
  getInternalToolTurnCompletion,
  setInternalToolTurnCompletion,
} from "../../runtime/internal-hooks.js";
import { createZeroUsageFixture } from "../../test-helpers/usage-fixtures.js";
import { installToolAuthoredSourceReplyTerminalHook } from "./message-tool-terminal.js";

const finalReply = { ok: true, sourceReply: { text: "Pedido creado." } };
const progressReply = { sourceReply: { text: "Comprobando…", final: false } };

const model: Model = {
  id: "test-model",
  name: "Test Model",
  api: "openai-responses",
  provider: "test-provider",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000,
  maxTokens: 1_000,
};

type ToolPlan = {
  name: string;
  details: unknown;
  isError?: boolean;
  terminate?: boolean;
  /** Required arguments the call omits, so validation rejects it before execution. */
  rejectBeforeExecution?: boolean;
};

function assistant(
  content: AssistantMessage["content"],
): AssistantMessage & { stopReason: "toolUse" | "stop" } {
  const stopReason: "toolUse" | "stop" = content.some((entry) => entry.type === "toolCall")
    ? "toolUse"
    : "stop";
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: createZeroUsageFixture(),
    stopReason,
    timestamp: Date.now(),
  };
}

/**
 * Runs one model step that calls every planned tool in parallel. Each executing tool
 * waits on its own gate; `completionOrder` releases the gates one at a time, waiting
 * for each tool to finish before releasing the next. A second model step would answer
 * "restated".
 */
async function runBatch(params: {
  tools: ToolPlan[];
  completionOrder: string[];
  capableToolNames?: string[];
  assistantIdentity?: Pick<AssistantMessage, "responseId" | "turnId">;
  runId?: string;
  configureAgent?: (agent: Agent) => void;
}) {
  const signalsByTool = new Map(
    params.tools.map((tool) => [
      tool.name,
      { gate: createDeferred(), started: createDeferred(), finished: createDeferred() },
    ]),
  );
  const signals = (name: string) => {
    const toolSignals = signalsByTool.get(name);
    if (!toolSignals) {
      throw new Error(`no planned tool ${name}`);
    }
    return toolSignals;
  };
  const completed: string[] = [];
  const tools: AgentTool[] = params.tools.map((plan) => ({
    name: plan.name,
    label: plan.name,
    description: plan.name,
    parameters: plan.rejectBeforeExecution
      ? Type.Object({ path: Type.String() }, { additionalProperties: false })
      : Type.Object({}, { additionalProperties: false }),
    execute: async () => {
      signals(plan.name).started.resolve();
      await signals(plan.name).gate.promise;
      completed.push(plan.name);
      signals(plan.name).finished.resolve();
      if (plan.isError) {
        throw new Error(`${plan.name} failed`);
      }
      return {
        content: [{ type: "text", text: `${plan.name} done` }],
        details: plan.details,
        terminate: plan.terminate,
      };
    },
  }));
  const turns: AssistantMessage["content"][] = [
    params.tools.map((plan) => ({
      type: "toolCall",
      id: `call-${plan.name}`,
      name: plan.name,
      arguments: {},
    })),
    [{ type: "text", text: "restated" }],
  ];
  let requests = 0;
  const agent = new Agent({
    initialState: { model, tools },
    streamFn: () => {
      const content = turns[requests];
      requests += 1;
      if (!content) {
        throw new Error(`unexpected provider request ${requests}`);
      }
      const message = { ...assistant(content), ...params.assistantIdentity };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: "done", reason: message.stopReason, message });
        stream.end();
      });
      return stream;
    },
  });
  params.configureAgent?.(agent);
  const replies: MessagingToolSourceReplyPayload[] = [];
  installToolAuthoredSourceReplyTerminalHook({
    agent,
    idempotencyScope: params.runId ?? "run-test",
    onSourceReplies: (payloads) => replies.push(...payloads),
    sourceReplyCapableToolNames: new Set(params.capableToolNames ?? ["order_confirm"]),
  });
  const run = agent.prompt("confirm the order");
  const executing = params.tools.filter((plan) => !plan.rejectBeforeExecution);
  await Promise.all(executing.map((plan) => signals(plan.name).started.promise));
  for (const name of params.completionOrder) {
    signals(name).gate.resolve();
    await signals(name).finished.promise;
  }
  await run;
  return { requests, completed, replies };
}

describe("tool-authored source reply turn completion", () => {
  it("keeps reused call IDs distinct across assistant turns and stable across recovery runs", async () => {
    const replies: MessagingToolSourceReplyPayload[] = [];
    for (const [runId, turnId, responseId] of [
      ["run-first", "persisted-1", "response-1"],
      ["run-first", "persisted-2", "response-2"],
      ["run-recovery", "persisted-1", "response-1"],
      ["run-without-response-id", "persisted-3", undefined],
      ["run-response-only", undefined, "response-4"],
    ] as const) {
      const run = await runBatch({
        tools: [{ name: "order_confirm", details: finalReply }],
        completionOrder: ["order_confirm"],
        assistantIdentity: { turnId, responseId },
        runId,
      });
      expect(run.requests).toBe(1);
      replies.push(...run.replies);
    }
    expect(replies.map((reply) => reply.idempotencyKey)).toEqual([
      "response-1:tool-source-reply:call-order_confirm",
      "response-2:tool-source-reply:call-order_confirm",
      "response-1:tool-source-reply:call-order_confirm",
      "persisted-3:tool-source-reply:call-order_confirm",
      "response-4:tool-source-reply:call-order_confirm",
    ]);
    expect(replies.map((reply) => reply.toolAuthoredForTurnId)).toEqual([
      "response-1",
      "response-2",
      "response-1",
      "persisted-3",
      "response-4",
    ]);
  });
  it.each([
    { terminate: true, capable: false },
    { terminate: false, capable: false },
    { terminate: true, capable: true },
    { terminate: false, capable: true },
  ])(
    "retains a final reply beside a terminal sibling (authored terminate=$terminate, capable=$capable)",
    async ({ terminate, capable }) => {
      const run = await runBatch({
        tools: [
          { name: "order_confirm", details: finalReply, terminate },
          { name: "handoff", details: { ok: true }, terminate: true },
        ],
        completionOrder: ["order_confirm", "handoff"],
        capableToolNames: capable ? ["order_confirm", "handoff"] : ["order_confirm"],
      });
      expect(run.requests).toBe(1);
      expect(run.replies).toEqual([
        expect.objectContaining({ text: "Pedido creado.", toolAuthored: true }),
      ]);
    },
  );

  it.each([progressReply, { ok: false }])(
    "does not admit a partial reply beside a terminal sibling with %j",
    async (details) => {
      const run = await runBatch({
        tools: [
          { name: "order_confirm", details: finalReply },
          { name: "handoff", details, terminate: true },
        ],
        capableToolNames: ["order_confirm", "handoff"],
        completionOrder: ["handoff", "order_confirm"],
      });
      expect(run.requests).toBe(2);
      expect(run.replies).toEqual([]);
    },
  );

  it.each([
    { order: ["order_confirm", "crm_note"], label: "the capable tool finishes first" },
    { order: ["crm_note", "order_confirm"], label: "the ordinary tool finishes first" },
  ])("keeps the model responsible for an unhandled sibling when $label", async ({ order }) => {
    const run = await runBatch({
      tools: [
        { name: "order_confirm", details: finalReply },
        { name: "crm_note", details: { ok: true } },
      ],
      completionOrder: order,
    });

    expect(run.completed).toEqual(order);
    expect(run.requests).toBe(2);
    expect(run.replies).toEqual([]);
  });

  it.each([
    { label: "a progress reply", plan: { name: "stock_check", details: progressReply } },
    { label: "an error", plan: { name: "stock_check", details: {}, isError: true } },
    { label: "ordinary details", plan: { name: "stock_check", details: { ok: true } } },
  ])("continues when a second capable tool in the batch returns $label", async ({ plan }) => {
    const run = await runBatch({
      tools: [{ name: "order_confirm", details: finalReply }, plan],
      completionOrder: ["order_confirm", "stock_check"],
      capableToolNames: ["order_confirm", "stock_check"],
    });

    expect(run.completed).toEqual(["order_confirm", "stock_check"]);
    expect(run.requests).toBe(2);
    expect(run.replies).toEqual([]);
  });

  it("continues when another call is rejected before it executes", async () => {
    const run = await runBatch({
      tools: [
        { name: "order_confirm", details: finalReply },
        { name: "file_read", details: {}, rejectBeforeExecution: true },
      ],
      completionOrder: ["order_confirm"],
    });

    expect(run.completed).toEqual(["order_confirm"]);
    expect(run.requests).toBe(2);
    expect(run.replies).toEqual([]);
  });

  it.each([
    { label: "authored a progress reply", details: progressReply, isError: false },
    { label: "failed", details: finalReply, isError: true },
    { label: "reported ok: false", details: { ...finalReply, ok: false }, isError: false },
    { label: "returned no source reply", details: { ok: true }, isError: false },
    {
      label: "returned only blank media",
      details: { sourceReply: { mediaUrls: ["", "  "] } },
      isError: false,
    },
  ])("lets the model continue when the capable tool $label", async ({ details, isError }) => {
    const run = await runBatch({
      tools: [
        { name: "order_confirm", details, isError },
        { name: "crm_note", details: { ok: true } },
      ],
      completionOrder: ["order_confirm", "crm_note"],
    });

    expect(run.requests).toBe(2);
  });

  it("lets the model continue for a tool without the capability", async () => {
    const run = await runBatch({
      tools: [{ name: "order_confirm", details: finalReply }],
      completionOrder: ["order_confirm"],
      capableToolNames: ["other_tool"],
    });

    expect(run.requests).toBe(2);
  });

  it("commits every final reply only after all capable siblings settle", async () => {
    const run = await runBatch({
      tools: [
        { name: "order_confirm", details: finalReply },
        { name: "stock_check", details: { sourceReply: { text: "Stock reserved." } } },
      ],
      capableToolNames: ["order_confirm", "stock_check"],
      completionOrder: ["stock_check", "order_confirm"],
    });
    expect(run.requests).toBe(1);
    expect(
      run.replies
        .map((reply) => reply.text)
        .toSorted((left, right) => (left ?? "").localeCompare(right ?? "")),
    ).toEqual(["Pedido creado.", "Stock reserved."]);
  });

  it("matches a capable tool by its policy-normalized name", async () => {
    const run = await runBatch({
      tools: [{ name: "Order_Confirm", details: finalReply }],
      completionOrder: ["Order_Confirm"],
      capableToolNames: ["order_confirm"],
    });

    expect(run.requests).toBe(1);
  });

  it("reads the result after afterToolCall hooks, so a hook can withdraw the reply", async () => {
    const run = await runBatch({
      tools: [{ name: "order_confirm", details: finalReply }],
      completionOrder: ["order_confirm"],
      configureAgent: (agent) => {
        agent.afterToolCall = async () => ({ details: { redacted: true } });
      },
    });

    expect(run.requests).toBe(2);
  });

  it.each(["tool", "previous-hook"] as const)(
    "captures a reply even when %s already completes the turn",
    async (owner) => {
      const run = await runBatch({
        tools: [{ name: "order_confirm", details: finalReply, terminate: owner === "tool" }],
        completionOrder: ["order_confirm"],
        configureAgent:
          owner === "previous-hook"
            ? (agent) => setInternalToolTurnCompletion(agent, () => true)
            : undefined,
      });
      expect(run.requests).toBe(1);
      expect(run.replies).toEqual([
        expect.objectContaining({ text: "Pedido creado.", toolAuthored: true }),
      ]);
    },
  );

  it("keeps an earlier turn-completion hook in charge", async () => {
    const run = await runBatch({
      tools: [{ name: "crm_note", details: { ok: true } }],
      completionOrder: ["crm_note"],
      configureAgent: (agent) => {
        setInternalToolTurnCompletion(agent, () => true);
      },
    });

    expect(run.requests).toBe(1);
  });

  it("installs nothing when no tool is capable", () => {
    const agent = new Agent({ initialState: { model } });
    installToolAuthoredSourceReplyTerminalHook({
      agent,
      sourceReplyCapableToolNames: new Set(),
      idempotencyScope: "run-test",
      onSourceReplies: () => {},
    });
    expect(getInternalToolTurnCompletion(agent)).toBeUndefined();
  });
});
