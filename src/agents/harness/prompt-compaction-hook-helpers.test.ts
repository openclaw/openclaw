import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  loadSessionEntryReadOnly,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { withTempConfig } from "../../gateway/test-temp-config.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import type { PluginHookAgentContext } from "../../plugins/hook-types.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-fixtures.js";
import { enqueuePluginNextTurnInjection } from "../../plugins/host-hook-state.js";
import { clearActivePluginRegistry, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createPluginRecord } from "../../plugins/status.test-helpers.js";
import type { PersistedUserTurnMessage } from "../../sessions/user-turn-transcript.types.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { forgetPromptBuildDrainCacheForRun } from "../plugin-turn-context.js";
import { awaitAgentHarnessAgentEndHook } from "./lifecycle-hook-helpers.js";
import { resolveAgentHarnessBeforePromptBuildResult as buildBase } from "./prompt-compaction-hook-helpers.js";

function buildPrompt(overrides: Partial<Parameters<typeof buildBase>[0]> = {}) {
  return buildBase({
    prompt: "hello",
    developerInstructions: "base",
    messages: [],
    ctx: {},
    ...overrides,
  });
}

type Hook = Parameters<typeof createMockPluginRegistry>[0][number];
function promptHook(handler: Hook["handler"], options: Partial<Omit<Hook, "handler">> = {}): Hook {
  return { hookName: "before_prompt_build", handler, ...options };
}
function installHooks(...hooks: Hook[]) {
  initializeGlobalHookRunner(createMockPluginRegistry(hooks));
}

function toolAuthority(activeToolNames = () => ["memory_search"]) {
  return { fingerprint: "synthetic", activeToolNames, assertActive: () => undefined };
}

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-harness-injection-");

afterEach(async () => {
  resetGlobalHookRunner();
  await clearActivePluginRegistry();
  forgetPromptBuildDrainCacheForRun("harness-injection-run");
});

describe("resolveAgentHarnessBeforePromptBuildResult", () => {
  it("delivers queued injections without prompt hooks and reuses them within the run", async () => {
    const stateDir = sessionDirs.make();
    const storePath = path.join(stateDir, "sessions.json");
    const config = { agents: { entries: { main: {} } }, session: { store: storePath } };
    const sessionKey = "agent:main:main";
    const registry = createMockPluginRegistry([]);
    registry.plugins.push(createPluginRecord({ id: "injector", status: "loaded" }));
    setActivePluginRegistry(registry);
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      await withTempConfig({
        cfg: config,
        run: async () => {
          await replaceSessionEntry(
            { sessionKey, storePath },
            { sessionId: "session-1", updatedAt: Date.now() },
          );
          expect(
            await enqueuePluginNextTurnInjection({
              cfg: config,
              pluginId: "injector",
              injection: { sessionKey, text: "queued workflow context" },
            }),
          ).toMatchObject({ enqueued: true });
          const build = () =>
            buildPrompt({
              ctx: { config, sessionKey, agentId: "main", runId: "harness-injection-run" },
            });
          const first = await build();
          expect(first.prompt.match(/queued workflow context/g)).toHaveLength(1);
          // A failed attempt ends before its retry; the retry must still see the drained note.
          await awaitAgentHarnessAgentEndHook({
            event: { runId: "harness-injection-run", messages: [], success: false },
            ctx: { runId: "harness-injection-run", sessionKey, agentId: "main" },
          });
          expect((await build()).prompt).toBe(first.prompt);
          expect(
            loadSessionEntryReadOnly({ sessionKey, storePath })?.pluginNextTurnInjections,
          ).toBeUndefined();
        },
      });
    });
  });

  it("preserves the admitted request through projected prompts", async () => {
    const handler = vi.fn(async (_event: unknown) => undefined);
    const history = [{ role: "user", content: "Earlier request" }];
    installHooks(promptHook(handler));
    const result = await buildPrompt({
      prompt: "Current message: hello",
      currentInboundContext: {
        text: "Prior conversation: remember my preference",
        promptJoiner: "\n",
      },
      currentUserMessage: "hello",
      currentUserMessageId: "message-1",
      messages: async () => history,
      toolAuthority: toolAuthority(),
    });
    expect(result.prompt).toBe(
      "Prior conversation: remember my preference\nCurrent message: hello",
    );
    expect(result.promptInputRange).toEqual({ start: 0, end: result.prompt.length });
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0]?.[0]).toMatchObject({
      currentUserMessage: "hello",
      currentUserMessageId: "message-1",
      prompt: expect.stringContaining("Prior conversation:"),
      messages: history,
    });
  });

  it.each([
    { content: "hello", expected: "hello" },
    {
      content: [
        { type: "text", text: "What do you remember" },
        { type: "image", mimeType: "image/png", data: "synthetic-image" },
        { type: "text", text: "about my preferences?" },
      ],
      expected: "What do you remember\nabout my preferences?",
    },
  ] satisfies { content: PersistedUserTurnMessage["content"]; expected: string }[])(
    "normalizes admitted message content for prompt hooks: $expected",
    async ({ content, expected }) => {
      const handler = vi.fn(async (_event: unknown) => undefined);
      installHooks(promptHook(handler), promptHook(handler, { requiresToolAuthority: true }));
      await buildPrompt({
        prompt: "Projected transport prompt",
        currentUserMessage: { content, idempotencyKey: "original:user" },
        toolAuthority: toolAuthority(),
      });
      expect(handler).toHaveBeenCalledTimes(2);
      for (const [event] of handler.mock.calls) {
        expect(event).toMatchObject({
          currentUserMessage: expected,
          currentUserMessageId: "original:user",
        });
      }
    },
  );

  it("isolates nested prompt history across authorized rebuilds", async () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "toolCall", arguments: { nested: { value: "original" } } }],
        __openclaw: { upstreamUserText: "x".repeat(1024 * 1024), mirrorIdentity: "synthetic" },
      },
    ];
    const retained: (typeof messages)[] = [];
    installHooks(
      promptHook(
        (event) => {
          expect(event).not.toHaveProperty("currentUserMessage");
          expect(event).not.toHaveProperty("currentUserMessageId");
          const snapshot = (event as { messages: typeof messages }).messages;
          expect(snapshot[0]!["__openclaw"]).toEqual({ mirrorIdentity: "synthetic" });
          expect(snapshot[0]!.content[0]!.arguments.nested.value).toBe("original");
          retained.push(snapshot);
          snapshot[0]!.content[0]!.arguments.nested.value = "immediate mutation";
          return { prependContext: "contribution" };
        },
        { requiresToolAuthority: true },
      ),
    );
    const build = () =>
      buildPrompt({
        messages,
        toolAuthority: toolAuthority(() => ["read"]),
      });
    expect((await build()).prompt).toBe("contribution\n\nhello");
    expect(messages[0]!.content[0]!.arguments.nested.value).toBe("original");
    retained[0]![0]!.content[0]!.arguments.nested.value = "retained mutation";
    expect((await build()).prompt).toBe("contribution\n\nhello");
    expect(retained[0]).not.toBe(retained[1]);
    expect(messages[0]!.content[0]!.arguments.nested.value).toBe("original");
  });
  it("preserves registration chaining while isolating prepare and authorized dispatches", async () => {
    const messages = [{ role: "user", content: [{ type: "text", text: "original" }] }];
    const calls: string[] = [];
    const mutate = (event: unknown, expected: string, next: string) => {
      const snapshot = (event as { messages: typeof messages }).messages;
      expect(snapshot[0]!.content[0]!.text).toBe(expected);
      snapshot[0]!.content[0]!.text = next;
      calls.push(next);
      return { prependContext: next };
    };
    installHooks(
      promptHook((event) => mutate(event, "original", "prepare"), {
        hookName: "agent_turn_prepare",
      }),
      promptHook((event) => mutate(event, "original", "first"), { priority: 10 }),
      promptHook((event) => mutate(event, "first", "second"), { priority: 0 }),
      promptHook((event) => mutate(event, "original", "authorized"), {
        requiresToolAuthority: true,
      }),
    );
    const result = await buildPrompt({
      messages,
      toolAuthority: toolAuthority(() => []),
    });
    expect(calls).toEqual(["prepare", "first", "second", "authorized"]);
    expect(result.prompt).toBe("prepare\n\nfirst\n\nsecond\n\nauthorized\n\nhello");
    expect(messages[0]!.content[0]!.text).toBe("original");
  });
  it("classifies restrictive globs before building system instructions", async () => {
    const toolsAllow = ["read*"];
    installHooks(
      promptHook(() => ({
        appendSystemContext: "after replacement",
        prependSystemContext: "before replacement",
        systemPrompt: "hook replacement",
        toolsAllow,
      })),
    );
    const build = vi.fn(() => "policy-filtered base");

    const result = await buildPrompt({
      prompt: "answer directly",
      developerInstructions: { build },
    });

    expect(build).toHaveBeenCalledWith({ toolsAllow, hasToolRestrictions: true });
    expect(result).toMatchObject({
      toolsAllow,
      threadDeveloperInstructions: "hook replacement",
      turnDeveloperInstructions:
        "---\n\nOpenClaw plugin-injected system context. This block is not workspace file content.\n\nbefore replacement\n\n---\n\n---\n\nOpenClaw plugin-injected system context. This block is not workspace file content.\n\nafter replacement\n\n---",
      developerInstructions:
        "---\n\nOpenClaw plugin-injected system context. This block is not workspace file content.\n\nbefore replacement\n\n---\n\nhook replacement\n\n---\n\nOpenClaw plugin-injected system context. This block is not workspace file content.\n\nafter replacement\n\n---",
    });
    expect(result.developerInstructions).not.toContain("policy-filtered base");
  });

  it.each([
    ["only", "read", "beat", "beat\n\nread"],
    ["ordered", "hello", "beat", "beat\n\nprompt\n\nhello"],
    ["user", "hello", "should not appear", "hello"],
  ] as const)(
    "dispatches heartbeat contributions for %s turns",
    async (mode, prompt, contribution, expected) => {
      const calls: string[] = [];
      const handler = vi.fn(() => {
        calls.push("heartbeat");
        return { prependContext: contribution };
      });
      const hooks = [promptHook(handler, { hookName: "heartbeat_prompt_contribution" })];
      if (mode === "ordered") {
        hooks.push(
          promptHook(() => {
            calls.push("before_prompt_build");
            return { prependContext: "prompt" };
          }),
        );
      }
      installHooks(...hooks);
      const result = await buildPrompt({
        prompt,
        messages: mode === "only" ? () => Promise.reject(new Error("History unavailable")) : [],
        ctx: { trigger: mode === "user" ? "user" : "heartbeat" },
      });
      expect(handler).toHaveBeenCalledTimes(mode === "user" ? 0 : 1);
      const orderedCalls = ["heartbeat", ...(mode === "ordered" ? ["before_prompt_build"] : [])];
      expect(calls).toEqual(mode === "user" ? [] : orderedCalls);
      expect(result).toMatchObject({ prompt: expected, developerInstructions: "base" });
    },
  );

  it("preserves authenticated channel identity in prompt-build hook context", async () => {
    const ctx = {
      trigger: "user",
      accountId: "account-a",
      channel: "telegram",
      channelId: "chat-a",
      senderId: "sender-a",
      chatId: "chat-a",
      channelContext: {
        sender: { id: "sender-a" },
        chat: { id: "chat-a" },
      },
    } satisfies Parameters<typeof buildBase>[0]["ctx"];
    const expected = structuredClone(ctx);
    const handler = vi.fn(() => undefined);
    installHooks(promptHook(handler));

    await buildPrompt({ ctx });

    expect(handler).toHaveBeenCalledWith(expect.anything(), expect.objectContaining(expected));
  });

  it("runs authorized enrichment after restrictive hooks finalize the tool surface", async () => {
    const calls: string[] = [];
    installHooks(
      promptHook(() => {
        calls.push("restrict");
        return { prependContext: "regular context", toolsAllow: ["message"] };
      }),
      promptHook(
        (_event, ctx) => {
          calls.push("enrich");
          expect((ctx as PluginHookAgentContext).toolAuthority?.allows("memory_search")).toBe(
            false,
          );
          return { prependContext: "authorized context" };
        },
        { requiresToolAuthority: true },
      ),
    );
    let activeToolNames: string[] = [];

    const result = await buildPrompt({
      developerInstructions: {
        build: ({ toolsAllow }) => {
          calls.push("build");
          activeToolNames = toolsAllow ?? [];
          return "base instructions";
        },
      },
      toolAuthority: toolAuthority(() => activeToolNames),
    });

    expect(calls).toEqual(["restrict", "build", "enrich"]);
    expect(result.prompt).toBe("regular context\n\nauthorized context\n\nhello");
  });
});
