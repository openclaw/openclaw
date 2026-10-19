import { describe, expect, it } from "vitest";
import type { AgentEntryConfig } from "../config/types.agents.js";
import type { OpenClawConfig } from "../config/types.js";
import { createWarnLogCapture } from "../logging/test-helpers/warn-log-capture.js";
import {
  resolveAgentEffectiveModelPrimary,
  resolveAgentExplicitModelPrimary,
  resolveEffectiveModelFallbacks,
} from "./agent-scope.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./defaults.js";
import { FailoverError } from "./failover-error.js";
import { resolveModelCandidateChain } from "./model-fallback-candidates.js";
import { runWithModelFallback } from "./model-fallback-runner.js";
import {
  resolveConfiguredSubagentSpawnModelSelection,
  resolveDefaultModelForAgent,
} from "./model-selection.js";

const HARNESS_MODEL = "harness-only[context=272k,reasoning=medium]";
const nativePrimary = "native/primary";
const nativeFallback = "native/backup";

function buildConfig(agent: AgentEntryConfig): OpenClawConfig {
  return {
    plugins: { enabled: false },
    agents: {
      defaults: { model: { primary: nativePrimary, fallbacks: [nativeFallback] } },
      entries: { worker: agent },
    },
  };
}

describe("ACP native model policy", () => {
  it.each([
    {
      name: "strict native primary",
      cfg: buildConfig({ model: "other/primary" }),
      authored: "other/primary",
      primary: { provider: "other", model: "primary" },
      pinned: false,
      fallbacks: [],
      chain: ["other/primary"],
    },
    {
      name: "implicit native default for a native-shaped ACP primary",
      cfg: {
        plugins: { enabled: false },
        agents: { entries: { worker: { model: "openai/gpt-5.4", runtime: { type: "acp" } } } },
      } satisfies OpenClawConfig,
      authored: "openai/gpt-5.4",
      primary: { provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL },
      pinned: false,
      fallbacks: undefined,
      chain: [`${DEFAULT_PROVIDER}/${DEFAULT_MODEL}`],
    },
    {
      name: "persisted native selection without a source marker",
      cfg: buildConfig({ model: HARNESS_MODEL, runtime: { type: "acp" } }),
      authored: HARNESS_MODEL,
      primary: { provider: "native", model: "primary" },
      pinned: true,
      fallbacks: [],
      chain: ["pinned/selection"],
    },
  ])(
    "resolves $name without changing the authored model",
    ({ cfg, authored, primary, pinned, fallbacks, chain }) => {
      expect(resolveDefaultModelForAgent({ cfg, agentId: "worker", manifestPlugins: [] })).toEqual(
        primary,
      );
      expect(resolveAgentEffectiveModelPrimary(cfg, "worker")).toBe(authored);
      expect(resolveAgentExplicitModelPrimary(cfg, "worker")).toBe(authored);
      const fallbacksOverride = resolveEffectiveModelFallbacks({
        cfg,
        agentId: "worker",
        hasSessionModelOverride: pinned,
      });
      expect(fallbacksOverride).toEqual(fallbacks);
      expect(
        resolveModelCandidateChain({
          cfg,
          agentId: "worker",
          manifestPlugins: [],
          fallbacksOverride,
          ...(pinned ? { provider: "pinned", model: "selection" } : primary),
        }).map(({ provider, model }) => `${provider}/${model}`),
      ).toEqual(chain);
    },
  );

  it.each([
    { fallbacks: undefined, expected: nativeFallback },
    { fallbacks: ["other/backup"], expected: "other/backup" },
    { fallbacks: [], expected: undefined },
  ])(
    "executes native failure recovery with fallbacks $fallbacks",
    async ({ fallbacks, expected }) => {
      const cfg = buildConfig({
        model: { primary: HARNESS_MODEL, ...(fallbacks ? { fallbacks } : {}) },
        runtime: { type: "acp" },
      });
      const primary = resolveDefaultModelForAgent({ cfg, agentId: "worker", manifestPlugins: [] });
      const attempts: string[] = [];
      const result = runWithModelFallback({
        cfg,
        agentId: "worker",
        skipAuthProfileRuntime: true,
        ...primary,
        manifestPlugins: [],
        fallbacksOverride: resolveEffectiveModelFallbacks({
          cfg,
          agentId: "worker",
          hasSessionModelOverride: false,
        }),
        run: async (provider, model) => {
          const ref = `${provider}/${model}`;
          attempts.push(ref);
          if (ref === nativePrimary) {
            throw new FailoverError("Native primary unavailable", { reason: "model_not_found" });
          }
          return ref;
        },
      });
      if (expected) {
        await expect(result).resolves.toMatchObject({ result: expected });
        expect(attempts).toEqual([nativePrimary, expected]);
      } else {
        await expect(result).rejects.toThrow("Native primary unavailable");
        expect(attempts).toEqual([nativePrimary]);
      }
    },
  );

  it("reports native model advice for native spawn selection", async () => {
    const warnings = createWarnLogCapture("acp-model-selection");
    try {
      const cfg = buildConfig({ model: HARNESS_MODEL });
      expect(
        resolveConfiguredSubagentSpawnModelSelection({
          cfg,
          agentId: "worker",
          modelRuntime: "native",
        }),
      ).toBe(HARNESS_MODEL);
      expect(await warnings.findText("specified without provider")).toContain("Please use");
    } finally {
      warnings.cleanup();
    }
  });
});
