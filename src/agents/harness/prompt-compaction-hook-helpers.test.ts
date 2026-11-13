import { afterEach, describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  loadSessionEntryReadOnly,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
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
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { forgetPromptBuildDrainCacheForRun } from "../plugin-turn-context.js";
import { withAgentPromptProjects } from "../prompt-projects.js";
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

afterEach(async () => {
  resetGlobalHookRunner();
  await clearActivePluginRegistry();
  forgetPromptBuildDrainCacheForRun("harness-injection-run");
});

describe("resolveAgentHarnessBeforePromptBuildResult", () => {
  it("delivers queued injections without prompt hooks and reuses them within the run", async () => {
    await withOpenClawTestState({ label: "harness-injection" }, async (state) => {
      const storePath = state.path("sessions.json");
      const config = { agents: { entries: { main: {} } }, session: { store: storePath } };
      await state.writeConfig(config);
      setRuntimeConfigSnapshot(config);
      const sessionKey = "agent:main:main";
      const registry = createMockPluginRegistry([]);
      registry.plugins.push(createPluginRecord({ id: "injector", status: "loaded" }));
      setActivePluginRegistry(registry);
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
    });
  });

  it.each([
    { content: undefined, expected: "hello" },
    { content: "hello", expected: "hello" },
    {
      content: [
        { type: "text", text: "What do you remember" },
        { type: "image", mimeType: "image/png", data: "synthetic-image" },
        { type: "text", text: "about my preferences?" },
      ],
      expected: "What do you remember\nabout my preferences?",
    },
  ] satisfies { content: PersistedUserTurnMessage["content"] | undefined; expected: string }[])(
    "preserves admitted content and identity through projected prompts: $content",
    async ({ content, expected }) => {
      const handler = vi.fn(async (_event: unknown) => undefined);
      const history = [{ role: "user", content: "Earlier request" }];
      const ctx = {
        trigger: "user",
        accountId: "account-a",
        channel: "telegram",
        channelId: "chat-a",
        senderId: "sender-a",
        chatId: "chat-a",
        channelContext: { sender: { id: "sender-a" }, chat: { id: "chat-a" } },
      } satisfies Parameters<typeof buildBase>[0]["ctx"];
      const expectedContext = structuredClone(ctx);
      installHooks(promptHook(handler), promptHook(handler, { requiresToolAuthority: true }));
      const result = await buildPrompt({
        ctx,
        prompt: "Current message: hello",
        currentInboundContext: {
          text: "Prior conversation: remember my preference",
          promptJoiner: "\n",
        },
        currentUserMessage:
          content === undefined ? "hello" : { content, idempotencyKey: "original:user" },
        currentUserMessageId: content === undefined ? "message-1" : undefined,
        messages: async () => history,
        toolAuthority: toolAuthority(),
      });
      expect(result.prompt).toBe(
        "Prior conversation: remember my preference\nCurrent message: hello",
      );
      expect(result.promptInputRange).toEqual({ start: 0, end: result.prompt.length });
      expect(handler).toHaveBeenCalledTimes(2);
      for (const [event] of handler.mock.calls) {
        expect(event).toMatchObject({
          currentUserMessage: expected,
          currentUserMessageId: content === undefined ? "message-1" : "original:user",
          prompt: expect.stringContaining("Prior conversation:"),
          messages: history,
        });
      }
      expect(handler).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining(expectedContext),
      );
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
  it("re-runs authorized enrichment for each fallback candidate of one turn", async () => {
    // Synthetic stand-in for a recall owner that checks live eligibility per model.
    const eligibleModels = new Set(["primary", "fallback"]);
    const seen: unknown[] = [];
    installHooks(
      promptHook(
        (event, ctx) => {
          const { modelId } = ctx as PluginHookAgentContext;
          seen.push([modelId, (event as { continuity?: unknown }).continuity]);
          return eligibleModels.has(modelId ?? "")
            ? { prependContext: `private recall for ${modelId}` }
            : undefined;
        },
        { requiresToolAuthority: true },
      ),
    );
    const build = (modelId: string, state: "resumed" | "invalidated") =>
      buildPrompt({
        ctx: { sessionKey: "agent:main:main", sessionId: "session-1", modelId },
        toolAuthority: toolAuthority(),
        continuity: { state, history: "none" },
      });
    const prompts = await withAgentPromptProjects(async () => {
      const primary = (await build("primary", "resumed")).prompt;
      const fallback = (await build("fallback", "invalidated")).prompt;
      // Eligibility revoked between attempts: the next candidate gets no enrichment.
      eligibleModels.clear();
      return [primary, fallback, (await build("fallback", "invalidated")).prompt];
    });
    expect(prompts).toEqual([
      "private recall for primary\n\nhello",
      "private recall for fallback\n\nhello",
      "hello",
    ]);
    expect(seen).toEqual([
      ["primary", { state: "resumed", history: "none" }],
      ["fallback", { state: "invalidated", history: "none" }],
      ["fallback", { state: "invalidated", history: "none" }],
    ]);
  });
  it("preserves registration chaining while isolating prepare and authorized dispatches", async () => {
    const messages = [{ role: "user", content: [{ type: "text", text: "original" }] }];
    const calls: string[] = [];
    let activeToolNames: string[] = [];
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
      promptHook(
        (event) => ({
          ...mutate(event, "original", "first"),
          toolsAllow: ["message"],
        }),
        { priority: 10 },
      ),
      promptHook((event) => mutate(event, "first", "second"), { priority: 0 }),
      promptHook(
        (event, ctx) => {
          expect((ctx as PluginHookAgentContext).toolAuthority?.allows("memory_search")).toBe(
            false,
          );
          return mutate(event, "original", "authorized");
        },
        {
          requiresToolAuthority: true,
        },
      ),
    );
    const result = await buildPrompt({
      messages,
      developerInstructions: {
        build: ({ toolsAllow }) => {
          calls.push("build");
          activeToolNames = toolsAllow ?? [];
          return "base instructions";
        },
      },
      toolAuthority: toolAuthority(() => activeToolNames),
    });
    expect(calls).toEqual(["prepare", "first", "second", "build", "authorized"]);
    expect(result.prompt).toBe("prepare\n\nfirst\n\nsecond\n\nauthorized\n\nhello");
    expect(result).not.toHaveProperty("systemPromptReplaced");
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
      systemPromptReplaced: true,
      threadDeveloperInstructions: "hook replacement",
      turnDeveloperInstructions:
        "---\n\nOpenClaw plugin-injected system context. This block is not workspace file content.\n\nbefore replacement\n\n---\n\n---\n\nOpenClaw plugin-injected system context. This block is not workspace file content.\n\nafter replacement\n\n---",
      developerInstructions:
        "---\n\nOpenClaw plugin-injected system context. This block is not workspace file content.\n\nbefore replacement\n\n---\n\nhook replacement\n\n---\n\nOpenClaw plugin-injected system context. This block is not workspace file content.\n\nafter replacement\n\n---",
    });
    expect(result.developerInstructions).not.toContain("policy-filtered base");
  });

  it("marks a failed handler in the assembled prompt without leaking its error text", async () => {
    const secret = "AUTH_TOKEN=sk-live-9f3c https://internal.example/v1/queue";
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_prompt_build",
          pluginId: "leaky-plugin",
          handler: () => {
            throw new Error(`bd ready failed: ${secret}`);
          },
        },
      ]),
    );

    const result = await buildBase({
      prompt: "hello",
      developerInstructions: "base instructions",
      messages: [],
      ctx: { trigger: "user", agentId: "agent-1", sessionKey: "session-1" },
    });

    expect(result.prompt).toContain("hello");
    expect(result.prompt).toContain('<dropped_plugin_context hook="before_prompt_build">');
    expect(result.prompt).toContain("leaky-plugin (handler-failed)");
    expect(result.prompt).not.toContain("sk-live-9f3c");
    expect(result.prompt).not.toContain("internal.example");
    expect(result.prompt).not.toContain("bd ready failed");
  });

  it("marks the drop when the authorized dispatch rejects before any handler runs", async () => {
    const secret = "AUTH_TOKEN=sk-live-9f3c https://internal.example/v1/queue";
    const handler = vi.fn(() => ({ prependContext: "authorized context" }));
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_prompt_build",
          pluginId: "authority-plugin",
          requiresToolAuthority: true,
          handler,
        },
      ]),
    );

    const result = await buildBase({
      prompt: "hello",
      developerInstructions: "base instructions",
      messages: [],
      ctx: {},
      toolAuthority: {
        fingerprint: "turn-authority",
        activeToolNames: () => [],
        // Rejects at the dispatch boundary, so the per-handler drop collector
        // inside runAuthorizedPromptBuild never sees it. With only
        // authority-required registrations the ordinary phase reports nothing
        // either, which is exactly how this contribution used to vanish.
        assertActive: () => {
          throw new Error(`authority boundary closed: ${secret}`);
        },
      },
    });

    expect(handler).not.toHaveBeenCalled();
    expect(result.prompt).toContain("hello");
    expect(result.prompt).toContain('<dropped_plugin_context hook="before_prompt_build">');
    expect(result.prompt).toContain("unknown plugin (dispatch-failed)");
    expect(result.prompt.match(/<dropped_plugin_context/gu)).toHaveLength(1);
    expect(result.prompt).not.toContain("authority boundary closed");
    expect(result.prompt).not.toContain("sk-live-9f3c");
    expect(result.prompt).not.toContain("internal.example");
  });

  it("bounds the marker in the assembled prompt when many handlers fail", async () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry(
        Array.from({ length: 30 }, (_unused, index) => ({
          hookName: "before_prompt_build",
          pluginId: `bulk-plugin-${index}`,
          handler: () => {
            throw new Error(`handler ${index} exploded`);
          },
        })),
      ),
    );

    const result = await buildBase({
      prompt: "hello",
      developerInstructions: "base instructions",
      messages: [],
      ctx: { trigger: "user", agentId: "agent-1", sessionKey: "session-1" },
    });

    const marker = result.prompt.slice(
      result.prompt.indexOf('<dropped_plugin_context hook="before_prompt_build">'),
    );
    expect(marker.match(/\(handler-failed\)/gu)).toHaveLength(5);
    expect(marker).toContain("+25 more");
    expect(new TextEncoder().encode(marker).length).toBeLessThanOrEqual(640);
    expect(result.prompt).not.toContain("exploded");
  });
});
