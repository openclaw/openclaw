import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listActiveProcessSessionReferences } from "../../bash-process-references.js";
import { addSession } from "../../bash-process-registry.js";
import { createProcessSessionFixture } from "../../bash-process-registry.test-helpers.js";
import { resetProcessRegistryForTests } from "../../bash-process-registry.test-support.js";
import { resolveProcessToolScopeKey } from "../../bash-process-scope.js";
import { resolveModelCallUrgency } from "../../run-trigger.js";
import { buildAgentRuntimePlan } from "../../runtime-plan/build.js";
import type { NormalizedUsage } from "../../usage.js";
import * as compactionRuntime from "../compaction-runtime-context.js";
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
  const runtimeParams = <T extends Partial<RuntimeAttempt>>(overrides: T) => ({
    attempt: { ...base, ...overrides },
    workspaceDir: "/tmp/workspace",
    agentDir: "/tmp/agent",
  });

  it.each([true, false])("preserves process scope and model policy (locked=%s)", (locked) => {
    // The two process snapshots must observe the same elapsed runtime.
    using _ = vi.spyOn(Date, "now").mockReturnValue(Date.now());
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
    let attemptEnumerations = 0;
    const params = runtimeParams({
      agentId: "main",
      sessionId: "session-123",
      sessionKey: "session-123",
      sandboxSessionKey: "global",
      sandboxAgentId: "main",
      messageChannel: "slack",
      messageProvider: "slack",
      agentAccountId: "workspace-account",
      currentChannelId: "channel-123",
      currentThreadTs: "123.456",
      currentMessageId: "message-123",
      trigger: "cron",
      inputProvenance: { kind: "external_user" },
      authProfileId: "openai:p1",
      authProfileIdSource: "user",
      modelId: "gpt-5.5",
      agentHarnessId: "openclaw",
      modelSelectionLocked: locked,
      toolsAllow: ["read", "exec"],
      skillsSnapshot: { prompt: "Selected skills", skills: [{ name: "example" }] },
      senderId: "sender-123",
      thinkLevel: "low",
      reasoningLevel: "on",
      bashElevated: { enabled: true, allowed: true, defaultLevel: "ask" },
      extraSystemPrompt: "Synthetic after-turn policy",
      ownerNumbers: ["owner-123"],
      runtimePlan: buildAgentRuntimePlan({
        provider: "openai",
        modelId: "gpt-5.5",
        workspaceDir: "/tmp/workspace",
        providerRuntimeHandle: {
          provider: "openai",
          modelId: "gpt-5.5",
          workspaceDir: "/tmp/workspace",
          prepared: true,
        },
        preparedAuthPlan: {
          providerForAuth: "openai",
          modelId: "gpt-5.5",
          authProfileProviderForAuth: "openai",
          forwardedAuthProfileId: "openai:p1",
          forwardedAuthProfileSource: "user",
        },
      }),
      config: {
        agents: {
          defaults: {
            models: { "openrouter/anthropic/claude-sonnet-4-5": { alias: "summary" } },
            compaction: { model: "summary" },
          },
        },
      },
    });
    const request = { ...params, cwd: "/tmp/workspace/subdir", activeAgentId: "main" };
    const legacyOverrides = {
      modelCallUrgency: resolveModelCallUrgency(params.attempt),
      runtimeAuthPlan: params.attempt.runtimePlan?.auth,
      workspaceDir: request.workspaceDir,
      cwd: request.cwd,
      agentDir: request.agentDir,
      harnessRuntime: params.attempt.agentHarnessId,
      activeProcessSessions: listActiveProcessSessionReferences({
        scopeKey: resolveProcessToolScopeKey({
          sessionKey: params.attempt.sessionKey,
          sessionId: params.attempt.sessionId,
          agentId: request.activeAgentId,
        }),
      }),
    };
    const realBuild = compactionRuntime.buildEmbeddedCompactionRuntimeContext;
    using compactionBuilder = vi
      .spyOn(compactionRuntime, "buildEmbeddedCompactionRuntimeContext")
      .mockImplementation((candidate, profile) => {
        const execute = (input: Parameters<typeof realBuild>[0]) => {
          const reads: { key: PropertyKey; present: boolean; value: unknown }[] = [];
          const output = realBuild(
            new Proxy(input, {
              get(target, key, receiver) {
                const value = Reflect.get(target, key, receiver);
                reads.push({ key, present: Object.hasOwn(target, key), value });
                return value;
              },
            }),
            profile,
          );
          return { reads, output };
        };
        // Execute both through the real builder, including target and auth resolution.
        const projected = execute(candidate);
        const legacy = execute({ ...params.attempt, ...legacyOverrides });
        expect(projected.reads).toEqual(legacy.reads);
        expect(projected.output).toEqual(legacy.output);
        for (const { key, value } of projected.reads) {
          if (Object.hasOwn(params.attempt, key) && !Object.hasOwn(legacyOverrides, key)) {
            expect(value).toBe(Reflect.get(params.attempt, key));
          }
        }
        return projected.output;
      });
    const context = buildAfterTurnRuntimeContext({
      ...request,
      attempt: new Proxy(params.attempt, {
        ownKeys(target) {
          attemptEnumerations++;
          return Reflect.ownKeys(target);
        },
      }),
    });
    expect(compactionBuilder).toHaveBeenCalledOnce();
    expect(attemptEnumerations).toBe(0);
    expect(context.activeProcessSessions).toHaveLength(1);
    expect(context).toMatchObject({
      activeProcessSessions: [{ sessionId: "sess-session-id", command: "sleep 600", pid: 1234 }],
      transcriptStorage: { kind: "sqlite" },
      modelSelectionLocked: locked,
      sandboxSessionKey: "global",
      sandboxAgentId: "main",
      provider: locked ? "openai" : "openrouter",
      model: locked ? "gpt-5.5" : "anthropic/claude-sonnet-4-5",
      modelCallUrgency: "background",
    });
    if (!locked) {
      expect(context.authProfileId).toBeUndefined();
    }
    expect(context.runtimeAuthPlan).toBe(locked ? params.attempt.runtimePlan?.auth : undefined);
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
