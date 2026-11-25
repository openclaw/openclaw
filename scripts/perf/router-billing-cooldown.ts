/**
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/router-billing-cooldown.ts
 * Owner-only workload: one upstream rejection, then 2,000 distinct sessions
 * sharing the same inline key. Generic-only classification is the pre-hook
 * control. A/A controls and alternating A/B pairs run in separate timing and
 * sampled-allocation passes. No credentials, provider calls, or real data.
 * This measures admission and the health reducer, not SQLite persistence,
 * whole-Gateway latency, successful inference, or filesystem scaling.
 * Acceptance: zero collateral refusals with the provider hook; unchanged
 * router-auth/budget behavior is covered by the real HTTP integration test.
 */
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import type { AuthProfileStore } from "../../src/agents/auth-profiles/types.js";
import { computeNextProfileUsageStats } from "../../src/agents/auth-profiles/usage-failure-state.js";
import { resolveInlineProviderApiKeyUsageId } from "../../src/agents/auth-profiles/usage-state.js";
import { classifyAssistantFailoverReason } from "../../src/agents/embedded-agent-helpers/assistant-message-failures.js";
import { resolveAuthProfileFailureReason } from "../../src/agents/embedded-agent-runner/run/auth-profile-failure-policy.js";
import { assertInlineProviderApiKeyUsable } from "../../src/agents/model-auth-provider-config.js";
import type { AssistantMessage } from "../../src/llm/types.js";
import { loadBundledPluginFacade } from "../../src/test-utils/bundled-plugin-public-surface.js";
import { registerSingleProviderPlugin } from "../../src/test-utils/plugin-registration.js";
import { sumSampledHeapBytes } from "../lib/heap-sampling.ts";

const entry = await loadBundledPluginFacade<{
  default: Parameters<typeof registerSingleProviderPlugin>[0];
}>({ pluginId: "clawrouter", artifactBasename: "index.ts" });
const plugin = await registerSingleProviderPlugin(entry.default);
assert(plugin.classifyFailoverReason, "Run the workload on the candidate with its provider hook");
const generic = { id: "clawrouter" };
const peers = Array.from({ length: 2_000 }, (_, i) => `agent:synthetic:session-${i}`);
const usageId = resolveInlineProviderApiKeyUsageId("clawrouter");
const failed: AssistantMessage = {
  role: "assistant",
  api: "anthropic-messages",
  provider: "clawrouter",
  model: "anthropic/claude-fixture",
  content: [],
  stopReason: "error",
  errorType: "invalid_request_error",
  errorMessage:
    '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}',
  timestamp: 0,
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
};

function cohort(providerOwner: typeof generic, repetitions: number) {
  let refused = 0;
  let healthUpdates = 0;
  for (let iteration = 0; iteration < repetitions; iteration++) {
    const store: AuthProfileStore = { version: 1, profiles: {} };
    const reason = resolveAuthProfileFailureReason({
      failoverReason: classifyAssistantFailoverReason(failed, { providerOwner }),
      providerStarted: true,
    });
    if (reason) {
      healthUpdates++;
      store.usageStats = {
        [usageId]: computeNextProfileUsageStats({
          existing: {},
          now: Date.now(),
          reason,
          modelId: failed.model,
        }),
      };
    }
    for (const sessionKey of peers) {
      assert(sessionKey.length > 0);
      try {
        assertInlineProviderApiKeyUsable({ store, provider: "clawrouter" });
      } catch {
        refused++;
      }
    }
  }
  return { refused, healthUpdates };
}

const repetitions = 20;
for (const owner of [generic, plugin]) {
  cohort(owner, 2);
}
for (const mode of ["timing", "allocation"] as const) {
  for (const comparison of ["AA", "AB"] as const) {
    for (let sample = 0; sample < 5; sample++) {
      const arms = sample % 2 === 0 ? (["A", "B"] as const) : (["B", "A"] as const);
      for (const arm of arms) {
        const fixed = comparison === "AB" && arm === "B";
        globalThis.gc?.();
        const inspector = mode === "allocation" ? new Session() : undefined;
        inspector?.connect();
        await inspector?.post("HeapProfiler.startSampling", {
          samplingInterval: 32_768,
          includeObjectsCollectedByMajorGC: true,
          includeObjectsCollectedByMinorGC: true,
        });
        const cpuStart = process.cpuUsage();
        const start = performance.now();
        const counts = cohort(fixed ? plugin : generic, repetitions);
        const wallMs = performance.now() - start;
        const cpu = process.cpuUsage(cpuStart);
        const allocation = await inspector?.post("HeapProfiler.stopSampling");
        inspector?.disconnect();
        assert.equal(counts.refused, fixed ? 0 : peers.length * repetitions);
        assert.equal(counts.healthUpdates, fixed ? 0 : repetitions);
        console.log(
          JSON.stringify({
            comparison,
            sample,
            arm,
            mode,
            peers: peers.length,
            repetitions,
            hostLoad: loadavg(),
            ...counts,
            ...(allocation
              ? {
                  sampledBytesPerCohort: sumSampledHeapBytes(allocation.profile.head) / repetitions,
                }
              : {
                  wallMsPerCohort: wallMs / repetitions,
                  cpuMsPerCohort: (cpu.user + cpu.system) / 1_000 / repetitions,
                }),
          }),
        );
      }
    }
  }
}
