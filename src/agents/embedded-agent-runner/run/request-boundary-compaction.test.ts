import type { Model, StreamFn } from "@openclaw/llm-core";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../../../../packages/ai/src/host.js";
import { streamSimpleAnthropic } from "../../../../packages/ai/src/providers/anthropic.js";
import {
  clearBoundaryMaintenance,
  clearBoundaryMaintenanceDeferral,
  declineBoundaryMaintenance,
} from "../../context-pressure.js";
import { relocateCurrentRuntimeContextCarrierToTail } from "../../internal-runtime-context.js";
import {
  createAssistant,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import {
  agentSessionDeferThresholdCompaction,
  agentSessionRunWarmCompaction,
  type AgentSessionEvent,
} from "../../sessions/agent-session-types.js";
import { withSessionManagerWrite } from "../../sessions/session-manager-write-admission.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { SettingsManager } from "../../sessions/settings-manager.js";
import { createToolResultPromptProjectionState } from "../session-prompt-state.js";
import { normalizeMessagesForLlmBoundary } from "./attempt-llm-boundary.js";
import { submitEmbeddedAttemptPrompt } from "./attempt-prompt-submit.js";
import { MidTurnPrecheckSignal } from "./midturn-precheck.js";
import { createRequestBoundaryCompaction } from "./request-boundary-compaction.js";
import { buildRuntimeContextCustomMessage } from "./runtime-context-prompt.js";

// mock-isolation: records the boundary's lifecycle calls; the real hooks need a Gateway.
const hookCalls = vi.hoisted(() => [] as string[]);
vi.mock("../compaction-hooks.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../compaction-hooks.js")>()),
  runCompactionHooks: async (params: { phase: string }) => {
    hookCalls.push(`hooks:${params.phase}`);
  },
  runPostCompactionSideEffects: async () => {
    hookCalls.push("post-compaction");
  },
}));
registerAgentSessionLoopTestLifecycle();
const initialHost = getAiTransportHost();
const model = {
  id: "claude-sonnet-4-6",
  name: "Claude Sonnet 4.6",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "https://api.anthropic.com",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_000,
  maxTokens: 512,
} satisfies Model<"anthropic-messages">;

type Payload = {
  system?: unknown;
  tools?: unknown;
  messages: Array<{ role: string; content: string | Array<Record<string, unknown>> }>;
  [key: string]: unknown;
};
type Reply = "summary" | "tool" | "length" | "done";
let requests: Payload[];
let replies: Reply[];

const anthropicEvents = (reply: Reply) => {
  const block =
    reply === "tool"
      ? { type: "tool_use", id: "toolu_fixture", name: "lookup", input: {} }
      : { type: "text", text: "" };
  const text = reply === "summary" ? "## Goal\nKeep the codeword copper." : "done";
  return [
    {
      type: "message_start",
      message: {
        id: "msg_fixture",
        model: model.id,
        usage: { input_tokens: 30, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: block },
    reply === "tool"
      ? {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: "{}" },
        }
      : { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: {
        stop_reason: reply === "tool" ? "tool_use" : reply === "length" ? "max_tokens" : "end_turn",
      },
      usage: { input_tokens: 30, output_tokens: 5 },
    },
    { type: "message_stop" },
  ];
};

beforeEach(() => {
  hookCalls.length = 0;
  requests = [];
  replies = [];
  const captureFetch: typeof fetch = async (input, init) => {
    const payload = JSON.parse(await new Request(input, init).text()) as Payload;
    requests.push(payload);
    const body = anthropicEvents(replies.shift() ?? "done")
      .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      .join("");
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  };
  configureAiTransportHost({ ...initialHost, buildModelFetch: () => captureFetch });
});
afterEach(() => {
  configureAiTransportHost(initialHost);
  for (const runId of ["warm-run", "pr205959-check-false", "pr205959-check-true"]) {
    clearBoundaryMaintenanceDeferral(runId);
  }
});

const textOf = (message: Payload["messages"][number]) =>
  typeof message.content === "string" ? message.content : JSON.stringify(message.content);
const isSummaryRequest = (payload: Payload) =>
  textOf(payload.messages.at(-1)!).includes("context checkpoint summary");

async function fixture(
  options: { boundary?: boolean; history?: SessionManager; runtimeContext?: string } = {},
) {
  const sessionManager = options.history ?? SessionManager.inMemory();
  if (!options.history) {
    sessionManager.appendMessage({ role: "user", content: "remember copper", timestamp: 1 });
    sessionManager.appendMessage(
      createAssistant(model, [{ type: "text", text: "Old detail. ".repeat(3_500) }], "stop", 7_000),
    );
  }
  const { session } = await createTestSession({
    model,
    sessionManager,
    systemPrompt: "stable system",
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: true, reserveTokens: 2_000, keepRecentTokens: 500 },
      retry: { enabled: false },
    }),
    contextOverflowRecoveryOwner: "caller",
    customTools: [
      {
        name: "lookup",
        label: "lookup",
        description: "read a record",
        parameters: Type.Object({}),
        execute: async () => ({
          content: [{ type: "text" as const, text: "record" }],
          details: {},
        }),
      },
    ],
  });
  const appendOnlyRuntimeContext = options.runtimeContext === undefined;
  const convertToLlm = session.agent.convertToLlm.bind(session.agent);
  session.agent.convertToLlm = async (messages) => {
    const normalized = normalizeMessagesForLlmBoundary(messages, {
      appendOnlyRuntimeContext,
      inHistorySystemUpdates: appendOnlyRuntimeContext,
    });
    return convertToLlm(
      appendOnlyRuntimeContext
        ? normalized
        : relocateCurrentRuntimeContextCarrierToTail(normalized),
    );
  };
  session[agentSessionDeferThresholdCompaction] = true;
  const providerStream: StreamFn = (activeModel, context, streamOptions) =>
    streamSimpleAnthropic(activeModel as Model<"anthropic-messages">, context, {
      ...streamOptions,
      apiKey: "sk-test",
      cacheRetention: "short",
    });
  session.agent.streamFn = providerStream;
  const events: AgentSessionEvent[] = [];
  session.subscribe((event) => {
    events.push(event);
  });
  const onPrecheck = vi.fn();
  const onModelRequest =
    vi.fn<NonNullable<Parameters<typeof submitEmbeddedAttemptPrompt>[0]["onModelRequest"]>>();
  const withTranscriptWrite = <T>(write: () => Promise<T>) =>
    withSessionManagerWrite(sessionManager, write);
  const boundary =
    options.boundary === false
      ? undefined
      : createRequestBoundaryCompaction({
          variant: "text",
          session,
          contextTokenBudget: 8_000,
          reserveTokens: 2_000,
          isToolBoundarySafe: () => true,
          runId: "warm-run",
          timeoutMs: 30_000,
          assertActive: () => {},
          withTranscriptWrite,
          onPrecheck,
          hookContext: {
            sessionId: session.sessionId,
            sessionKey: "agent:main:main",
            sessionAgentId: "main",
            workspaceDir: "/tmp/warm-workspace",
          },
          postCompaction: { sessionKey: "agent:main:main", sessionFile: "warm.sqlite" },
        });
  const submit = (prompt = "current request") =>
    submitEmbeddedAttemptPrompt({
      attempt: { sessionId: session.sessionId },
      activeSession: session,
      contextTokenBudget: 8_000,
      ...(boundary ? { compactBeforeRequest: boundary } : {}),
      images: [],
      modelPrompt: prompt,
      transcriptPrompt: prompt,
      onFinalPromptText: () => {},
      onModelRequest,
      persistToolResultProjections: async () => {},
      withTranscriptWrite,
      runtimeOnly: false,
      runtimeContextMessage: buildRuntimeContextCustomMessage(options.runtimeContext),
      systemPrompt: "stable system",
      toolResultAggregateMaxChars: 80_000,
      toolResultMaxChars: 80_000,
      toolResultPromptProjectionState: createToolResultPromptProjectionState(),
      trajectoryRecorder: null,
      transcriptLeafId: sessionManager.getLeafId(),
      appendOnlyRuntimeContext,
      promptActiveSession: (text, promptOptions) => session.prompt(text, promptOptions),
    });
  return { session, sessionManager, events, onPrecheck, onModelRequest, submit };
}

const completedCompactions = (events: AgentSessionEvent[]) =>
  events.filter((event) => event.type === "compaction_end" && event.outcome.status === "completed");

describe("warm text compaction at the request boundary", () => {
  it("does not turn fresh-request maintenance headroom into hard overflow", async () => {
    const f = await fixture({ history: SessionManager.inMemory() });
    const boundary = createRequestBoundaryCompaction({
      variant: "text",
      session: f.session,
      contextTokenBudget: 110_000,
      reserveTokens: 20_000,
      isToolBoundarySafe: () => true,
      runId: "fresh-knowledge",
      timeoutMs: 30_000,
      assertActive: () => {},
      withTranscriptWrite: (write) => withSessionManagerWrite(f.sessionManager, write),
      onPrecheck: f.onPrecheck,
    });
    const context = {
      systemPrompt: "Use the configured tools to answer the current request. ".repeat(1_500),
      tools: [
        {
          name: "knowledge_record",
          description: "Read source evidence and update the selected knowledge record. ".repeat(
            5_000,
          ),
          parameters: Type.Object({}),
        },
      ],
      messages: [{ role: "user" as const, content: "BUDGET-QA-PING", timestamp: 1 }],
    };
    const send = () =>
      boundary(f.session.agent.streamFn, { ...model, contextWindow: 110_000 }, context, {
        sessionId: f.session.sessionId,
      });
    await expect(send()).rejects.toBeInstanceOf(MidTurnPrecheckSignal);
    expect(f.onPrecheck).toHaveBeenCalledWith(expect.objectContaining({ pressure: "maintenance" }));
    expect(f.onPrecheck.mock.calls[0]?.[0].estimatedPromptTokens).toBeLessThan(110_000);
    expect(requests).toHaveLength(0);
    declineBoundaryMaintenance("fresh-knowledge");
    try {
      await expect(send()).resolves.toBeUndefined();
      expect(f.onPrecheck).toHaveBeenCalledOnce();
      context.messages[0]!.content = "中".repeat(110_000);
      await expect(send()).rejects.toBeInstanceOf(MidTurnPrecheckSignal);
      expect(f.onPrecheck).toHaveBeenLastCalledWith(
        expect.objectContaining({ pressure: "overflow" }),
      );
      expect(requests).toHaveLength(0);
    } finally {
      clearBoundaryMaintenance("fresh-knowledge");
    }
  });

  it("sends the unchanged request plus one unmarked summarize item", async () => {
    const plain = await fixture({ boundary: false });
    await plain.submit();
    const [normal] = requests;
    expect(requests).toHaveLength(1);

    requests = [];
    replies = ["summary"];
    const f = await fixture();
    await f.submit();
    expect(requests).toHaveLength(1);
    const warm = requests[0]!;
    expect(isSummaryRequest(warm)).toBe(true);
    // System, tools, parameters, every earlier message and its cache markers are unchanged.
    const { messages: warmMessages, ...warmParams } = warm;
    const { messages: normalMessages, ...normalParams } = normal!;
    expect(warmParams).toEqual(normalParams);
    expect(warmMessages.slice(0, -1)).toEqual(normalMessages);
    const appended = warmMessages.at(-1)!;
    expect(appended.role).toBe("user");
    expect(JSON.stringify(appended)).not.toContain("cache_control");
  });

  it("commits the summary with the retained tail and continues from it", async () => {
    replies = ["summary"];
    const f = await fixture();
    await f.submit();
    expect(f.onPrecheck).toHaveBeenCalledOnce();
    expect(f.onPrecheck.mock.calls[0]?.[0]).toMatchObject({
      pressure: "maintenance",
      route: "compact_only",
    });
    expect(completedCompactions(f.events)).toHaveLength(1);
    // The boundary owns internal hooks and post-compaction sync, as the reply-level path did.
    expect(hookCalls).toEqual(["hooks:before", "post-compaction", "hooks:after"]);
    expect(f.events.find((event) => event.type === "compaction_start")).toMatchObject({
      hooksHandled: true,
    });
    const compaction = f.sessionManager
      .getEntries()
      .findLast((entry) => entry.type === "compaction");
    expect(compaction).toMatchObject({
      summary: expect.stringContaining("Keep the codeword copper"),
    });
    // One request covers the whole history; no turn-prefix section is generated.
    expect(compaction && "summary" in compaction ? compaction.summary : "").not.toContain(
      "Turn Context (split turn)",
    );

    // The run's retry rebuilds its request from this context: the summary, then the
    // kept tail with the pending request once and none of the summarized history.
    const retried = f.sessionManager
      .buildSessionContext()
      .messages.map((message) => JSON.stringify(message));
    expect(retried[0]).toContain("Keep the codeword copper");
    expect(retried.slice(1).filter((text) => text.includes("current request"))).toHaveLength(1);
    expect(retried.slice(1).join("\n")).not.toContain("remember copper");
  });

  it("compacts a split turn with one request after a settled tool round", async () => {
    // The first request fits; its tool round pushes the next boundary over the trigger.
    const manager = SessionManager.inMemory();
    manager.appendMessage({ role: "user", content: "remember copper", timestamp: 1 });
    manager.appendMessage(createAssistant(model, [{ type: "text", text: "noted" }], "stop", 10));
    const f = await fixture({ history: manager });
    f.session.agent.state.tools[0]!.execute = async () => ({
      content: [{ type: "text", text: "large tool output. ".repeat(1_800) }],
      details: {},
    });
    replies = ["tool", "summary"];
    await f.submit();
    expect(requests.map(isSummaryRequest)).toEqual([false, true]);
    expect(JSON.stringify(requests[1])).toContain("large tool output.");
    const compaction = manager.getEntries().findLast((entry) => entry.type === "compaction");
    expect(compaction).toBeDefined();
    expect(compaction && "summary" in compaction ? compaction.summary : "").not.toContain(
      "Turn Context (split turn)",
    );
    const kept = manager.buildSessionContext().messages;
    expect(kept.filter((message) => message.role === "toolResult")).toHaveLength(1);
  });

  it.each([false, true])(
    "finishes with the intact tool result and no checkpoint (runtime carrier: %s)",
    async (carrier) => {
      const runtimeContext = "The current request is a release review.";
      const f = await fixture({
        history: SessionManager.inMemory(),
        runtimeContext: carrier ? runtimeContext : undefined,
      });
      const evidence = "Release evidence. ".repeat(1_200);
      f.session.agent.state.tools[0]!.execute = async () => ({
        content: [{ type: "text", text: evidence }],
        details: {},
      });
      replies = ["tool", "done"];
      await f.submit();
      if (carrier) {
        expect(f.onModelRequest.mock.calls[1]?.[1].messages.at(-1)).toMatchObject({
          role: "user",
          runtimeContextCarrier: true,
        });
      }
      expect(requests.map(isSummaryRequest)).toEqual([false, false]);
      expect(JSON.stringify(requests[1]!.messages)).toContain(evidence);
      if (carrier) {
        expect(JSON.stringify(requests[1]!.messages)).toContain(runtimeContext);
      }
      expect(completedCompactions(f.events)).toHaveLength(0);
    },
  );

  it.each([false, true])(
    "defers once across rebuilt attempt boundaries (runtime carrier: %s)",
    async (carrier) => {
      const f = await fixture({ history: SessionManager.inMemory() });
      const compact = vi
        .spyOn(f.session, agentSessionRunWarmCompaction)
        .mockResolvedValue(undefined);
      const result = {
        role: "toolResult" as const,
        toolName: "lookup",
        toolCallId: "finished-call",
        content: [{ type: "text" as const, text: "complete" }],
        timestamp: 1,
        isError: false,
      };
      const context = {
        role: "user" as const,
        runtimeContextCarrier: true,
        content: "context",
        timestamp: 2,
      };
      const send = () => {
        const messages = carrier ? [result, context] : [result];
        return createRequestBoundaryCompaction({
          variant: "text",
          session: f.session,
          runId: "pr205959-check-" + String(carrier),
          contextTokenBudget: 8_000,
          reserveTokens: 2_000,
          isToolBoundarySafe: () => true,
          timeoutMs: 30_000,
          assertActive: () => {},
          withTranscriptWrite: <T>(write: () => Promise<T>) => write(),
          onPrecheck: () => {},
        })(
          f.session.agent.streamFn,
          model,
          { messages },
          { maxTokens: 512 },
          { requestIndex: 1, messageCount: messages.length, contextTokens: 6_988 },
        );
      };
      await expect(send()).resolves.toBeUndefined();
      expect(compact).not.toHaveBeenCalled();
      await expect(send()).rejects.toBeInstanceOf(MidTurnPrecheckSignal);
      expect(compact).toHaveBeenCalledOnce();
    },
  );

  it("sends the request unchanged after the run declined maintenance", async () => {
    // Recovery declines maintenance that could not reduce context; repeating it would
    // stop every later attempt of the run.
    declineBoundaryMaintenance("warm-run");
    try {
      const f = await fixture();
      await f.submit();
      expect(requests.map(isSummaryRequest)).toEqual([false]);
      expect(f.onPrecheck).not.toHaveBeenCalled();
      expect(completedCompactions(f.events)).toEqual([]);
    } finally {
      clearBoundaryMaintenance("warm-run");
    }
  });

  it.each(["tool", "length"] as const)(
    "falls back to the client compactor once when the summary reply is a %s stop",
    async (reply) => {
      replies = [reply];
      const f = await fixture();
      const before = f.sessionManager.getEntries().length;
      await f.submit();
      expect(requests).toHaveLength(1);
      // Nothing but the pending user request and the attempt's local stop signal is written.
      expect(
        f.sessionManager
          .getEntries()
          .slice(before)
          .map((entry) => (entry.type === "message" ? entry.message.role : entry.type)),
      ).toEqual(["user", "assistant"]);
      expect(f.onPrecheck).toHaveBeenCalledOnce();
      expect(f.onPrecheck.mock.calls[0]?.[0]).toMatchObject({ route: "compact_only" });
      expect(completedCompactions(f.events)).toEqual([]);
      expect(hookCalls).toEqual(["hooks:before"]);
    },
  );
});
