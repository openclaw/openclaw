import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addSession } from "../../bash-process-registry.js";
import { createProcessSessionFixture } from "../../bash-process-registry.test-helpers.js";
import { resetProcessRegistryForTests } from "../../bash-process-registry.test-support.js";
import type { NormalizedUsage } from "../../usage.js";
import { buildContextEnginePromptCacheInfo } from "./attempt-context-engine-helpers.js";

const hostHookStateMocks = vi.hoisted(() => ({
  drainPluginNextTurnInjectionContext: vi.fn(),
}));

vi.mock("../../../plugins/host-hook-state.js", () => hostHookStateMocks);

import { forgetPromptBuildDrainCacheForRun } from "../../plugin-turn-context.js";
import {
  buildAfterTurnRuntimeContext,
  buildAfterTurnRuntimeContextFromUsage,
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

const runtimeHistory = [
  { role: "system", content: "policy" },
  { role: "toolResult", content: "output", toolCallId: "call-1" },
  { role: "user", content: "   " },
  { role: "assistant", content: [] },
];
it.each([
  [runtimeHistory, "   ", 0, "empty_prompt_history_images"],
  [[{ role: "user", content: "old", timestamp: 1 }], "   ", 0, "blank_user_prompt"],
  [[], "hello", 0, null],
  [[], "   ", 1, null],
] satisfies Array<[unknown[], string, number, string | null]>)(
  "resolves prompt submission %#",
  (messages, prompt, imageCount, expected) => {
    expect(resolvePromptSubmissionSkipReason({ messages, prompt, imageCount })).toBe(expected);
  },
);

describe("resolvePromptBuildHookResult drain cache", () => {
  const drain = hostHookStateMocks.drainPluginNextTurnInjectionContext;
  beforeEach(() => {
    drain.mockReset().mockResolvedValue({ queuedInjections: [] });
  });

  function build(overrides: Partial<Parameters<typeof resolvePromptBuildHookResult>[0]> = {}) {
    return resolvePromptBuildHookResult({
      config: {},
      prompt: "hi",
      messages: [],
      hookCtx: { sessionKey: "global", agentId: "qa" },
      ...overrides,
    });
  }

  it("preserves an explicit empty per-turn tool allowlist", async () => {
    const runBeforePromptBuild = vi.fn(async () => ({ toolsAllow: [] }));
    const result = await build({
      prompt: "answer without tools",
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
    drain.mockResolvedValue({
      queuedInjections: [
        {
          id: "inj-1",
          pluginId: "demo",
          text: "injected",
          placement: "prepend_context",
          createdAt: 1,
        },
      ],
      prependContext: "injected",
    });
    const runId = "run-cache-test";
    const retry = () => build({ hookCtx: { runId, sessionKey: "global", agentId: "qa" } });
    expect((await retry()).prependContext).toBe("injected");
    expect((await retry()).prependContext).toBe("injected");
    expect(drain).toHaveBeenCalledTimes(1);
    expect(drain).toHaveBeenCalledWith({ cfg: {}, sessionKey: "global", agentId: "qa" });
    forgetPromptBuildDrainCacheForRun(runId);
    await retry();
    expect(drain).toHaveBeenCalledTimes(2);
    forgetPromptBuildDrainCacheForRun(runId);
  });
});

describe("buildAfterTurnRuntimeContext", () => {
  afterEach(resetProcessRegistryForTests);
  type RuntimeAttempt = Parameters<typeof buildAfterTurnRuntimeContext>[0]["attempt"];
  const base: RuntimeAttempt = {
    config: {},
    provider: "openai",
    modelId: "gpt-5.4",
    thinkLevel: "off",
  };
  const runtimeParams = (overrides: Partial<RuntimeAttempt> = {}) => ({
    attempt: { ...base, ...overrides },
    workspaceDir: "/tmp/workspace",
    agentDir: "/tmp/agent",
  });
  const runtime = (overrides: Partial<RuntimeAttempt>) =>
    buildAfterTurnRuntimeContext(runtimeParams(overrides));

  it("preserves session-id-scoped processes with borrowed policy", () => {
    resetProcessRegistryForTests();
    for (const [id, scopeKey, pid] of [
      ["sess-session-id", "session-123", 1234],
      ["sess-other", "agent:main", undefined],
    ] as const) {
      addSession({
        ...createProcessSessionFixture({ id, command: "sleep 600", backgrounded: true, pid }),
        scopeKey,
      });
    }
    const legacy = buildAfterTurnRuntimeContext({
      ...runtimeParams({ sessionId: "session-123", sandboxSessionKey: "agent:main" }),
      activeAgentId: "main",
    });
    expect(legacy.activeProcessSessions).toHaveLength(1);
    expect(legacy).toMatchObject({
      activeProcessSessions: [{ sessionId: "sess-session-id", command: "sleep 600", pid: 1234 }],
      transcriptStorage: { kind: "sqlite" },
    });
  });

  it("keeps the primary model for a locked after-turn runtime context", () => {
    const runtimeContext = runtime({
      sessionKey: "agent:main:session:locked",
      sandboxSessionKey: "global",
      sandboxAgentId: "main",
      config: { agents: { defaults: { compaction: { model: "anthropic/claude-opus-4-6" } } } },
      modelId: "gpt-5.5",
      agentHarnessId: "openclaw",
      modelSelectionLocked: true,
    });

    expect(runtimeContext).toMatchObject({
      modelSelectionLocked: true,
      sandboxSessionKey: "global",
      sandboxAgentId: "main",
      provider: "openai",
      model: "gpt-5.5",
    });
  });

  it("resolves compaction.model override in runtime context so all context engines use the correct model", () => {
    const legacy = runtime({
      trigger: "cron",
      inputProvenance: { kind: "external_user" },
      sessionKey: "agent:main:session:abc",
      authProfileId: "openai:p1",
      config: {
        agents: {
          defaults: {
            models: { "openrouter/anthropic/claude-sonnet-4-5": { alias: "summary" } },
            compaction: { model: "summary" },
          },
        },
      },
    });

    expect(legacy).toMatchObject({
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4-5",
      modelCallUrgency: "background",
    });
    expect(legacy.authProfileId).toBeUndefined();
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
      ...runtimeParams({}),
      tokenBudget: 1050000,
      lastCallUsage,
      promptCache,
    });

    expect(legacy).toMatchObject({
      currentTokenCount: 23,
      promptCache: { lastCallUsage: { total: 57 } },
    });
  });
});
