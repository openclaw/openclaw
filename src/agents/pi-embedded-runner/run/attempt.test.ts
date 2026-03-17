import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import type { PluginHookAgentEndEvent } from "../../../plugins/types.js";
import { resolveOllamaBaseUrlForRun } from "../../ollama-stream.js";
import {
  buildAfterTurnRuntimeContext,
  buildAgentEndFinalLlmOutcome,
  buildAgentEndHookEvent,
  composeSystemPromptWithHookContext,
  decodeHtmlEntitiesInObject,
  isOllamaCompatProvider,
  prependSystemPromptAddition,
  resolveAttemptFsWorkspaceOnly,
  resolveOllamaCompatNumCtxEnabled,
  resolvePromptBuildHookResult,
  resolvePromptModeForSession,
  shouldInjectOllamaCompatNumCtx,
  wrapOllamaCompatNumCtx,
  wrapStreamFnRepairMalformedToolCallArguments,
  wrapStreamFnTrimToolCallNames,
} from "./attempt.js";

type FakeWrappedStream = {
  result: () => Promise<unknown>;
  [Symbol.asyncIterator]: () => AsyncIterator<unknown>;
};

function createOllamaProviderConfig(injectNumCtxForOpenAICompat: boolean): OpenClawConfig {
  return {
    models: {
      providers: {
        ollama: {
          baseUrl: "http://127.0.0.1:11434/v1",
          api: "openai-completions",
          injectNumCtxForOpenAICompat,
          models: [],
        },
      },
    },
  };
}

function createFakeStream(params: {
  events: unknown[];
  resultMessage: unknown;
}): FakeWrappedStream {
  return {
    async result() {
      return params.resultMessage;
    },
    [Symbol.asyncIterator]() {
      return (async function* () {
        for (const event of params.events) {
          yield event;
        }
      })();
    },
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

function createAssistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    api: "openai-responses" as AssistantMessage["api"],
    provider: "openai" as AssistantMessage["provider"],
    model: "gpt-4.1",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: "stop",
    timestamp: 0,
    ...overrides,
  };
}

describe("resolvePromptBuildHookResult", () => {
  function createLegacyOnlyHookRunner() {
    return {
      hasHooks: vi.fn(
        (hookName: "before_prompt_build" | "before_agent_start") =>
          hookName === "before_agent_start",
      ),
      runBeforePromptBuild: vi.fn(async () => undefined),
      runBeforeAgentStart: vi.fn(async () => ({ prependContext: "from-hook" })),
    };
  }

  it("reuses precomputed legacy before_agent_start result without invoking hook again", async () => {
    const hookRunner = createLegacyOnlyHookRunner();
    const result = await resolvePromptBuildHookResult({
      prompt: "hello",
      messages: [],
      hookCtx: {},
      hookRunner,
      legacyBeforeAgentStartResult: { prependContext: "from-cache", systemPrompt: "legacy-system" },
    });

    expect(hookRunner.runBeforeAgentStart).not.toHaveBeenCalled();
    expect(result).toEqual({
      prependContext: "from-cache",
      systemPrompt: "legacy-system",
      prependSystemContext: undefined,
      appendSystemContext: undefined,
    });
  });

  it("calls legacy hook when precomputed result is absent", async () => {
    const hookRunner = createLegacyOnlyHookRunner();
    const messages = [{ role: "user", content: "ctx" }];
    const result = await resolvePromptBuildHookResult({
      prompt: "hello",
      messages,
      hookCtx: {},
      hookRunner,
    });

    expect(hookRunner.runBeforeAgentStart).toHaveBeenCalledTimes(1);
    expect(hookRunner.runBeforeAgentStart).toHaveBeenCalledWith({ prompt: "hello", messages }, {});
    expect(result.prependContext).toBe("from-hook");
  });

  it("merges prompt-build and legacy context fields in deterministic order", async () => {
    const hookRunner = {
      hasHooks: vi.fn(() => true),
      runBeforePromptBuild: vi.fn(async () => ({
        prependContext: "prompt context",
        prependSystemContext: "prompt prepend",
        appendSystemContext: "prompt append",
      })),
      runBeforeAgentStart: vi.fn(async () => ({
        prependContext: "legacy context",
        prependSystemContext: "legacy prepend",
        appendSystemContext: "legacy append",
      })),
    };

    const result = await resolvePromptBuildHookResult({
      prompt: "hello",
      messages: [],
      hookCtx: {},
      hookRunner,
    });

    expect(result.prependContext).toBe("prompt context\n\nlegacy context");
    expect(result.prependSystemContext).toBe("prompt prepend\n\nlegacy prepend");
    expect(result.appendSystemContext).toBe("prompt append\n\nlegacy append");
  });
});

describe("composeSystemPromptWithHookContext", () => {
  it("returns undefined when no hook system context is provided", () => {
    expect(composeSystemPromptWithHookContext({ baseSystemPrompt: "base" })).toBeUndefined();
  });

  it("builds prepend/base/append system prompt order", () => {
    expect(
      composeSystemPromptWithHookContext({
        baseSystemPrompt: "  base system  ",
        prependSystemContext: "  prepend  ",
        appendSystemContext: "  append  ",
      }),
    ).toBe("prepend\n\nbase system\n\nappend");
  });

  it("avoids blank separators when base system prompt is empty", () => {
    expect(
      composeSystemPromptWithHookContext({
        baseSystemPrompt: "   ",
        appendSystemContext: "  append only  ",
      }),
    ).toBe("append only");
  });
});

describe("resolvePromptModeForSession", () => {
  it("uses minimal mode for subagent sessions", () => {
    expect(resolvePromptModeForSession("agent:main:subagent:child")).toBe("minimal");
  });

  it("uses minimal mode for cron sessions", () => {
    expect(resolvePromptModeForSession("agent:main:cron:job-1")).toBe("minimal");
    expect(resolvePromptModeForSession("agent:main:cron:job-1:run:run-abc")).toBe("minimal");
  });

  it("uses full mode for regular and undefined sessions", () => {
    expect(resolvePromptModeForSession(undefined)).toBe("full");
    expect(resolvePromptModeForSession("agent:main")).toBe("full");
    expect(resolvePromptModeForSession("agent:main:thread:abc")).toBe("full");
  });
});

describe("resolveAttemptFsWorkspaceOnly", () => {
  it("uses global tools.fs.workspaceOnly when agent has no override", () => {
    const cfg: OpenClawConfig = {
      tools: {
        fs: { workspaceOnly: true },
      },
    };

    expect(
      resolveAttemptFsWorkspaceOnly({
        config: cfg,
        sessionAgentId: "main",
      }),
    ).toBe(true);
  });

  it("prefers agent-specific tools.fs.workspaceOnly override", () => {
    const cfg: OpenClawConfig = {
      tools: {
        fs: { workspaceOnly: true },
      },
      agents: {
        list: [
          {
            id: "main",
            tools: {
              fs: { workspaceOnly: false },
            },
          },
        ],
      },
    };

    expect(
      resolveAttemptFsWorkspaceOnly({
        config: cfg,
        sessionAgentId: "main",
      }),
    ).toBe(false);
  });
});

describe("buildAgentEndHookEvent", () => {
  it("includes optional finalLlmOutcome in the agent_end payload", () => {
    const event: PluginHookAgentEndEvent = buildAgentEndHookEvent({
      messages: [{ role: "assistant", content: "done" }] as never,
      success: true,
      durationMs: 42,
      finalLlmOutcome: {
        ok: true,
        source: "provider",
        provider: "openai",
        model: "gpt-4.1",
      },
    });

    expect(event).toEqual({
      messages: [{ role: "assistant", content: "done" }],
      success: true,
      error: undefined,
      durationMs: 42,
      finalLlmOutcome: {
        ok: true,
        source: "provider",
        provider: "openai",
        model: "gpt-4.1",
      },
    });
  });

  it("keeps legacy agent_end consumers working when finalLlmOutcome is omitted", () => {
    const event = buildAgentEndHookEvent({
      messages: [{ role: "assistant", content: "done" }] as never,
      success: true,
      durationMs: 42,
    });
    const consumeLegacy = ({ messages, success, error, durationMs }: PluginHookAgentEndEvent) => ({
      messages,
      success,
      error,
      durationMs,
    });

    expect(consumeLegacy(event)).toEqual({
      messages: [{ role: "assistant", content: "done" }],
      success: true,
      error: undefined,
      durationMs: 42,
    });
    expect("finalLlmOutcome" in event).toBe(false);
  });
});

describe("buildAgentEndFinalLlmOutcome", () => {
  it("marks successful terminal provider completions with ok=true", () => {
    expect(
      buildAgentEndFinalLlmOutcome({
        provider: "openai",
        modelId: "gpt-4.1",
        lastAssistant: createAssistantMessage(),
        promptError: null,
        promptErrorSource: null,
        providerCallStarted: true,
        aborted: false,
        timedOut: false,
      }),
    ).toEqual({
      ok: true,
      source: "provider",
      provider: "openai",
      model: "gpt-4.1",
      stopReason: "stop",
    });
  });

  it("reports prompt-build failures with source=prompt and ok=false", () => {
    expect(
      buildAgentEndFinalLlmOutcome({
        provider: "openai",
        modelId: "gpt-4.1",
        lastAssistant: undefined,
        promptError: new Error("prompt assembly failed"),
        promptErrorSource: "prompt",
        providerCallStarted: false,
        aborted: false,
        timedOut: false,
      }),
    ).toEqual({
      ok: false,
      source: "prompt",
      errorMessage: "prompt assembly failed",
    });
  });

  it("reports structured provider failures with statusCode when available", () => {
    const providerError = Object.assign(new Error("Unauthorized"), {
      status: 401,
      statusText: "Unauthorized",
    });

    expect(
      buildAgentEndFinalLlmOutcome({
        provider: "deepseek",
        modelId: "deepseek-v3.2-speciale",
        lastAssistant: undefined,
        promptError: providerError,
        promptErrorSource: "prompt",
        providerCallStarted: true,
        aborted: false,
        timedOut: false,
      }),
    ).toEqual({
      ok: false,
      source: "provider",
      provider: "deepseek",
      model: "deepseek-v3.2-speciale",
      statusCode: 401,
      statusText: "Unauthorized",
      errorMessage: "Unauthorized",
    });
  });

  it("marks terminal assistant provider failures even when promptError is null", () => {
    const outcome = buildAgentEndFinalLlmOutcome({
      provider: "openai",
      modelId: "gpt-4.1",
      lastAssistant: createAssistantMessage({
        stopReason: "error",
        errorMessage:
          '401 {"error":{"type":"auth_error","message":"Unauthorized"}} Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz123456',
      }),
      promptError: null,
      promptErrorSource: null,
      providerCallStarted: true,
      aborted: false,
      timedOut: false,
    });

    expect(outcome).toMatchObject({
      ok: false,
      source: "provider",
      provider: "openai",
      model: "gpt-4.1",
      stopReason: "error",
    });
    expect(outcome?.errorMessage).toContain("Unauthorized");
    expect(outcome?.errorMessage).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
  });
});

describe("wrapStreamFnTrimToolCallNames", () => {
  async function invokeWrappedStream(
    baseFn: (...args: never[]) => unknown,
    allowedToolNames?: Set<string>,
  ) {
    return await invokeWrappedTestStream(
      (innerBaseFn) => wrapStreamFnTrimToolCallNames(innerBaseFn as never, allowedToolNames),
      baseFn,
    );
  }

  function createEventStream(params: {
    event: unknown;
    finalToolCall: { type: string; name: string };
  }) {
    const finalMessage = { role: "assistant", content: [params.finalToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({ events: [params.event], resultMessage: finalMessage }),
    );
    return { baseFn, finalMessage };
  }

  it("trims whitespace from live streamed tool call names and final result message", async () => {
    const partialToolCall = { type: "toolCall", name: " read " };
    const messageToolCall = { type: "toolCall", name: " exec " };
    const finalToolCall = { type: "toolCall", name: " write " };
    const event = {
      type: "toolcall_delta",
      partial: { role: "assistant", content: [partialToolCall] },
      message: { role: "assistant", content: [messageToolCall] },
    };
    const { baseFn, finalMessage } = createEventStream({ event, finalToolCall });

    const stream = await invokeWrappedStream(baseFn);

    const seenEvents: unknown[] = [];
    for await (const item of stream) {
      seenEvents.push(item);
    }
    const result = await stream.result();

    expect(seenEvents).toHaveLength(1);
    expect(partialToolCall.name).toBe("read");
    expect(messageToolCall.name).toBe("exec");
    expect(finalToolCall.name).toBe("write");
    expect(result).toBe(finalMessage);
    expect(baseFn).toHaveBeenCalledTimes(1);
  });

  it("supports async stream functions that return a promise", async () => {
    const finalToolCall = { type: "toolCall", name: " browser " };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = vi.fn(async () =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn);
    const result = await stream.result();

    expect(finalToolCall.name).toBe("browser");
    expect(result).toBe(finalMessage);
    expect(baseFn).toHaveBeenCalledTimes(1);
  });
  it("normalizes common tool aliases when the canonical name is allowed", async () => {
    const finalToolCall = { type: "toolCall", name: " BASH " };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["exec"]));
    const result = await stream.result();

    expect(finalToolCall.name).toBe("exec");
    expect(result).toBe(finalMessage);
  });

  it("maps provider-prefixed tool names to allowed canonical tools", async () => {
    const partialToolCall = { type: "toolCall", name: " functions.read " };
    const messageToolCall = { type: "toolCall", name: " functions.write " };
    const finalToolCall = { type: "toolCall", name: " tools/exec " };
    const event = {
      type: "toolcall_delta",
      partial: { role: "assistant", content: [partialToolCall] },
      message: { role: "assistant", content: [messageToolCall] },
    };
    const { baseFn } = createEventStream({ event, finalToolCall });

    const stream = await invokeWrappedStream(baseFn, new Set(["read", "write", "exec"]));

    for await (const _item of stream) {
      // drain
    }
    await stream.result();

    expect(partialToolCall.name).toBe("read");
    expect(messageToolCall.name).toBe("write");
    expect(finalToolCall.name).toBe("exec");
  });

  it("normalizes toolUse and functionCall names before dispatch", async () => {
    const partialToolCall = { type: "toolUse", name: " functions.read " };
    const messageToolCall = { type: "functionCall", name: " functions.exec " };
    const finalToolCall = { type: "toolUse", name: " tools/write " };
    const event = {
      type: "toolcall_delta",
      partial: { role: "assistant", content: [partialToolCall] },
      message: { role: "assistant", content: [messageToolCall] },
    };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [event],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["read", "write", "exec"]));

    for await (const _item of stream) {
      // drain
    }
    const result = await stream.result();

    expect(partialToolCall.name).toBe("read");
    expect(messageToolCall.name).toBe("exec");
    expect(finalToolCall.name).toBe("write");
    expect(result).toBe(finalMessage);
  });

  it("preserves multi-segment tool suffixes when dropping provider prefixes", async () => {
    const finalToolCall = { type: "toolCall", name: " functions.graph.search " };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["graph.search", "search"]));
    const result = await stream.result();

    expect(finalToolCall.name).toBe("graph.search");
    expect(result).toBe(finalMessage);
  });

  it("infers tool names from malformed toolCallId variants when allowlist is present", async () => {
    const partialToolCall = { type: "toolCall", id: "functions.read:0", name: "" };
    const finalToolCallA = { type: "toolCall", id: "functionsread3", name: "" };
    const finalToolCallB: { type: string; id: string; name?: string } = {
      type: "toolCall",
      id: "functionswrite4",
    };
    const finalToolCallC = { type: "functionCall", id: "functions.exec2", name: "" };
    const event = {
      type: "toolcall_delta",
      partial: { role: "assistant", content: [partialToolCall] },
    };
    const finalMessage = {
      role: "assistant",
      content: [finalToolCallA, finalToolCallB, finalToolCallC],
    };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [event],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["read", "write", "exec"]));
    for await (const _item of stream) {
      // drain
    }
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
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn);
    await stream.result();

    expect(finalToolCall.name).toBeUndefined();
  });

  it("infers malformed non-blank tool names before dispatch", async () => {
    const partialToolCall = { type: "toolCall", id: "functionsread3", name: "functionsread3" };
    const finalToolCall = { type: "toolCall", id: "functionsread3", name: "functionsread3" };
    const event = {
      type: "toolcall_delta",
      partial: { role: "assistant", content: [partialToolCall] },
    };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [event],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["read", "write"]));
    for await (const _item of stream) {
      // drain
    }
    await stream.result();

    expect(partialToolCall.name).toBe("read");
    expect(finalToolCall.name).toBe("read");
  });

  it("recovers malformed non-blank names when id is missing", async () => {
    const finalToolCall = { type: "toolCall", name: "functionsread3" };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["read", "write"]));
    await stream.result();

    expect(finalToolCall.name).toBe("read");
  });

  it("recovers canonical tool names from canonical ids when name is empty", async () => {
    const finalToolCall = { type: "toolCall", id: "read", name: "" };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["read", "write"]));
    await stream.result();

    expect(finalToolCall.name).toBe("read");
  });

  it("recovers tool names from ids when name is whitespace-only", async () => {
    const finalToolCall = { type: "toolCall", id: "functionswrite4", name: "   " };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["read", "write"]));
    await stream.result();

    expect(finalToolCall.name).toBe("write");
  });

  it("keeps blank names blank and assigns fallback ids when both name and id are blank", async () => {
    const finalToolCall = { type: "toolCall", id: "", name: "" };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["read", "write"]));
    await stream.result();

    expect(finalToolCall.name).toBe("");
    expect(finalToolCall.id).toBe("call_auto_1");
  });

  it("assigns fallback ids when both name and id are missing", async () => {
    const finalToolCall: { type: string; name?: string; id?: string } = { type: "toolCall" };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["read", "write"]));
    await stream.result();

    expect(finalToolCall.name).toBeUndefined();
    expect(finalToolCall.id).toBe("call_auto_1");
  });

  it("prefers explicit canonical names over conflicting canonical ids", async () => {
    const finalToolCall = { type: "toolCall", id: "write", name: "read" };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["read", "write"]));
    await stream.result();

    expect(finalToolCall.name).toBe("read");
    expect(finalToolCall.id).toBe("write");
  });

  it("prefers explicit trimmed canonical names over conflicting malformed ids", async () => {
    const finalToolCall = { type: "toolCall", id: "functionswrite4", name: " read " };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["read", "write"]));
    await stream.result();

    expect(finalToolCall.name).toBe("read");
  });

  it("does not rewrite composite names that mention multiple tools", async () => {
    const finalToolCall = { type: "toolCall", id: "functionsread3", name: "read write" };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["read", "write"]));
    await stream.result();

    expect(finalToolCall.name).toBe("read write");
  });

  it("fails closed for malformed non-blank names that are ambiguous", async () => {
    const finalToolCall = { type: "toolCall", id: "functions.exec2", name: "functions.exec2" };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["exec", "exec2"]));
    await stream.result();

    expect(finalToolCall.name).toBe("functions.exec2");
  });

  it("matches malformed ids case-insensitively across common separators", async () => {
    const finalToolCall = { type: "toolCall", id: "Functions.Read_7", name: "" };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["read", "write"]));
    await stream.result();

    expect(finalToolCall.name).toBe("read");
  });
  it("does not override explicit non-blank tool names with inferred ids", async () => {
    const finalToolCall = { type: "toolCall", id: "functionswrite4", name: "someOtherTool" };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["read", "write"]));
    await stream.result();

    expect(finalToolCall.name).toBe("someOtherTool");
  });

  it("fails closed when malformed ids could map to multiple allowlisted tools", async () => {
    const finalToolCall = { type: "toolCall", id: "functions.exec2", name: "" };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["exec", "exec2"]));
    await stream.result();

    expect(finalToolCall.name).toBe("");
  });
  it("does not collapse whitespace-only tool names to empty strings", async () => {
    const partialToolCall = { type: "toolCall", name: "   " };
    const finalToolCall = { type: "toolCall", name: "\t  " };
    const event = {
      type: "toolcall_delta",
      partial: { role: "assistant", content: [partialToolCall] },
    };
    const { baseFn } = createEventStream({ event, finalToolCall });

    const stream = await invokeWrappedStream(baseFn);

    for await (const _item of stream) {
      // drain
    }
    await stream.result();

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
    const event = {
      type: "toolcall_delta",
      partial: { role: "assistant", content: [partialToolCall] },
    };
    const finalMessage = { role: "assistant", content: [finalToolCallA, finalToolCallB] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [event],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn);
    for await (const _item of stream) {
      // drain
    }
    const result = await stream.result();

    expect(partialToolCall.name).toBe("read");
    expect(partialToolCall.id).toBe("call_auto_1");
    expect(finalToolCallA.name).toBe("exec");
    expect(finalToolCallA.id).toBe("call_auto_1");
    expect(finalToolCallB.name).toBe("write");
    expect(finalToolCallB.id).toBe("call_auto_2");
    expect(result).toBe(finalMessage);
  });

  it("trims surrounding whitespace on tool call ids", async () => {
    const finalToolCall = { type: "toolCall", name: " read ", id: "  call_42  " };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn);
    await stream.result();

    expect(finalToolCall.name).toBe("read");
    expect(finalToolCall.id).toBe("call_42");
  });

  it("reassigns duplicate tool call ids within a message to unique fallbacks", async () => {
    const finalToolCallA = { type: "toolCall", name: " read ", id: "  edit:22  " };
    const finalToolCallB = { type: "toolCall", name: " write ", id: "edit:22" };
    const finalMessage = { role: "assistant", content: [finalToolCallA, finalToolCallB] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn);
    await stream.result();

    expect(finalToolCallA.name).toBe("read");
    expect(finalToolCallB.name).toBe("write");
    expect(finalToolCallA.id).toBe("edit:22");
    expect(finalToolCallB.id).toBe("call_auto_1");
  });
});

describe("wrapStreamFnRepairMalformedToolCallArguments", () => {
  async function invokeWrappedStream(baseFn: (...args: never[]) => unknown) {
    return await invokeWrappedTestStream(
      (innerBaseFn) => wrapStreamFnRepairMalformedToolCallArguments(innerBaseFn as never),
      baseFn,
    );
  }

  it("repairs anthropic-compatible tool arguments when trailing junk follows valid JSON", async () => {
    const partialToolCall = { type: "toolCall", name: "read", arguments: {} };
    const streamedToolCall = { type: "toolCall", name: "read", arguments: {} };
    const endMessageToolCall = { type: "toolCall", name: "read", arguments: {} };
    const finalToolCall = { type: "toolCall", name: "read", arguments: {} };
    const partialMessage = { role: "assistant", content: [partialToolCall] };
    const endMessage = { role: "assistant", content: [endMessageToolCall] };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [
          {
            type: "toolcall_delta",
            contentIndex: 0,
            delta: '{"path":"/tmp/report.txt"}',
            partial: partialMessage,
          },
          {
            type: "toolcall_delta",
            contentIndex: 0,
            delta: "xx",
            partial: partialMessage,
          },
          {
            type: "toolcall_end",
            contentIndex: 0,
            toolCall: streamedToolCall,
            partial: partialMessage,
            message: endMessage,
          },
        ],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn);
    for await (const _item of stream) {
      // drain
    }
    const result = await stream.result();

    expect(partialToolCall.arguments).toEqual({ path: "/tmp/report.txt" });
    expect(streamedToolCall.arguments).toEqual({ path: "/tmp/report.txt" });
    expect(endMessageToolCall.arguments).toEqual({ path: "/tmp/report.txt" });
    expect(finalToolCall.arguments).toEqual({ path: "/tmp/report.txt" });
    expect(result).toBe(finalMessage);
  });

  it("keeps incomplete partial JSON unchanged until a complete object exists", async () => {
    const partialToolCall = { type: "toolCall", name: "read", arguments: {} };
    const partialMessage = { role: "assistant", content: [partialToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [
          {
            type: "toolcall_delta",
            contentIndex: 0,
            delta: '{"path":"/tmp',
            partial: partialMessage,
          },
        ],
        resultMessage: { role: "assistant", content: [partialToolCall] },
      }),
    );

    const stream = await invokeWrappedStream(baseFn);
    for await (const _item of stream) {
      // drain
    }

    expect(partialToolCall.arguments).toEqual({});
  });

  it("does not repair tool arguments when trailing junk exceeds the Kimi-specific allowance", async () => {
    const partialToolCall = { type: "toolCall", name: "read", arguments: {} };
    const streamedToolCall = { type: "toolCall", name: "read", arguments: {} };
    const partialMessage = { role: "assistant", content: [partialToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [
          {
            type: "toolcall_delta",
            contentIndex: 0,
            delta: '{"path":"/tmp/report.txt"}oops',
            partial: partialMessage,
          },
          {
            type: "toolcall_end",
            contentIndex: 0,
            toolCall: streamedToolCall,
            partial: partialMessage,
          },
        ],
        resultMessage: { role: "assistant", content: [partialToolCall] },
      }),
    );

    const stream = await invokeWrappedStream(baseFn);
    for await (const _item of stream) {
      // drain
    }

    expect(partialToolCall.arguments).toEqual({});
    expect(streamedToolCall.arguments).toEqual({});
  });

  it("clears a cached repair when later deltas make the trailing suffix invalid", async () => {
    const partialToolCall = { type: "toolCall", name: "read", arguments: {} };
    const streamedToolCall = { type: "toolCall", name: "read", arguments: {} };
    const partialMessage = { role: "assistant", content: [partialToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [
          {
            type: "toolcall_delta",
            contentIndex: 0,
            delta: '{"path":"/tmp/report.txt"}',
            partial: partialMessage,
          },
          {
            type: "toolcall_delta",
            contentIndex: 0,
            delta: "x",
            partial: partialMessage,
          },
          {
            type: "toolcall_delta",
            contentIndex: 0,
            delta: "yzq",
            partial: partialMessage,
          },
          {
            type: "toolcall_end",
            contentIndex: 0,
            toolCall: streamedToolCall,
            partial: partialMessage,
          },
        ],
        resultMessage: { role: "assistant", content: [partialToolCall] },
      }),
    );

    const stream = await invokeWrappedStream(baseFn);
    for await (const _item of stream) {
      // drain
    }

    expect(partialToolCall.arguments).toEqual({});
    expect(streamedToolCall.arguments).toEqual({});
  });
});

describe("isOllamaCompatProvider", () => {
  it("detects native ollama provider id", () => {
    expect(
      isOllamaCompatProvider({
        provider: "ollama",
        api: "openai-completions",
        baseUrl: "https://example.com/v1",
      }),
    ).toBe(true);
  });

  it("detects localhost Ollama OpenAI-compatible endpoint", () => {
    expect(
      isOllamaCompatProvider({
        provider: "custom",
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:11434/v1",
      }),
    ).toBe(true);
  });

  it("does not misclassify non-local OpenAI-compatible providers", () => {
    expect(
      isOllamaCompatProvider({
        provider: "custom",
        api: "openai-completions",
        baseUrl: "https://api.openrouter.ai/v1",
      }),
    ).toBe(false);
  });

  it("detects remote Ollama-compatible endpoint when provider id hints ollama", () => {
    expect(
      isOllamaCompatProvider({
        provider: "my-ollama",
        api: "openai-completions",
        baseUrl: "http://ollama-host:11434/v1",
      }),
    ).toBe(true);
  });

  it("detects IPv6 loopback Ollama OpenAI-compatible endpoint", () => {
    expect(
      isOllamaCompatProvider({
        provider: "custom",
        api: "openai-completions",
        baseUrl: "http://[::1]:11434/v1",
      }),
    ).toBe(true);
  });

  it("does not classify arbitrary remote hosts on 11434 without ollama provider hint", () => {
    expect(
      isOllamaCompatProvider({
        provider: "custom",
        api: "openai-completions",
        baseUrl: "http://example.com:11434/v1",
      }),
    ).toBe(false);
  });
});

describe("resolveOllamaBaseUrlForRun", () => {
  it("prefers provider baseUrl over model baseUrl", () => {
    expect(
      resolveOllamaBaseUrlForRun({
        modelBaseUrl: "http://model-host:11434",
        providerBaseUrl: "http://provider-host:11434",
      }),
    ).toBe("http://provider-host:11434");
  });

  it("falls back to model baseUrl when provider baseUrl is missing", () => {
    expect(
      resolveOllamaBaseUrlForRun({
        modelBaseUrl: "http://model-host:11434",
      }),
    ).toBe("http://model-host:11434");
  });

  it("falls back to native default when neither baseUrl is configured", () => {
    expect(resolveOllamaBaseUrlForRun({})).toBe("http://127.0.0.1:11434");
  });
});

describe("wrapOllamaCompatNumCtx", () => {
  it("injects num_ctx and preserves downstream onPayload hooks", () => {
    let payloadSeen: Record<string, unknown> | undefined;
    const baseFn = vi.fn((_model, _context, options) => {
      const payload: Record<string, unknown> = { options: { temperature: 0.1 } };
      options?.onPayload?.(payload, _model);
      payloadSeen = payload;
      return {} as never;
    });
    const downstream = vi.fn();

    const wrapped = wrapOllamaCompatNumCtx(baseFn as never, 202752);
    void wrapped({} as never, {} as never, { onPayload: downstream } as never);

    expect(baseFn).toHaveBeenCalledTimes(1);
    expect((payloadSeen?.options as Record<string, unknown> | undefined)?.num_ctx).toBe(202752);
    expect(downstream).toHaveBeenCalledTimes(1);
  });
});

describe("resolveOllamaCompatNumCtxEnabled", () => {
  it("defaults to true when config is missing", () => {
    expect(resolveOllamaCompatNumCtxEnabled({ providerId: "ollama" })).toBe(true);
  });

  it("defaults to true when provider config is missing", () => {
    expect(
      resolveOllamaCompatNumCtxEnabled({
        config: { models: { providers: {} } },
        providerId: "ollama",
      }),
    ).toBe(true);
  });

  it("returns false when provider flag is explicitly disabled", () => {
    expect(
      resolveOllamaCompatNumCtxEnabled({
        config: createOllamaProviderConfig(false),
        providerId: "ollama",
      }),
    ).toBe(false);
  });
});

describe("shouldInjectOllamaCompatNumCtx", () => {
  it("requires openai-completions adapter", () => {
    expect(
      shouldInjectOllamaCompatNumCtx({
        model: {
          provider: "ollama",
          api: "openai-responses",
          baseUrl: "http://127.0.0.1:11434/v1",
        },
      }),
    ).toBe(false);
  });

  it("respects provider flag disablement", () => {
    expect(
      shouldInjectOllamaCompatNumCtx({
        model: {
          provider: "ollama",
          api: "openai-completions",
          baseUrl: "http://127.0.0.1:11434/v1",
        },
        config: createOllamaProviderConfig(false),
        providerId: "ollama",
      }),
    ).toBe(false);
  });
});

describe("decodeHtmlEntitiesInObject", () => {
  it("decodes HTML entities in string values", () => {
    const result = decodeHtmlEntitiesInObject(
      "source .env &amp;&amp; psql &quot;$DB&quot; -c &lt;query&gt;",
    );
    expect(result).toBe('source .env && psql "$DB" -c <query>');
  });

  it("recursively decodes nested objects", () => {
    const input = {
      command: "cd ~/dev &amp;&amp; npm run build",
      args: ["--flag=&quot;value&quot;", "&lt;input&gt;"],
      nested: { deep: "a &amp; b" },
    };
    const result = decodeHtmlEntitiesInObject(input) as Record<string, unknown>;
    expect(result.command).toBe("cd ~/dev && npm run build");
    expect((result.args as string[])[0]).toBe('--flag="value"');
    expect((result.args as string[])[1]).toBe("<input>");
    expect((result.nested as Record<string, string>).deep).toBe("a & b");
  });

  it("passes through non-string primitives unchanged", () => {
    expect(decodeHtmlEntitiesInObject(42)).toBe(42);
    expect(decodeHtmlEntitiesInObject(null)).toBe(null);
    expect(decodeHtmlEntitiesInObject(true)).toBe(true);
    expect(decodeHtmlEntitiesInObject(undefined)).toBe(undefined);
  });

  it("returns strings without entities unchanged", () => {
    const input = "plain string with no entities";
    expect(decodeHtmlEntitiesInObject(input)).toBe(input);
  });

  it("decodes numeric character references", () => {
    expect(decodeHtmlEntitiesInObject("&#39;hello&#39;")).toBe("'hello'");
    expect(decodeHtmlEntitiesInObject("&#x27;world&#x27;")).toBe("'world'");
  });
});
describe("prependSystemPromptAddition", () => {
  it("prepends context-engine addition to the system prompt", () => {
    const result = prependSystemPromptAddition({
      systemPrompt: "base system",
      systemPromptAddition: "extra behavior",
    });

    expect(result).toBe("extra behavior\n\nbase system");
  });

  it("returns the original system prompt when no addition is provided", () => {
    const result = prependSystemPromptAddition({
      systemPrompt: "base system",
    });

    expect(result).toBe("base system");
  });
});

describe("buildAfterTurnRuntimeContext", () => {
  it("uses primary model when compaction.model is not set", () => {
    const legacy = buildAfterTurnRuntimeContext({
      attempt: {
        sessionKey: "agent:main:session:abc",
        messageChannel: "slack",
        messageProvider: "slack",
        agentAccountId: "acct-1",
        authProfileId: "openai:p1",
        config: {} as OpenClawConfig,
        skillsSnapshot: undefined,
        senderIsOwner: true,
        provider: "openai-codex",
        modelId: "gpt-5.3-codex",
        thinkLevel: "off",
        reasoningLevel: "on",
        extraSystemPrompt: "extra",
        ownerNumbers: ["+15555550123"],
      },
      workspaceDir: "/tmp/workspace",
      agentDir: "/tmp/agent",
    });

    expect(legacy).toMatchObject({
      provider: "openai-codex",
      model: "gpt-5.3-codex",
    });
  });

  it("passes primary model through even when compaction.model is set (override resolved in compactDirect)", () => {
    const legacy = buildAfterTurnRuntimeContext({
      attempt: {
        sessionKey: "agent:main:session:abc",
        messageChannel: "slack",
        messageProvider: "slack",
        agentAccountId: "acct-1",
        authProfileId: "openai:p1",
        config: {
          agents: {
            defaults: {
              compaction: {
                model: "openrouter/anthropic/claude-sonnet-4-5",
              },
            },
          },
        } as OpenClawConfig,
        skillsSnapshot: undefined,
        senderIsOwner: true,
        provider: "openai-codex",
        modelId: "gpt-5.3-codex",
        thinkLevel: "off",
        reasoningLevel: "on",
        extraSystemPrompt: "extra",
        ownerNumbers: ["+15555550123"],
      },
      workspaceDir: "/tmp/workspace",
      agentDir: "/tmp/agent",
    });

    // buildAfterTurnLegacyCompactionParams no longer resolves the override;
    // compactEmbeddedPiSessionDirect does it centrally for both auto + manual paths.
    expect(legacy).toMatchObject({
      provider: "openai-codex",
      model: "gpt-5.3-codex",
    });
  });
  it("includes resolved auth profile fields for context-engine afterTurn compaction", () => {
    const legacy = buildAfterTurnRuntimeContext({
      attempt: {
        sessionKey: "agent:main:session:abc",
        messageChannel: "slack",
        messageProvider: "slack",
        agentAccountId: "acct-1",
        authProfileId: "openai:p1",
        config: { plugins: { slots: { contextEngine: "lossless-claw" } } } as OpenClawConfig,
        skillsSnapshot: undefined,
        senderIsOwner: true,
        provider: "openai-codex",
        modelId: "gpt-5.3-codex",
        thinkLevel: "off",
        reasoningLevel: "on",
        extraSystemPrompt: "extra",
        ownerNumbers: ["+15555550123"],
      },
      workspaceDir: "/tmp/workspace",
      agentDir: "/tmp/agent",
    });

    expect(legacy).toMatchObject({
      authProfileId: "openai:p1",
      provider: "openai-codex",
      model: "gpt-5.3-codex",
      workspaceDir: "/tmp/workspace",
      agentDir: "/tmp/agent",
    });
  });
});
