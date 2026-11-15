import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { setInternalToolTurnCompletion } from "../../../../packages/agent-core/src/internal-hooks.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { MessagingToolSourceReplyPayload } from "../../embedded-agent-messaging.types.js";
import { Agent, type AgentTool } from "../../runtime/index.js";
import { installToolAuthoredSourceReplyTerminalHook } from "./message-tool-terminal.js";
import {
  createTerminalTestModel,
  terminalResponse,
  terminalToolCall,
} from "./message-tool-terminal.test-support.js";

const finalReply = { ok: true, sourceReply: { text: "Pedido creado." } };
const progressReply = { sourceReply: { text: "Comprobando…", final: false } };

const model = createTerminalTestModel();

type ToolPlan = {
  name: string;
  details: unknown;
  isError?: boolean;
  terminate?: boolean;
  /** Required arguments the call omits, so validation rejects it before execution. */
  rejectBeforeExecution?: boolean;
};

// Release parallel calls one at a time to exercise batch settlement in either order.
async function runBatch(params: {
  tools?: ToolPlan[];
  sibling?: ToolPlan;
  completionOrder?: string[];
  capableToolNames?: string[];
  assistantIdentity?: Pick<AssistantMessage, "responseId" | "turnId">;
  runId?: string;
  configureAgent?: (agent: Agent) => void;
}) {
  const plans = params.tools ?? [
    { name: "order_confirm", details: finalReply },
    ...(params.sibling ? [params.sibling] : []),
  ];
  const executing = plans.filter((plan) => !plan.rejectBeforeExecution);
  const signalsByTool = new Map(
    plans.map((tool) => [
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
  const tools: AgentTool[] = plans.map((plan) => ({
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
    plans.map((plan) => terminalToolCall(plan.name, `call-${plan.name}`)),
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
      return terminalResponse(
        content,
        content.some((entry) => entry.type === "toolCall") ? "toolUse" : "stop",
        params.assistantIdentity,
      );
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
  await Promise.all(executing.map((plan) => signals(plan.name).started.promise));
  for (const name of params.completionOrder ?? executing.map((plan) => plan.name)) {
    signals(name).gate.resolve();
    await signals(name).finished.promise;
  }
  await run;
  return { requests, completed, replies };
}

function expectContinuation(run: Awaited<ReturnType<typeof runBatch>>, completed?: string[]) {
  expect(run.requests).toBe(2);
  expect(run.replies).toEqual([]);
  if (completed) {
    expect(run.completed).toEqual(completed);
  }
}

function expectFinal(run: Awaited<ReturnType<typeof runBatch>>) {
  expect(run.requests).toBe(1);
  expect(run.replies).toEqual([
    expect.objectContaining({ text: "Pedido creado.", toolAuthored: true }),
  ]);
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
        assistantIdentity: { turnId, responseId },
        runId,
      });
      expect(run.requests).toBe(1);
      replies.push(...run.replies);
    }
    const identities = ["response-1", "response-2", "response-1", "persisted-3", "response-4"];
    expect(replies.map((reply) => reply.idempotencyKey)).toEqual(
      identities.map((identity) => `${identity}:tool-source-reply:call-order_confirm`),
    );
    expect(replies.map((reply) => reply.toolAuthoredForTurnId)).toEqual(identities);
  });
  it.each([
    [false, false],
    [true, true],
  ])(
    "retains a final reply beside a terminal sibling (authored terminate=%s, capable=%s)",
    async (terminate, capable) => {
      const run = await runBatch({
        tools: [
          { name: "order_confirm", details: finalReply, terminate },
          { name: "handoff", details: { ok: true }, terminate: true },
        ],
        capableToolNames: capable ? ["order_confirm", "handoff"] : ["order_confirm"],
      });
      expectFinal(run);
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
      expectContinuation(run);
    },
  );

  it.each([
    ["order_confirm", "crm_note"],
    ["crm_note", "order_confirm"],
  ])(
    "keeps the model responsible for an unhandled sibling finishing %s then %s",
    async (...order) => {
      const run = await runBatch({
        sibling: { name: "crm_note", details: { ok: true } },
        completionOrder: order,
      });

      expectContinuation(run, order);
    },
  );

  it.each([
    ["a progress reply", progressReply, false],
    ["an error", finalReply, true],
    ["ordinary details", { ok: true }, false],
    ["ok: false", { ...finalReply, ok: false }, false],
    ["blank media", { sourceReply: { mediaUrls: ["", "  "] } }, false],
  ] satisfies [string, unknown, boolean][])(
    "continues when a second capable tool returns %s",
    async (_label, details, isError) => {
      const run = await runBatch({
        sibling: { name: "stock_check", details, isError },
        capableToolNames: ["order_confirm", "stock_check"],
      });

      expectContinuation(run, ["order_confirm", "stock_check"]);
    },
  );

  it("continues when another call is rejected before it executes", async () => {
    const run = await runBatch({
      sibling: { name: "file_read", details: {}, rejectBeforeExecution: true },
    });

    expectContinuation(run, ["order_confirm"]);
  });

  it.each([{ capableToolNames: [] }, { capableToolNames: ["other_tool"] }])(
    "continues when the tool is not capable ($capableToolNames)",
    async ({ capableToolNames }) => {
      expect((await runBatch({ capableToolNames })).requests).toBe(2);
    },
  );

  it("commits every final reply only after all capable siblings settle", async () => {
    const run = await runBatch({
      tools: [
        { name: "Order_Confirm", details: finalReply },
        { name: "stock_check", details: { sourceReply: { text: "Stock reserved." } } },
      ],
      capableToolNames: ["order_confirm", "stock_check"],
      completionOrder: ["stock_check", "Order_Confirm"],
    });
    expect(run.requests).toBe(1);
    expect(
      run.replies
        .map((reply) => reply.text)
        .toSorted((left, right) => (left ?? "").localeCompare(right ?? "")),
    ).toEqual(["Pedido creado.", "Stock reserved."]);
  });

  it("reads the result after afterToolCall hooks, so a hook can withdraw the reply", async () => {
    const run = await runBatch({
      configureAgent: (agent) => {
        agent.afterToolCall = async () => ({ details: { redacted: true } });
      },
    });

    expect(run.requests).toBe(2);
  });

  it("captures a reply even when the previous hook already completes the turn", async () => {
    const run = await runBatch({
      configureAgent: (agent) => setInternalToolTurnCompletion(agent, () => true),
    });
    expectFinal(run);
  });

  it("keeps an earlier turn-completion hook in charge", async () => {
    const run = await runBatch({
      tools: [{ name: "crm_note", details: { ok: true } }],
      configureAgent: (agent) => {
        setInternalToolTurnCompletion(agent, () => true);
      },
    });

    expect(run.requests).toBe(1);
  });
});
