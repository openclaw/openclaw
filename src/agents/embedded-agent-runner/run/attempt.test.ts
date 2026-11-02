import type { LlmRuntime } from "@openclaw/ai";
import { defaultLlmRuntime } from "@openclaw/ai/internal/runtime";
import { describe, expect, it, vi } from "vitest";
import { streamSimple } from "../../../llm/stream.js";
import { createAssistantMessageEventStream } from "../../../llm/utils/event-stream.js";
import { wrapPluginSystemContextSection } from "../../hook-system-context-boundary.js";
import type { StreamFn } from "../../runtime/index.js";
import {
  sparseAssistant,
  textToolResult,
  textAssistant,
} from "../../test-helpers/sparse-transcript.test-support.js";
import { resolveEmbeddedAgentStream as resolveEmbeddedAgentStreamImpl } from "../stream-resolution.js";
import { mergeOrphanedTrailingUserPrompt } from "./attempt-prompt-helpers.js";
import { createFakeStream, type FakeWrappedStream } from "./attempt-stream.test-helpers.js";
import { composeSystemPromptWithHookContext } from "./attempt-thread-helpers.js";
import { wrapStreamFnSanitizeMalformedToolCalls } from "./attempt-tool-call-replay-sanitization.js";
import { wrapStreamFnTrimToolCallNames } from "./attempt-tool-call-stream-normalization.js";
import { wrapStreamFnRepairMalformedToolCallArguments } from "./attempt.tool-call-argument-repair.js";

const llmRuntime = { ...defaultLlmRuntime, streamSimple } as LlmRuntime;

function resolveEmbeddedAgentStream(
  params: Omit<Parameters<typeof resolveEmbeddedAgentStreamImpl>[0], "llmRuntime">,
) {
  return resolveEmbeddedAgentStreamImpl({ ...params, llmRuntime });
}

type NamedCall = { type: string; name?: string };

type ToolStreamMessage = {
  role: string;
  content: Array<{ type: string; text?: string; name?: string }>;
};
function fakeBaseStream(resultMessage: unknown, events: unknown[] = []) {
  return vi.fn(() => createFakeStream({ events, resultMessage }));
}

async function drainStream(stream: FakeWrappedStream) {
  for await (const event of stream) {
    void event;
  }
}

async function readStream(wrapped: StreamFn, drain = true) {
  const stream = await wrapped({} as never, {} as never, {} as never);
  if (drain) {
    await drainStream(stream);
  }
  return (await stream.result()) as ToolStreamMessage;
}

function textUser(text: string) {
  return { role: "user", content: [{ type: "text", text }] };
}

function toolMessage(name: string) {
  return sparseAssistant([{ type: "toolCall", name }]);
}

function toolDelta(projection: "partial" | "message", content: unknown[]) {
  return { type: "toolcall_delta", [projection]: { role: "assistant", content } };
}

function thinkingTurn(...calls: unknown[]) {
  return sparseAssistant([
    { type: "thinking", thinking: "internal", thinkingSignature: "sig_1" },
    ...calls,
  ]);
}

function expectSingleTextContent(content: unknown[], textFragment: string) {
  expect(content).toEqual([
    expect.objectContaining({ type: "text", text: expect.stringContaining(textFragment) }),
  ]);
}

function expectSingleToolCallContent(content: unknown[], name: string) {
  expect(content).toEqual([expect.objectContaining({ type: "toolCall", name })]);
}

it("normalizes hook system context block line endings and trailing whitespace", () => {
  expect(
    composeSystemPromptWithHookContext({
      baseSystemPrompt: "  base system  ",
      prependSystemContext: wrapPluginSystemContextSection("  prepend line  \r\nsecond line\t\r\n"),
      appendSystemContext: wrapPluginSystemContextSection("  append  \t\r\n"),
    }),
  ).toBe(
    `${wrapPluginSystemContextSection("  prepend line\nsecond line")}\n\nbase system\n\n${wrapPluginSystemContextSection("  append")}`,
  );
});

describe("mergeOrphanedTrailingUserPrompt", () => {
  function mergeOrphan(
    leafMessage: Parameters<typeof mergeOrphanedTrailingUserPrompt>[0]["leafMessage"],
    prompt = "newest inbound message",
  ) {
    return mergeOrphanedTrailingUserPrompt({ prompt, leafMessage });
  }
  const interSessionLeaf = (content: string, sourceTool: string) => ({
    content,
    provenance: { kind: "inter_session", sourceTool },
  });
  function promptResult(prompt: string, merged = false, removeLeaf = false) {
    return { prompt, merged, removeLeaf };
  }
  const forwarded = promptResult(
    "[Queued user message from a previous active turn; preserved as context only. Continue with the active prompt below.]\nforwarded user request\n\nnewest inbound message",
    true,
  );
  const approved = "authenticated approved-exec result";
  type OrphanCase = {
    name: string;
    leaf: Parameters<typeof mergeOrphan>[0];
    prompt: string | undefined;
    expected: ReturnType<typeof mergeOrphan>;
  };
  it.each`
    name                                  | leaf                                                                   | prompt       | expected
    ${"drops approved-exec orphans"}      | ${interSessionLeaf("run the command again", "exec_approval_followup")} | ${approved}  | ${promptResult(approved, false, true)}
    ${"preserves forwarded user context"} | ${interSessionLeaf("forwarded user request", "sessions_send")}         | ${undefined} | ${forwarded}
    ${"removes empty user leaves"}        | ${{ content: [] }}                                                     | ${undefined} | ${promptResult("newest inbound message", false, true)}
  `("$name", ({ leaf, prompt, expected }: OrphanCase) => {
    expect(mergeOrphan(leaf, prompt)).toEqual(expected);
  });

  it("summarizes unknown structured data before JSON serialization", () => {
    const nested = {
      inline: `data:image/png;base64,${"a".repeat(10_000)}`,
      longText: "b".repeat(2_000),
    };
    const result = mergeOrphan({ content: [{ type: "unknown_content", nested }] });
    expect(result).toMatchObject({ merged: true, removeLeaf: false });
    expect(result.prompt).toContain("[value] inline data URI (image/png, 10022 chars)");
    expect(result.prompt).toContain("bbbb");
    expect(result.prompt).toContain("(2000 chars)");
    expect(result.prompt).not.toContain("base64");
    expect(result.prompt).not.toContain("aaaa");
  });
});

describe("resolveEmbeddedAgentStream", () => {
  it("injects authStorage api keys into provider-owned stream functions", async () => {
    const providerStreamFn = vi.fn<StreamFn>(() => createAssistantMessageEventStream());
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
    await streamFn({ provider: "demo-provider", id: "demo-model" } as never, {} as never, {});
    expect(providerStreamFn.mock.calls[0]?.[2]).toMatchObject({
      apiKey: "demo-runtime-key",
      authProfileId: "demo-provider:oauth",
    });
  });
  it("keeps explicit custom streams unchanged", () => {
    const currentStreamFn = vi.fn();
    const { streamFn } = resolveEmbeddedAgentStream({
      currentStreamFn: currentStreamFn as never,
      sessionId: "session-1",
      model: { api: "openai-responses", provider: "openai", id: "gpt-5.4" } as never,
    });
    expect(streamFn).toBe(currentStreamFn);
  });
});
describe("wrapStreamFnTrimToolCallNames", () => {
  async function runCall(
    call: NamedCall | NamedCall[],
    allowed?: Set<string>,
    events: unknown[] = [],
    guardOptions?: { unknownToolThreshold?: number },
  ) {
    const finalMessage = sparseAssistant(Array.isArray(call) ? call : [call]);
    const baseFn = fakeBaseStream(finalMessage, events);
    const result = await readStream(
      wrapStreamFnTrimToolCallNames(baseFn as never, allowed, guardOptions),
    );
    return { result, finalMessage };
  }

  it("normalizes common tool aliases when the canonical name is allowed", async () => {
    const finalToolCall = { type: "toolCall", name: " BASH " };
    const { result, finalMessage } = await runCall(finalToolCall, new Set(["exec"]));
    expect(finalToolCall.name).toBe("exec");
    expect(result).toBe(finalMessage);
  });

  it("strips only supported provider-leaked XML fragments from allowed tool names", async () => {
    const calls = (names: string[]) => names.map((name) => ({ type: "toolCall", name }));
    const partial = calls([
      'read" parameter="path" string="true',
      'unknown" parameter="value" string="true',
    ]);
    const message = calls(["exec' parameter='command' string='true", "allowedTool>suffix"]);
    const final = calls(["qualified/write<parameter=path"]);
    const { result, finalMessage } = await runCall(
      final,
      new Set(["read", "write", "exec", "qualified.write", "allowedTool"]),
      [{ ...toolDelta("partial", partial), message: sparseAssistant(message) }],
    );
    expect(result).toBe(finalMessage);
    expect([...partial, ...message, ...final].map((call) => call.name)).toEqual([
      "read",
      'unknown" parameter="value" string="true',
      "exec",
      "allowedTool>suffix",
      "qualified.write",
    ]);
  });

  it("does not count partial tool-call deltas as separate unavailable-tool retries", async () => {
    const partialToolCall = { type: "toolCall", name: " exec " };
    const messageToolCall = { type: "toolCall", name: " exec " };
    const finalToolCall = { type: "toolCall", name: " exec " };
    const { result } = await runCall(
      finalToolCall,
      new Set(["read"]),
      [
        {
          ...toolDelta("partial", [partialToolCall]),
          message: sparseAssistant([messageToolCall]),
        },
      ],
      { unknownToolThreshold: 1 },
    );
    expect([partialToolCall.name, messageToolCall.name]).toEqual(["exec", "exec"]);
    expectSingleToolCallContent(result.content, "exec");
  });

  function sequenceStreams(
    allowedTools: string[],
    frames: Parameters<typeof createFakeStream>[0][],
  ) {
    const streams = frames.map(createFakeStream);
    const baseFn = vi.fn(() => streams.shift());
    const wrappedFn = wrapStreamFnTrimToolCallNames(baseFn as never, new Set(allowedTools), {
      unknownToolThreshold: 1,
    });
    return (drain = false) => readStream(wrappedFn, drain);
  }

  function frame(resultMessage: unknown, ...messages: string[][]) {
    return {
      resultMessage,
      events: messages.map((names) =>
        toolDelta(
          "message",
          names.map((name) => ({ type: "toolCall", name })),
        ),
      ),
    };
  }

  function retryFrames(projection: "partial" | "message", name: string) {
    return Array.from({ length: 2 }, () => ({
      events: [toolDelta(projection, [{ type: "toolCall", name }])],
      resultMessage: toolMessage(" exec "),
    }));
  }

  const allowedAfterUnknown = [
    frame(textAssistant("resolved to allowed tool"), [" re "], [" read "]),
    frame(toolMessage(" re ")),
  ];
  const mixedAfterUnknown = [
    frame(toolMessage(" ex ")),
    frame(toolMessage(" exec "), [" exec ", " ex "]),
    frame(toolMessage(" ex ")),
  ];
  type RetryCase = {
    name: string;
    tools: string[];
    frames: Parameters<typeof createFakeStream>[0][];
    drain: boolean[];
    text: boolean;
    expected: string;
  };
  it.each`
    name                                  | tools       | frames                              | drain                   | text     | expected
    ${"counts final after partial delta"} | ${["read"]} | ${retryFrames("partial", " exec ")} | ${[false, true]}        | ${true}  | ${'"exec"'}
    ${"counts final after blank delta"}   | ${["read"]} | ${retryFrames("message", "")}       | ${[false, true]}        | ${true}  | ${'"exec"'}
    ${"continues after allowed message"}  | ${["read"]} | ${allowedAfterUnknown}              | ${[true, false]}        | ${false} | ${"re"}
    ${"resets on mixed allowed message"}  | ${["exec"]} | ${mixedAfterUnknown}                | ${[false, true, false]} | ${false} | ${"ex"}
  `("$name", async ({ tools, frames, drain, text, expected }: RetryCase) => {
    const next = sequenceStreams(tools, frames);
    for (const readEvents of drain.slice(0, -1)) {
      await next(readEvents);
    }
    const result = await next(drain.at(-1));
    expect(result.role).toBe("assistant");
    if (text) {
      expectSingleTextContent(result.content, expected);
    } else {
      expectSingleToolCallContent(result.content, expected);
    }
  });

  it.each([
    { id: "functionsread3", name: undefined, allowed: undefined },
    { id: "functions.exec2", name: "functions.exec2", allowed: new Set(["exec", "exec2"]) },
  ])("does not guess a tool name for $id", async ({ id, name, allowed }) => {
    const toolCall = { type: "toolCall", id, name };
    await runCall(toolCall, allowed);
    expect(toolCall.name).toBe(name);
  });

  it("leaves provisional blank streamed names recoverable while stopping final blank dispatch", async () => {
    const partialToolCall = { type: "toolCall", name: "   " };
    const finalToolCall = { type: "toolCall", name: "\t  " };
    const { result } = await runCall(finalToolCall, undefined, [
      toolDelta("partial", [partialToolCall]),
    ]);
    expectSingleTextContent(result.content, '"blank tool name"');
    expect([partialToolCall.name, finalToolCall.name]).toEqual(["   ", "\t  "]);
  });

  it("reassigns duplicate tool call ids within a message to unique fallbacks", async () => {
    const finalToolCallA = { type: "toolCall", name: " read ", id: "  edit:22  " };
    const finalToolCallB = { type: "toolCall", name: " write ", id: "edit:22" };
    await runCall([finalToolCallA, finalToolCallB]);
    expect([finalToolCallA, finalToolCallB]).toMatchObject([
      { name: "read", id: "edit:22" },
      { name: "write", id: expect.stringMatching(/^call_[0-9a-f]{24}$/) },
    ]);
  });

  it("keeps repeated provider ids unique across compacted responses with prior history", async () => {
    const makeToolCall = () => ({ type: "toolCall", name: "exec", id: "exec_0", arguments: {} });
    const makeMessage = (call = makeToolCall()) => ({ role: "assistant", content: [call] });
    const baseFn = vi.fn(() => {
      const partialCall = makeToolCall();
      const partial = makeMessage(partialCall);
      const [message, result] = [makeMessage(), makeMessage()];
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
    const history = [makeMessage()];
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
      expect(call.id).toMatch(/^call_[0-9a-f]{24}$/);
      responseIds.push(call.id);
    }
    expect(new Set(responseIds).size).toBe(3);
    expect(history).toEqual([makeMessage()]);
  });
});

describe("wrapStreamFnSanitizeMalformedToolCalls", () => {
  function replayCall(name: string, id: string) {
    return { type: "toolCall", id, name, arguments: {} };
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

  async function replay(
    messages: unknown[],
    allowedToolNames?: Set<string>,
    policy?: Parameters<typeof wrapStreamFnSanitizeMalformedToolCalls>[2],
    api?: string,
  ) {
    const baseFn = vi.fn((_model: unknown, _context: { messages: unknown[] }) =>
      createFakeStream({ events: [], resultMessage: { role: "assistant", content: [] } }),
    );
    const wrapped = wrapStreamFnSanitizeMalformedToolCalls(
      baseFn as never,
      allowedToolNames,
      policy,
    );
    await wrapped((api ? { api } : {}) as never, { messages } as never, {} as never);
    return baseFn.mock.calls[0]![1].messages;
  }
  function replaySigned(messages: unknown[], api = "anthropic-messages") {
    return replay(messages, new Set(["read"]), signedPolicy, api);
  }

  it("strips trailing assistant prefill turns for Gemini outbound replay", async () => {
    const messages = [textUser("earlier question"), textAssistant("stale model answer")];
    const seen = await replay(
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
    expect(seen).toEqual([textUser("earlier question")]);
    expect(seen).not.toBe(messages);
  });

  it.each`
    name                             | turn                                                                                                               | api
    ${"unsafe Bedrock sibling tool"} | ${thinkingTurn(replayCall("gateway", "toolu_legacy"))}                                                             | ${"bedrock-converse-stream"}
    ${"duplicate sibling tool id"}   | ${thinkingTurn(replayCall("read", "call_1"), { type: "functionCall", id: "call_1", name: "read", arguments: {} })} | ${"anthropic-messages"}
  `(
    "drops signed thinking replay with $name",
    async ({ turn, api }: { turn: ReturnType<typeof thinkingTurn>; api: string }) => {
      expect(await replaySigned([turn, textUser("retry")], api)).toEqual([textUser("retry")]);
    },
  );

  it.each([false, true])(
    "retains reused signed ids only with adjacent results (displaced: %s)",
    async (displaced) => {
      const prefix = [
        sparseAssistant([replayCall("read", "call_1")]),
        textToolResult("call_1", "read", "mutable result"),
      ];
      const user = textUser("retry");
      const result = textToolResult("call_1", "read", "signed result");
      const messages = [
        ...prefix,
        thinkingTurn({ type: "toolUse", id: "call_1", name: "read", input: {} }),
        ...(displaced ? [user, result] : [result, user]),
      ];
      const seen = await replaySigned(messages);
      if (displaced) {
        expect(seen).toEqual([...prefix, user]);
      } else {
        expect(seen).toBe(messages);
      }
    },
  );

  it("keeps mutable thinking turns outside anthropic replay-only preservation", async () => {
    const messages = [thinkingTurn(replayCall(" read ", "call_1")), textUser("retry")];
    const seen = await replay(messages, new Set(["read"]), anthropicPolicy, "openai-completions");
    expect(seen).toEqual([
      thinkingTurn(replayCall("read", "call_1")),
      expect.objectContaining({
        ...textToolResult(
          "call_1",
          "read",
          "Tool call interrupted before a result was recorded; its outcome is unknown. Retry only if the operation is read-only or safe to repeat. If it may have had side effects, verify the current state first instead of repeating it.",
          { isError: true },
        ),
        timestamp: expect.any(Number),
      }),
      textUser("retry"),
    ]);
  });

  it("canonicalizes mixed-case allowlisted tool names on replay", async () => {
    const messages = [sparseAssistant([replayCall("readfile", "call_1")])];
    const seen = await replay(messages, new Set(["ReadFile"]));
    expect(seen[0]).toMatchObject({ content: [{ name: "ReadFile" }] });
  });

  it.each`
    name                                     | messages                                                                                                             | allowed
    ${"blank names and their stale results"} | ${[sparseAssistant([replayCall("   ", "call_1")]), textToolResult("call_1", "", "stale result", { isError: true })]} | ${undefined}
    ${"ambiguous mangled names"}             | ${[sparseAssistant([replayCall("functions.exec2", "call_1")])]}                                                      | ${new Set(["exec", "exec2"])}
  `(
    "drops replayed $name",
    async ({ messages, allowed }: { messages: unknown[]; allowed?: Set<string> }) => {
      expect(await replay(messages, allowed)).toStrictEqual([]);
    },
  );

  it("preserves matching tool results for retained errored assistant turns", async () => {
    const retained = { ...sparseAssistant([replayCall("read", "call_1")]), stopReason: "error" };
    const tail = [
      textToolResult("call_1", "read", "kept result", { isError: false }),
      textUser("retry"),
    ];
    const seen = await replay(
      [
        {
          ...retained,
          content: [...retained.content, { type: "toolCall", name: "read", arguments: {} }],
        },
        ...tail,
      ],
      new Set(["read"]),
    );
    expect(seen).toEqual([retained, ...tail]);
  });

  it.each([false, true])(
    "drops orphaned Anthropic results (assistant dropped: %s)",
    async (dropped) => {
      const text = textAssistant("partial response");
      const call = { type: "toolUse", name: "read", input: { path: "." } };
      const assistant = dropped
        ? { ...sparseAssistant([call]), stopReason: "error" }
        : sparseAssistant([...text.content, call]);
      const seen = await replay(
        [...(dropped ? [textUser("first")] : []), assistant, embeddedResultUser("stale")],
        new Set(["read"]),
        anthropicPolicy,
      );
      expect(seen).toEqual(
        dropped
          ? [
              {
                role: "user",
                content: [...textUser("first").content, ...textUser("retry").content],
              },
            ]
          : [text, textUser("retry")],
      );
    },
  );

  it("preserves embedded Anthropic user tool_result blocks for non-thinking turns even when immutable replay is enabled", async () => {
    const messages = [
      sparseAssistant([{ type: "toolUse", id: "call_1", name: "read", input: { path: "." } }]),
      embeddedResultUser("kept result"),
    ];
    expect(await replaySigned(messages)).toEqual(messages);
  });
});

describe("wrapStreamFnRepairMalformedToolCallArguments", () => {
  async function replayArgumentDeltas(deltas: string[], initialArgs: Record<string, unknown>) {
    const call = (args: Record<string, unknown> = {}) => ({
      type: "toolCall",
      name: "read",
      arguments: args,
    });
    const calls = [call(initialArgs), call()] as const;
    const partial = sparseAssistant([calls[0]]);
    const baseFn = fakeBaseStream(partial, [
      ...deltas.map((delta) => ({ type: "toolcall_delta", contentIndex: 0, delta, partial })),
      {
        type: "toolcall_end",
        contentIndex: 0,
        toolCall: calls[1],
        partial,
      },
    ]);
    const wrapped = wrapStreamFnRepairMalformedToolCallArguments(baseFn as never);
    const stream = await wrapped({} as never, {} as never, {} as never);
    await drainStream(stream);
    return calls;
  }

  const json = '{"path":"/tmp/report.txt"}';
  type ArgumentCase = {
    name: string;
    deltas: string[];
    initialArgs: Record<string, unknown>;
    expected: Record<string, unknown>[];
  };
  it.each`
    name                                   | deltas                    | initialArgs               | expected
    ${"rejects leading prose"}             | ${[`please use ${json}`]} | ${{}}                     | ${[{}, {}]}
    ${"clears oversized trailing repairs"} | ${[json, "oops"]}         | ${{}}                     | ${[{}, {}]}
    ${"preserves preexisting arguments"}   | ${["}"]}                  | ${{ path: "/etc/hosts" }} | ${[{ path: "/etc/hosts" }, {}]}
  `("$name", async ({ deltas, initialArgs, expected }: ArgumentCase) => {
    const calls = await replayArgumentDeltas(deltas, initialArgs);
    expect(calls.map((call) => call.arguments)).toStrictEqual(expected);
  });
});
