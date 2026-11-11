import { expectDefined } from "@openclaw/normalization-core";
import { Agent, type AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { createAssistantMessageEventStream, type Message } from "openclaw/plugin-sdk/llm";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import type { ContextEngine } from "../../context-engine/types.js";
import { sanitizeToolUseResultPairing } from "../session-transcript-repair.js";
import { estimateMessageTokenPressure } from "../sessions/context-token-pressure.js";
import { convertToLlm } from "../sessions/messages.js";
import {
  castAgentMessage,
  makeAgentAssistantMessage,
} from "../test-helpers/agent-message-fixtures.js";
import { makeProviderModelFixture } from "../test-helpers/provider-model-fixture.js";
import { normalizeMessagesForLlmBoundary } from "./run/attempt-llm-boundary.js";
import { resolveProjectedRequestPressure } from "./run/preemptive-compaction.js";
import {
  estimateMessageCharsCached,
  getToolResultText as getAllToolResultText,
} from "./tool-result-char-estimator.js";
import {
  installContextEngineLoopHook,
  installToolResultContextGuard,
} from "./tool-result-context-guard.js";
import {
  CONTEXT_LIMIT_TRUNCATION_NOTICE,
  makeUser,
  makeToolResult,
  makeAssistant,
  makeReadToolResult,
  makeLegacyToolResult,
  makeToolResultWithDetails,
  makeGuardableAgent,
  applyGuardToContext,
  expectOpenClawTruncation,
} from "./tool-result-context-guard.test-support.js";

async function project(messages: AgentMessage[], contextWindowTokens = 1_000) {
  return expectDefined(
    await applyGuardToContext(makeGuardableAgent(), messages, contextWindowTokens),
    "guarded messages",
  );
}

function makeEngine(cancelAt?: string, cancel?: () => void) {
  const checkpoint = (stage: string) => {
    if (stage === cancelAt) {
      cancel?.();
    }
  };
  return {
    info: { id: "test-engine", name: "Test Engine", version: "0.0.1", ownsCompaction: true },
    afterTurn: vi.fn<NonNullable<ContextEngine["afterTurn"]>>(async () => {}),
    assemble: vi.fn<ContextEngine["assemble"]>(async ({ messages }) => {
      checkpoint("assemble");
      return { messages, estimatedTokens: 0 };
    }),
    compact: vi.fn<ContextEngine["compact"]>(async () => {
      throw new Error("unexpected direct compaction");
    }),
    ingest: vi.fn<ContextEngine["ingest"]>(async () => {
      checkpoint("ingest");
      return { ingested: true };
    }),
    ingestBatch: vi.fn<NonNullable<ContextEngine["ingestBatch"]>>(async ({ messages }) => {
      checkpoint("ingestBatch");
      return { ingestedCount: cancelAt === "ingestBatch" ? 1 : messages.length };
    }),
  } satisfies ContextEngine;
}

type HookOptions = Partial<
  Omit<Parameters<typeof installContextEngineLoopHook>[0], "agent" | "contextEngine">
>;
function hook(engine: ContextEngine, options: HookOptions = {}, agent = makeGuardableAgent()) {
  installContextEngineLoopHook({
    agent,
    contextEngine: engine,
    sessionId: "test-session",
    sessionKey: "agent:main:test",
    sessionFile: "/tmp/test-session.jsonl",
    tokenBudget: 4_096,
    modelId: "test-model",
    getPrePromptMessageCount: () => 1,
    ...options,
  });
  return {
    agent,
    run: (messages: AgentMessage[], signal = new AbortController().signal) =>
      expectDefined(agent.transformContext, "installed hook")(messages, signal),
  };
}

const textBlock = (text: string) => ({ type: "text" as const, text });
const exchange = () => [makeUser("first"), makeToolResult("one", "result")];

function expectBoundedResult(message: AgentMessage, maxChars: number, ...snippets: string[]) {
  expect(message).not.toHaveProperty("details");
  expect(
    estimateMessageCharsCached(message, new WeakMap<AgentMessage, number>()),
  ).toBeLessThanOrEqual(maxChars);
  for (const snippet of [CONTEXT_LIMIT_TRUNCATION_NOTICE, ...snippets]) {
    expect(getAllToolResultText(message)).toContain(snippet);
  }
}

describe("installToolResultContextGuard", () => {
  it("delivers the truncated diagnostic through the real agent loop", async () => {
    const diagnostic = "Error: missing import;";
    const hint = "Inspect src/fixture.ts before retrying.";
    const content = [textBlock("progress output\n".repeat(400) + diagnostic + " " + hint)];
    const original = structuredClone(content);
    const requests: Message[][] = [];
    const contextWindowTokens = 8_192;
    const model = makeProviderModelFixture({
      id: "test-model",
      api: "openai-responses",
      provider: "openai",
      baseUrl: "https://example.test",
      contextWindow: contextWindowTokens,
    });
    const agent = new Agent({
      initialState: {
        model,
        tools: [
          {
            name: "diagnostic",
            label: "Diagnostic",
            description: "Read diagnostic output",
            parameters: Type.Object({}),
            execute: async () => ({ content, details: { privateReference: "fixture" } }),
          },
        ],
      },
      convertToLlm,
      streamFn: (_model, context) => {
        requests.push(structuredClone(context.messages));
        const result = context.messages.find((message) => message.role === "toolResult");
        const hasHint = result && getAllToolResultText(result).includes(hint);
        const reason = requests.length === 1 ? "toolUse" : "stop";
        const message = makeAgentAssistantMessage({
          content:
            reason === "toolUse"
              ? [{ type: "toolCall", id: "call_diagnostic", name: "diagnostic", arguments: {} }]
              : [textBlock(hasHint ? hint : "The diagnostic hint was unavailable.")],
          stopReason: reason,
        });
        const stream = createAssistantMessageEventStream();
        stream.push({ type: "done", reason, message });
        stream.end();
        return stream;
      },
    });
    const dispose = installToolResultContextGuard({ agent, contextWindowTokens });
    try {
      await agent.prompt("Read the diagnostic and report its next step.");
    } finally {
      agent.abort();
      await agent.waitForIdle();
      dispose();
    }

    expect(requests).toHaveLength(2);
    expect(content).toEqual(original);
    const stored = expectDefined(
      agent.state.messages.find((message) => message.role === "toolResult"),
      "raw agent tool result",
    );
    expect(stored.content).toEqual(original);
    expect(stored).toHaveProperty("details.privateReference", "fixture");
    const projected = expectDefined(
      requests[1]?.find((message) => message.role === "toolResult"),
      "provider-bound tool result",
    );
    expectBoundedResult(projected, contextWindowTokens, diagnostic, hint);
    expect(agent.state.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: [textBlock(hint)],
      stopReason: "stop",
    });
    expect(agent.state).toMatchObject({ isStreaming: false, errorMessage: undefined });
  });

  it("omits oversized metadata within the cap", async () => {
    const metadata = { type: "custom", value: "m".repeat(8_192) };
    const hint = textBlock("Inspect src/fixture.ts before retrying.");
    const source = castAgentMessage({
      ...makeToolResult("blocks", ""),
      content: [textBlock("x".repeat(6_000)), metadata, hint],
      details: { privateReference: "not model context" },
    });
    const original = structuredClone(source);
    const [result] = await project([source], 8_192);
    const projected = expectDefined(result, "bounded mixed result");
    if (projected.role !== "toolResult") {
      throw new Error("expected a tool result");
    }
    expect(source).toEqual(original);
    expectBoundedResult(projected, 8_192, hint.text);
    expect(projected.content).not.toContain(metadata);
  });

  it("leaves aggregate pressure and private details out of per-result shaping", async () => {
    const messages = [
      makeUser("u".repeat(50_000)),
      makeToolResultWithDetails("small", "x".repeat(100), "d".repeat(80_000)),
      makeReadToolResult("recent", "small output"),
    ];
    expect(await applyGuardToContext(makeGuardableAgent(), messages)).toBe(messages);
  });

  it("truncates legacy string tool outputs", async () => {
    const [result] = await project([makeLegacyToolResult("legacy", "y".repeat(5_000))]);
    const text = getAllToolResultText(expectDefined(result, "legacy result"));
    expect(result).toHaveProperty("content", text);
    expectOpenClawTruncation(text);
  });
});

describe("installContextEngineLoopHook", () => {
  it.each(["live", "deferred"] as const)(
    "budgets %s assembly in the mid-turn precheck's units",
    async (mode) => {
      const systemPrompt = "system rules ".repeat(2_000);
      const tools = Array.from({ length: 40 }, (_, index) => ({
        name: `tool_${index}`,
        description: "Runs a fixture operation with several options. ".repeat(8),
        parameters: Type.Object({ path: Type.String(), limit: Type.Optional(Type.Number()) }),
      }));
      const contextTokenBudget = 64_000;
      const reserveTokens = 8_000;
      const filler = () => makeUser("history filler ".repeat(100));
      let lastAssembled: AgentMessage[] = [];
      const engine = makeEngine();
      // Fill the requested budget as tightly as the engine's raw estimate allows.
      engine.assemble.mockImplementation(async ({ tokenBudget }) => {
        const messages: AgentMessage[] = [];
        let tokens = 0;
        while (tokens + estimateMessageTokenPressure(filler()) <= (tokenBudget ?? 0)) {
          messages.push(filler());
          tokens += estimateMessageTokenPressure(filler());
        }
        lastAssembled = messages;
        return { messages, estimatedTokens: tokens };
      });
      const { run } = hook(engine, {
        tokenBudget: contextTokenBudget,
        reserveTokens: () => reserveTokens,
        getSystemPrompt: () => systemPrompt,
        getTools: () => tools,
        ...(mode === "deferred"
          ? { deferredTurn: { prompt: "go", availableTools: new Set<string>() } }
          : {}),
      });
      const view = await run([
        makeUser("first"),
        makeAssistant("calling a tool"),
        makeToolResult("call_1", "tool output ".repeat(1_500)),
      ]);
      expect(lastAssembled.length).toBeGreaterThan(0);
      const precheck = (messages: AgentMessage[]) =>
        resolveProjectedRequestPressure({
          context: { messages: convertToLlm(messages), systemPrompt, tools },
          contextTokenBudget,
          reserveTokens,
        });

      expect(precheck(view).route).toBe("fits");
      // One more history item must overflow: the budget is tight, not conservatively small.
      const pending = view.slice(lastAssembled.length);
      expect(precheck([...lastAssembled, filler(), ...pending]).route).not.toBe("fits");
    },
  );

  it.each(["before", "upstream", "afterTurn", "ingestBatch", "ingest", "assemble"] as const)(
    "stops the next provider request when cancelled at %s",
    async (stage) => {
      const controller = new AbortController();
      const cancellation = new Error("operator cancelled");
      const cancel = () => controller.abort(cancellation);
      const engine = makeEngine(stage, cancel);
      const agent = makeGuardableAgent(
        stage === "upstream"
          ? async (messages) => {
              cancel();
              return messages;
            }
          : undefined,
      );
      if (stage === "afterTurn") {
        engine.afterTurn.mockImplementation(async ({ messages }) => {
          messages.length = 0;
          cancel();
        });
      }
      const individual = stage === "ingest";
      const { run } = hook(
        {
          ...engine,
          afterTurn: individual || stage === "ingestBatch" ? undefined : engine.afterTurn,
          ingestBatch: individual ? undefined : engine.ingestBatch,
        },
        {},
        agent,
      );
      const original = [
        makeUser("first"),
        makeToolResult("one", "result"),
        makeToolResult("two", "later result"),
      ];
      const messages = original.slice();
      if (stage === "before") {
        cancel();
      }
      const requestProvider = vi.fn();
      await expect(
        Promise.resolve(run(messages, controller.signal)).then(requestProvider),
      ).rejects.toBe(cancellation);
      expect(messages).toEqual(original);
      expect(requestProvider).not.toHaveBeenCalled();
      if (stage !== "assemble") {
        expect(engine.assemble).not.toHaveBeenCalled();
      }
      if (stage === "before" || stage === "upstream") {
        expect(engine.afterTurn).not.toHaveBeenCalled();
      }
      if (individual) {
        expect(engine.ingest).toHaveBeenCalledTimes(1);
      }
    },
  );

  it("advances the ingest fence and checkpoints only new iterations", async () => {
    const engine = makeEngine();
    const onAfterTurnCheckpoint = vi.fn();
    const getRuntimeContext = vi.fn(() => ({ provider: "anthropic" }));
    const { run } = hook(engine, {
      getPrePromptMessageCount: undefined,
      onAfterTurnCheckpoint,
      getRuntimeContext,
    });
    let messages = exchange();
    expect(await run(messages)).toBe(messages);
    await run(messages);
    expect(engine.afterTurn).not.toHaveBeenCalled();
    for (const id of ["two", "three"]) {
      const fence = messages.length;
      messages = messages.concat(
        makeUser(id),
        makeAssistant("tool use"),
        makeToolResult(id, "result"),
      );
      await run(messages);
      expect(engine.afterTurn).toHaveBeenLastCalledWith(
        expect.objectContaining({
          messages,
          prePromptMessageCount: fence,
          runtimeContext: { provider: "anthropic" },
        }),
      );
      expect(getRuntimeContext).toHaveBeenLastCalledWith({
        messages,
        prePromptMessageCount: fence,
      });
      expect(onAfterTurnCheckpoint).toHaveBeenLastCalledWith(messages.length);
    }
    expect(engine.afterTurn).toHaveBeenCalledTimes(2);
    expect(engine.assemble).toHaveBeenCalledTimes(2);
  });

  it("keeps original text for ingestion and replays the recorded model projection", async () => {
    const engine = makeEngine();
    const { run } = hook(engine, { getPrePromptMessageCount: () => 0 });
    const visible = "visible prompt";
    const projection = "model-only context\n\nvisible prompt";
    const prompt = {
      ...makeUser(visible),
      __openclaw: { modelPromptProjection: { version: 1, text: projection } },
    };
    const transformed = await run([prompt, makeToolResult("one", "result")]);
    for (const message of [
      engine.afterTurn.mock.calls[0]?.[0].messages[0],
      engine.assemble.mock.calls[0]?.[0].messages[0],
    ]) {
      expect(message).toMatchObject({ role: "user", content: visible });
    }
    const normalized = normalizeMessagesForLlmBoundary(transformed);
    expect(normalized[0]).toMatchObject({ role: "user", content: projection });
    expect(JSON.stringify(normalized)).not.toContain("modelPromptProjection");
  });

  it("repairs orphan results from an engine returning its working array", async () => {
    const engine = makeEngine();
    const { run } = hook(engine, { repairAssembledMessages: sanitizeToolUseResultPairing });
    const messages = exchange();
    expect(await run(messages)).toEqual([messages[0]]);
    const input = engine.assemble.mock.calls[0]?.[0].messages;
    expect(input).not.toBe(messages);
    expect(input).toEqual(messages);
    expect(input?.[0]).toBe(messages[0]);
    expect(messages).toHaveLength(2);
  });

  it.each(["shrinks", "resets at the same length"])(
    "clears cached assembly when history %s",
    async (reset) => {
      const engine = makeEngine();
      const compacted = [makeUser("compacted")];
      engine.assemble.mockResolvedValueOnce({ messages: compacted, estimatedTokens: 0 });
      const { run } = hook(engine);
      const messages = [...exchange(), makeToolResult("two", "result")];
      expect(await run(messages)).toBe(compacted);
      expect(await run(messages)).toBe(compacted);
      expect(engine.assemble).toHaveBeenCalledOnce();
      const replacement =
        reset === "shrinks"
          ? [makeUser("reset")]
          : [makeUser("reset"), makeToolResult("new", "result"), makeUser("fresh")];
      const result = await run(replacement);
      expect(result).toEqual(replacement);
      expect(result[0]).toBe(replacement[0]);
      if (reset === "shrinks") {
        expect(result).toBe(replacement);
      } else {
        expect(result).not.toBe(replacement);
      }
    },
  );

  it.each([true, false])(
    "ingests only new messages when afterTurn is absent (batch: %s)",
    async (batch) => {
      const engine = makeEngine();
      const { run } = hook({
        ...engine,
        afterTurn: undefined,
        ingestBatch: batch ? engine.ingestBatch : undefined,
      });
      const first = exchange();
      await run(first);
      const second = [...first, makeUser("second"), makeToolResult("two", "result")];
      await run(second);
      if (batch) {
        expect(engine.ingestBatch.mock.calls.map(([params]) => params.messages)).toEqual([
          first.slice(1),
          second.slice(2),
        ]);
        expect(engine.ingest).not.toHaveBeenCalled();
      } else {
        expect(engine.ingest.mock.calls.map(([params]) => params.message)).toEqual([
          ...first.slice(1),
          ...second.slice(2),
        ]);
      }
      expect(engine.assemble).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    "afterTurn throws",
    "assemble throws",
    "assemble returns null",
    "assemble omits messages",
  ] as const)("restores hook-mutated history and retries when %s", async (failure) => {
    const engine = makeEngine();
    const compacted = [makeUser("compacted")];
    engine.assemble.mockResolvedValueOnce({ messages: compacted, estimatedTokens: 0 });
    const { run } = hook(engine);
    const first = exchange();
    expect(await run(first)).toBe(compacted);
    const original = [...first, makeToolResult("two", "preserve result")];
    const messages = original.slice();
    engine.afterTurn.mockImplementationOnce(async ({ messages: history }) => {
      history.splice(0, history.length, makeUser("mutated history"));
      if (failure === "afterTurn throws") {
        throw new Error("failed after mutation");
      }
    });
    if (failure === "assemble returns null") {
      engine.assemble.mockResolvedValueOnce(null as never);
    }
    if (failure === "assemble throws") {
      engine.assemble.mockImplementationOnce(async ({ messages: history }) => {
        history.reverse();
        history.pop();
        throw new Error("assemble failed");
      });
    }
    if (failure === "assemble omits messages") {
      engine.assemble.mockResolvedValueOnce({ estimatedTokens: 0 } as never);
    }
    expect(await run(messages)).toBe(messages);
    expect(messages).toEqual(original);
    original.forEach((message, index) => expect(messages[index]).toBe(message));
    const retry = await run(messages);
    expect(retry).toEqual(original);
    expect(retry).not.toBe(messages);
    expect(retry).not.toBe(compacted);
    expect(retry[0]).toBe(messages[0]);
    expect(engine.afterTurn.mock.calls[2]?.[0].prePromptMessageCount).toBe(first.length);
    expect(await run(messages)).toBe(retry);
    expect(engine.afterTurn).toHaveBeenCalledTimes(3);
  });

  it("keeps successful in-place windowing and caches the assembled view", async () => {
    const engine = makeEngine();
    engine.afterTurn.mockImplementation(async ({ messages }) => {
      messages.splice(0, 1);
    });
    const { run } = hook(engine);
    const result = makeToolResult("one", "result");
    const messages = [makeUser("first"), result];
    const assembled = await run(messages);
    expect(assembled).toEqual([result]);
    expect(messages).toEqual([result]);
    expect(await run(messages)).toBe(assembled);
    expect(engine.afterTurn).toHaveBeenCalledOnce();
  });
});
