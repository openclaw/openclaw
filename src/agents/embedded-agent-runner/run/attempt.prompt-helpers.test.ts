import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { addSession } from "../../bash-process-registry.js";
import { createProcessSessionFixture } from "../../bash-process-registry.test-helpers.js";
import { resetProcessRegistryForTests } from "../../bash-process-registry.test-support.js";
import type { NormalizedUsage } from "../../usage.js";
import { buildContextEnginePromptCacheInfo } from "./attempt-context-engine-helpers.js";

const hostHookStateMocks = vi.hoisted(() => ({
  drainPluginNextTurnInjectionContext: vi.fn(),
}));

vi.mock("../../../plugins/host-hook-state.js", () => hostHookStateMocks);

import {
  buildAfterTurnRuntimeContext,
  buildAfterTurnRuntimeContextFromUsage,
  forgetPromptBuildDrainCacheForRun,
  mergeOrphanedTrailingUserPrompt,
  resolvePromptBuildHookResult,
} from "./attempt-prompt-helpers.js";
import { resolvePromptSubmissionSkipReason } from "./attempt-prompt-submit.js";

it("keeps structured media and JSON summaries on UTF-16 boundaries", () => {
  const result = mergeOrphanedTrailingUserPrompt({
    prompt: "Continue.",
    leafMessage: {
      content: [
        { type: "image_url", image_url: { url: `${"u".repeat(299)}😀tail` } },
        { type: "custom", value: `${"v".repeat(299)}😀tail` },
        { [`${"k".repeat(997)}😀tail`]: 1 },
      ],
    },
  });
  expect(result.merged).toBe(true);
  expect(result.prompt.isWellFormed()).toBe(true);
  expect(result.prompt).not.toContain("\\ud83d");
  expect(result.prompt).toContain("[image_url]");
  expect(result.prompt).toContain("chars)");
});

describe("resolvePromptSubmissionSkipReason", () => {
  const skip = (messages: unknown[] = [], prompt = "   ", imageCount = 0) =>
    resolvePromptSubmissionSkipReason({ prompt, messages, imageCount });

  it("treats runtime messages and empty conversation placeholders as empty history", () => {
    expect(
      skip([
        { role: "system", content: "runtime-only policy" },
        { role: "toolResult", content: "old tool output", toolCallId: "call-1" },
        { role: "user", content: "   " },
        { role: "assistant", content: [] },
      ]),
    ).toBe("empty_prompt_history_images");
  });

  it("skips a blank current prompt even with visible replay history", () => {
    expect(skip([{ role: "user", content: "previous turn", timestamp: 1 }])).toBe(
      "blank_user_prompt",
    );
  });

  it("admits current text or images without replay history", () => {
    expect(skip([], "hello")).toBeNull();
    expect(skip([], "   ", 1)).toBeNull();
  });
});

describe("resolvePromptBuildHookResult drain cache", () => {
  beforeEach(() => {
    hostHookStateMocks.drainPluginNextTurnInjectionContext.mockReset();
    hostHookStateMocks.drainPluginNextTurnInjectionContext.mockResolvedValue({
      queuedInjections: [],
    });
  });

  function build(runId?: string) {
    return resolvePromptBuildHookResult({
      config: {},
      prompt: "hi",
      messages: [],
      hookCtx: { runId, sessionKey: "global", agentId: "qa" },
    });
  }

  it("preserves an explicit empty per-turn tool allowlist", async () => {
    const runBeforePromptBuild = vi.fn(async () => ({ toolsAllow: [] }));
    const result = await resolvePromptBuildHookResult({
      config: {},
      prompt: "answer without tools",
      messages: [],
      hookCtx: { sessionKey: "agent:main:main" },
      hookRunner: {
        hasHooks: (hookName) => hookName === "before_prompt_build",
        runBeforePromptBuild,
      },
    });
    expect(result.toolsAllow).toEqual([]);
    expect(runBeforePromptBuild).toHaveBeenCalledOnce();
  });

  it("reuses drained injections across retries and releases them when the run ends", async () => {
    hostHookStateMocks.drainPluginNextTurnInjectionContext.mockResolvedValue({
      queuedInjections: [
        {
          id: "inj-1",
          pluginId: "demo",
          text: "first attempt context",
          placement: "prepend_context",
          createdAt: 1,
        },
      ],
      prependContext: "first attempt context",
    });
    const runId = "run-cache-test";
    expect((await build(runId)).prependContext).toBe("first attempt context");
    expect((await build(runId)).prependContext).toBe("first attempt context");
    expect(hostHookStateMocks.drainPluginNextTurnInjectionContext).toHaveBeenCalledTimes(1);
    expect(hostHookStateMocks.drainPluginNextTurnInjectionContext).toHaveBeenCalledWith({
      cfg: {},
      sessionKey: "global",
      agentId: "qa",
    });
    forgetPromptBuildDrainCacheForRun(runId);
    await build(runId);
    expect(hostHookStateMocks.drainPluginNextTurnInjectionContext).toHaveBeenCalledTimes(2);
    forgetPromptBuildDrainCacheForRun(runId);
  });
});

describe("buildAfterTurnRuntimeContext", () => {
  type RuntimeAttempt = Parameters<typeof buildAfterTurnRuntimeContext>[0]["attempt"];
  const runtimeDirectories = { workspaceDir: "/tmp/workspace", agentDir: "/tmp/agent" };
  function runtimeAttempt(overrides: Partial<RuntimeAttempt>): RuntimeAttempt {
    return {
      config: {},
      provider: "openai",
      modelId: "gpt-5.4",
      thinkLevel: "off",
      reasoningLevel: "on",
      extraSystemPrompt: "extra",
      ownerNumbers: ["+15555550123"],
      ...overrides,
    };
  }

  it("preserves session-id-scoped processes with borrowed policy", () => {
    resetProcessRegistryForTests();
    try {
      const active = createProcessSessionFixture({
        id: "sess-session-id",
        command: "sleep 600",
        backgrounded: true,
        pid: 1234,
      });
      active.scopeKey = "session-123";
      addSession(active);
      const other = createProcessSessionFixture({
        id: "sess-other",
        command: "sleep 600",
        backgrounded: true,
      });
      other.scopeKey = "agent:main";
      addSession(other);

      const legacy = buildAfterTurnRuntimeContext({
        attempt: runtimeAttempt({
          sessionId: "session-123",
          sandboxSessionKey: "agent:main",
        }),
        ...runtimeDirectories,
        activeAgentId: "main",
      });

      expect(legacy.activeProcessSessions).toHaveLength(1);
      expect(legacy.activeProcessSessions).toMatchObject([
        { sessionId: "sess-session-id", command: "sleep 600", pid: 1234 },
      ]);
      expect(legacy.transcriptStorage).toEqual({ kind: "sqlite" });
    } finally {
      resetProcessRegistryForTests();
    }
  });

  it("keeps the primary model for a locked after-turn runtime context", () => {
    const runtimeContext = buildAfterTurnRuntimeContext({
      attempt: runtimeAttempt({
        sessionKey: "agent:main:session:locked",
        sandboxSessionKey: "global",
        sandboxAgentId: "main",
        config: {
          agents: { defaults: { compaction: { model: "anthropic/claude-opus-4-6" } } },
        } as OpenClawConfig,
        modelId: "gpt-5.5",
        agentHarnessId: "openclaw",
        modelSelectionLocked: true,
      }),
      ...runtimeDirectories,
    });

    expect(runtimeContext.modelSelectionLocked).toBe(true);
    expect(runtimeContext.sandboxSessionKey).toBe("global");
    expect(runtimeContext.sandboxAgentId).toBe("main");
    expect(runtimeContext.provider).toBe("openai");
    expect(runtimeContext.model).toBe("gpt-5.5");
  });

  it("resolves compaction.model override in runtime context so all context engines use the correct model", () => {
    const legacy = buildAfterTurnRuntimeContext({
      attempt: runtimeAttempt({
        trigger: "heartbeat",
        inputProvenance: { kind: "external_user" },
        sessionKey: "agent:main:session:abc",
        authProfileId: "openai:p1",
        config: {
          agents: {
            defaults: {
              models: {
                "openrouter/anthropic/claude-sonnet-4-5": { alias: "summary" },
              },
              compaction: { model: "summary" },
            },
          },
        } as OpenClawConfig,
      }),
      ...runtimeDirectories,
    });

    expect(legacy.provider).toBe("openrouter");
    expect(legacy.model).toBe("anthropic/claude-sonnet-4-5");
    expect(legacy.authProfileId).toBeUndefined();
    expect(legacy.modelCallUrgency).toBe("background");
  });
  it("derives afterTurn token count from the current assistant usage snapshot", () => {
    const lastCallUsage = {
      input: 10,
      output: 5,
      cacheRead: 40,
      cacheWrite: 2,
      contextUsage: { state: "available", promptTokens: 23, totalTokens: 28 },
      total: 57,
    } satisfies NormalizedUsage;
    const promptCache = buildContextEnginePromptCacheInfo({ lastCallUsage });
    const legacy = buildAfterTurnRuntimeContextFromUsage({
      attempt: runtimeAttempt({
        sessionKey: "agent:main:session:abc",
        authProfileId: "openai:p1",
        config: { plugins: { slots: { contextEngine: "lossless-claw" } } } as OpenClawConfig,
      }),
      ...runtimeDirectories,
      tokenBudget: 1050000,
      lastCallUsage,
      promptCache,
    });

    expect(legacy.currentTokenCount).toBe(23);
    expect(legacy.promptCache?.lastCallUsage?.total).toBe(57);
  });
});
