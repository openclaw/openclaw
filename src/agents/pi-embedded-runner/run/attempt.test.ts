import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { resolveOllamaBaseUrlForRun } from "../../ollama-stream.js";
import {
  buildAfterTurnLegacyCompactionParams,
  composeSystemPromptWithHookContext,
  isOllamaCompatProvider,
  prependSystemPromptAddition,
  resolveAttemptFsWorkspaceOnly,
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

describe("buildAfterTurnLegacyCompactionParams", () => {
  it("uses primary model when compaction.model is not set", () => {
    const legacy = buildAfterTurnLegacyCompactionParams({
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
    const legacy = buildAfterTurnLegacyCompactionParams({
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
    const legacy = buildAfterTurnLegacyCompactionParams({
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
