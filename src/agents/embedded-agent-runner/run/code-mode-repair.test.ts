import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Message,
  type Model,
} from "openclaw/plugin-sdk/llm";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { createAgentExecutionAttribution } from "../../agent-execution-attribution.js";
import { bindToolExecutionAttribution } from "../../agent-tools.before-tool-call.attribution.js";
import { wrapToolWithBeforeToolCallHook } from "../../agent-tools.before-tool-call.wrapper.js";
import { CODE_MODE_REPAIR_EVIDENCE } from "../../code-mode-repair-evidence.js";
import {
  Agent,
  type AfterToolOutcomeContext,
  type AgentTool,
  type AgentToolResult,
} from "../../runtime/index.js";
import { setInternalBeforeToolBatch } from "../../runtime/internal-hooks.js";
import { hasUnsafeToolExecutionAuthority } from "../../tool-side-effect-authority.js";
import type { AnyAgentTool } from "../../tools/common.js";
import { installCodeModeRepairHook } from "./code-mode-repair.js";

const model: Model = {
  id: "test-model",
  name: "Test Model",
  api: "test-api",
  provider: "test-provider",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 1000,
};

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantMessage(
  content: AssistantMessage["content"],
  timestamp: number,
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage,
    stopReason: content.some((entry) => entry.type === "toolCall") ? "toolUse" : "stop",
    timestamp,
  };
}

function streamDoneReason(message: AssistantMessage): "toolUse" | "stop" {
  return message.stopReason === "toolUse" ? "toolUse" : "stop";
}

function outcome(params: {
  assistantMessage?: AfterToolOutcomeContext["assistantMessage"];
  toolCallId?: string;
  toolName?: string;
  result: AgentToolResult<unknown>;
  isError?: boolean;
  executionStarted?: boolean;
  errorKind?: "argument-validation";
}): AfterToolOutcomeContext {
  const toolCall = {
    type: "toolCall" as const,
    id: params.toolCallId ?? "call-1",
    name: params.toolName ?? "exec",
    arguments: {},
  };
  return {
    assistantMessage:
      params.assistantMessage ??
      ({
        role: "assistant",
        content: [toolCall],
        timestamp: 1,
      } as unknown as AfterToolOutcomeContext["assistantMessage"]),
    toolCall,
    args: {},
    result: params.result,
    isError: params.isError ?? false,
    executionStarted: params.executionStarted ?? true,
    ...(params.errorKind ? { errorKind: params.errorKind } : {}),
    context: { systemPrompt: "", messages: [], tools: [] },
  } as unknown as AfterToolOutcomeContext;
}

function failedResult(params?: {
  bridgeDispatchStarted?: boolean;
  code?: string;
  failurePhase?: "input" | "guest" | "bridge" | "host";
  output?: unknown[];
  trustedPreflight?: boolean;
}): AgentToolResult<unknown> {
  const details: Record<PropertyKey, unknown> = {
    status: "failed",
    code: params?.code ?? "internal_error",
    error: "guest failed",
    failurePhase: params?.failurePhase ?? "guest",
    bridgeDispatchStarted: params?.bridgeDispatchStarted ?? false,
    ...(params?.output ? { output: params.output } : {}),
  };
  if (params?.trustedPreflight) {
    Object.defineProperty(details, CODE_MODE_REPAIR_EVIDENCE, { value: true });
  }
  return {
    content: [{ type: "text", text: JSON.stringify(details) }],
    details,
  };
}

function completedResult(): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text: '{"status":"completed","value":42}' }],
    details: { status: "completed", value: 42 },
  };
}

function toolLoopBlockedResult(params?: {
  triggerId?: string;
  triggerName?: string;
}): AgentToolResult<unknown> {
  const triggerId = params?.triggerId ?? "call-1";
  const triggerName = params?.triggerName ?? "exec";
  return {
    content: [{ type: "text", text: "choose a different action" }],
    details: {
      status: "blocked",
      deniedReason: "tool-loop",
      intervention: {
        kind: "critical-tool-loop",
        toolCallId: triggerId,
        toolName: triggerName,
        actionKey: `${triggerName}:repeated`,
        detector: "generic_repeat",
        count: 20,
        reason: "critical repeated action",
      },
    },
  };
}

function createAgent(params?: {
  hasPotentialSideEffects?: () => boolean;
  previousBefore?: Agent["beforeToolCall"];
  previous?: Agent["afterToolOutcome"];
}): Agent {
  const agent = {
    beforeToolCall: params?.previousBefore,
    afterToolOutcome: params?.previous,
  } as Agent;
  installCodeModeRepairHook({
    agent,
    hasPotentialSideEffects: params?.hasPotentialSideEffects ?? (() => false),
  });
  return agent;
}

async function runCorrectiveBatch(
  correctiveContent: AssistantMessage["content"],
  options?: {
    previousBefore?: Agent["beforeToolCall"];
  },
): Promise<{ executedCallIds: string[]; turns: number }> {
  const executedCallIds: string[] = [];
  const execTool: AgentTool = {
    name: "exec",
    label: "exec",
    description: "Code Mode exec test tool",
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: async (toolCallId) => {
      executedCallIds.push(toolCallId);
      return toolCallId === "origin" ? failedResult({ trustedPreflight: true }) : completedResult();
    },
  };
  let turns = 0;
  const agent = new Agent({
    initialState: { model, tools: [execTool] },
    convertToLlm: (messages) => messages as Message[],
    toolExecution: "parallel",
    beforeToolCall: options?.previousBefore,
    streamFn: () => {
      turns += 1;
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const message =
          turns === 1
            ? assistantMessage(
                [{ type: "toolCall", id: "origin", name: "exec", arguments: {} }],
                turns,
              )
            : assistantMessage(correctiveContent, turns);
        stream.push({ type: "done", reason: streamDoneReason(message), message });
        stream.end();
      });
      return stream;
    },
  });
  installCodeModeRepairHook({ agent, hasPotentialSideEffects: () => false });

  await agent.prompt("run");
  return { executedCallIds, turns };
}

async function runCorrectiveBatchAfterToolLoopIntervention(
  correctiveContent: AssistantMessage["content"],
  options?: {
    interventionContent?: AssistantMessage["content"];
    previous?: Agent["afterToolOutcome"];
  },
): Promise<{ executedCallIds: string[]; turns: number }> {
  const executedCallIds: string[] = [];
  const execTool: AgentTool = {
    name: "exec",
    label: "exec",
    description: "Code Mode exec test tool",
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: async (toolCallId) => {
      executedCallIds.push(toolCallId);
      return toolCallId === "origin" ? failedResult({ trustedPreflight: true }) : completedResult();
    },
  };
  const otherTool: AgentTool = {
    name: "other",
    label: "other",
    description: "Other test tool",
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: async (toolCallId) => {
      executedCallIds.push(toolCallId);
      return completedResult();
    },
  };
  let turns = 0;
  const agent = new Agent({
    initialState: { model, tools: [execTool, otherTool] },
    convertToLlm: (messages) => messages as Message[],
    toolExecution: "parallel",
    afterToolOutcome: options?.previous,
    streamFn: () => {
      turns += 1;
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const message =
          turns === 1
            ? assistantMessage(
                [{ type: "toolCall", id: "origin", name: "exec", arguments: {} }],
                turns,
              )
            : turns === 2
              ? assistantMessage(
                  options?.interventionContent ?? [
                    {
                      type: "toolCall",
                      id: "loop-intervention",
                      name: "exec",
                      arguments: {},
                    },
                  ],
                  turns,
                )
              : turns === 3
                ? assistantMessage(correctiveContent, turns)
                : assistantMessage([{ type: "text", text: "done" }], turns);
        stream.push({ type: "done", reason: streamDoneReason(message), message });
        stream.end();
      });
      return stream;
    },
  });
  setInternalBeforeToolBatch(agent, async ({ calls }) => {
    const trigger = calls.find(
      (call) => call.toolCall.id === "loop-intervention" || call.toolCall.id === "loop-trigger",
    );
    return trigger
      ? {
          intervention: {
            kind: "critical-tool-loop",
            toolCallId: trigger.toolCall.id,
            toolName: trigger.toolCall.name,
            actionKey: "exec:loop-intervention",
            detector: "generic_repeat",
            count: 20,
            reason: "critical repeated action",
          },
        }
      : undefined;
  });
  installCodeModeRepairHook({ agent, hasPotentialSideEffects: () => false });

  await agent.prompt("run");
  return { executedCallIds, turns };
}

async function runSiblingAuthorityRace(
  siblingName: "read" | "write",
): Promise<{ executedCallIds: string[]; authorityChecks: number }> {
  const execution = createAgentExecutionAttribution({
    runId: `run-${siblingName}`,
    lifecycleGeneration: "generation-1",
  });
  const hookContext = bindToolExecutionAttribution({}, execution);
  let releasePreparation = () => {};
  const preparationGate = new Promise<void>((resolve) => {
    releasePreparation = resolve;
  });
  const executedCallIds: string[] = [];
  const execTool: AgentTool = {
    name: "exec",
    label: "exec",
    description: "Code Mode exec test tool",
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: async (toolCallId) => {
      executedCallIds.push(toolCallId);
      return toolCallId === "origin" ? failedResult({ trustedPreflight: true }) : completedResult();
    },
  };
  const siblingSource: AnyAgentTool = {
    name: siblingName,
    label: siblingName,
    description: `${siblingName} sibling`,
    parameters: Type.Object({}, { additionalProperties: false }),
    prepareBeforeToolCallParams: async (params) => {
      await preparationGate;
      return params;
    },
    execute: async (toolCallId) => {
      executedCallIds.push(toolCallId);
      return completedResult();
    },
  };
  const sibling = wrapToolWithBeforeToolCallHook(siblingSource, hookContext, {
    emitDiagnostics: false,
  });
  let turns = 0;
  let authorityChecks = 0;
  const agent = new Agent({
    initialState: { model, tools: [execTool, sibling] },
    convertToLlm: (messages) => messages as Message[],
    toolExecution: "parallel",
    streamFn: () => {
      turns += 1;
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const message =
          turns === 1
            ? assistantMessage(
                [
                  { type: "toolCall", id: "origin", name: "exec", arguments: {} },
                  { type: "toolCall", id: "sibling", name: siblingName, arguments: {} },
                ],
                turns,
              )
            : turns === 2
              ? assistantMessage(
                  [{ type: "toolCall", id: "repair-singleton", name: "exec", arguments: {} }],
                  turns,
                )
              : assistantMessage([{ type: "text", text: "done" }], turns);
        stream.push({ type: "done", reason: streamDoneReason(message), message });
        stream.end();
      });
      return stream;
    },
  });
  installCodeModeRepairHook({
    agent,
    hasPotentialSideEffects: () => {
      authorityChecks += 1;
      if (authorityChecks === 1) {
        releasePreparation();
      }
      return hasUnsafeToolExecutionAuthority(execution);
    },
  });

  await agent.prompt("run");
  return { executedCallIds, authorityChecks };
}

function expectRepair(
  result: Awaited<ReturnType<NonNullable<Agent["afterToolOutcome"]>>>,
  allowed: boolean,
) {
  expect(result).toMatchObject({
    isError: true,
    terminate: !allowed,
    details: {
      repair: {
        allowed,
        remainingAttempts: allowed ? 1 : 0,
      },
    },
  });
}

describe("installCodeModeRepairHook", () => {
  it("fails closed for outer argument validation without authenticated bridge evidence", async () => {
    const agent = createAgent();
    const result = await agent.afterToolOutcome?.(
      outcome({
        result: { content: [{ type: "text", text: "code is required" }], details: {} },
        isError: true,
        executionStarted: false,
        errorKind: "argument-validation",
      }),
    );

    expectRepair(result, false);
    expect(result).toMatchObject({
      details: { code: "invalid_input", failurePhase: "input" },
    });
  });

  it("fails closed for ordinary guest failures without authenticated bridge evidence", async () => {
    const agent = createAgent();

    expectRepair(await agent.afterToolOutcome?.(outcome({ result: failedResult() })), false);
  });

  it("offers exactly one repair for an authenticated preflight failure", async () => {
    const agent = createAgent();

    expectRepair(
      await agent.afterToolOutcome?.(outcome({ result: failedResult({ trustedPreflight: true }) })),
      true,
    );
    expectRepair(
      await agent.afterToolOutcome?.(outcome({ result: failedResult({ trustedPreflight: true }) })),
      false,
    );
  });

  it("does not spend the repair token on successful pure computation", async () => {
    const agent = createAgent();

    await expect(
      agent.afterToolOutcome?.(outcome({ result: completedResult() })),
    ).resolves.toBeUndefined();
    expectRepair(
      await agent.afterToolOutcome?.(outcome({ result: failedResult({ trustedPreflight: true }) })),
      true,
    );
  });

  it("leaves tool-loop recovery to agent core without spending repair", async () => {
    const agent = createAgent();

    await expect(
      agent.afterToolOutcome?.(
        outcome({
          result: toolLoopBlockedResult(),
          isError: true,
          executionStarted: false,
        }),
      ),
    ).resolves.toBeUndefined();
    expectRepair(
      await agent.afterToolOutcome?.(outcome({ result: failedResult({ trustedPreflight: true }) })),
      true,
    );
  });

  it.each([
    {
      label: "two exec calls",
      content: [
        { type: "toolCall" as const, id: "repair-1", name: "exec", arguments: {} },
        { type: "toolCall" as const, id: "repair-2", name: "exec", arguments: {} },
      ],
    },
    {
      label: "exec plus another tool",
      content: [
        { type: "toolCall" as const, id: "repair-exec", name: "exec", arguments: {} },
        { type: "toolCall" as const, id: "repair-other", name: "other", arguments: {} },
      ],
    },
  ])(
    "rejects every corrective body in $label after a real tool-loop intervention",
    async ({ content }) => {
      const result = await runCorrectiveBatchAfterToolLoopIntervention(content);

      expect(result.executedCallIds).toEqual(["origin"]);
    },
  );

  it("admits a singleton repair after a real tool-loop intervention", async () => {
    const result = await runCorrectiveBatchAfterToolLoopIntervention([
      { type: "toolCall", id: "repair-singleton", name: "exec", arguments: {} },
    ]);

    expect(result.executedCallIds).toEqual(["origin", "repair-singleton"]);
  });

  it.each([
    { label: "throwing trigger first", throwId: "loop-trigger" },
    { label: "throwing sibling second", throwId: "loop-sibling" },
  ])(
    "keeps the repair singleton gate after a mixed $label intervention batch",
    async ({ throwId }) => {
      const result = await runCorrectiveBatchAfterToolLoopIntervention(
        [
          { type: "toolCall", id: "repair-1", name: "exec", arguments: {} },
          { type: "toolCall", id: "repair-2", name: "exec", arguments: {} },
        ],
        {
          interventionContent: [
            { type: "toolCall", id: "loop-trigger", name: "exec", arguments: {} },
            { type: "toolCall", id: "loop-sibling", name: "exec", arguments: {} },
          ],
          previous: vi.fn(async (context) => {
            if (context.toolCall.id === throwId) {
              throw new Error(`hook exploded for ${throwId}`);
            }
            return undefined;
          }),
        },
      );

      expect(result.executedCallIds).toEqual(["origin"]);
    },
  );

  it("returns a prior synthetic-loop decision exactly without consuming repair", async () => {
    const prior = { terminate: true as const };
    const previous = vi.fn(async (context: AfterToolOutcomeContext) =>
      context.toolCall.id === "loop-trigger" ? prior : undefined,
    );
    const agent = createAgent({ previous });

    expectRepair(
      await agent.afterToolOutcome?.(
        outcome({
          toolCallId: "origin",
          result: failedResult({ trustedPreflight: true }),
        }),
      ),
      true,
    );
    const loopMessage = assistantMessage(
      [{ type: "toolCall", id: "loop-trigger", name: "exec", arguments: {} }],
      2,
    );
    const result = await agent.afterToolOutcome?.(
      outcome({
        assistantMessage: loopMessage,
        toolCallId: "loop-trigger",
        result: toolLoopBlockedResult({ triggerId: "loop-trigger" }),
        isError: true,
        executionStarted: false,
      }),
    );

    expect(result).toBe(prior);
    await expect(
      agent.beforeToolCall?.(
        {
          assistantMessage: assistantMessage(
            [{ type: "toolCall", id: "repair-singleton", name: "exec", arguments: {} }],
            3,
          ),
          toolCall: {
            type: "toolCall",
            id: "repair-singleton",
            name: "exec",
            arguments: {},
          },
          args: {},
          context: { systemPrompt: "", messages: [], tools: [] },
        } as never,
        undefined,
      ),
    ).resolves.toBeUndefined();
  });

  it("returns terminal hook failure for a synthetic loop without consuming repair", async () => {
    const previous = vi.fn(async (context: AfterToolOutcomeContext) => {
      if (context.toolCall.id === "loop-trigger") {
        throw new Error("hook exploded during loop recovery");
      }
      return undefined;
    });
    const agent = createAgent({ previous });
    expectRepair(
      await agent.afterToolOutcome?.(
        outcome({
          toolCallId: "origin",
          result: failedResult({ trustedPreflight: true }),
        }),
      ),
      true,
    );
    const loopMessage = assistantMessage(
      [{ type: "toolCall", id: "loop-trigger", name: "exec", arguments: {} }],
      2,
    );

    const result = await agent.afterToolOutcome?.(
      outcome({
        assistantMessage: loopMessage,
        toolCallId: "loop-trigger",
        result: toolLoopBlockedResult({ triggerId: "loop-trigger" }),
        isError: true,
        executionStarted: false,
      }),
    );

    expectRepair(result, false);
    expect(result?.content).toEqual([
      expect.objectContaining({
        text: expect.stringContaining("hook exploded during loop recovery"),
      }),
    ]);
    await expect(
      agent.beforeToolCall?.(
        {
          assistantMessage: assistantMessage(
            [{ type: "toolCall", id: "repair-singleton", name: "exec", arguments: {} }],
            3,
          ),
          toolCall: {
            type: "toolCall",
            id: "repair-singleton",
            name: "exec",
            arguments: {},
          },
          args: {},
          context: { systemPrompt: "", messages: [], tools: [] },
        } as never,
        undefined,
      ),
    ).resolves.toBeUndefined();
  });

  it("does not trust forged or executed tool-loop-shaped outcomes", async () => {
    for (const testCase of [
      {
        label: "executed",
        executionStarted: true,
        result: toolLoopBlockedResult({ triggerId: "candidate" }),
      },
      {
        label: "mismatched intervention",
        executionStarted: false,
        result: toolLoopBlockedResult({ triggerId: "other-call" }),
      },
    ]) {
      const agent = createAgent();
      expectRepair(
        await agent.afterToolOutcome?.(
          outcome({
            toolCallId: `origin-${testCase.label}`,
            result: failedResult({ trustedPreflight: true }),
          }),
        ),
        true,
      );
      const candidateMessage = assistantMessage(
        [{ type: "toolCall", id: "candidate", name: "exec", arguments: {} }],
        2,
      );

      expectRepair(
        await agent.afterToolOutcome?.(
          outcome({
            assistantMessage: candidateMessage,
            toolCallId: "candidate",
            result: testCase.result,
            isError: true,
            executionStarted: testCase.executionStarted,
          }),
        ),
        false,
      );
    }
  });

  it("does not let a prior hook rewrite an ordinary outcome into synthetic recovery", async () => {
    const previous = vi.fn(async (context: AfterToolOutcomeContext) =>
      context.toolCall.id === "candidate"
        ? { ...toolLoopBlockedResult({ triggerId: "candidate" }), isError: true }
        : undefined,
    );
    const agent = createAgent({ previous });
    expectRepair(
      await agent.afterToolOutcome?.(
        outcome({
          toolCallId: "origin",
          result: failedResult({ trustedPreflight: true }),
        }),
      ),
      true,
    );
    const candidateMessage = assistantMessage(
      [{ type: "toolCall", id: "candidate", name: "exec", arguments: {} }],
      2,
    );

    expectRepair(
      await agent.afterToolOutcome?.(
        outcome({
          assistantMessage: candidateMessage,
          toolCallId: "candidate",
          result: failedResult(),
          isError: true,
          executionStarted: false,
        }),
      ),
      false,
    );
  });

  it.each([
    { label: "cancelled", errorKind: undefined, abort: true },
    { label: "invalid", errorKind: "argument-validation" as const, abort: false },
    { label: "unknown", errorKind: undefined, abort: false },
  ])("consumes repair on non-synthetic pre-execution $label outcomes", async (testCase) => {
    const agent = createAgent();
    expectRepair(
      await agent.afterToolOutcome?.(
        outcome({
          toolCallId: `origin-${testCase.label}`,
          result: failedResult({ trustedPreflight: true }),
        }),
      ),
      true,
    );
    const candidateMessage = assistantMessage(
      [{ type: "toolCall", id: "candidate", name: "exec", arguments: {} }],
      2,
    );
    const controller = new AbortController();
    if (testCase.abort) {
      controller.abort(new Error("cancelled"));
    }
    const result =
      testCase.label === "unknown"
        ? {
            content: [{ type: "text" as const, text: "unknown tool" }],
            details: { status: "blocked", deniedReason: "unknown-tool" },
          }
        : failedResult();

    expectRepair(
      await agent.afterToolOutcome?.(
        outcome({
          assistantMessage: candidateMessage,
          toolCallId: "candidate",
          result,
          isError: true,
          executionStarted: false,
          ...(testCase.errorKind ? { errorKind: testCase.errorKind } : {}),
        }),
        controller.signal,
      ),
      false,
    );
  });

  it("does not consume repair on sibling execs from the originating turn", async () => {
    const agent = createAgent();
    const assistantMessage = {
      role: "assistant",
      content: [],
      timestamp: 1,
    } as unknown as AfterToolOutcomeContext["assistantMessage"];

    expectRepair(
      await agent.afterToolOutcome?.(
        outcome({
          assistantMessage,
          result: failedResult({ trustedPreflight: true }),
        }),
      ),
      true,
    );
    await expect(
      agent.afterToolOutcome?.(outcome({ assistantMessage, result: completedResult() })),
    ).resolves.toBeUndefined();
    expectRepair(
      await agent.afterToolOutcome?.(
        outcome({
          assistantMessage,
          result: failedResult({ trustedPreflight: true }),
        }),
      ),
      true,
    );
    expectRepair(
      await agent.afterToolOutcome?.(outcome({ result: failedResult({ trustedPreflight: true }) })),
      false,
    );
  });

  it.each([
    {
      label: "two exec calls",
      content: [
        { type: "toolCall" as const, id: "repair-1", name: "exec", arguments: {} },
        { type: "toolCall" as const, id: "repair-2", name: "exec", arguments: {} },
      ],
    },
    {
      label: "exec then unknown",
      content: [
        { type: "toolCall" as const, id: "repair-exec", name: "exec", arguments: {} },
        { type: "toolCall" as const, id: "repair-unknown", name: "unknown", arguments: {} },
      ],
    },
    {
      label: "unknown then exec",
      content: [
        { type: "toolCall" as const, id: "repair-unknown", name: "unknown", arguments: {} },
        { type: "toolCall" as const, id: "repair-exec", name: "exec", arguments: {} },
      ],
    },
  ])("blocks every corrective body in a parallel $label batch", async ({ content }) => {
    const result = await runCorrectiveBatch(content);

    expect(result.executedCallIds).toEqual(["origin"]);
    expect(result.turns).toBe(2);
  });

  it("lets the preserved before hook observe every rejected corrective body first", async () => {
    const observedToolCallIds: string[] = [];
    const result = await runCorrectiveBatch(
      [
        { type: "toolCall", id: "repair-1", name: "exec", arguments: {} },
        { type: "toolCall", id: "repair-2", name: "exec", arguments: {} },
      ],
      {
        previousBefore: async ({ toolCall }) => {
          observedToolCallIds.push(toolCall.id);
          return undefined;
        },
      },
    );

    expect(result.executedCallIds).toEqual(["origin"]);
    expect(observedToolCallIds).toEqual(["origin", "repair-1", "repair-2"]);
  });

  it("returns a preserved before-hook block unchanged and consumes the repair outcome", async () => {
    const prior = { block: true as const, reason: "extension policy" };
    const previousBefore = vi.fn(async () => prior);
    const agent = createAgent({ previousBefore });
    const offeredBy = outcome({
      result: failedResult({ trustedPreflight: true }),
    }).assistantMessage;
    expectRepair(
      await agent.afterToolOutcome?.(
        outcome({
          assistantMessage: offeredBy,
          result: failedResult({ trustedPreflight: true }),
        }),
      ),
      true,
    );
    const corrective = assistantMessage(
      [{ type: "toolCall", id: "repair-blocked", name: "exec", arguments: {} }],
      2,
    );
    const context = {
      assistantMessage: corrective,
      toolCall: corrective.content[0],
      args: {},
      context: { systemPrompt: "", messages: [], tools: [] },
    } as Parameters<NonNullable<Agent["beforeToolCall"]>>[0];

    await expect(agent.beforeToolCall?.(context)).resolves.toBe(prior);
    expectRepair(
      await agent.afterToolOutcome?.(
        outcome({
          assistantMessage: corrective,
          toolCallId: "repair-blocked",
          result: { content: [{ type: "text", text: "extension policy" }], details: {} },
          isError: true,
          executionStarted: false,
        }),
      ),
      false,
    );
  });

  it("propagates a preserved before-hook failure and consumes its finalized outcome", async () => {
    const previousBefore = vi.fn(async ({ toolCall }) => {
      if (toolCall.id === "repair-throw") {
        throw new Error("extension hook failed");
      }
      return undefined;
    });
    const result = await runCorrectiveBatch(
      [{ type: "toolCall", id: "repair-throw", name: "exec", arguments: {} }],
      { previousBefore },
    );

    expect(result.executedCallIds).toEqual(["origin"]);
    expect(result.turns).toBe(2);
    expect(previousBefore).toHaveBeenCalledTimes(2);
  });

  it("revokes an offered repair when an unsafe parallel sibling starts", async () => {
    const result = await runSiblingAuthorityRace("write");

    expect(result.executedCallIds).toEqual(["origin", "sibling"]);
    expect(result.authorityChecks).toBeGreaterThanOrEqual(2);
  });

  it("allows one repair when a replay-safe parallel sibling starts", async () => {
    const result = await runSiblingAuthorityRace("read");

    expect(result.executedCallIds).toEqual(["origin", "sibling", "repair-singleton"]);
    expect(result.authorityChecks).toBeGreaterThanOrEqual(2);
  });

  it("blocks repair after any authoritative potential side effect", async () => {
    const agent = createAgent({ hasPotentialSideEffects: () => true });

    expectRepair(
      await agent.afterToolOutcome?.(outcome({ result: failedResult({ trustedPreflight: true }) })),
      false,
    );
  });

  it("blocks waits even when their failure carries repair evidence", async () => {
    const agent = createAgent();

    expectRepair(
      await agent.afterToolOutcome?.(
        outcome({
          toolName: "wait",
          result: failedResult({ failurePhase: "host", trustedPreflight: true }),
        }),
      ),
      false,
    );
  });

  it("uses original repair authority when an earlier hook rewrites the presentation", async () => {
    const previous = vi.fn(async () => ({
      details: {
        status: "failed",
        code: "internal_error",
        error: "rewritten failure",
        failurePhase: "guest",
        bridgeDispatchStarted: false,
      },
    }));
    const agent = createAgent({ previous });

    const result = await agent.afterToolOutcome?.(
      outcome({ result: failedResult({ trustedPreflight: true }) }),
    );

    expectRepair(result, true);
    expect(result).toMatchObject({ details: { error: "rewritten failure" } });
  });

  it("falls back to the original failure when an earlier hook rewrites it as success", async () => {
    const previous = vi.fn(async () => ({
      content: [{ type: "text" as const, text: '{"status":"completed"}' }],
      details: { status: "completed" },
      isError: false,
      terminate: false,
    }));
    const agent = createAgent({ previous });

    expectRepair(
      await agent.afterToolOutcome?.(outcome({ result: failedResult({ trustedPreflight: true }) })),
      true,
    );
  });

  it("fails closed when an earlier outcome hook throws", async () => {
    const agent = createAgent({
      previous: vi.fn(async () => {
        throw new Error("hook exploded");
      }),
    });

    const result = await agent.afterToolOutcome?.(
      outcome({ result: failedResult({ trustedPreflight: true }) }),
    );

    expectRepair(result, false);
    expect(result?.content).toEqual([
      expect.objectContaining({ text: expect.stringContaining("hook exploded") }),
    ]);
  });

  it("preserves terminal decisions", async () => {
    const agent = createAgent({ previous: vi.fn(async () => ({ terminate: true })) });

    expectRepair(
      await agent.afterToolOutcome?.(outcome({ result: failedResult({ trustedPreflight: true }) })),
      false,
    );
  });

  it("preserves bounded partial output without serializing repair authority", async () => {
    const original = failedResult({
      output: [{ type: "text", text: "before failure" }],
      trustedPreflight: true,
    });
    const agent = createAgent();
    const result = await agent.afterToolOutcome?.(outcome({ result: original }));
    const modelText = String(result?.content?.find((entry) => entry.type === "text")?.text);
    const payload = JSON.parse(modelText) as Record<string, unknown>;

    expect(payload.output).toEqual([{ type: "text", text: "before failure" }]);
    expect(payload.repair).toMatchObject({ allowed: true, remainingAttempts: 1 });
    expect(Reflect.ownKeys(result?.details ?? {})).not.toContain(CODE_MODE_REPAIR_EVIDENCE);
    expect(JSON.stringify(original.details)).not.toContain("codeModeRepairEvidence");
    expect(modelText).not.toContain("codeModeRepairEvidence");
  });

  it("fails closed on an aborted pre-execution wait", async () => {
    const previous = vi.fn(async () => undefined);
    const agent = createAgent({ previous });
    const controller = new AbortController();
    controller.abort();
    const context = outcome({
      toolName: "wait",
      result: { content: [{ type: "text", text: "Operation aborted" }], details: {} },
      isError: true,
      executionStarted: false,
    });

    expectRepair(await agent.afterToolOutcome?.(context, controller.signal), false);
    expect(previous).toHaveBeenCalledWith(context, controller.signal);
    expectRepair(
      await agent.afterToolOutcome?.(outcome({ result: failedResult({ trustedPreflight: true }) })),
      false,
    );
  });

  it("leaves non-Code-Mode tools with the previously installed hook", async () => {
    const previous = vi.fn(async () => ({ details: { previous: true } }));
    const agent = createAgent({ previous });
    const context = outcome({ toolName: "read", result: completedResult() });

    await expect(agent.afterToolOutcome?.(context)).resolves.toEqual({
      details: { previous: true },
    });
    expect(previous).toHaveBeenCalledWith(context, undefined);
  });
});
