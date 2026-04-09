import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import type { ContextEngine } from "../../context-engine/types.js";
import { castAgentMessage } from "../test-helpers/agent-message-fixtures.js";
import {
  CONTEXT_LIMIT_TRUNCATION_NOTICE,
  formatContextLimitTruncationNotice,
  installContextEngineLoopHook,
  installToolResultContextGuard,
  PREEMPTIVE_CONTEXT_OVERFLOW_MESSAGE,
} from "./tool-result-context-guard.js";

function makeUser(text: string): AgentMessage {
  return castAgentMessage({
    role: "user",
    content: text,
    timestamp: Date.now(),
  });
}

function makeToolResult(id: string, text: string, toolName = "grep"): AgentMessage {
  return castAgentMessage({
    role: "toolResult",
    toolCallId: id,
    toolName,
    content: [{ type: "text", text }],
    isError: false,
    timestamp: Date.now(),
  });
}

function makeReadToolResult(id: string, text: string): AgentMessage {
  return makeToolResult(id, text, "read");
}

function makeLegacyToolResult(id: string, text: string): AgentMessage {
  return castAgentMessage({
    role: "tool",
    tool_call_id: id,
    tool_name: "read",
    content: text,
  });
}

function makeToolResultWithDetails(id: string, text: string, detailText: string): AgentMessage {
  return castAgentMessage({
    role: "toolResult",
    toolCallId: id,
    toolName: "read",
    content: [{ type: "text", text }],
    details: {
      truncation: {
        truncated: true,
        outputLines: 100,
        content: detailText,
      },
    },
    isError: false,
    timestamp: Date.now(),
  });
}

function getToolResultText(msg: AgentMessage): string {
  const content = (msg as { content?: unknown }).content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const block = content.find(
    (entry) => entry && typeof entry === "object" && (entry as { type?: string }).type === "text",
  ) as { text?: string } | undefined;
  return typeof block?.text === "string" ? block.text : "";
}

function makeGuardableAgent(
  transformContext?: (
    messages: AgentMessage[],
    signal: AbortSignal,
  ) => AgentMessage[] | Promise<AgentMessage[]>,
) {
  return { transformContext };
}

async function applyGuardToContext(
  agent: { transformContext?: (messages: AgentMessage[], signal: AbortSignal) => unknown },
  contextForNextCall: AgentMessage[],
  contextWindowTokens = 1_000,
) {
  installToolResultContextGuard({
    agent,
    contextWindowTokens,
  });
  return await agent.transformContext?.(contextForNextCall, new AbortController().signal);
}

function expectPiStyleTruncation(text: string): void {
  expect(text).toContain(CONTEXT_LIMIT_TRUNCATION_NOTICE);
  expect(text).toMatch(/\[\.\.\. \d+ more characters truncated\]$/);
  expect(text).not.toContain("[compacted: tool output removed to free context]");
  expect(text).not.toContain("[compacted: tool output trimmed to free context]");
  expect(text).not.toContain("[truncated: output exceeded context limit]");
}

describe("formatContextLimitTruncationNotice", () => {
  it("formats pi-style truncation wording with a count", () => {
    expect(formatContextLimitTruncationNotice(123)).toBe("[... 123 more characters truncated]");
  });
});

describe("installToolResultContextGuard", () => {
  it("passes through unchanged context when under the per-tool and total budget", async () => {
    const agent = makeGuardableAgent();
    const contextForNextCall = [makeUser("hello"), makeToolResult("call_ok", "small output")];

    const transformed = await applyGuardToContext(agent, contextForNextCall);

    expect(transformed).toBe(contextForNextCall);
  });

  it("does not preemptively overflow large non-tool context that is still under the high-water mark", async () => {
    const agent = makeGuardableAgent();
    const contextForNextCall = [makeUser("u".repeat(3_200))];

    const transformed = await applyGuardToContext(agent, contextForNextCall);

    expect(transformed).toBe(contextForNextCall);
  });

  it("returns a cloned guarded context so original oversized tool output stays visible", async () => {
    const agent = makeGuardableAgent();
    const contextForNextCall = [makeToolResult("call_big", "z".repeat(5_000))];

    const transformed = (await applyGuardToContext(agent, contextForNextCall)) as AgentMessage[];

    expect(transformed).not.toBe(contextForNextCall);
    const newResultText = getToolResultText(transformed[0]);
    expect(newResultText.length).toBeLessThan(5_000);
    expectPiStyleTruncation(newResultText);
    expect(getToolResultText(contextForNextCall[0])).toBe("z".repeat(5_000));
  });

  it("wraps an existing transformContext and guards the transformed output", async () => {
    const agent = makeGuardableAgent((messages) =>
      messages.map((msg) =>
        castAgentMessage({
          ...(msg as unknown as Record<string, unknown>),
        }),
      ),
    );
    const contextForNextCall = [makeToolResult("call_big", "x".repeat(5_000))];

    const transformed = (await applyGuardToContext(agent, contextForNextCall)) as AgentMessage[];

    expect(transformed).not.toBe(contextForNextCall);
    expectPiStyleTruncation(getToolResultText(transformed[0]));
  });

  it("handles legacy role=tool string outputs with pi-style truncation wording", async () => {
    const agent = makeGuardableAgent();
    const contextForNextCall = [makeLegacyToolResult("call_big", "y".repeat(5_000))];

    const transformed = (await applyGuardToContext(agent, contextForNextCall)) as AgentMessage[];
    const newResultText = getToolResultText(transformed[0]);

    expect(typeof (transformed[0] as { content?: unknown }).content).toBe("string");
    expectPiStyleTruncation(newResultText);
  });

  it("drops oversized tool-result details when truncating once", async () => {
    const agent = makeGuardableAgent();
    const contextForNextCall = [
      makeToolResultWithDetails("call_big", "x".repeat(900), "d".repeat(8_000)),
    ];

    const transformed = (await applyGuardToContext(agent, contextForNextCall)) as AgentMessage[];
    const result = transformed[0] as { details?: unknown };
    const newResultText = getToolResultText(transformed[0]);

    expectPiStyleTruncation(newResultText);
    expect(result.details).toBeUndefined();
    expect((contextForNextCall[0] as { details?: unknown }).details).toBeDefined();
  });

  it("throws a preemptive overflow when total context still exceeds the high-water mark", async () => {
    const agent = makeGuardableAgent();
    const contextForNextCall = [
      makeUser("u".repeat(50_000)),
      makeToolResult("call_big", "x".repeat(5_000)),
    ];

    await expect(applyGuardToContext(agent, contextForNextCall)).rejects.toThrow(
      PREEMPTIVE_CONTEXT_OVERFLOW_MESSAGE,
    );
    expect(getToolResultText(contextForNextCall[1])).toBe("x".repeat(5_000));
  });

  it("throws instead of rewriting older tool results under aggregate pressure", async () => {
    const agent = makeGuardableAgent();
    const contextForNextCall = [
      makeUser("u".repeat(50_000)),
      makeToolResult("call_1", "a".repeat(500)),
      makeToolResult("call_2", "b".repeat(500)),
      makeToolResult("call_3", "c".repeat(500)),
    ];

    await expect(applyGuardToContext(agent, contextForNextCall)).rejects.toThrow(
      PREEMPTIVE_CONTEXT_OVERFLOW_MESSAGE,
    );
    expect(getToolResultText(contextForNextCall[1])).toBe("a".repeat(500));
    expect(getToolResultText(contextForNextCall[2])).toBe("b".repeat(500));
    expect(getToolResultText(contextForNextCall[3])).toBe("c".repeat(500));
  });

  it("does not special-case the latest read result before throwing under aggregate pressure", async () => {
    const agent = makeGuardableAgent();
    const contextForNextCall = [
      makeUser("u".repeat(50_000)),
      makeToolResult("call_old", "x".repeat(400)),
      makeReadToolResult("call_new", "y".repeat(500)),
    ];

    await expect(applyGuardToContext(agent, contextForNextCall)).rejects.toThrow(
      PREEMPTIVE_CONTEXT_OVERFLOW_MESSAGE,
    );
    expect(getToolResultText(contextForNextCall[1])).toBe("x".repeat(400));
    expect(getToolResultText(contextForNextCall[2])).toBe("y".repeat(500));
  });

  it("supports model-window-specific truncation for large but otherwise valid tool results", async () => {
    const agent = makeGuardableAgent();
    const contextForNextCall = [makeToolResult("call_big", "q".repeat(95_000))];

    const transformed = (await applyGuardToContext(
      agent,
      contextForNextCall,
      100_000,
    )) as AgentMessage[];

    expectPiStyleTruncation(getToolResultText(transformed[0]));
  });
});

type MockedEngine = ContextEngine & {
  afterTurn: ReturnType<typeof vi.fn>;
  assemble: ReturnType<typeof vi.fn>;
};

function makeMockEngine(
  overrides: {
    assemble?: (
      params: Parameters<ContextEngine["assemble"]>[0],
    ) => Promise<{ messages: AgentMessage[]; estimatedTokens: number }>;
    afterTurn?: (params: Parameters<NonNullable<ContextEngine["afterTurn"]>>[0]) => Promise<void>;
    omitAfterTurn?: boolean;
  } = {},
): MockedEngine {
  const defaultAfterTurn = vi.fn(async () => {});
  const defaultAssemble = vi.fn(async (params: Parameters<ContextEngine["assemble"]>[0]) => ({
    messages: params.messages,
    estimatedTokens: 0,
  }));
  const afterTurn = overrides.omitAfterTurn
    ? undefined
    : overrides.afterTurn
      ? vi.fn(overrides.afterTurn)
      : defaultAfterTurn;
  const assemble = overrides.assemble ? vi.fn(overrides.assemble) : defaultAssemble;
  const engine = {
    info: {
      id: "test-engine",
      name: "Test Engine",
      version: "0.0.1",
      ownsCompaction: true,
    },
    ingest: async () => ({ ingested: true }),
    assemble,
    ...(afterTurn ? { afterTurn } : {}),
  } as unknown as MockedEngine;
  return engine;
}

async function callTransform(
  agent: { transformContext?: (messages: AgentMessage[], signal: AbortSignal) => unknown },
  messages: AgentMessage[],
) {
  return await agent.transformContext?.(messages, new AbortController().signal);
}

describe("installContextEngineLoopHook", () => {
  const sessionId = "test-session-id";
  const sessionKey = "agent:main:subagent:test";
  const sessionFile = "/tmp/test-session.jsonl";
  const tokenBudget = 4096;
  const modelId = "test-model";

  it("forwards new messages to engine.afterTurn with prePromptMessageCount=0 on first call", async () => {
    const agent = makeGuardableAgent();
    const engine = makeMockEngine();
    installContextEngineLoopHook({
      agent,
      contextEngine: engine,
      sessionId,
      sessionKey,
      sessionFile,
      tokenBudget,
      modelId,
    });

    const messages = [makeUser("first"), makeToolResult("call_1", "result")];
    await callTransform(agent, messages);

    expect(engine.afterTurn).toHaveBeenCalledTimes(1);
    expect(engine.afterTurn.mock.calls[0]?.[0]).toMatchObject({
      sessionId,
      sessionKey,
      sessionFile,
      messages,
      prePromptMessageCount: 0,
      tokenBudget,
    });
  });

  it("advances prePromptMessageCount on subsequent calls based on the previous high-water mark", async () => {
    const agent = makeGuardableAgent();
    const engine = makeMockEngine();
    installContextEngineLoopHook({
      agent,
      contextEngine: engine,
      sessionId,
      sessionKey,
      sessionFile,
      tokenBudget,
      modelId,
    });

    const firstBatch = [makeUser("first"), makeToolResult("call_1", "result")];
    await callTransform(agent, firstBatch);

    const secondBatch = [
      makeUser("first"),
      makeToolResult("call_1", "result"),
      makeUser("second"),
      makeToolResult("call_2", "result two"),
    ];
    await callTransform(agent, secondBatch);

    expect(engine.afterTurn).toHaveBeenCalledTimes(2);
    expect(engine.afterTurn.mock.calls[1]?.[0]).toMatchObject({
      prePromptMessageCount: 2,
      messages: secondBatch,
    });
  });

  it("does not call engine.afterTurn when no new messages have been appended", async () => {
    const agent = makeGuardableAgent();
    const engine = makeMockEngine();
    installContextEngineLoopHook({
      agent,
      contextEngine: engine,
      sessionId,
      sessionKey,
      sessionFile,
      tokenBudget,
      modelId,
    });

    const messages = [makeUser("first"), makeToolResult("call_1", "result")];
    await callTransform(agent, messages);
    await callTransform(agent, messages);

    expect(engine.afterTurn).toHaveBeenCalledTimes(1);
  });

  it("returns the engine's assembled view when its length differs from the source", async () => {
    const agent = makeGuardableAgent();
    const compactedView = [makeUser("compacted")];
    const engine = makeMockEngine({
      assemble: async () => ({ messages: compactedView, estimatedTokens: 0 }),
    });
    installContextEngineLoopHook({
      agent,
      contextEngine: engine,
      sessionId,
      sessionKey,
      sessionFile,
      tokenBudget,
      modelId,
    });

    const sourceMessages = [
      makeUser("first"),
      makeToolResult("call_1", "result"),
      makeToolResult("call_2", "result two"),
    ];
    const transformed = await callTransform(agent, sourceMessages);

    expect(transformed).toBe(compactedView);
    expect(transformed).not.toBe(sourceMessages);
  });

  it("returns the source messages when the engine's assembled view has the same length", async () => {
    const agent = makeGuardableAgent();
    const engine = makeMockEngine();
    installContextEngineLoopHook({
      agent,
      contextEngine: engine,
      sessionId,
      sessionKey,
      sessionFile,
      tokenBudget,
      modelId,
    });

    const sourceMessages = [makeUser("first"), makeToolResult("call_1", "result")];
    const transformed = await callTransform(agent, sourceMessages);

    expect(transformed).toBe(sourceMessages);
  });

  it("does not mutate the source messages array even when the engine returns a different view", async () => {
    const agent = makeGuardableAgent();
    const compactedView = [makeUser("compacted")];
    const engine = makeMockEngine({
      assemble: async () => ({ messages: compactedView, estimatedTokens: 0 }),
    });
    installContextEngineLoopHook({
      agent,
      contextEngine: engine,
      sessionId,
      sessionKey,
      sessionFile,
      tokenBudget,
      modelId,
    });

    const sourceMessages = [makeUser("first"), makeToolResult("call_1", "result")];
    const sourceCopy = [...sourceMessages];
    await callTransform(agent, sourceMessages);

    expect(sourceMessages).toEqual(sourceCopy);
    expect(sourceMessages).toHaveLength(2);
  });

  it("skips the afterTurn call when the engine does not implement it", async () => {
    const agent = makeGuardableAgent();
    const engine = makeMockEngine({ omitAfterTurn: true });
    installContextEngineLoopHook({
      agent,
      contextEngine: engine,
      sessionId,
      sessionKey,
      sessionFile,
      tokenBudget,
      modelId,
    });

    const messages = [makeUser("first"), makeToolResult("call_1", "result")];
    const transformed = await callTransform(agent, messages);

    expect(transformed).toBe(messages);
    expect(engine.assemble).toHaveBeenCalledTimes(1);
  });

  it("falls through to the source messages when engine.afterTurn throws", async () => {
    const agent = makeGuardableAgent();
    const engine = makeMockEngine({
      afterTurn: async () => {
        throw new Error("engine afterTurn boom");
      },
    });
    installContextEngineLoopHook({
      agent,
      contextEngine: engine,
      sessionId,
      sessionKey,
      sessionFile,
      tokenBudget,
      modelId,
    });

    const messages = [makeUser("first"), makeToolResult("call_1", "result")];
    const transformed = await callTransform(agent, messages);

    expect(transformed).toBe(messages);
  });

  it("falls through to the source messages when engine.assemble throws", async () => {
    const agent = makeGuardableAgent();
    const engine = makeMockEngine({
      assemble: async () => {
        throw new Error("engine assemble boom");
      },
    });
    installContextEngineLoopHook({
      agent,
      contextEngine: engine,
      sessionId,
      sessionKey,
      sessionFile,
      tokenBudget,
      modelId,
    });

    const messages = [makeUser("first"), makeToolResult("call_1", "result")];
    const transformed = await callTransform(agent, messages);

    expect(transformed).toBe(messages);
  });

  it("invokes any pre-existing transformContext before passing the result to the engine", async () => {
    const upstream = vi.fn(async (messages: AgentMessage[]) => [...messages, makeUser("appended")]);
    const agent = makeGuardableAgent(upstream);
    const compactedView = [makeUser("compacted")];
    const engine = makeMockEngine({
      assemble: async (params) => {
        expect(params.messages).toHaveLength(2);
        return { messages: compactedView, estimatedTokens: 0 };
      },
    });
    installContextEngineLoopHook({
      agent,
      contextEngine: engine,
      sessionId,
      sessionKey,
      sessionFile,
      tokenBudget,
      modelId,
    });

    const sourceMessages = [makeUser("first")];
    const transformed = await callTransform(agent, sourceMessages);

    expect(upstream).toHaveBeenCalledTimes(1);
    expect(transformed).toBe(compactedView);
  });

  it("restores the previous transformContext when the returned dispose is called", async () => {
    const upstream = vi.fn(async (messages: AgentMessage[]) => messages);
    const agent = makeGuardableAgent(upstream);
    const engine = makeMockEngine();
    const dispose = installContextEngineLoopHook({
      agent,
      contextEngine: engine,
      sessionId,
      sessionKey,
      sessionFile,
      tokenBudget,
      modelId,
    });

    dispose();

    expect(agent.transformContext).toBe(upstream);
  });
});
