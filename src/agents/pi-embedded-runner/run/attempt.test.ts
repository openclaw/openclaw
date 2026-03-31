import { describe, expect, it, vi } from "vitest";
import { resolveHeartbeatPrompt } from "../../../auto-reply/heartbeat.js";
import type { OpenClawConfig } from "../../../config/config.js";
import {
  isOllamaCompatProvider,
  resolveOllamaCompatNumCtxEnabled,
  shouldInjectOllamaCompatNumCtx,
  wrapOllamaCompatNumCtx,
} from "../../../plugin-sdk/ollama.js";
import { appendBootstrapPromptWarning } from "../../bootstrap-budget.js";
import { buildAgentSystemPrompt } from "../../system-prompt.js";
import { buildEmbeddedSystemPrompt } from "../system-prompt.js";
import {
  buildAfterTurnRuntimeContext,
  buildSessionsYieldContextMessage,
  composeSystemPromptWithHookContext,
  persistSessionsYieldContextMessage,
  prependSystemPromptAddition,
  queueSessionsYieldInterruptMessage,
  resolveAttemptFsWorkspaceOnly,
  resolvePromptBuildHookResult,
  resolvePromptModeForSession,
  stripSessionsYieldArtifacts,
  shouldInjectHeartbeatPrompt,
  decodeHtmlEntitiesInObject,
  wrapStreamFnRepairMalformedToolCallArguments,
  wrapStreamFnSanitizeMalformedToolCalls,
  wrapStreamFnTrimToolCallNames,
  resolveEmbeddedAgentStreamFn,
} from "./attempt.js";
import { shouldInjectHeartbeatPromptForTrigger } from "./trigger-policy.js";

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

describe("sessions_yield helpers", () => {
  it("builds a hidden follow-up context note", () => {
    expect(buildSessionsYieldContextMessage("Waiting for subagent")).toContain(
      "Waiting for subagent",
    );
    expect(buildSessionsYieldContextMessage("Waiting for subagent")).toContain(
      "ended intentionally via sessions_yield",
    );
  });

  it("queues a hidden interrupt steering message", () => {
    const steer = vi.fn();
    queueSessionsYieldInterruptMessage({ agent: { steer } });
    expect(steer).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "custom",
        customType: "openclaw.sessions_yield_interrupt",
        display: false,
        details: { source: "sessions_yield" },
      }),
    );
  });

  it("persists a hidden yield context message without triggering a turn", async () => {
    const sendCustomMessage = vi.fn(async () => {});
    await persistSessionsYieldContextMessage(
      {
        sendCustomMessage,
      },
      "Waiting for subagent",
    );
    expect(sendCustomMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "openclaw.sessions_yield",
        display: false,
        details: { source: "sessions_yield", message: "Waiting for subagent" },
        content: expect.stringContaining("Waiting for subagent"),
      }),
      { triggerTurn: false },
    );
  });

  it("strips trailing yield interrupt artifacts from memory and transcript state", () => {
    const replaceMessages = vi.fn();
    const rewriteFile = vi.fn();
    const activeSession = {
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "custom", customType: "openclaw.sessions_yield_interrupt" },
        { role: "assistant", stopReason: "aborted" },
      ],
      agent: { replaceMessages },
      sessionManager: {
        fileEntries: [
          { type: "session", id: "session-root" },
          {
            type: "custom_message",
            id: "interrupt",
            parentId: "session-root",
            customType: "openclaw.sessions_yield_interrupt",
          },
          {
            type: "message",
            id: "aborted",
            parentId: "interrupt",
            message: { role: "assistant", stopReason: "aborted" },
          },
        ],
        byId: new Map([
          ["interrupt", { id: "interrupt" }],
          ["aborted", { id: "aborted" }],
        ]),
        leafId: "aborted",
        _rewriteFile: rewriteFile,
      },
    };

    stripSessionsYieldArtifacts(activeSession as never);

    expect(replaceMessages).toHaveBeenCalledWith([
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);
    expect(activeSession.sessionManager.fileEntries).toEqual([
      { type: "session", id: "session-root" },
    ]);
    expect(activeSession.sessionManager.byId.has("interrupt")).toBe(false);
    expect(activeSession.sessionManager.byId.has("aborted")).toBe(false);
    expect(activeSession.sessionManager.leafId).toBe("session-root");
    expect(rewriteFile).toHaveBeenCalledTimes(1);
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

  it("keeps hook-composed system prompt stable when bootstrap warnings only change the user prompt", () => {
    const baseSystemPrompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      contextFiles: [{ path: "AGENTS.md", content: "Follow AGENTS guidance." }],
      toolNames: ["read"],
    });
    const composedSystemPrompt = composeSystemPromptWithHookContext({
      baseSystemPrompt,
      appendSystemContext: "hook system context",
    });
    const turns = [
      {
        systemPrompt: composedSystemPrompt,
        prompt: appendBootstrapPromptWarning("hello", ["AGENTS.md: 200 raw -> 0 injected"]),
      },
      {
        systemPrompt: composedSystemPrompt,
        prompt: appendBootstrapPromptWarning("hello again", []),
      },
      {
        systemPrompt: composedSystemPrompt,
        prompt: appendBootstrapPromptWarning("hello once more", [
          "AGENTS.md: 200 raw -> 0 injected",
        ]),
      },
    ];

    expect(turns[0]?.systemPrompt).toBe(turns[1]?.systemPrompt);
    expect(turns[1]?.systemPrompt).toBe(turns[2]?.systemPrompt);
    expect(turns[0]?.prompt.startsWith("hello")).toBe(true);
    expect(turns[1]?.prompt).toBe("hello again");
    expect(turns[2]?.prompt.startsWith("hello once more")).toBe(true);
    expect(turns[0]?.prompt).toContain("[Bootstrap truncation warning]");
    expect(turns[2]?.prompt).toContain("[Bootstrap truncation warning]");
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

describe("shouldInjectHeartbeatPrompt", () => {
  it("uses trigger policy defaults for non-cron triggers", () => {
    expect(shouldInjectHeartbeatPromptForTrigger("user")).toBe(true);
    expect(shouldInjectHeartbeatPromptForTrigger("heartbeat")).toBe(true);
    expect(shouldInjectHeartbeatPromptForTrigger("memory")).toBe(true);
    expect(shouldInjectHeartbeatPromptForTrigger(undefined)).toBe(true);
  });

  it("uses trigger policy overrides for cron", () => {
    expect(shouldInjectHeartbeatPromptForTrigger("cron")).toBe(false);
  });

  it("injects the heartbeat prompt for default-agent non-cron runs", () => {
    expect(shouldInjectHeartbeatPrompt({ isDefaultAgent: true, trigger: "user" })).toBe(true);
    expect(shouldInjectHeartbeatPrompt({ isDefaultAgent: true, trigger: "heartbeat" })).toBe(true);
    expect(shouldInjectHeartbeatPrompt({ isDefaultAgent: true, trigger: "memory" })).toBe(true);
    expect(shouldInjectHeartbeatPrompt({ isDefaultAgent: true, trigger: undefined })).toBe(true);
  });

  it("suppresses the heartbeat prompt for cron-triggered runs", () => {
    expect(shouldInjectHeartbeatPrompt({ isDefaultAgent: true, trigger: "cron" })).toBe(false);
  });

  it("suppresses the heartbeat prompt for non-default agents", () => {
    expect(shouldInjectHeartbeatPrompt({ isDefaultAgent: false, trigger: "user" })).toBe(false);
  });

  it("omits heartbeat prompt content for cron-triggered full-mode runs on non-cron session keys", () => {
    const sessionKey = "agent:main:kos:thread:abc";
    expect(resolvePromptModeForSession(sessionKey)).toBe("full");

    const heartbeatPrompt = shouldInjectHeartbeatPrompt({
      isDefaultAgent: true,
      trigger: "cron",
    })
      ? resolveHeartbeatPrompt(undefined)
      : undefined;

    const prompt = buildEmbeddedSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      defaultThinkLevel: "off",
      reasoningLevel: "off",
      reasoningTagHint: false,
      heartbeatPrompt,
      promptMode: resolvePromptModeForSession(sessionKey),
      runtimeInfo: {
        host: "host",
        os: "Darwin",
        arch: "arm64",
        node: "v22.0.0",
        model: "openai/gpt-5.4",
      },
      tools: [],
      modelAliasLines: [],
      userTimezone: "UTC",
      userTime: "00:00",
      userTimeFormat: "24",
    });

    expect(prompt).not.toContain("## Heartbeats");
    expect(prompt).not.toContain("HEARTBEAT_OK");
    expect(prompt).not.toContain("Read HEARTBEAT.md");
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

describe("wrapStreamFnSanitizeMalformedToolCalls", () => {
  it("drops malformed assistant tool calls from outbound context before provider replay", async () => {
    const messages = [
      {
        role: "assistant",
        stopReason: "error",
        content: [{ type: "toolCall", name: "read", arguments: {} }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "retry" }],
      },
    ];
    const baseFn = vi.fn((_model, _context) =>
      createFakeStream({ events: [], resultMessage: { role: "assistant", content: [] } }),
    );

    const wrapped = wrapStreamFnSanitizeMalformedToolCalls(baseFn as never, new Set(["read"]));
    const stream = wrapped({} as never, { messages } as never, {} as never) as
      | FakeWrappedStream
      | Promise<FakeWrappedStream>;
    await Promise.resolve(stream);

    expect(baseFn).toHaveBeenCalledTimes(1);
    const seenContext = baseFn.mock.calls[0]?.[1] as { messages: unknown[] };
    expect(seenContext.messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "retry" }],
      },
    ]);
    expect(seenContext.messages).not.toBe(messages);
  });

  it("preserves outbound context when all assistant tool calls are valid", async () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
      },
    ];
    const baseFn = vi.fn((_model, _context) =>
      createFakeStream({ events: [], resultMessage: { role: "assistant", content: [] } }),
    );

    const wrapped = wrapStreamFnSanitizeMalformedToolCalls(baseFn as never, new Set(["read"]));
    const stream = wrapped({} as never, { messages } as never, {} as never) as
      | FakeWrappedStream
      | Promise<FakeWrappedStream>;
    await Promise.resolve(stream);

    expect(baseFn).toHaveBeenCalledTimes(1);
    const seenContext = baseFn.mock.calls[0]?.[1] as { messages: unknown[] };
    expect(seenContext.messages).toBe(messages);
  });

  it("preserves sessions_spawn attachment payloads on replay", async () => {
    const attachmentContent = "INLINE_ATTACHMENT_PAYLOAD";
    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "toolUse",
            id: "call_1",
            name: "  SESSIONS_SPAWN  ",
            input: {
              task: "inspect attachment",
              attachments: [{ name: "snapshot.txt", content: attachmentContent }],
            },
          },
        ],
      },
    ];
    const baseFn = vi.fn((_model, _context) =>
      createFakeStream({ events: [], resultMessage: { role: "assistant", content: [] } }),
    );

    const wrapped = wrapStreamFnSanitizeMalformedToolCalls(
      baseFn as never,
      new Set(["sessions_spawn"]),
    );
    const stream = wrapped({} as never, { messages } as never, {} as never) as
      | FakeWrappedStream
      | Promise<FakeWrappedStream>;
    await Promise.resolve(stream);

    expect(baseFn).toHaveBeenCalledTimes(1);
    const seenContext = baseFn.mock.calls[0]?.[1] as {
      messages: Array<{ content?: Array<Record<string, unknown>> }>;
    };
    const toolCall = seenContext.messages[0]?.content?.[0] as {
      name?: string;
      input?: { attachments?: Array<{ content?: string }> };
    };
    expect(toolCall.name).toBe("sessions_spawn");
    expect(toolCall.input?.attachments?.[0]?.content).toBe(attachmentContent);
  });

  it("preserves allowlisted tool names that contain punctuation", async () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "toolUse", id: "call_1", name: "admin.export", input: { scope: "all" } }],
      },
    ];
    const baseFn = vi.fn((_model, _context) =>
      createFakeStream({ events: [], resultMessage: { role: "assistant", content: [] } }),
    );

    const wrapped = wrapStreamFnSanitizeMalformedToolCalls(
      baseFn as never,
      new Set(["admin.export"]),
    );
    const stream = wrapped({} as never, { messages } as never, {} as never) as
      | FakeWrappedStream
      | Promise<FakeWrappedStream>;
    await Promise.resolve(stream);

    expect(baseFn).toHaveBeenCalledTimes(1);
    const seenContext = baseFn.mock.calls[0]?.[1] as { messages: unknown[] };
    expect(seenContext.messages).toBe(messages);
  });

  it("normalizes provider-prefixed replayed tool names before provider replay", async () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "toolUse", id: "call_1", name: "functions.read", input: { path: "." } }],
      },
    ];
    const baseFn = vi.fn((_model, _context) =>
      createFakeStream({ events: [], resultMessage: { role: "assistant", content: [] } }),
    );

    const wrapped = wrapStreamFnSanitizeMalformedToolCalls(baseFn as never, new Set(["read"]));
    const stream = wrapped({} as never, { messages } as never, {} as never) as
      | FakeWrappedStream
      | Promise<FakeWrappedStream>;
    await Promise.resolve(stream);

    expect(baseFn).toHaveBeenCalledTimes(1);
    const seenContext = baseFn.mock.calls[0]?.[1] as {
      messages: Array<{ content?: Array<{ name?: string }> }>;
    };
    expect(seenContext.messages[0]?.content?.[0]?.name).toBe("read");
  });

  it("canonicalizes mixed-case allowlisted tool names on replay", async () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "readfile", arguments: {} }],
      },
    ];
    const baseFn = vi.fn((_model, _context) =>
      createFakeStream({ events: [], resultMessage: { role: "assistant", content: [] } }),
    );

    const wrapped = wrapStreamFnSanitizeMalformedToolCalls(baseFn as never, new Set(["ReadFile"]));
    const stream = wrapped({} as never, { messages } as never, {} as never) as
      | FakeWrappedStream
      | Promise<FakeWrappedStream>;
    await Promise.resolve(stream);

    expect(baseFn).toHaveBeenCalledTimes(1);
    const seenContext = baseFn.mock.calls[0]?.[1] as {
      messages: Array<{ content?: Array<{ name?: string }> }>;
    };
    expect(seenContext.messages[0]?.content?.[0]?.name).toBe("ReadFile");
  });

  it("recovers blank replayed tool names from their ids", async () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "functionswrite4", name: "   ", arguments: {} }],
      },
    ];
    const baseFn = vi.fn((_model, _context) =>
      createFakeStream({ events: [], resultMessage: { role: "assistant", content: [] } }),
    );

    const wrapped = wrapStreamFnSanitizeMalformedToolCalls(baseFn as never, new Set(["write"]));
    const stream = wrapped({} as never, { messages } as never, {} as never) as
      | FakeWrappedStream
      | Promise<FakeWrappedStream>;
    await Promise.resolve(stream);

    expect(baseFn).toHaveBeenCalledTimes(1);
    const seenContext = baseFn.mock.calls[0]?.[1] as {
      messages: Array<{ content?: Array<{ name?: string }> }>;
    };
    expect(seenContext.messages[0]?.content?.[0]?.name).toBe("write");
  });

  it("recovers mangled replayed tool names before dropping the call", async () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "functionsread3", arguments: {} }],
      },
    ];
    const baseFn = vi.fn((_model, _context) =>
      createFakeStream({ events: [], resultMessage: { role: "assistant", content: [] } }),
    );

    const wrapped = wrapStreamFnSanitizeMalformedToolCalls(baseFn as never, new Set(["read"]));
    const stream = wrapped({} as never, { messages } as never, {} as never) as
      | FakeWrappedStream
      | Promise<FakeWrappedStream>;
    await Promise.resolve(stream);

    expect(baseFn).toHaveBeenCalledTimes(1);
    const seenContext = baseFn.mock.calls[0]?.[1] as {
      messages: Array<{ content?: Array<{ name?: string }> }>;
    };
    expect(seenContext.messages[0]?.content?.[0]?.name).toBe("read");
  });

  it("drops orphaned tool results after replay sanitization removes a tool-call turn", async () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "toolCall", name: "read", arguments: {} }],
        stopReason: "error",
      },
      {
        role: "toolResult",
        toolCallId: "call_missing",
        toolName: "read",
        content: [{ type: "text", text: "stale result" }],
        isError: false,
      },
      {
        role: "user",
        content: [{ type: "text", text: "retry" }],
      },
    ];
    const baseFn = vi.fn((_model, _context) =>
      createFakeStream({ events: [], resultMessage: { role: "assistant", content: [] } }),
    );

    const wrapped = wrapStreamFnSanitizeMalformedToolCalls(baseFn as never, new Set(["read"]));
    const stream = wrapped({} as never, { messages } as never, {} as never) as
      | FakeWrappedStream
      | Promise<FakeWrappedStream>;
    await Promise.resolve(stream);

    expect(baseFn).toHaveBeenCalledTimes(1);
    const seenContext = baseFn.mock.calls[0]?.[1] as {
      messages: Array<{ role?: string }>;
    };
    expect(seenContext.messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "retry" }],
      },
    ]);
  });

  it("drops replayed tool calls that are no longer allowlisted", async () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "write", arguments: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "write",
        content: [{ type: "text", text: "stale result" }],
        isError: false,
      },
      {
        role: "user",
        content: [{ type: "text", text: "retry" }],
      },
    ];
    const baseFn = vi.fn((_model, _context) =>
      createFakeStream({ events: [], resultMessage: { role: "assistant", content: [] } }),
    );

    const wrapped = wrapStreamFnSanitizeMalformedToolCalls(baseFn as never, new Set(["read"]));
    const stream = wrapped({} as never, { messages } as never, {} as never) as
      | FakeWrappedStream
      | Promise<FakeWrappedStream>;
    await Promise.resolve(stream);

    expect(baseFn).toHaveBeenCalledTimes(1);
    const seenContext = baseFn.mock.calls[0]?.[1] as {
      messages: Array<{ role?: string }>;
    };
    expect(seenContext.messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "retry" }],
      },
    ]);
  });
  it("drops replayed tool names that are no longer allowlisted", async () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "toolUse", id: "call_1", name: "unknown_tool", input: { path: "." } }],
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "unknown_tool",
        content: [{ type: "text", text: "stale result" }],
        isError: false,
      },
    ];
    const baseFn = vi.fn((_model, _context) =>
      createFakeStream({ events: [], resultMessage: { role: "assistant", content: [] } }),
    );

    const wrapped = wrapStreamFnSanitizeMalformedToolCalls(baseFn as never, new Set(["read"]));
    const stream = wrapped({} as never, { messages } as never, {} as never) as
      | FakeWrappedStream
      | Promise<FakeWrappedStream>;
    await Promise.resolve(stream);

    expect(baseFn).toHaveBeenCalledTimes(1);
    const seenContext = baseFn.mock.calls[0]?.[1] as { messages: unknown[] };
    expect(seenContext.messages).toEqual([]);
  });

  it("drops ambiguous mangled replay names instead of guessing a tool", async () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "functions.exec2", arguments: {} }],
      },
    ];
    const baseFn = vi.fn((_model, _context) =>
      createFakeStream({ events: [], resultMessage: { role: "assistant", content: [] } }),
    );

    const wrapped = wrapStreamFnSanitizeMalformedToolCalls(
      baseFn as never,
      new Set(["exec", "exec2"]),
    );
    const stream = wrapped({} as never, { messages } as never, {} as never) as
      | FakeWrappedStream
      | Promise<FakeWrappedStream>;
    await Promise.resolve(stream);

    expect(baseFn).toHaveBeenCalledTimes(1);
    const seenContext = baseFn.mock.calls[0]?.[1] as { messages: unknown[] };
    expect(seenContext.messages).toEqual([]);
  });

  it("preserves matching tool results for retained errored assistant turns", async () => {
    const messages = [
      {
        role: "assistant",
        stopReason: "error",
        content: [
          { type: "toolCall", id: "call_1", name: "read", arguments: {} },
          { type: "toolCall", name: "read", arguments: {} },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: [{ type: "text", text: "kept result" }],
        isError: false,
      },
      {
        role: "user",
        content: [{ type: "text", text: "retry" }],
      },
    ];
    const baseFn = vi.fn((_model, _context) =>
      createFakeStream({ events: [], resultMessage: { role: "assistant", content: [] } }),
    );

    const wrapped = wrapStreamFnSanitizeMalformedToolCalls(baseFn as never, new Set(["read"]));
    const stream = wrapped({} as never, { messages } as never, {} as never) as
      | FakeWrappedStream
      | Promise<FakeWrappedStream>;
    await Promise.resolve(stream);

    expect(baseFn).toHaveBeenCalledTimes(1);
    const seenContext = baseFn.mock.calls[0]?.[1] as { messages: unknown[] };
    expect(seenContext.messages).toEqual([
      {
        role: "assistant",
        stopReason: "error",
        content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: [{ type: "text", text: "kept result" }],
        isError: false,
      },
      {
        role: "user",
        content: [{ type: "text", text: "retry" }],
      },
    ]);
  });

  it("revalidates turn ordering after dropping an assistant replay turn", async () => {
    const messages = [
      {
        role: "user",
        content: [{ type: "text", text: "first" }],
      },
      {
        role: "assistant",
        stopReason: "error",
        content: [{ type: "toolCall", name: "read", arguments: {} }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "second" }],
      },
    ];
    const baseFn = vi.fn((_model, _context) =>
      createFakeStream({ events: [], resultMessage: { role: "assistant", content: [] } }),
    );

    const wrapped = wrapStreamFnSanitizeMalformedToolCalls(baseFn as never, new Set(["read"]), {
      validateGeminiTurns: false,
      validateAnthropicTurns: true,
    });
    const stream = wrapped({} as never, { messages } as never, {} as never) as
      | FakeWrappedStream
      | Promise<FakeWrappedStream>;
    await Promise.resolve(stream);

    expect(baseFn).toHaveBeenCalledTimes(1);
    const seenContext = baseFn.mock.calls[0]?.[1] as {
      messages: Array<{ role?: string; content?: unknown[] }>;
    };
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

  it("drops orphaned Anthropic user tool_result blocks after replay sanitization", async () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "partial response" },
          { type: "toolUse", name: "read", input: { path: "." } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "toolResult", toolUseId: "call_1", content: [{ type: "text", text: "stale" }] },
          { type: "text", text: "retry" },
        ],
      },
    ];
    const baseFn = vi.fn((_model, _context) =>
      createFakeStream({ events: [], resultMessage: { role: "assistant", content: [] } }),
    );

    const wrapped = wrapStreamFnSanitizeMalformedToolCalls(baseFn as never, new Set(["read"]), {
      validateGeminiTurns: false,
      validateAnthropicTurns: true,
    });
    const stream = wrapped({} as never, { messages } as never, {} as never) as
      | FakeWrappedStream
      | Promise<FakeWrappedStream>;
    await Promise.resolve(stream);

    expect(baseFn).toHaveBeenCalledTimes(1);
    const seenContext = baseFn.mock.calls[0]?.[1] as {
      messages: Array<{ role?: string; content?: unknown[] }>;
    };
    expect(seenContext.messages).toEqual([
      {
        role: "assistant",
        content: [{ type: "text", text: "partial response" }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "retry" }],
      },
    ]);
  });

  it("drops orphaned Anthropic user tool_result blocks after dropping an assistant replay turn", async () => {
    const messages = [
      {
        role: "user",
        content: [{ type: "text", text: "first" }],
      },
      {
        role: "assistant",
        stopReason: "error",
        content: [{ type: "toolUse", name: "read", input: { path: "." } }],
      },
      {
        role: "user",
        content: [
          { type: "toolResult", toolUseId: "call_1", content: [{ type: "text", text: "stale" }] },
          { type: "text", text: "second" },
        ],
      },
    ];
    const baseFn = vi.fn((_model, _context) =>
      createFakeStream({ events: [], resultMessage: { role: "assistant", content: [] } }),
    );

    const wrapped = wrapStreamFnSanitizeMalformedToolCalls(baseFn as never, new Set(["read"]), {
      validateGeminiTurns: false,
      validateAnthropicTurns: true,
    });
    const stream = wrapped({} as never, { messages } as never, {} as never) as
      | FakeWrappedStream
      | Promise<FakeWrappedStream>;
    await Promise.resolve(stream);

    expect(baseFn).toHaveBeenCalledTimes(1);
    const seenContext = baseFn.mock.calls[0]?.[1] as {
      messages: Array<{ role?: string; content?: unknown[] }>;
    };
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

  it("repairs tool arguments when malformed tool-call preamble appears before JSON", async () => {
    const partialToolCall = { type: "toolCall", name: "write", arguments: {} };
    const streamedToolCall = { type: "toolCall", name: "write", arguments: {} };
    const endMessageToolCall = { type: "toolCall", name: "write", arguments: {} };
    const finalToolCall = { type: "toolCall", name: "write", arguments: {} };
    const partialMessage = { role: "assistant", content: [partialToolCall] };
    const endMessage = { role: "assistant", content: [endMessageToolCall] };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [
          {
            type: "toolcall_delta",
            contentIndex: 0,
            delta: '.functions.write:8  \n{"path":"/tmp/report.txt"}',
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
  it("preserves anthropic-compatible tool arguments when the streamed JSON is already valid", async () => {
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
            delta: '{"path":"/tmp/report.txt"',
            partial: partialMessage,
          },
          {
            type: "toolcall_delta",
            contentIndex: 0,
            delta: "}",
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

  it("does not repair tool arguments when leading text is not tool-call metadata", async () => {
    const partialToolCall = { type: "toolCall", name: "read", arguments: {} };
    const streamedToolCall = { type: "toolCall", name: "read", arguments: {} };
    const partialMessage = { role: "assistant", content: [partialToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [
          {
            type: "toolcall_delta",
            contentIndex: 0,
            delta: 'please use {"path":"/tmp/report.txt"}',
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

  it("clears a cached repair when a later delta adds a single oversized trailing suffix", async () => {
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
            delta: "oops",
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

describe("resolveEmbeddedAgentStreamFn", () => {
  it("keeps the session-managed HTTP stream when no override applies", () => {
    const currentStreamFn = vi.fn();

    const resolved = resolveEmbeddedAgentStreamFn({
      currentStreamFn: currentStreamFn as never,
      shouldUseWebSocketTransport: false,
      sessionId: "session-1",
      model: { provider: "xai" } as never,
    });

    expect(resolved).toBe(currentStreamFn);
  });

  it("keeps the session-managed HTTP stream when websocket auth is unavailable", () => {
    const currentStreamFn = vi.fn();

    const resolved = resolveEmbeddedAgentStreamFn({
      currentStreamFn: currentStreamFn as never,
      shouldUseWebSocketTransport: true,
      wsApiKey: undefined,
      sessionId: "session-1",
      model: { provider: "xai" } as never,
    });

    expect(resolved).toBe(currentStreamFn);
  });

  it("prefers a provider-owned stream override when present", () => {
    const currentStreamFn = vi.fn();
    const providerStreamFn = vi.fn();

    const resolved = resolveEmbeddedAgentStreamFn({
      currentStreamFn: currentStreamFn as never,
      providerStreamFn: providerStreamFn as never,
      shouldUseWebSocketTransport: false,
      sessionId: "session-1",
      model: { provider: "xai" } as never,
    });

    expect(resolved).toBe(providerStreamFn);
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
        modelId: "gpt-5.4",
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
      model: "gpt-5.4",
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
        modelId: "gpt-5.4",
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
      model: "gpt-5.4",
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
        modelId: "gpt-5.4",
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
      model: "gpt-5.4",
      workspaceDir: "/tmp/workspace",
      agentDir: "/tmp/agent",
    });
  });

  it("preserves sender and channel routing context for scoped compaction discovery", () => {
    const legacy = buildAfterTurnRuntimeContext({
      attempt: {
        sessionKey: "agent:main:session:abc",
        messageChannel: "slack",
        messageProvider: "slack",
        agentAccountId: "acct-1",
        currentChannelId: "C123",
        currentThreadTs: "thread-9",
        currentMessageId: "msg-42",
        authProfileId: "openai:p1",
        config: {} as OpenClawConfig,
        skillsSnapshot: undefined,
        senderIsOwner: true,
        senderId: "user-123",
        provider: "openai-codex",
        modelId: "gpt-5.4",
        thinkLevel: "off",
        reasoningLevel: "on",
        extraSystemPrompt: "extra",
        ownerNumbers: ["+15555550123"],
      },
      workspaceDir: "/tmp/workspace",
      agentDir: "/tmp/agent",
    });

    expect(legacy).toMatchObject({
      senderId: "user-123",
      currentChannelId: "C123",
      currentThreadTs: "thread-9",
      currentMessageId: "msg-42",
    });
  });
});
