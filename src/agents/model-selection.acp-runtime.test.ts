import { expect, it } from "vitest";
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
const nativeRef = { provider: "native", model: "primary" };
const defaultRef = { provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL };
const nativeDefaults = { model: { primary: nativePrimary, fallbacks: [nativeFallback] } };
type PolicyCase = [string, typeof nativeRef, string[] | undefined, ("implicit" | "pinned")?];

function selection(agent: AgentEntryConfig, defaults = true) {
  const cfg: OpenClawConfig = {
    plugins: { enabled: false },
    agents: { ...(defaults ? { defaults: nativeDefaults } : {}), entries: { worker: agent } },
  };
  return { cfg, agentId: "worker", manifestPlugins: [] };
}

it.each<PolicyCase>([
  ["other/primary", { provider: "other", model: "primary" }, []],
  ["openai/gpt-5.4", defaultRef, undefined, "implicit"],
  [HARNESS_MODEL, nativeRef, [], "pinned"],
])("resolves %s without changing the authored model", (authored, primary, fallbacks, mode) => {
  const params = selection(
    { model: authored, ...(mode ? { runtime: { type: "acp" } } : {}) },
    mode !== "implicit",
  );
  const selected = mode === "pinned" ? { provider: "pinned", model: "selection" } : primary;
  const fallbacksOverride = resolveEffectiveModelFallbacks({
    ...params,
    hasSessionModelOverride: mode === "pinned",
  });
  expect([
    resolveDefaultModelForAgent(params),
    resolveAgentEffectiveModelPrimary(params.cfg, "worker"),
    resolveAgentExplicitModelPrimary(params.cfg, "worker"),
    fallbacksOverride,
    resolveModelCandidateChain({
      ...params,
      ...selected,
      fallbacksOverride,
    }).map(({ provider, model }) => `${provider}/${model}`),
  ]).toEqual([primary, authored, authored, fallbacks, [`${selected.provider}/${selected.model}`]]);
});

it.each([
  { fallbacks: undefined, expected: nativeFallback },
  { fallbacks: ["other/backup"], expected: "other/backup" },
  { fallbacks: [], expected: undefined },
])(
  "executes native failure recovery with fallbacks $fallbacks",
  async ({ fallbacks, expected }) => {
    const params = selection({
      model: { primary: HARNESS_MODEL, ...(fallbacks ? { fallbacks } : {}) },
      runtime: { type: "acp" },
    });
    const attempts: string[] = [];
    const result = runWithModelFallback({
      ...params,
      ...resolveDefaultModelForAgent(params),
      skipAuthProfileRuntime: true,
      fallbacksOverride: resolveEffectiveModelFallbacks({
        ...params,
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
    } else {
      await expect(result).rejects.toThrow("Native primary unavailable");
    }
    expect(attempts).toEqual(expected ? [nativePrimary, expected] : [nativePrimary]);
  },
);

it("reports native model advice for native spawn selection", async () => {
  const warnings = createWarnLogCapture("acp-model-selection");
  try {
    const params = selection({ model: HARNESS_MODEL });
    expect(
      resolveConfiguredSubagentSpawnModelSelection({ ...params, modelRuntime: "native" }),
    ).toBe(HARNESS_MODEL);
    expect(await warnings.findText("specified without provider")).toContain("Please use");
  } finally {
    warnings.cleanup();
  }
});
