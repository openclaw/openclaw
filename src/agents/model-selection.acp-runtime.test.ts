import { describe, expect, it } from "vitest";
import type { AgentModelConfig } from "../config/types.agents-shared.js";
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
  it.each<{ name: string; model: AgentModelConfig; fallbacks: string[] }>([
    { name: "string primary", model: HARNESS_MODEL, fallbacks: [nativeFallback] },
    {
      name: "object primary",
      model: { primary: HARNESS_MODEL },
      fallbacks: [nativeFallback],
    },
    {
      name: "native-shaped harness primary",
      model: { primary: "another-provider/harness-model" },
      fallbacks: [nativeFallback],
    },
    {
      name: "explicit native fallbacks",
      model: { primary: HARNESS_MODEL, fallbacks: ["other/backup"] },
      fallbacks: ["other/backup"],
    },
    {
      name: "explicit empty fallbacks",
      model: { primary: HARNESS_MODEL, fallbacks: [] },
      fallbacks: [],
    },
  ])("uses native primary and fallback policy for $name", ({ model, fallbacks }) => {
    const cfg = buildConfig({ model, runtime: { type: "acp" } });
    const primary = resolveDefaultModelForAgent({ cfg, agentId: "worker", manifestPlugins: [] });
    expect(primary).toEqual({ provider: "native", model: "primary" });
    expect(resolveAgentEffectiveModelPrimary(cfg, "worker")).toBe(
      typeof model === "string" ? model : model.primary,
    );
    expect(resolveAgentExplicitModelPrimary(cfg, "worker")).toBe(
      typeof model === "string" ? model : model.primary,
    );
    expect(
      resolveModelCandidateChain({
        cfg,
        agentId: "worker",
        ...primary,
        manifestPlugins: [],
        fallbacksOverride: resolveEffectiveModelFallbacks({
          cfg,
          agentId: "worker",
          hasSessionModelOverride: false,
        }),
      }).map((candidate) => candidate.provider + "/" + candidate.model),
    ).toEqual([nativePrimary, ...fallbacks]);
  });

  it("keeps native agent primaries strict when fallbacks are omitted", () => {
    const cfg = buildConfig({ model: "other/primary" });
    const primary = resolveDefaultModelForAgent({ cfg, agentId: "worker", manifestPlugins: [] });
    expect(primary).toEqual({ provider: "other", model: "primary" });
    expect(resolveAgentEffectiveModelPrimary(cfg, "worker")).toBe("other/primary");
    expect(
      resolveEffectiveModelFallbacks({ cfg, agentId: "worker", hasSessionModelOverride: false }),
    ).toEqual([]);
  });

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

  it.each([HARNESS_MODEL, "openai/gpt-5.4"])(
    "uses the native implicit default for ACP primary %s without a native default",
    (model) => {
      const cfg: OpenClawConfig = {
        plugins: { enabled: false },
        agents: { entries: { worker: { model, runtime: { type: "acp" } } } },
      };
      expect(resolveDefaultModelForAgent({ cfg, agentId: "worker", manifestPlugins: [] })).toEqual({
        provider: DEFAULT_PROVIDER,
        model: DEFAULT_MODEL,
      });
      expect(resolveAgentEffectiveModelPrimary(cfg, "worker")).toBe(model);
    },
  );

  it.each(["acp", "native"] as const)(
    "reports native model advice only for native spawn selection (%s)",
    async (modelRuntime) => {
      const warnings = createWarnLogCapture("acp-model-selection");
      try {
        const cfg = buildConfig({
          model: HARNESS_MODEL,
          ...(modelRuntime === "acp" ? { runtime: { type: "acp" } } : {}),
        });
        expect(
          resolveConfiguredSubagentSpawnModelSelection({ cfg, agentId: "worker", modelRuntime }),
        ).toBe(HARNESS_MODEL);
        const warning = await warnings.findText("specified without provider");
        if (modelRuntime === "acp") {
          expect(warning).toBeUndefined();
        } else {
          expect(warning).toContain("Please use");
        }
      } finally {
        warnings.cleanup();
      }
    },
  );

  it.each(["user", undefined] as const)(
    "keeps persisted %s native model selections strict",
    (modelOverrideSource) => {
      const cfg = buildConfig({ model: HARNESS_MODEL, runtime: { type: "acp" } });
      const fallbacksOverride = resolveEffectiveModelFallbacks({
        cfg,
        agentId: "worker",
        hasSessionModelOverride: true,
        modelOverrideSource,
      });
      expect(
        resolveModelCandidateChain({
          cfg,
          agentId: "worker",
          provider: "pinned",
          model: "selection",
          fallbacksOverride,
          manifestPlugins: [],
        }).map(({ provider, model }) => provider + "/" + model),
      ).toEqual(["pinned/selection"]);
    },
  );
});
