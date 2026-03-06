import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import type { PluginHookBeforePromptBuildResult } from "../../../plugins/types.js";
import {
  applyPromptBuildHookResult,
  buildEmbeddedHookContext,
  composeSystemPromptWithHookContext,
  isOllamaCompatProvider,
  resolveAttemptFsWorkspaceOnly,
  resolveOllamaBaseUrlForRun,
  resolveOllamaCompatNumCtxEnabled,
  resolvePromptBuildHookResult,
  resolvePromptModeForSession,
  shouldInjectOllamaCompatNumCtx,
  decodeHtmlEntitiesInObject,
  wrapOllamaCompatNumCtx,
  wrapStreamFnTrimToolCallNames,
} from "./attempt.js";

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
      actions: [{ kind: "prependContext", text: "from-cache" }],
      prependContext: "from-cache",
      systemPrompt: "legacy-system",
      prependSystemContext: undefined,
      appendSystemContext: undefined,
    });
  });

  it("calls legacy hook when precomputed result is absent", async () => {
    const hookRunner = createLegacyOnlyHookRunner();
    const messages: AgentMessage[] = [{ role: "user", content: "ctx" } as AgentMessage];

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

  it("preserves legacy prependContext from one hook when another returns explicit actions", async () => {
    const promptBuildResult = {
      actions: [{ kind: "prependContext", text: "action ctx" }],
    } satisfies PluginHookBeforePromptBuildResult;
    const result = await resolvePromptBuildHookResult({
      prompt: "hello",
      messages: [],
      hookCtx: {},
      hookRunner: {
        hasHooks: vi.fn(() => true),
        runBeforePromptBuild: vi.fn(async () => promptBuildResult),
        runBeforeAgentStart: vi.fn(async () => ({
          prependContext: "legacy ctx",
        })),
      },
    });

    expect(result.actions).toEqual([
      { kind: "prependContext", text: "action ctx" },
      { kind: "prependContext", text: "legacy ctx" },
    ]);
    expect(
      applyPromptBuildHookResult({
        prompt: "user prompt",
        systemPromptText: "BASE",
        hookResult: result,
      }).effectivePrompt,
    ).toBe("action ctx\n\nlegacy ctx\n\nuser prompt");
  });

  it("ignores malformed runtime actions payloads before merging", async () => {
    // Simulate a JS plugin returning runtime-invalid data that bypasses TypeScript.
    const malformedPromptBuildResult = {
      actions: { kind: "prependContext", text: "bad shape" },
      prependContext: "fallback ctx",
    } as unknown as PluginHookBeforePromptBuildResult;
    const result = await resolvePromptBuildHookResult({
      prompt: "hello",
      messages: [],
      hookCtx: {},
      hookRunner: {
        hasHooks: vi.fn(() => true),
        runBeforePromptBuild: vi.fn(async () => malformedPromptBuildResult),
        runBeforeAgentStart: vi.fn(async () => undefined),
      },
    });

    expect(result.actions).toEqual([{ kind: "prependContext", text: "fallback ctx" }]);
    expect(result.prependContext).toBe("fallback ctx");
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

describe("buildEmbeddedHookContext", () => {
  it("preserves trigger and resolves channelId from messageChannel", () => {
    expect(
      buildEmbeddedHookContext({
        agentId: "agent-1",
        sessionKey: "session-1",
        sessionId: "session-id-1",
        workspaceDir: "/tmp/workspace",
        messageProvider: "slack-provider",
        messageChannel: "slack",
        trigger: "cron",
      }),
    ).toEqual({
      agentId: "agent-1",
      sessionKey: "session-1",
      sessionId: "session-id-1",
      workspaceDir: "/tmp/workspace",
      messageProvider: "slack-provider",
      trigger: "cron",
      channelId: "slack",
    });
  });

  it("falls back channelId to messageProvider when messageChannel is absent", () => {
    expect(
      buildEmbeddedHookContext({
        messageProvider: "telegram",
      }),
    ).toEqual({
      agentId: undefined,
      sessionKey: undefined,
      sessionId: undefined,
      workspaceDir: undefined,
      messageProvider: "telegram",
      trigger: undefined,
      channelId: "telegram",
    });
  });
});

describe("resolvePromptModeForSession", () => {
  it("uses minimal mode for subagent sessions", () => {
    expect(resolvePromptModeForSession("agent:main:subagent:child")).toBe("minimal");
  });

  it("uses full mode for cron sessions", () => {
    expect(resolvePromptModeForSession("agent:main:cron:job-1")).toBe("full");
    expect(resolvePromptModeForSession("agent:main:cron:job-1:run:run-abc")).toBe("full");
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

describe("wrapStreamFnTrimToolCallNames", () => {
  function createFakeStream(params: { events: unknown[]; resultMessage: unknown }): {
    result: () => Promise<unknown>;
    [Symbol.asyncIterator]: () => AsyncIterator<unknown>;
  } {
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

  async function invokeWrappedStream(
    baseFn: (...args: never[]) => unknown,
    allowedToolNames?: Set<string>,
  ) {
    const wrappedFn = wrapStreamFnTrimToolCallNames(baseFn as never, allowedToolNames);
    return await wrappedFn({} as never, {} as never, {} as never);
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
      options?.onPayload?.(payload);
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

describe("applyPromptBuildHookResult", () => {
  it("prepends multiple contexts in-order and appends system prompt", () => {
    const result = applyPromptBuildHookResult({
      prompt: "user prompt",
      systemPromptText: "BASE",
      hookResult: {
        actions: [
          { kind: "prependContext", text: "ctx A" },
          { kind: "prependContext", text: "ctx B" },
          { kind: "appendSystemPrompt", text: "sys X" },
          { kind: "appendSystemPrompt", text: "sys Y" },
        ],
      },
    });

    expect(result.effectivePrompt).toBe("ctx A\n\nctx B\n\nuser prompt");
    expect(result.systemPromptText).toBe("BASE\n\nsys X\n\nsys Y");
    expect(result.prependContextChars).toBe("ctx A\n\nctx B".length);
    expect(result.appendedSystemPromptChars).toBe("sys X\n\nsys Y".length);
  });

  it("combines explicit actions with legacy system prompt fields without double-applying prompt text", () => {
    const result = applyPromptBuildHookResult({
      prompt: "user prompt",
      systemPromptText: "BASE",
      hookResult: {
        prependContext: "legacy ctx",
        systemPrompt: "legacy sys",
        prependSystemContext: "prepend ctx",
        appendSystemContext: "append ctx",
        actions: [
          { kind: "prependContext", text: "action ctx" },
          { kind: "appendSystemPrompt", text: "sys tail" },
        ],
      },
    });

    expect(result.effectivePrompt).toBe("action ctx\n\nuser prompt");
    expect(result.prependContextChars).toBe("action ctx".length);
    expect(result.systemPromptText).toBe("prepend ctx\n\nlegacy sys\n\nsys tail\n\nappend ctx");
    expect(result.systemPromptOverrideChars).toBe("legacy sys".length);
    expect(result.prependSystemContextChars).toBe("prepend ctx".length);
    expect(result.appendSystemContextChars).toBe("append ctx".length);
    expect(result.appendedSystemPromptChars).toBe("sys tail".length);
  });

  it("caps prependContext and appendSystemPrompt budgets", () => {
    const base = "BASE";
    const longCtx = "x".repeat(9_000);
    const longSys = "y".repeat(5_000);
    const prompt = "user prompt";

    const result = applyPromptBuildHookResult({
      prompt,
      systemPromptText: base,
      hookResult: {
        actions: [
          { kind: "prependContext", text: longCtx },
          { kind: "appendSystemPrompt", text: longSys },
        ],
      },
    });

    const contextPart = result.effectivePrompt.slice(0, -`\n\n${prompt}`.length);
    expect(contextPart.length).toBeLessThanOrEqual(8_000);

    const appendedPart = result.systemPromptText.slice(`${base}\n\n`.length);
    expect(appendedPart.length).toBeLessThanOrEqual(4_000);
  });
});
