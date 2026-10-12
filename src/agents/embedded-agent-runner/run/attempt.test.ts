import type { LlmRuntime } from "@openclaw/ai";
import { defaultLlmRuntime } from "@openclaw/ai/internal/runtime";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { streamSimple } from "../../../llm/stream.js";
import { wrapPluginSystemContextSection } from "../../hook-system-context-boundary.js";
import { buildAgentSystemPrompt } from "../../system-prompt.js";
import {
  textToolResult,
  textAssistant,
} from "../../test-helpers/sparse-transcript.test-support.js";
import { resolveEmbeddedAgentStream as resolveEmbeddedAgentStreamImpl } from "../stream-resolution.js";
import {
  mergeOrphanedTrailingUserPrompt,
  resolveAttemptFsWorkspaceOnly,
  resolvePromptBuildHookResult,
} from "./attempt-prompt-helpers.js";
import { composeSystemPromptWithHookContext } from "./attempt-thread-helpers.js";
import { wrapStreamFnSanitizeMalformedToolCalls } from "./attempt-tool-call-replay-sanitization.js";
import { wrapStreamFnTrimToolCallNames } from "./attempt-tool-call-stream-normalization.js";
import { wrapStreamFnRepairMalformedToolCallArguments } from "./attempt.tool-call-argument-repair.js";

const llmRuntime = {
  ...defaultLlmRuntime,
  streamSimple,
} as LlmRuntime;

function resolveEmbeddedAgentStream(
  params: Omit<Parameters<typeof resolveEmbeddedAgentStreamImpl>[0], "llmRuntime">,
) {
  return resolveEmbeddedAgentStreamImpl({ ...params, llmRuntime });
}

type FakeWrappedStream = {
  result: () => Promise<unknown>;
  [Symbol.asyncIterator]: () => AsyncIterator<unknown>;
};

type ToolStreamMessage = {
  role: string;
  content: Array<{ type: string; text?: string; name?: string }>;
};

function createFakeStream(params: {
  events: unknown[];
  resultMessage: unknown;
}): FakeWrappedStream {
  return {
    async result() {
      return params.resultMessage;
    },
    async *[Symbol.asyncIterator]() {
      yield* params.events;
    },
  };
}

function fakeBaseStream(resultMessage: unknown, events: unknown[] = []) {
  return vi.fn(() => createFakeStream({ events, resultMessage }));
}

async function drainStream(stream: FakeWrappedStream) {
  for await (const event of stream) {
    void event;
  }
}

function textUser(text: string) {
  return { role: "user", content: [{ type: "text", text }] };
}

function toolMessage(name: string, command: string) {
  return { role: "assistant", content: [{ type: "toolCall", name, arguments: { command } }] };
}

function toolDelta(projection: "partial" | "message", content: unknown[]) {
  return { type: "toolcall_delta", [projection]: { role: "assistant", content } };
}

function thinkingTurn(...calls: unknown[]) {
  return {
    role: "assistant",
    content: [{ type: "thinking", thinking: "internal", thinkingSignature: "sig_1" }, ...calls],
  };
}

async function invokeWrappedTestStream(
  wrap: (
    baseFn: (...args: never[]) => unknown,
  ) => (...args: never[]) => FakeWrappedStream | Promise<FakeWrappedStream>,
  baseFn: (...args: never[]) => unknown,
): Promise<FakeWrappedStream> {
  const wrappedFn = wrap(baseFn);
  return await Promise.resolve(wrappedFn({} as never, {} as never, {} as never));
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error(`expected ${label}`);
  }
  return value as Record<string, unknown>;
}

function wrappedPluginSystemContext(text: string): string {
  return wrapPluginSystemContextSection(text) ?? "";
}

function expectSingleTextContent(content: unknown[], textFragment: string) {
  expect(content).toEqual([
    expect.objectContaining({ type: "text", text: expect.stringContaining(textFragment) }),
  ]);
}

function expectSingleToolCallContent(content: unknown[], name: string) {
  expect(content).toEqual([expect.objectContaining({ type: "toolCall", name })]);
}

function firstBaseContext(baseFn: ReturnType<typeof vi.fn>): { messages: unknown[] } {
  const call = baseFn.mock.calls.at(0);
  if (!call) {
    throw new Error("expected base stream call");
  }
  return call[1] as { messages: unknown[] };
}

describe("resolvePromptBuildHookResult", () => {
  it("applies heartbeat prompt contributions only during heartbeat turns", async () => {
    const hookRunner = {
      hasHooks: vi.fn((hookName: string) => hookName === "heartbeat_prompt_contribution"),
      runHeartbeatPromptContribution: vi.fn(async () => ({
        prependContext: "heartbeat prepend",
        appendContext: "heartbeat append",
      })),
      runBeforePromptBuild: vi.fn(async () => undefined),
    };

    const heartbeatResult = await resolvePromptBuildHookResult({
      config: {},
      prompt: "hello",
      messages: [],
      hookCtx: { trigger: "heartbeat", sessionKey: "agent:main:main" },
      hookRunner,
    });

    expect(hookRunner.runHeartbeatPromptContribution).toHaveBeenCalledTimes(1);
    expect(heartbeatResult.prependContext).toBe("heartbeat prepend");
    expect(heartbeatResult.appendContext).toBe("heartbeat append");

    hookRunner.runHeartbeatPromptContribution.mockClear();
    const userResult = await resolvePromptBuildHookResult({
      config: {},
      prompt: "hello",
      messages: [],
      hookCtx: { trigger: "user", sessionKey: "agent:main:main" },
      hookRunner,
    });

    expect(hookRunner.runHeartbeatPromptContribution).not.toHaveBeenCalled();
    expect(userResult.prependContext).toBeUndefined();
    expect(userResult.appendContext).toBeUndefined();
  });
});

describe("composeSystemPromptWithHookContext", () => {
  it("normalizes hook system context block line endings and trailing whitespace", () => {
    expect(
      composeSystemPromptWithHookContext({
        baseSystemPrompt: "  base system  ",
        prependSystemContext: wrappedPluginSystemContext("  prepend line  \r\nsecond line\t\r\n"),
        appendSystemContext: wrappedPluginSystemContext("  append  \t\r\n"),
      }),
    ).toBe(
      `${wrappedPluginSystemContext("  prepend line\nsecond line")}\n\nbase system\n\n${wrappedPluginSystemContext("  append")}`,
    );
  });
  it("keeps bootstrap truncation notices in the system prompt instead of the user prompt", () => {
    const baseSystemPrompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      contextFiles: [{ path: "AGENTS.md", content: "Follow AGENTS guidance." }],
      toolNames: ["read"],
      bootstrapTruncationNotice:
        "[Bootstrap truncation warning]\nSome workspace bootstrap files were truncated before Project Context injection.\nTreat Project Context as partial and read the relevant files directly if details seem missing.",
    });
    const composedSystemPrompt = composeSystemPromptWithHookContext({
      baseSystemPrompt,
      appendSystemContext: "hook system context",
    });

    expect(composedSystemPrompt).toContain("[Bootstrap truncation warning]");
    expect(composedSystemPrompt).toContain("Treat Project Context as partial");
    expect(composedSystemPrompt).toContain("hook system context");
  });
});

describe("mergeOrphanedTrailingUserPrompt", () => {
  function mergeOrphan(
    leafMessage: Parameters<typeof mergeOrphanedTrailingUserPrompt>[0]["leafMessage"],
    prompt = "newest inbound message",
  ) {
    return mergeOrphanedTrailingUserPrompt({ prompt, leafMessage });
  }
  it("does not replay the initiating user turn into an approved-exec continuation", () => {
    expect(
      mergeOrphan(
        {
          content: "run the command again",
          provenance: { kind: "inter_session", sourceTool: "exec_approval_followup" },
        },
        "authenticated approved-exec result",
      ),
    ).toEqual({ merged: false, removeLeaf: true, prompt: "authenticated approved-exec result" });
  });

  it("preserves user-directed inter-session orphan context", () => {
    expect(
      mergeOrphan({
        content: "forwarded user request",
        provenance: { kind: "inter_session", sourceTool: "sessions_send" },
      }),
    ).toEqual({
      merged: true,
      removeLeaf: false,
      prompt:
        "[Queued user message from a previous active turn; preserved as context only. Continue with the active prompt below.]\n" +
        "forwarded user request\n\nnewest inbound message",
    });
  });

  it("does not duplicate orphaned user text already present in the next prompt", () => {
    expect(
      mergeOrphan(
        { content: "older active-turn message" },
        "summary\nolder active-turn message\nnewest inbound message",
      ),
    ).toEqual({
      merged: false,
      removeLeaf: false,
      prompt: "summary\nolder active-turn message\nnewest inbound message",
    });
  });

  it("keeps structured orphaned user input actionable alongside the current request", () => {
    expect(
      mergeOrphan({
        content: [
          { type: "text", text: "please inspect this" },
          { type: "image_url", image_url: { url: "https://example.test/cat.png" } },
          { type: "input_audio", audio_url: "https://example.test/cat.wav" },
        ],
      }),
    ).toEqual({
      merged: true,
      removeLeaf: false,
      prompt:
        "[Earlier unanswered user message. Address this request alongside the current input; follow the latest user instruction if they conflict.]\n" +
        "please inspect this\n" +
        "[image_url] https://example.test/cat.png\n" +
        "[input_audio] https://example.test/cat.wav\n\n" +
        "newest inbound message",
    });
  });

  it("summarizes unknown structured data before JSON serialization", () => {
    const dataUri = `data:image/png;base64,${"a".repeat(10_000)}`;
    const result = mergeOrphan({
      content: [
        {
          type: "unknown_content",
          nested: {
            inline: dataUri,
            longText: "b".repeat(2_000),
          },
        },
      ],
    });

    expect(result.merged).toBe(true);
    expect(result.removeLeaf).toBe(false);
    expect(result.prompt).toContain("[value] inline data URI (image/png, 10022 chars)");
    expect(result.prompt).toContain("bbbb");
    expect(result.prompt).toContain("(2000 chars)");
    expect(result.prompt).not.toContain("base64");
    expect(result.prompt).not.toContain("aaaa");
  });

  it("removes an empty orphaned user leaf to prevent consecutive user turns", () => {
    expect(mergeOrphan({ content: [] })).toEqual({
      merged: false,
      removeLeaf: true,
      prompt: "newest inbound message",
    });
  });
});

describe("resolveEmbeddedAgentStream", () => {
  it("injects authStorage api keys into provider-owned stream functions", async () => {
    const providerStreamFn = vi.fn(async (_model, _context, options) => options);
    const { streamFn } = resolveEmbeddedAgentStream({
      currentStreamFn: undefined,
      providerStreamFn,
      sessionId: "session-1",
      model: { api: "openai-completions", provider: "demo-provider", id: "demo-model" } as never,
      authProfileId: "demo-provider:oauth",
      authStorage: {
        getApiKey: vi.fn(async () => "demo-runtime-key"),
      },
    });

    const streamOptions = await streamFn(
      { provider: "demo-provider", id: "demo-model" } as never,
      {} as never,
      {},
    );
    expect(requireRecord(streamOptions, "stream options").apiKey).toBe("demo-runtime-key");
    expect(requireRecord(streamOptions, "stream options").authProfileId).toBe(
      "demo-provider:oauth",
    );
    expect(providerStreamFn).toHaveBeenCalledTimes(1);
  });

  it("keeps explicit custom currentStreamFn values unchanged", () => {
    const currentStreamFn = vi.fn();
    const { streamFn } = resolveEmbeddedAgentStream({
      currentStreamFn: currentStreamFn as never,
      sessionId: "session-1",
      model: { api: "openai-responses", provider: "openai", id: "gpt-5.4" } as never,
    });

    expect(streamFn).toBe(currentStreamFn);
  });

  it("routes runtime-auth custom currentStreamFn values through boundary-aware transports", async () => {
    const currentStreamFn = vi.fn();
    const { streamFn } = resolveEmbeddedAgentStream({
      currentStreamFn: currentStreamFn as never,
      sessionId: "session-1",
      model: {
        api: "anthropic-messages",
        provider: "cloudflare-ai-gateway",
        id: "claude-sonnet-4-6",
        baseUrl: "https://gateway.ai.cloudflare.com/v1/account/gateway/anthropic",
        maxTokens: 1024,
        contextWindow: 200_000,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      } as never,
      resolvedApiKey: "sk-ant-test",
    });

    expect(streamFn).not.toBe(currentStreamFn);
  });
});

describe("resolveAttemptFsWorkspaceOnly", () => {
  it("prefers agent-specific tools.fs.workspaceOnly override", () => {
    const cfg: OpenClawConfig = {
      tools: {
        fs: { workspaceOnly: true },
      },
      agents: {
        entries: {
          main: {
            tools: {
              fs: { workspaceOnly: false },
            },
          },
        },
      },
    };

    expect(resolveAttemptFsWorkspaceOnly({ config: cfg, sessionAgentId: "main" })).toBe(false);
  });
});

describe("wrapStreamFnTrimToolCallNames", () => {
  async function invokeWrappedStream(
    baseFn: (...args: never[]) => unknown,
    allowedToolNames?: Set<string>,
    guardOptions?: { unknownToolThreshold?: number },
  ) {
    return await invokeWrappedTestStream(
      (innerBaseFn) =>
        wrapStreamFnTrimToolCallNames(innerBaseFn as never, allowedToolNames, guardOptions),
      baseFn,
    );
  }

  function createEventStream(params: {
    event: unknown;
    finalToolCall: { type: string; name: string };
  }) {
    const finalMessage = { role: "assistant", content: [params.finalToolCall] };
    const baseFn = fakeBaseStream(finalMessage, [params.event]);
    return { baseFn, finalMessage };
  }

  it("normalizes common tool aliases when the canonical name is allowed", async () => {
    const finalToolCall = { type: "toolCall", name: " BASH " };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = fakeBaseStream(finalMessage);

    const stream = await invokeWrappedStream(baseFn, new Set(["exec"]));
    const result = await stream.result();

    expect(finalToolCall.name).toBe("exec");
    expect(result).toBe(finalMessage);
  });

  it("strips only supported provider-leaked XML fragments from allowed tool names", async () => {
    const cases = [
      ['read" parameter="path" string="true', "read", "partial"],
      ["exec' parameter='command' string='true", "exec", "message"],
      ["qualified/write<parameter=path", "qualified.write", "final"],
      [
        'unknown" parameter="value" string="true',
        'unknown" parameter="value" string="true',
        "partial",
      ],
      ["allowedTool>suffix", "allowedTool>suffix", "message"],
    ].map(([name, expectedName, projection]) => ({
      label: name,
      toolCall: { type: "toolCall", name },
      expectedName,
      projection,
    }));
    const project = (projection: string) => ({
      role: "assistant",
      content: cases
        .filter((testCase) => testCase.projection === projection)
        .map(({ toolCall }) => toolCall),
    });
    const event = {
      type: "toolcall_delta",
      partial: project("partial"),
      message: project("message"),
    };
    const finalMessage = project("final");
    const baseFn = fakeBaseStream(finalMessage, [event]);

    const stream = await invokeWrappedStream(
      baseFn,
      new Set(["read", "write", "exec", "qualified.write", "allowedTool"]),
    );

    await drainStream(stream);
    const result = await stream.result();

    for (const testCase of cases) {
      expect(testCase.toolCall.name, testCase.label).toBe(testCase.expectedName);
    }
    expect(result).toBe(finalMessage);
  });

  it("does not count partial tool-call deltas as separate unavailable-tool retries", async () => {
    const partialToolCall = { type: "toolCall", name: " exec " };
    const messageToolCall = { type: "toolCall", name: " exec " };
    const finalToolCall = { type: "toolCall", name: " exec " };
    const event = {
      type: "toolcall_delta",
      partial: { role: "assistant", content: [partialToolCall] },
      message: { role: "assistant", content: [messageToolCall] },
    };
    const { baseFn } = createEventStream({ event, finalToolCall });

    const stream = await invokeWrappedStream(baseFn, new Set(["read"]), {
      unknownToolThreshold: 1,
    });

    await drainStream(stream);
    const result = (await stream.result()) as {
      content: Array<{ type: string; text?: string; name?: string }>;
    };

    expect(partialToolCall.name).toBe("exec");
    expect(messageToolCall.name).toBe("exec");
    expectSingleToolCallContent(result.content, "exec");
  });

  function sequenceStreams(
    allowedTools: string[],
    frames: Parameters<typeof createFakeStream>[0][],
  ) {
    const baseFn = vi.fn();
    for (const frame of frames) {
      baseFn.mockImplementationOnce(() => createFakeStream(frame));
    }
    const wrappedFn = wrapStreamFnTrimToolCallNames(baseFn as never, new Set(allowedTools), {
      unknownToolThreshold: 1,
    });
    return () => Promise.resolve(wrappedFn({} as never, {} as never, {} as never));
  }

  function retryFrames(projection: "partial" | "message", name: string) {
    return Array.from({ length: 2 }, () => ({
      events: [toolDelta(projection, [{ type: "toolCall", name }])],
      resultMessage: toolMessage(" exec ", "echo retry"),
    }));
  }

  it("does not reset the unavailable-tool streak on partial-only stream chunks", async () => {
    const nextStream = sequenceStreams(["read"], retryFrames("partial", " exec "));
    const firstStream = await nextStream();
    await firstStream.result();
    const secondStream = await nextStream();
    await drainStream(secondStream);
    const secondResult = (await secondStream.result()) as ToolStreamMessage;
    expect(secondResult.role).toBe("assistant");
    expectSingleTextContent(secondResult.content, '"exec"');
  });

  it("counts the final unknown-tool retry when streamed messages omit the tool name", async () => {
    const nextStream = sequenceStreams(["read"], retryFrames("message", ""));
    const firstStream = await nextStream();
    await firstStream.result();
    const secondStream = await nextStream();
    await drainStream(secondStream);
    const secondResult = (await secondStream.result()) as ToolStreamMessage;
    expect(secondResult.role).toBe("assistant");
    expectSingleTextContent(secondResult.content, '"exec"');
  });

  it("keeps processing later streamed messages after one streamed unknown-tool retry was counted", async () => {
    const nextStream = sequenceStreams(
      ["read"],
      [
        {
          events: [
            toolDelta("message", [{ type: "toolCall", name: " re " }]),
            toolDelta("message", [{ type: "toolCall", name: " read " }]),
          ],
          resultMessage: textAssistant("resolved to allowed tool"),
        },
        { events: [], resultMessage: toolMessage(" re ", "echo retry") },
      ],
    );
    const firstStream = await nextStream();
    await drainStream(firstStream);
    await firstStream.result();
    const secondStream = await nextStream();
    const secondResult = (await secondStream.result()) as ToolStreamMessage;
    expect(secondResult.role).toBe("assistant");
    expectSingleToolCallContent(secondResult.content, "re");
  });

  it("resets a stale unknown-tool streak when a streamed message mixes allowed and unknown tools", async () => {
    const nextStream = sequenceStreams(
      ["exec"],
      [
        { events: [], resultMessage: toolMessage(" ex ", "echo first") },
        {
          events: [
            {
              type: "toolcall_delta",
              message: {
                role: "assistant",
                content: [
                  { type: "toolCall", name: " exec ", arguments: { command: "echo allowed" } },
                  { type: "toolCall", name: " ex ", arguments: { command: "echo provisional" } },
                ],
              },
            },
          ],
          resultMessage: toolMessage(" exec ", "echo ok"),
        },
        { events: [], resultMessage: toolMessage(" ex ", "echo retry") },
      ],
    );
    const firstStream = await nextStream();
    await firstStream.result();
    const secondStream = await nextStream();
    await drainStream(secondStream);
    await secondStream.result();
    const thirdStream = await nextStream();
    const thirdResult = (await thirdStream.result()) as ToolStreamMessage;
    expect(thirdResult.role).toBe("assistant");
    expectSingleToolCallContent(thirdResult.content, "ex");
  });

  it("infers tool names from malformed toolCallId variants when allowlist is present", async () => {
    const partialToolCall = { type: "toolCall", id: "functions.read:0", name: "" };
    const finalToolCallA = { type: "toolCall", id: "functionsread3", name: "" };
    const finalToolCallB: { type: string; id: string; name?: string } = {
      type: "toolCall",
      id: "functionswrite4",
    };
    const finalToolCallC = { type: "functionCall", id: "functions.exec2", name: "" };
    const event = toolDelta("partial", [partialToolCall]);
    const finalMessage = {
      role: "assistant",
      content: [finalToolCallA, finalToolCallB, finalToolCallC],
    };
    const baseFn = fakeBaseStream(finalMessage, [event]);

    const stream = await invokeWrappedStream(baseFn, new Set(["read", "write", "exec"]));
    await drainStream(stream);
    const result = await stream.result();

    expect(partialToolCall.name).toBe("read");
    expect(finalToolCallA.name).toBe("read");
    expect(finalToolCallB.name).toBe("write");
    expect(finalToolCallC.name).toBe("exec");
    expect(result).toBe(finalMessage);
  });

  it("does not infer names from malformed toolCallId when allowlist is absent", async () => {
    const finalToolCall: { type: string; id: string; name?: string } = {
      type: "toolCall",
      id: "functionsread3",
    };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = fakeBaseStream(finalMessage);

    const stream = await invokeWrappedStream(baseFn);
    await stream.result();

    expect(finalToolCall.name).toBeUndefined();
  });

  it("fails closed for malformed non-blank names that are ambiguous", async () => {
    const toolCall = { type: "toolCall", id: "functions.exec2", name: "functions.exec2" };
    const finalMessage = { role: "assistant", content: [toolCall] };
    const baseFn = fakeBaseStream(finalMessage);

    const stream = await invokeWrappedStream(baseFn, new Set(["exec", "exec2"]));
    await stream.result();

    expect(toolCall.name).toBe("functions.exec2");
  });

  it("does not reuse fallback ids across assistant response streams", async () => {
    const ids: string[] = [];
    for (let responseIndex = 0; responseIndex < 2; responseIndex += 1) {
      const finalToolCall: { type: string; name: string; id?: string } = {
        type: "toolCall",
        name: "read",
      };
      const baseFn = vi.fn(() =>
        createFakeStream({
          events: [],
          resultMessage: { role: "assistant", content: [finalToolCall] },
        }),
      );
      const stream = await invokeWrappedStream(baseFn, new Set(["read"]));
      await stream.result();
      if (!finalToolCall.id) {
        throw new Error("missing fallback tool call id");
      }
      ids.push(finalToolCall.id);
    }

    expect(ids[0]).toMatch(/^call_[0-9a-f]{24}$/);
    expect(ids[1]).toMatch(/^call_[0-9a-f]{24}$/);
    expect(ids[1]).not.toBe(ids[0]);
  });
  it("leaves provisional blank streamed names recoverable while stopping final blank dispatch", async () => {
    const partialToolCall = { type: "toolCall", name: "   " };
    const finalToolCall = { type: "toolCall", name: "\t  " };
    const event = toolDelta("partial", [partialToolCall]);
    const { baseFn } = createEventStream({ event, finalToolCall });

    const stream = await invokeWrappedStream(baseFn);

    await drainStream(stream);
    const result = (await stream.result()) as {
      content: Array<{ type: string; text?: string }>;
    };

    expectSingleTextContent(result.content, '"blank tool name"');
    expect(partialToolCall.name).toBe("   ");
    expect(finalToolCall.name).toBe("\t  ");
    expect(baseFn).toHaveBeenCalledTimes(1);
  });

  it("assigns fallback ids to missing/blank tool call ids in streamed and final messages", async () => {
    const partialToolCall = { type: "toolCall", name: " read ", id: "   " };
    const finalToolCallA = { type: "toolCall", name: " exec ", id: "" };
    const finalToolCallB: { type: string; name: string; id?: string } = {
      type: "toolCall",
      name: " write ",
    };
    const event = toolDelta("partial", [partialToolCall]);
    const finalMessage = { role: "assistant", content: [finalToolCallA, finalToolCallB] };
    const baseFn = fakeBaseStream(finalMessage, [event]);

    const stream = await invokeWrappedStream(baseFn);
    await drainStream(stream);
    const result = await stream.result();

    expect(partialToolCall.name).toBe("read");
    expect(partialToolCall.id).toMatch(/^call_[0-9a-f]{24}$/);
    expect(finalToolCallA.name).toBe("exec");
    expect(finalToolCallA.id).toBe(partialToolCall.id);
    expect(finalToolCallB.name).toBe("write");
    expect(finalToolCallB.id).toMatch(/^call_[0-9a-f]{24}$/);
    expect(finalToolCallB.id).not.toBe(finalToolCallA.id);
    expect(result).toBe(finalMessage);
  });

  it("reassigns duplicate tool call ids within a message to unique fallbacks", async () => {
    const finalToolCallA = { type: "toolCall", name: " read ", id: "  edit:22  " };
    const finalToolCallB = { type: "toolCall", name: " write ", id: "edit:22" };
    const finalMessage = { role: "assistant", content: [finalToolCallA, finalToolCallB] };
    const baseFn = fakeBaseStream(finalMessage);

    const stream = await invokeWrappedStream(baseFn);
    await stream.result();

    expect(finalToolCallA.name).toBe("read");
    expect(finalToolCallB.name).toBe("write");
    expect(finalToolCallA.id).toBe("edit:22");
    expect(finalToolCallB.id).toMatch(/^call_[0-9a-f]{24}$/);
  });

  it.each([true, false])(
    "keeps repeated provider ids unique across compacted responses (prior history: %s)",
    async (hasPriorHistory) => {
      const makeToolCall = () => ({ type: "toolCall", name: "exec", id: "exec_0", arguments: {} });
      const makeMessage = (call = makeToolCall()) => ({ role: "assistant", content: [call] });
      const baseFn = vi.fn(() => {
        const partialCall = makeToolCall();
        const partial = makeMessage(partialCall);
        const message = makeMessage();
        const result = makeMessage();
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: "toolcall_delta", partial };
            // Later transport deltas can restore the provider id on the same block.
            partialCall.id = "exec_0";
            yield { type: "toolcall_delta", partial };
            yield { type: "done", message };
          },
          async result() {
            return result;
          },
        };
      });
      const wrappedFn = wrapStreamFnTrimToolCallNames(baseFn as never, new Set(["exec"]));
      const history = hasPriorHistory ? [makeMessage()] : [];
      const responseIds: string[] = [];
      for (let responseIndex = 0; responseIndex < 3; responseIndex += 1) {
        const stream = await wrappedFn(
          {} as never,
          { messages: responseIndex === 0 ? history : [] } as never,
          {} as never,
        );
        const projectedIds: string[] = [];
        for await (const event of stream) {
          const message =
            "partial" in event ? event.partial : "message" in event ? event.message : undefined;
          const call = message?.content[0];
          if (call?.type === "toolCall") {
            projectedIds.push(call.id);
          }
        }
        const result = await stream.result();
        const call = result.content[0];
        if (call?.type !== "toolCall") {
          throw new Error("missing final tool call");
        }
        expect(projectedIds).toEqual([call.id, call.id, call.id]);
        if (hasPriorHistory || responseIndex > 0) {
          expect(call.id).toMatch(/^call_[0-9a-f]{24}$/);
        } else {
          expect(call.id).toBe("exec_0");
        }
        responseIds.push(call.id);
      }
      expect(new Set(responseIds).size).toBe(3);
      expect(history).toEqual(hasPriorHistory ? [makeMessage()] : []);
    },
  );

  it("preserves non-colliding provider ids byte-for-byte", async () => {
    const ids = ["toolu_01NativeAnthropic", "call_NativeOpenAI"];
    const finalMessage = {
      role: "assistant",
      content: ids.map((id) => ({ type: "toolCall", name: "exec", id, arguments: {} })),
    };
    const baseFn = fakeBaseStream(finalMessage, [
      { type: "toolcall_delta", partial: structuredClone(finalMessage) },
      { type: "done", message: structuredClone(finalMessage) },
    ]);
    const wrappedFn = wrapStreamFnTrimToolCallNames(baseFn as never, new Set(["exec"]));
    const stream = await wrappedFn(
      {} as never,
      { messages: [{ role: "assistant", content: [{ type: "toolCall", id: "exec_0" }] }] } as never,
      {} as never,
    );
    for await (const event of stream) {
      const message =
        "partial" in event ? event.partial : "message" in event ? event.message : undefined;
      expect(message?.content).toEqual(finalMessage.content);
    }
    expect((await stream.result()).content).toEqual(finalMessage.content);
    expect(finalMessage.content.map((call) => call.id)).toEqual(ids);
  });
});

describe("wrapStreamFnSanitizeMalformedToolCalls", () => {
  function replayCall(name: string, id: string) {
    return { type: "toolCall", id, name, arguments: {} };
  }
  function replayAssistant(content: unknown[]) {
    return { role: "assistant", content };
  }

  function embeddedResultUser(result: string, text = "retry") {
    return {
      role: "user",
      content: [
        { type: "toolResult", toolUseId: "call_1", content: [{ type: "text", text: result }] },
        { type: "text", text },
      ],
    };
  }

  const anthropicPolicy = {
    validateGeminiTurns: false,
    validateAnthropicTurns: true,
    preserveSignatures: false,
    dropThinkingBlocks: false,
  };
  const signedPolicy = { ...anthropicPolicy, preserveSignatures: true };

  async function replayContext(
    messages: unknown[],
    allowedToolNames?: Set<string>,
    policy?: Parameters<typeof wrapStreamFnSanitizeMalformedToolCalls>[2],
    api?: string,
  ) {
    const baseFn = vi.fn((_model, _context) =>
      createFakeStream({ events: [], resultMessage: { role: "assistant", content: [] } }),
    );
    const wrapped = wrapStreamFnSanitizeMalformedToolCalls(
      baseFn as never,
      allowedToolNames,
      policy,
    );
    await wrapped((api ? { api } : {}) as never, { messages } as never, {} as never);
    expect(baseFn).toHaveBeenCalledTimes(1);
    return firstBaseContext(baseFn);
  }
  function replaySigned(messages: unknown[], api = "anthropic-messages") {
    return replayContext(messages, new Set(["read"]), signedPolicy, api);
  }

  function expectedRetryMessages() {
    return [textUser("retry")];
  }

  it("strips trailing assistant prefill turns for Gemini outbound replay", async () => {
    const messages = [textUser("earlier question"), textAssistant("stale model answer")];
    const seenContext = await replayContext(
      messages,
      new Set(["read"]),
      {
        validateAnthropicTurns: false,
        validateGeminiTurns: true,
        preserveSignatures: true,
        dropThinkingBlocks: false,
      },
      "google-generative-ai",
    );
    expect(seenContext.messages).toEqual([textUser("earlier question")]);
    expect(seenContext.messages).not.toBe(messages);
  });

  it("drops signed thinking turns for bedrock claude replay when sibling tool calls are not replay-safe", async () => {
    const messages = [thinkingTurn(replayCall("gateway", "toolu_legacy")), textUser("retry")];
    const seenContext = await replaySigned(messages, "bedrock-converse-stream");
    expect(seenContext.messages).toEqual(expectedRetryMessages());
  });

  it("drops signed thinking turns when sibling replay tool calls reuse an id", async () => {
    const messages = [
      thinkingTurn(replayCall("read", "call_1"), {
        type: "functionCall",
        id: "call_1",
        name: "read",
        arguments: {},
      }),
      textUser("retry"),
    ];
    const seenContext = await replaySigned(messages);
    expect(seenContext.messages).toEqual(expectedRetryMessages());
  });

  it("keeps signed thinking turns that reuse a mutable earlier tool id", async () => {
    const messages = [
      replayAssistant([replayCall("read", "call_1")]),
      textToolResult("call_1", "read", "mutable result"),
      thinkingTurn({ type: "toolUse", id: "call_1", name: "read", input: {} }),
      textToolResult("call_1", "read", "signed result"),
      textUser("retry"),
    ];
    const seenContext = await replaySigned(messages);
    expect(seenContext.messages).toBe(messages);
  });

  it("drops signed thinking reused ids when their real result is displaced", async () => {
    const firstAssistant = replayAssistant([replayCall("read", "call_1")]);
    const firstResult = textToolResult("call_1", "read", "mutable result");
    const userMessage = textUser("retry");
    const messages = [
      firstAssistant,
      firstResult,
      thinkingTurn({ type: "toolUse", id: "call_1", name: "read", input: {} }),
      userMessage,
      textToolResult("call_1", "read", "signed result"),
    ];
    const seenContext = await replaySigned(messages);
    expect(seenContext.messages).toEqual([firstAssistant, firstResult, userMessage]);
  });

  it("keeps mutable thinking turns outside anthropic replay-only preservation", async () => {
    const messages = [thinkingTurn(replayCall(" read ", "call_1")), textUser("retry")];
    const seenContext = await replayContext(
      messages,
      new Set(["read"]),
      {
        validateGeminiTurns: false,
        preserveSignatures: false,
        dropThinkingBlocks: false,
        validateAnthropicTurns: true,
      },
      "openai-completions",
    );
    expect(seenContext.messages).toHaveLength(3);
    expect(seenContext.messages[0]).toEqual(thinkingTurn(replayCall("read", "call_1")));
    const repairedToolResult = requireRecord(seenContext.messages[1], "repaired tool result");
    expect(repairedToolResult.role).toBe("toolResult");
    expect(repairedToolResult.toolCallId).toBe("call_1");
    expect(repairedToolResult.toolName).toBe("read");
    expect(repairedToolResult.content).toEqual([
      {
        type: "text",
        text: "Tool call interrupted before a result was recorded; its outcome is unknown. Retry only if the operation is read-only or idempotent. If it may have had side effects, verify the current state first instead of repeating it.",
      },
    ]);
    expect(repairedToolResult.isError).toBe(true);
    expect(repairedToolResult.timestamp).toBeTypeOf("number");
    expect(seenContext.messages[2]).toEqual(textUser("retry"));
  });

  it("canonicalizes mixed-case allowlisted tool names on replay", async () => {
    const messages = [replayAssistant([replayCall("readfile", "call_1")])];
    const seenContext = (await replayContext(messages, new Set(["ReadFile"]))) as {
      messages: Array<{ content?: Array<{ name?: string }> }>;
    };
    expect(seenContext.messages[0]?.content?.[0]?.name).toBe("ReadFile");
  });

  it("drops replayed blank tool names that cannot be recovered from ids", async () => {
    const messages = [
      replayAssistant([replayCall("   ", "call_1")]),
      textToolResult("call_1", "", "stale result", { isError: true }),
    ];
    const seenContext = await replayContext(messages);
    expect(seenContext.messages).toStrictEqual([]);
  });

  it("drops ambiguous mangled replay names instead of guessing a tool", async () => {
    const messages = [replayAssistant([replayCall("functions.exec2", "call_1")])];
    const seenContext = await replayContext(messages, new Set(["exec", "exec2"]));
    expect(seenContext.messages).toStrictEqual([]);
  });

  it("preserves matching tool results for retained errored assistant turns", async () => {
    const messages = [
      {
        role: "assistant",
        stopReason: "error",
        content: [replayCall("read", "call_1"), { type: "toolCall", name: "read", arguments: {} }],
      },
      textToolResult("call_1", "read", "kept result", { isError: false }),
      textUser("retry"),
    ];
    const seenContext = await replayContext(messages, new Set(["read"]));
    expect(seenContext.messages).toEqual([
      {
        role: "assistant",
        stopReason: "error",
        content: [replayCall("read", "call_1")],
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: [{ type: "text", text: "kept result" }],
        isError: false,
      },
      textUser("retry"),
    ]);
  });

  it("drops orphaned Anthropic user tool_result blocks after replay sanitization", async () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "partial response" },
          { type: "toolUse", name: "read", input: { path: "." } },
        ],
      },
      embeddedResultUser("stale"),
    ];
    const seenContext = await replayContext(messages, new Set(["read"]), anthropicPolicy);
    expect(seenContext.messages).toEqual([
      replayAssistant([{ type: "text", text: "partial response" }]),
      textUser("retry"),
    ]);
  });

  it("preserves embedded Anthropic user tool_result blocks for non-thinking turns even when immutable replay is enabled", async () => {
    const messages = [
      replayAssistant([{ type: "toolUse", id: "call_1", name: "read", input: { path: "." } }]),
      embeddedResultUser("kept result"),
    ];
    const seenContext = await replaySigned(messages);
    expect(seenContext.messages).toEqual(messages);
  });

  it("drops orphaned Anthropic user tool_result blocks after dropping an assistant replay turn", async () => {
    const messages = [
      textUser("first"),
      {
        role: "assistant",
        stopReason: "error",
        content: [{ type: "toolUse", name: "read", input: { path: "." } }],
      },
      embeddedResultUser("stale", "second"),
    ];
    const seenContext = await replayContext(messages, new Set(["read"]), anthropicPolicy);
    expect(seenContext.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "first" },
          { type: "text", text: "second" },
        ],
      },
    ]);
  });
});

describe("wrapStreamFnRepairMalformedToolCallArguments", () => {
  async function replayArgumentDeltas(
    deltas: string[],
    options: {
      initialArgs?: Record<string, unknown>;
      fullResult?: boolean;
    } = {},
  ) {
    const name = "read";
    const partialToolCall = { type: "toolCall", name, arguments: options.initialArgs ?? {} };
    const streamedToolCall = { type: "toolCall", name, arguments: {} };
    const endMessageToolCall = { type: "toolCall", name, arguments: {} };
    const finalToolCall = { type: "toolCall", name, arguments: {} };
    const partialMessage = { role: "assistant", content: [partialToolCall] };
    const finalMessage = options.fullResult
      ? { role: "assistant", content: [finalToolCall] }
      : partialMessage;
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [
          ...deltas.map((delta) => ({
            type: "toolcall_delta",
            contentIndex: 0,
            delta,
            partial: partialMessage,
          })),
          {
            type: "toolcall_end",
            contentIndex: 0,
            toolCall: streamedToolCall,
            partial: partialMessage,
            ...(options.fullResult
              ? { message: { role: "assistant", content: [endMessageToolCall] } }
              : {}),
          },
        ],
        resultMessage: finalMessage,
      }),
    );
    const stream = await invokeWrappedTestStream(
      (innerBaseFn) => wrapStreamFnRepairMalformedToolCallArguments(innerBaseFn as never),
      baseFn,
    );
    await drainStream(stream);
    return {
      stream,
      partialToolCall,
      streamedToolCall,
      endMessageToolCall,
      finalToolCall,
      finalMessage,
    };
  }

  it.each([
    {
      name: "repairs anthropic-compatible tool arguments when trailing junk follows valid JSON",
      deltas: ['{"path":"/tmp/report.txt"}', "xx"],
    },
    {
      name: "preserves anthropic-compatible tool arguments when the streamed JSON is already valid",
      deltas: ['{"path":"/tmp/report.txt"', "}"],
    },
  ])("$name", async ({ deltas }) => {
    const {
      stream,
      partialToolCall,
      streamedToolCall,
      endMessageToolCall,
      finalToolCall,
      finalMessage,
    } = await replayArgumentDeltas(deltas, { fullResult: true });
    const result = await stream.result();

    expect(partialToolCall.arguments).toEqual({ path: "/tmp/report.txt" });
    expect(streamedToolCall.arguments).toEqual({ path: "/tmp/report.txt" });
    expect(endMessageToolCall.arguments).toEqual({ path: "/tmp/report.txt" });
    expect(finalToolCall.arguments).toEqual({ path: "/tmp/report.txt" });
    expect(result).toBe(finalMessage);
  });

  it("does not repair tool arguments when leading text is not tool-call metadata", async () => {
    const { partialToolCall, streamedToolCall } = await replayArgumentDeltas([
      'please use {"path":"/tmp/report.txt"}',
    ]);
    expect(partialToolCall.arguments).toStrictEqual({});
    expect(streamedToolCall.arguments).toStrictEqual({});
  });

  it("clears a cached repair when a later delta adds a single oversized trailing suffix", async () => {
    const { partialToolCall, streamedToolCall } = await replayArgumentDeltas([
      '{"path":"/tmp/report.txt"}',
      "oops",
    ]);
    expect(partialToolCall.arguments).toStrictEqual({});
    expect(streamedToolCall.arguments).toStrictEqual({});
  });

  it("preserves preexisting tool arguments when later reevaluation fails", async () => {
    const { partialToolCall, streamedToolCall } = await replayArgumentDeltas(["}"], {
      initialArgs: { path: "/etc/hosts" },
    });
    expect(partialToolCall.arguments).toEqual({ path: "/etc/hosts" });
    expect(streamedToolCall.arguments).toStrictEqual({});
  });
});

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
