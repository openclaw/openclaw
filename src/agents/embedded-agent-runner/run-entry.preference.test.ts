import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveModelFallbackOptions } from "../../auto-reply/reply/agent-runner-run-params.js";
import { buildEmbeddedRunExecutionParams } from "../../auto-reply/reply/agent-runner-utils.js";
import type { FollowupRun } from "../../auto-reply/reply/queue.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { prepareAuthFixture } from "../runtime-plan/prepare-auth.test-support.js";
import { runEmbeddedAgentEntry } from "./run-entry.js";
import { makeResult } from "./run-entry.test-support.js";

// Only the transport/harness installation is synthetic. The logical-turn entry,
// candidate search, route-aware auth preparation and terminal owner are real.
// mock-isolation: Auth-failover candidates use the fixture harness, never discover/install runtime plugins.
vi.mock("../harness/runtime-plugin.js", () => ({
  ensureSelectedAgentHarnessPlugin: vi.fn(async () => undefined),
}));
// mock-isolation: A no-capability harness keeps candidate auth/fallback real without bundled tools or context-engine state.
vi.mock("../harness/selection.js", () => ({
  selectAgentHarness: vi.fn(() => ({ id: "fixture", contextEngineHostCapabilities: [] })),
}));

afterEach(() => resetPluginRuntimeStateForTest());

describe("preferred model through logical-turn entry", () => {
  it.each([
    {
      name: "configured preference",
      policy: "configured" as const,
      locked: false,
      kind: "active",
      fallbacks: ["backup/healthy"],
    },
    {
      name: "unmarked strict selection",
      policy: undefined,
      locked: false,
      kind: "disabled_by_model_override",
      fallbacks: [],
    },
    {
      name: "operator-locked preference",
      policy: "configured" as const,
      locked: true,
      kind: "disabled_by_model_selection_lock",
      fallbacks: [],
    },
  ])("keeps the outer and embedded fallback policy aligned for $name", async (testCase) => {
    const run: FollowupRun["run"] = {
      config: {
        agents: {
          defaults: {
            model: { primary: "backup/default", fallbacks: ["backup/healthy"] },
            thinkingDefault: "max",
          },
        },
        models: {
          providers: {
            preferred: {
              baseUrl: "https://preferred.invalid/v1",
              api: "openai-responses",
              models: [
                {
                  id: "temporary",
                  name: "Temporary",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 32000,
                  maxTokens: 1000,
                },
              ],
            },
          },
        },
      },
      agentId: "main",
      sessionId: "preference-entry",
      sessionKey: "agent:main:fixture",
      provider: "preferred",
      model: "temporary",
      agentDir: "/tmp/preference-entry-agent",
      workspaceDir: "/tmp/preference-entry-workspace",
      sessionFile: "/tmp/preference-entry.jsonl",
      timeoutMs: 1000,
      blockReplyBreak: "message_end",
      thinkLevel: "max",
      skipProviderRuntimeHints: true,
      hasSessionModelOverride: true,
      modelOverrideSource: "user",
      modelFallbackPolicy: testCase.policy,
      modelSelectionLocked: testCase.locked,
    };
    const before = structuredClone(run);
    const outer = resolveModelFallbackOptions(run);
    const embedded = await buildEmbeddedRunExecutionParams({
      run,
      provider: run.provider,
      model: run.model,
      runId: "preference-inner-policy",
      sessionCtx: {},
      hasRepliedRef: undefined,
    });

    expect(outer.modelFallbackAvailability.kind).toBe(testCase.kind);
    expect(outer.fallbacksOverride).toEqual(testCase.fallbacks);
    expect(embedded.modelFallbackAvailability).toEqual(outer.modelFallbackAvailability);
    expect(embedded.modelFallbacksOverride).toEqual(testCase.fallbacks);
    expect(embedded.thinkLevel).toBe("max");
    expect(run).toEqual(before);
  });

  it.each(["selected-profile-missing", "route-auth-missing"] as const)(
    "delivers the fallback reply after %s before the requested transport starts",
    async (failure) => {
      setActivePluginRegistry(createEmptyPluginRegistry());
      const config = {
        agents: {
          defaults: {
            model: {
              primary: "backup/default",
              fallbacks: ["backup/healthy"],
            },
          },
        },
      };
      const run: FollowupRun["run"] = {
        config,
        agentId: "main",
        sessionId: "preference-entry",
        sessionKey: "agent:main:fixture",
        provider: "openai",
        model: "gpt-fixture",
        agentDir: "/tmp/preference-entry-agent",
        workspaceDir: "/tmp/preference-entry-workspace",
        sessionFile: "/tmp/preference-entry.jsonl",
        timeoutMs: 1000,
        blockReplyBreak: "message_end",
        thinkLevel: "max",
        thinkLevelOverride: "max",
        hasSessionModelOverride: true,
        modelOverrideSource: "user",
        modelFallbackPolicy: "configured",
      };
      const before = structuredClone(run);
      const prepared: string[] = [];
      const transport: string[] = [];
      const result = await runEmbeddedAgentEntry({
        selection: { ...resolveModelFallbackOptions(run), manifestPlugins: [] },
        identity: { agentId: run.agentId, sessionId: run.sessionId, runId: `entry-${failure}` },
        harness: {
          workspaceDir: "/tmp/workspace",
          preparation: { kind: "direct" },
          resolveRuntimeOverride: () => undefined,
        },
        behavior: {
          kind: "channel-delivery",
          readDeliveryEvidence: () => ({
            hasRetryBlockedDelivery: false,
            hasDirectlySentBlockReply: false,
            hasBlockReplyPipelineOutput: false,
          }),
        },
        sessionOverride: { kind: "preserve" },
        runCandidate: async (provider, model) => {
          prepared.push(`${provider}/${model}`);
          if (provider === "openai") {
            prepareAuthFixture({
              provider,
              modelId: model,
              env: {},
              config,
              modelApi: "openai-chatgpt-responses",
              modelBaseUrl: "https://chatgpt.com/backend-api/codex",
              authProfileStore: { version: 1, profiles: {} },
              ...(failure === "selected-profile-missing"
                ? {
                    sessionAuthProfileId: "openai:missing",
                    sessionAuthProfileSource: "user" as const,
                  }
                : {}),
            });
          }
          transport.push(`${provider}/${model}`);
          return makeResult({ provider, model });
        },
      });
      expect(result.outcome).toBe("completed");
      expect(result.result.payloads).toEqual([{ text: "recovered" }]);
      expect(result.provider).toBe("backup");
      expect(result.model).toBe("healthy");
      expect(result.attempts).toHaveLength(1);
      expect(result.attempts[0]?.error).toContain(
        failure === "selected-profile-missing"
          ? 'Selected auth profile "openai:missing" is unavailable'
          : "No route-compatible authentication source is configured for openai",
      );
      expect(prepared).toEqual(["openai/gpt-fixture", "backup/healthy"]);
      expect(transport).toEqual(["backup/healthy"]);
      await result.settleSessionOverride();
      expect(run).toEqual(before);
    },
  );
});
