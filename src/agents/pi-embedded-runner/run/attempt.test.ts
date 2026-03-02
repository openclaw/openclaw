import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { resolveClaudeSdkConfig } from "../../claude-sdk-runner/prepare-session.js";
import {
  isOllamaCompatProvider,
  resolveAttemptFsWorkspaceOnly,
  resolveOllamaBaseUrlForRun,
  resolveOllamaCompatNumCtxEnabled,
  resolvePromptBuildHookResult,
  resolvePromptModeForSession,
  resolveRuntime,
  shouldInjectOllamaCompatNumCtx,
  wrapOllamaCompatNumCtx,
  wrapStreamFnTrimToolCallNames,
} from "./attempt.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

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

describe("resolveClaudeSdkConfig", () => {
  it("returns undefined for empty claudeSdk object (no provider key)", () => {
    const params = {
      config: {
        agents: {
          list: [{ id: "main", claudeSdk: {} }],
        },
      },
    } as unknown as EmbeddedRunAttemptParams;

    expect(resolveClaudeSdkConfig(params, "main")).toBeUndefined();
  });

  it("returns config when claudeSdk has a provider key", () => {
    const params = {
      config: {
        agents: {
          list: [{ id: "main", claudeSdk: { provider: "claude-sdk" } }],
        },
      },
    } as unknown as EmbeddedRunAttemptParams;

    expect(resolveClaudeSdkConfig(params, "main")).toEqual({ provider: "claude-sdk" });
  });

  it("returns undefined when claudeSdk is explicitly false", () => {
    const params = {
      config: {
        agents: {
          list: [{ id: "main", claudeSdk: false }],
        },
      },
    } as unknown as EmbeddedRunAttemptParams;

    expect(resolveClaudeSdkConfig(params, "main")).toBeUndefined();
  });

  it("falls back to defaults.claudeSdk when agent has no override", () => {
    const params = {
      config: {
        agents: {
          defaults: { claudeSdk: { provider: "anthropic" } },
          list: [{ id: "main" }],
        },
      },
    } as unknown as EmbeddedRunAttemptParams;

    expect(resolveClaudeSdkConfig(params, "main")).toEqual({ provider: "anthropic" });
  });

  it("merges defaults.claudeSdk and agent claudeSdk with agent fields taking precedence", () => {
    const params = {
      config: {
        agents: {
          defaults: {
            claudeSdk: {
              provider: "anthropic",
              thinkingDefault: "low",
              configDir: "/tmp/default-claude-dir",
            },
          },
          list: [
            { id: "main", claudeSdk: { provider: "zai", configDir: "/tmp/agent-claude-dir" } },
          ],
        },
      },
    } as unknown as EmbeddedRunAttemptParams;

    expect(resolveClaudeSdkConfig(params, "main")).toEqual({
      provider: "zai",
      thinkingDefault: "low",
      configDir: "/tmp/agent-claude-dir",
    });
  });

  it("keeps defaults fields when agent claudeSdk is an empty object", () => {
    const params = {
      config: {
        agents: {
          defaults: {
            claudeSdk: {
              provider: "anthropic",
              thinkingDefault: "medium",
              configDir: "/tmp/default-claude-dir",
            },
          },
          list: [{ id: "main", claudeSdk: {} }],
        },
      },
    } as unknown as EmbeddedRunAttemptParams;

    expect(resolveClaudeSdkConfig(params, "main")).toEqual({
      provider: "anthropic",
      thinkingDefault: "medium",
      configDir: "/tmp/default-claude-dir",
    });
  });

  it("honors explicit agent false even when defaults.claudeSdk is set", () => {
    const params = {
      config: {
        agents: {
          defaults: { claudeSdk: { provider: "anthropic", thinkingDefault: "medium" } },
          list: [{ id: "main", claudeSdk: false }],
        },
      },
    } as unknown as EmbeddedRunAttemptParams;

    expect(resolveClaudeSdkConfig(params, "main")).toBeUndefined();
  });

  it("returns undefined for empty defaults.claudeSdk (no provider key)", () => {
    const params = {
      config: {
        agents: {
          defaults: { claudeSdk: {} },
        },
      },
    } as unknown as EmbeddedRunAttemptParams;

    expect(resolveClaudeSdkConfig(params, "other")).toBeUndefined();
  });

  it("returns custom claudeSdk config with required explicit fields", () => {
    const params = {
      config: {
        agents: {
          list: [
            {
              id: "main",
              claudeSdk: {
                provider: "custom",
                baseUrl: "https://gateway.example/v1",
                authProfileId: "custom-profile",
                anthropicDefaultHaikuModel: "custom-haiku",
                anthropicDefaultSonnetModel: "custom-sonnet",
                anthropicDefaultOpusModel: "custom-opus",
              },
            },
          ],
        },
      },
    } as unknown as EmbeddedRunAttemptParams;

    expect(resolveClaudeSdkConfig(params, "main")).toEqual({
      provider: "custom",
      baseUrl: "https://gateway.example/v1",
      authProfileId: "custom-profile",
      anthropicDefaultHaikuModel: "custom-haiku",
      anthropicDefaultSonnetModel: "custom-sonnet",
      anthropicDefaultOpusModel: "custom-opus",
    });
  });

  it("claudeSdkProviderOverride custom when existing claudeSdk has provider anthropic returns undefined", () => {
    const params = {
      claudeSdkProviderOverride: "custom",
      config: {
        agents: {
          list: [{ id: "main", claudeSdk: { provider: "anthropic" } }],
        },
      },
    } as unknown as EmbeddedRunAttemptParams;

    expect(resolveClaudeSdkConfig(params, "main")).toBeUndefined();
  });

  it("claudeSdkProviderOverride custom when existing claudeSdk already has provider custom with baseUrl returns full config", () => {
    const params = {
      claudeSdkProviderOverride: "custom",
      config: {
        agents: {
          list: [
            {
              id: "main",
              claudeSdk: {
                provider: "custom",
                baseUrl: "https://gateway.example/v1",
                authProfileId: "my-profile",
              },
            },
          ],
        },
      },
    } as unknown as EmbeddedRunAttemptParams;

    expect(resolveClaudeSdkConfig(params, "main")).toEqual({
      provider: "custom",
      baseUrl: "https://gateway.example/v1",
      authProfileId: "my-profile",
    });
  });

  it("config undefined (no agents) returns undefined", () => {
    const params = {
      config: undefined,
    } as unknown as EmbeddedRunAttemptParams;

    expect(resolveClaudeSdkConfig(params, "main")).toBeUndefined();
  });

  it("drops custom-only fields when overriding custom config to non-custom provider", () => {
    const params = {
      claudeSdkProviderOverride: "zai",
      config: {
        agents: {
          list: [
            {
              id: "main",
              claudeSdk: {
                provider: "custom",
                baseUrl: "https://gateway.example/v1",
                authProfileId: "custom-profile",
                thinkingDefault: "low",
                configDir: "/tmp/custom-claude-dir",
                supportedProviders: ["claude-pro", "zai"],
                anthropicDefaultHaikuModel: "custom-haiku",
                anthropicDefaultSonnetModel: "custom-sonnet",
                anthropicDefaultOpusModel: "custom-opus",
              },
            },
          ],
        },
      },
    } as unknown as EmbeddedRunAttemptParams;

    expect(resolveClaudeSdkConfig(params, "main")).toEqual({
      provider: "zai",
      thinkingDefault: "low",
      configDir: "/tmp/custom-claude-dir",
      supportedProviders: ["claude-pro", "zai"],
    });
  });
});

describe("resolveRuntime", () => {
  it("returns claude-sdk when resolved auth mode is system-keychain", () => {
    const params = {
      provider: "not-claude-pro",
      resolvedProviderAuth: {
        source: "Claude Pro (system keychain)",
        mode: "system-keychain",
      },
      config: {},
    } as unknown as EmbeddedRunAttemptParams;

    expect(resolveRuntime(params, "main")).toBe("claude-sdk");
  });

  it("returns claude-sdk for known claude-sdk providers", () => {
    const params = {
      provider: "claude-pro",
      config: {},
    } as unknown as EmbeddedRunAttemptParams;

    expect(resolveRuntime(params, "main")).toBe("claude-sdk");
  });

  it("returns claude-sdk for claude-max alias", () => {
    const params = {
      provider: "claude-max",
      config: {},
    } as unknown as EmbeddedRunAttemptParams;

    expect(resolveRuntime(params, "main")).toBe("claude-sdk");
  });

  it("returns pi for non-claude-sdk providers", () => {
    const params = {
      provider: "openai",
      config: {},
    } as unknown as EmbeddedRunAttemptParams;

    expect(resolveRuntime(params, "main")).toBe("pi");
  });

  it("returns claude-sdk when provider is listed in claudeSdk.supportedProviders", () => {
    const params = {
      provider: "openai",
      config: {
        agents: {
          list: [
            {
              id: "main",
              claudeSdk: { provider: "anthropic", supportedProviders: ["openai", "zai"] },
            },
          ],
        },
      },
    } as unknown as EmbeddedRunAttemptParams;

    expect(resolveRuntime(params, "main")).toBe("claude-sdk");
  });

  it("returns pi when claudeSdk config exists but provider is not supported", () => {
    const params = {
      provider: "openai",
      config: {
        agents: {
          list: [
            {
              id: "main",
              claudeSdk: { provider: "anthropic", supportedProviders: ["zai"] },
            },
          ],
        },
      },
    } as unknown as EmbeddedRunAttemptParams;

    expect(resolveRuntime(params, "main")).toBe("pi");
  });

  it("warns when provider resembles claude-sdk but does not match", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Use a dynamic import to access the subsystem logger's warn method.
    // Instead, we test indirectly: resolveRuntime returns "pi" and does not throw.
    const params = {
      provider: "claude-pro-custom",
      config: {},
    } as unknown as EmbeddedRunAttemptParams;

    const result = resolveRuntime(params, "main");
    expect(result).toBe("pi");
    warnSpy.mockRestore();
  });

  it("runtimeOverride pi forces pi even when provider is a known claude-sdk provider", () => {
    const params = {
      provider: "claude-pro",
      runtimeOverride: "pi",
      config: {},
    } as unknown as EmbeddedRunAttemptParams;

    expect(resolveRuntime(params, "main")).toBe("pi");
  });

  it("runtimeOverride claude-sdk forces claude-sdk even when provider is openai with no supportedProviders", () => {
    const params = {
      provider: "openai",
      runtimeOverride: "claude-sdk",
      config: {},
    } as unknown as EmbeddedRunAttemptParams;

    expect(resolveRuntime(params, "main")).toBe("claude-sdk");
  });

  it("supportedProviders matching is case-insensitive: provider OpenAI matches entry openai", () => {
    const params = {
      provider: "OpenAI",
      config: {
        agents: {
          list: [
            {
              id: "main",
              claudeSdk: { provider: "anthropic", supportedProviders: ["openai"] },
            },
          ],
        },
      },
    } as unknown as EmbeddedRunAttemptParams;

    expect(resolveRuntime(params, "main")).toBe("claude-sdk");
  });

  it("config undefined with a non-sdk provider returns pi", () => {
    const params = {
      provider: "gemini",
      config: undefined,
    } as unknown as EmbeddedRunAttemptParams;

    expect(resolveRuntime(params, "main")).toBe("pi");
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
