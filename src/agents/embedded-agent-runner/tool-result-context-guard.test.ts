import { expectDefined } from "@openclaw/normalization-core";
import { Agent, type AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { createAssistantMessageEventStream, type Message } from "openclaw/plugin-sdk/llm";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import type { ContextEngine } from "../../context-engine/types.js";
import { sanitizeToolUseResultPairing } from "../session-transcript-repair.js";
import { convertToLlm } from "../sessions/messages.js";
import {
  castAgentMessage,
  makeAgentAssistantMessage,
} from "../test-helpers/agent-message-fixtures.js";
import { makeProviderModelFixture } from "../test-helpers/provider-model-fixture.js";
import { formatContextLimitTruncationNotice } from "./context-truncation-notice.js";
import { MidTurnPrecheckSignal } from "./run/midturn-precheck.js";
import {
  createMessageCharEstimateCache,
  estimateMessageCharsCached,
  getToolResultText as getAllToolResultText,
} from "./tool-result-char-estimator.js";
import {
  installContextEngineLoopHook,
  installToolResultContextGuard,
  markTranscriptPromptText,
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
  getToolResultText,
  applyGuardToContext,
  applyMidTurnPrecheckGuardToContext,
  expectOpenClawTruncation,
} from "./tool-result-context-guard.test-support.js";

async function project(messages: AgentMessage[], contextWindowTokens = 1_000) {
  const agent = makeGuardableAgent();
  const dispose = installToolResultContextGuard({ agent, contextWindowTokens });
  try {
    return await expectDefined(agent.transformContext, "installed guard")(
      messages,
      new AbortController().signal,
    );
  } finally {
    dispose();
  }
}

function makeEngine() {
  return {
    info: { id: "test-engine", name: "Test Engine", version: "0.0.1", ownsCompaction: true },
    afterTurn: vi.fn<NonNullable<ContextEngine["afterTurn"]>>(async () => {}),
    assemble: vi.fn<ContextEngine["assemble"]>(async ({ messages }) => ({
      messages,
      estimatedTokens: 0,
    })),
    compact: vi.fn<ContextEngine["compact"]>(async () => {
      throw new Error("unexpected direct compaction");
    }),
    ingest: vi.fn<ContextEngine["ingest"]>(async () => ({ ingested: true })),
    ingestBatch: vi.fn<NonNullable<ContextEngine["ingestBatch"]>>(async ({ messages }) => ({
      ingestedCount: messages.length,
    })),
  } satisfies ContextEngine;
}

type HookOptions = Partial<
  Omit<Parameters<typeof installContextEngineLoopHook>[0], "agent" | "contextEngine">
>;
function hook(engine: ContextEngine, options: HookOptions = {}, agent = makeGuardableAgent()) {
  const dispose = installContextEngineLoopHook({
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
    dispose,
    run: (messages: AgentMessage[], signal = new AbortController().signal) =>
      expectDefined(agent.transformContext, "installed hook")(messages, signal),
  };
}

function pressureCheck(
  agent: ReturnType<typeof makeGuardableAgent>,
  messages: AgentMessage[],
  toolResultMaxChars?: number,
) {
  return applyMidTurnPrecheckGuardToContext(agent, messages, {
    contextWindowTokens: 200_000,
    contextTokenBudget: 20_000,
    reserveTokens: 12_000,
    toolResultMaxChars,
    systemPrompt: "sys",
    prePromptMessageCount: 1,
  });
}

describe("installToolResultContextGuard", () => {
  it("delivers actionable tool text through the real agent loop", async () => {
    const hint = "Inspect src/fixture.ts before retrying.";
    const preamble = "progress output\n".repeat(400);
    const sourceTexts = [preamble + "Error: missing import; " + hint];
    const content = sourceTexts.map((text) => ({ type: "text" as const, text }));
    const original = structuredClone(content);
    const requests: Message[][] = [];
    const execute = vi.fn(async () => ({ content, details: { privateReference: "fixture" } }));
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
            execute,
          },
        ],
      },
      convertToLlm,
      streamFn: (_model, context) => {
        requests.push(structuredClone(context.messages));
        const result = context.messages.find((message) => message.role === "toolResult");
        const hasHint = result && getAllToolResultText(result).includes(hint);
        const message = makeAgentAssistantMessage({
          content:
            requests.length === 1
              ? [{ type: "toolCall", id: "call_diagnostic", name: "diagnostic", arguments: {} }]
              : [{ type: "text", text: hasHint ? hint : "The diagnostic hint was unavailable." }],
          stopReason: requests.length === 1 ? "toolUse" : "stop",
        });
        const stream = createAssistantMessageEventStream();
        stream.push({
          type: "done",
          reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
          message,
        });
        stream.end();
        return stream;
      },
    });
    const dispose = installToolResultContextGuard({
      agent,
      contextWindowTokens,
    });
    try {
      await agent.prompt("Read the diagnostic and report its next step.");
    } finally {
      agent.abort();
      await agent.waitForIdle();
      dispose();
    }

    expect(execute).toHaveBeenCalledOnce();
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
    expect(projected).not.toHaveProperty("details");
    expect(
      estimateMessageCharsCached(projected, createMessageCharEstimateCache()),
    ).toBeLessThanOrEqual(contextWindowTokens);
    expect(getAllToolResultText(projected)).toContain(CONTEXT_LIMIT_TRUNCATION_NOTICE);
    expect(getAllToolResultText(projected)).toContain(hint);
    expect(agent.state.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: hint }],
      stopReason: "stop",
    });
    expect(agent.state.isStreaming).toBe(false);
    expect(agent.state.errorMessage).toBeUndefined();
  });

  it.each([64, 8_192])(
    "reserves or omits %i characters of metadata within the cap",
    async (size) => {
      const metadata = { type: "custom", value: "m".repeat(size) };
      const hint = { type: "text", text: "Inspect src/fixture.ts before retrying." };
      const source = castAgentMessage({
        ...makeToolResult("blocks", ""),
        content: [{ type: "text", text: "x".repeat(6_000) }, metadata, hint],
        details: { privateReference: "not model context" },
      });
      const original = structuredClone(source);
      const [result] = await project([source], 8_192);
      const projected = expectDefined(result, "bounded mixed result");
      if (projected.role !== "toolResult") {
        throw new Error("expected a tool result");
      }
      expect(
        estimateMessageCharsCached(projected, createMessageCharEstimateCache()),
      ).toBeLessThanOrEqual(8_192);
      expect(source).toEqual(original);
      expect(projected).not.toHaveProperty("details");
      expect(getAllToolResultText(projected)).toContain(CONTEXT_LIMIT_TRUNCATION_NOTICE);
      expect(getAllToolResultText(projected)).toContain(hint.text);
      if (size === 64) {
        expect(projected.content).toContain(metadata);
        expect(projected.content).toContainEqual(hint);
      } else {
        expect(projected.content).not.toContain(metadata);
      }
    },
  );

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

  it("does not split a surrogate pair at the old truncation boundary", async () => {
    const text = "a".repeat(439) + "😀" + "b".repeat(1_000);
    const source = makeToolResult("utf16", text);
    const [result] = await project([source]);
    expect(getToolResultText(expectDefined(result, "UTF-16 result"))).toBe(
      "a".repeat(439) + formatContextLimitTruncationNotice(1_002),
    );
    expect(getToolResultText(source)).toBe(text);
  });

  it.each(["compact_then_truncate", "compact_only"] as const)(
    "signals %s after engine assembly still leaves pressure",
    async (route) => {
      const engine = makeEngine();
      const { agent } = hook(engine);
      const messages =
        route === "compact_then_truncate"
          ? [makeUser("first"), makeToolResult("big", "x".repeat(80_000))]
          : [makeUser("u".repeat(80_000)), makeToolResult("small", "small output")];
      const pending = pressureCheck(
        agent,
        messages,
        route === "compact_then_truncate" ? 16_000 : undefined,
      );
      await expect(pending).rejects.toBeInstanceOf(MidTurnPrecheckSignal);
      await expect(pending).rejects.toMatchObject({
        request: {
          route,
          overflowTokens: expect.any(Number),
          toolResultReducibleChars: expect.any(Number),
        },
      });
      expect(engine.afterTurn).toHaveBeenCalledOnce();
      expect(engine.assemble).toHaveBeenCalledOnce();
    },
  );

  it("lets engine assembly resolve pressure before prechecking", async () => {
    const engine = makeEngine();
    const compacted = [makeUser("compacted")];
    engine.assemble.mockResolvedValue({ messages: compacted, estimatedTokens: 0 });
    const { agent } = hook(engine);
    expect(
      await pressureCheck(agent, [makeUser("first"), makeToolResult("big", "x".repeat(80_000))]),
    ).toBe(compacted);
    expect(engine.afterTurn).toHaveBeenCalledOnce();
    expect(engine.assemble).toHaveBeenCalledOnce();
  });
});

describe("installContextEngineLoopHook", () => {
  it.each(["before", "upstream", "afterTurn", "ingestBatch", "ingest", "assemble"] as const)(
    "stops the next provider request when cancelled at %s",
    async (stage) => {
      const controller = new AbortController();
      const cancellation = new Error("operator cancelled");
      const cancel = () => controller.abort(cancellation);
      const engine = makeEngine();
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
      if (stage === "ingestBatch") {
        engine.ingestBatch.mockImplementation(async () => {
          cancel();
          return { ingestedCount: 1 };
        });
      }
      if (stage === "ingest") {
        engine.ingest.mockImplementation(async () => {
          cancel();
          return { ingested: true };
        });
      }
      if (stage === "assemble") {
        engine.assemble.mockImplementation(async ({ messages }) => {
          cancel();
          return { messages, estimatedTokens: 0 };
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

  it("accepts the upstream contract with no abort signal", async () => {
    const engine = makeEngine();
    const { agent } = hook(engine);
    const messages = [makeUser("first"), makeToolResult("one", "result")];
    await expect(
      Reflect.apply(expectDefined(agent.transformContext, "hook"), agent, [messages, undefined]),
    ).resolves.toEqual(messages);
    expect(engine.afterTurn).toHaveBeenCalledOnce();
    expect(engine.assemble).toHaveBeenCalledOnce();
  });

  it("advances the ingest fence and checkpoints only new iterations", async () => {
    const engine = makeEngine();
    const onAfterTurnCheckpoint = vi.fn();
    const getRuntimeContext = vi.fn(() => ({ provider: "anthropic" }));
    const { run } = hook(engine, {
      getPrePromptMessageCount: undefined,
      onAfterTurnCheckpoint,
      getRuntimeContext,
    });
    let messages = [makeUser("first"), makeToolResult("one", "result")];
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

  it("projects transcript text for ingest and strips its marker from provider messages", async () => {
    const engine = makeEngine();
    const { run } = hook(engine, { getPrePromptMessageCount: () => 0 });
    const prompt = makeUser("model-only context\n\nvisible prompt");
    markTranscriptPromptText(prompt, "visible prompt");
    const transformed = await run([prompt, makeToolResult("one", "result")]);
    expect(engine.afterTurn.mock.calls[0]?.[0].messages[0]).toMatchObject({
      role: "user",
      content: "visible prompt",
    });
    expect(JSON.stringify(engine.afterTurn.mock.calls[0]?.[0].messages)).not.toContain(
      "__openclawTranscriptPromptText",
    );
    expect(engine.assemble.mock.calls[0]?.[0].messages[0]).toMatchObject({
      role: "user",
      content: "model-only context\n\nvisible prompt",
    });
    expect(transformed[0]).toMatchObject({
      role: "user",
      content: "model-only context\n\nvisible prompt",
    });
    expect(JSON.stringify(transformed)).not.toContain("__openclawTranscriptPromptText");
  });

  it("repairs orphan results from an engine returning its working array", async () => {
    const engine = makeEngine();
    const { run } = hook(engine, { repairAssembledMessages: sanitizeToolUseResultPairing });
    const messages = [makeUser("first"), makeToolResult("orphan", "result")];
    expect(await run(messages)).toEqual([messages[0]]);
    const input = engine.assemble.mock.calls[0]?.[0].messages;
    expect(input).not.toBe(messages);
    expect(input).toEqual(messages);
    expect(input?.[0]).toBe(messages[0]);
    expect(messages).toHaveLength(2);
  });

  it("clears a cached view after failed assembly and retries the same source", async () => {
    const engine = makeEngine();
    const compacted = [makeUser("compacted")];
    engine.assemble
      .mockResolvedValueOnce({ messages: compacted, estimatedTokens: 0 })
      .mockImplementationOnce(async ({ messages }) => {
        messages.reverse();
        messages.pop();
        throw new Error("assemble failed");
      });
    const { run } = hook(engine);
    const first = [makeUser("first"), makeToolResult("one", "result")];
    expect(await run(first)).toBe(compacted);
    const next = [...first, makeToolResult("two", "result")];
    const original = next.slice();
    expect(await run(next)).toBe(next);
    expect(next).toEqual(original);
    const retry = await run(next);
    expect(retry).not.toBe(next);
    expect(retry).toEqual(original);
    expect(retry[0]).toBe(next[0]);
    expect(retry).not.toBe(compacted);
    expect(engine.assemble).toHaveBeenCalledTimes(3);
  });

  it.each(["shrinks", "resets at the same length"])(
    "clears cached assembly when history %s",
    async (reset) => {
      const engine = makeEngine();
      const compacted = [makeUser("compacted")];
      engine.assemble.mockResolvedValueOnce({ messages: compacted, estimatedTokens: 0 });
      const { run } = hook(engine);
      const messages = [
        makeUser("first"),
        makeToolResult("one", "result"),
        makeToolResult("two", "result"),
      ];
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
      const { run } = hook(
        { ...engine, afterTurn: undefined, ingestBatch: batch ? engine.ingestBatch : undefined },
        { isHeartbeat: true },
      );
      const first = [makeUser("first"), makeToolResult("one", "result")];
      await run(first);
      const second = [...first, makeUser("second"), makeToolResult("two", "result")];
      await run(second);
      if (batch) {
        expect(engine.ingestBatch.mock.calls.map(([params]) => params.messages)).toEqual([
          first.slice(1),
          second.slice(2),
        ]);
        expect(engine.ingestBatch.mock.calls.map(([params]) => params.isHeartbeat)).toEqual([
          true,
          true,
        ]);
        expect(engine.ingest).not.toHaveBeenCalled();
      } else {
        expect(engine.ingest.mock.calls.map(([params]) => params.message)).toEqual([
          ...first.slice(1),
          ...second.slice(2),
        ]);
        expect(engine.ingest.mock.calls.map(([params]) => params.isHeartbeat)).toEqual([
          true,
          true,
          true,
        ]);
      }
      expect(engine.assemble).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["afterTurn throws", "assemble returns null", "assemble omits messages"] as const)(
    "restores hook-mutated history and retries when %s",
    async (failure) => {
      const engine = makeEngine();
      const original = [makeUser("preserve instruction"), makeToolResult("one", "preserve result")];
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
      if (failure === "assemble omits messages") {
        engine.assemble.mockResolvedValueOnce({ estimatedTokens: 0 } as never);
      }
      const { run } = hook(engine);
      expect(await run(messages)).toBe(messages);
      expect(messages).toEqual(original);
      original.forEach((message, index) => expect(messages[index]).toBe(message));
      expect(await run(messages)).toEqual(original);
      expect(engine.afterTurn).toHaveBeenCalledTimes(2);
      expect(engine.afterTurn.mock.calls[1]?.[0].prePromptMessageCount).toBe(1);
      expect(await run(messages)).toEqual(original);
      expect(engine.afterTurn).toHaveBeenCalledTimes(2);
    },
  );

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

  it("runs and restores the upstream transform across hook installation", async () => {
    const upstream = vi.fn(async (messages: AgentMessage[]) => [...messages, makeUser("appended")]);
    const engine = makeEngine();
    const compacted = [makeUser("compacted")];
    engine.assemble.mockResolvedValue({ messages: compacted, estimatedTokens: 0 });
    const { agent, run, dispose } = hook(
      engine,
      { getPrePromptMessageCount: undefined },
      makeGuardableAgent(upstream),
    );
    await run([makeUser("first")]);
    expect(upstream).toHaveBeenCalledOnce();
    expect(await run([makeUser("first"), makeUser("second")])).toBe(compacted);
    expect(upstream).toHaveBeenCalledTimes(2);
    dispose();
    expect(agent.transformContext).toBe(upstream);
  });
});
