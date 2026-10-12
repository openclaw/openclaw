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
import { resolveAgentHarnessBeforePromptBuildResult } from "./prompt-compaction-hook-helpers.js";

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
            resolveAgentHarnessBeforePromptBuildResult({
              prompt: "hello",
              developerInstructions: "base",
              messages: [],
              ctx: { config, sessionKey, agentId: "main", runId: "harness-injection-run" },
            });
          const first = await build();
          expect(first.prompt.match(/queued workflow context/g)).toHaveLength(1);
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
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_prompt_build",
          handler,
        },
      ]),
    );
    const result = await resolveAgentHarnessBeforePromptBuildResult({
      prompt: "Current message: hello",
      currentInboundContext: {
        text: "Prior conversation: remember my preference",
        promptJoiner: "\n",
      },
      currentUserMessage: "hello",
      currentUserMessageId: "message-1",
      messages: async () => history,
      developerInstructions: "base",
      ctx: {},
      toolAuthority: {
        fingerprint: "synthetic",
        activeToolNames: () => ["memory_search"],
        assertActive: () => undefined,
      },
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
      initializeGlobalHookRunner(
        createMockPluginRegistry([
          { hookName: "before_prompt_build", handler },
          { hookName: "before_prompt_build", requiresToolAuthority: true, handler },
        ]),
      );
      await resolveAgentHarnessBeforePromptBuildResult({
        prompt: "Projected transport prompt",
        currentUserMessage: { content, idempotencyKey: "original:user" },
        developerInstructions: "base",
        messages: [],
        ctx: {},
        toolAuthority: {
          fingerprint: "synthetic",
          activeToolNames: () => ["memory_search"],
          assertActive: () => undefined,
        },
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
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_prompt_build",
          requiresToolAuthority: true,
          handler: (event) => {
            expect(event).not.toHaveProperty("currentUserMessage");
            expect(event).not.toHaveProperty("currentUserMessageId");
            const snapshot = (event as { messages: typeof messages }).messages;
            expect(snapshot[0]!["__openclaw"]).toEqual({ mirrorIdentity: "synthetic" });
            expect(snapshot[0]!.content[0]!.arguments.nested.value).toBe("original");
            retained.push(snapshot);
            snapshot[0]!.content[0]!.arguments.nested.value = "immediate mutation";
            return { prependContext: "contribution" };
          },
        },
      ]),
    );
    const build = () =>
      resolveAgentHarnessBeforePromptBuildResult({
        prompt: "hello",
        developerInstructions: "base",
        messages,
        ctx: {},
        toolAuthority: {
          fingerprint: "synthetic-authority",
          activeToolNames: () => ["read"],
          assertActive: () => undefined,
        },
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
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "agent_turn_prepare",
          handler: (event) => mutate(event, "original", "prepare"),
        },
        {
          hookName: "before_prompt_build",
          priority: 10,
          handler: (event) => mutate(event, "original", "first"),
        },
        {
          hookName: "before_prompt_build",
          priority: 0,
          handler: (event) => mutate(event, "first", "second"),
        },
        {
          hookName: "before_prompt_build",
          requiresToolAuthority: true,
          handler: (event) => mutate(event, "original", "authorized"),
        },
      ]),
    );
    const result = await resolveAgentHarnessBeforePromptBuildResult({
      prompt: "hello",
      developerInstructions: "base",
      messages,
      ctx: {},
      toolAuthority: {
        fingerprint: "synthetic",
        activeToolNames: () => [],
        assertActive: () => undefined,
      },
    });
    expect(calls).toEqual(["prepare", "first", "second", "authorized"]);
    expect(result.prompt).toBe("prepare\n\nfirst\n\nsecond\n\nauthorized\n\nhello");
    expect(messages[0]!.content[0]!.text).toBe("original");
  });
  it("classifies restrictive globs before building system instructions", async () => {
    const toolsAllow = ["read*"];
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_prompt_build",
          handler: () => ({
            appendSystemContext: "after replacement",
            prependSystemContext: "before replacement",
            systemPrompt: "hook replacement",
            toolsAllow,
          }),
        },
      ]),
    );
    const build = vi.fn(() => "policy-filtered base");

    const result = await resolveAgentHarnessBeforePromptBuildResult({
      prompt: "answer directly",
      developerInstructions: { build },
      messages: [],
      ctx: {},
    });

    expect(build).toHaveBeenCalledWith({ toolsAllow, hasToolRestrictions: true });
    expect(result).toMatchObject({
      toolsAllow,
      developerInstructions:
        "---\n\nOpenClaw plugin-injected system context. This block is not workspace file content.\n\nbefore replacement\n\n---\n\nhook replacement\n\n---\n\nOpenClaw plugin-injected system context. This block is not workspace file content.\n\nafter replacement\n\n---",
    });
    expect(result.developerInstructions).not.toContain("policy-filtered base");
  });

  it("runs heartbeat_prompt_contribution on a heartbeat turn and prepends its contribution", async () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "heartbeat_prompt_contribution",
          handler: () => ({ prependContext: "Run the base-heartbeat skill." }),
        },
      ]),
    );

    const result = await resolveAgentHarnessBeforePromptBuildResult({
      prompt: "Read HEARTBEAT.md.",
      developerInstructions: "base instructions",
      messages: async () => {
        throw new Error("History is unavailable");
      },
      ctx: { trigger: "heartbeat", agentId: "agent-1", sessionKey: "session-1" },
    });

    expect(result.prompt).toBe("Run the base-heartbeat skill.\n\nRead HEARTBEAT.md.");
    // The heartbeat contribution affects only the prompt, not developer instructions.
    expect(result.developerInstructions).toBe("base instructions");
  });

  it("runs heartbeat contributions before other prompt-build hooks", async () => {
    const calls: string[] = [];
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "heartbeat_prompt_contribution",
          handler: () => {
            calls.push("heartbeat");
            return { prependContext: "heartbeat context" };
          },
        },
        {
          hookName: "before_prompt_build",
          handler: () => {
            calls.push("before_prompt_build");
            return { prependContext: "prompt context" };
          },
        },
      ]),
    );

    const result = await resolveAgentHarnessBeforePromptBuildResult({
      prompt: "hello",
      developerInstructions: "base instructions",
      messages: [],
      ctx: { trigger: "heartbeat", agentId: "agent-1", sessionKey: "session-1" },
    });

    expect(calls).toEqual(["heartbeat", "before_prompt_build"]);
    expect(result.prompt).toBe("heartbeat context\n\nprompt context\n\nhello");
  });

  it("preserves authenticated channel identity in prompt-build hook context", async () => {
    const handler = vi.fn(() => undefined);
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_prompt_build", handler }]),
    );

    await resolveAgentHarnessBeforePromptBuildResult({
      prompt: "hello",
      developerInstructions: "base instructions",
      messages: [],
      ctx: {
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
      },
    });

    expect(handler).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        accountId: "account-a",
        channel: "telegram",
        channelId: "chat-a",
        senderId: "sender-a",
        chatId: "chat-a",
        channelContext: {
          sender: { id: "sender-a" },
          chat: { id: "chat-a" },
        },
      }),
    );
  });

  it("runs authorized enrichment after restrictive hooks finalize the tool surface", async () => {
    const calls: string[] = [];
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_prompt_build",
          handler: () => {
            calls.push("restrict");
            return { prependContext: "regular context", toolsAllow: ["message"] };
          },
        },
        {
          hookName: "before_prompt_build",
          requiresToolAuthority: true,
          handler: (_event, ctx) => {
            calls.push("enrich");
            expect((ctx as PluginHookAgentContext).toolAuthority?.allows("memory_search")).toBe(
              false,
            );
            return { prependContext: "authorized context" };
          },
        },
      ]),
    );
    let activeToolNames: string[] = [];

    const result = await resolveAgentHarnessBeforePromptBuildResult({
      prompt: "hello",
      developerInstructions: {
        build: ({ toolsAllow }) => {
          calls.push("build");
          activeToolNames = toolsAllow ?? [];
          return "base instructions";
        },
      },
      messages: [],
      ctx: {},
      toolAuthority: {
        fingerprint: "turn-authority",
        activeToolNames: () => activeToolNames,
        assertActive: () => undefined,
      },
    });

    expect(calls).toEqual(["restrict", "build", "enrich"]);
    expect(result.prompt).toBe("regular context\n\nauthorized context\n\nhello");
  });

  it("skips heartbeat_prompt_contribution off a heartbeat turn", async () => {
    const handler = vi.fn(() => ({ prependContext: "should not appear" }));
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "heartbeat_prompt_contribution", handler }]),
    );

    const result = await resolveAgentHarnessBeforePromptBuildResult({
      prompt: "hello",
      developerInstructions: "base instructions",
      messages: [],
      ctx: { trigger: "user", agentId: "agent-1", sessionKey: "session-1" },
    });

    expect(handler).not.toHaveBeenCalled();
    expect(result.prompt).toBe("hello");
  });
});
