import assert from "node:assert/strict";
import { beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveSubagentModelAndThinkingPlan } from "./subagents/spawn/subagent-spawn-plan.js";
import { resolveSubagentThinkingOverride } from "./subagents/spawn/subagent-spawn-thinking.js";
import { supportedSpawnModelChoice } from "./subagents/spawn/subagent-spawn.test-helpers.js";

const modelChoice = vi.hoisted(() => vi.fn<typeof supportedSpawnModelChoice>());
vi.mock("./subagents/spawn/subagent-spawn.runtime.js", () => ({ prepareModelChoice: modelChoice }));
beforeEach(() => {
  modelChoice.mockReset().mockImplementation(supportedSpawnModelChoice);
});

const acpAgent = {
  runtime: { type: "acp", acp: { agent: "cursor" } },
  model: "gpt-5.6-sol[context=272k,reasoning=medium,fast=false]",
} satisfies NonNullable<NonNullable<OpenClawConfig["agents"]>["entries"]>[string];
const planFor = (options: Partial<Parameters<typeof resolveSubagentModelAndThinkingPlan>[0]>) =>
  resolveSubagentModelAndThinkingPlan({ cfg: {}, targetAgentId: "research", ...options });
const nativeModel = "minimax/MiniMax-M2.7";
const configFor = (
  defaults: NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>,
  research: NonNullable<NonNullable<OpenClawConfig["agents"]>["entries"]>[string] = acpAgent,
) => ({ agents: { defaults, entries: { research } } });
function expectModelPlan(
  plan: Awaited<ReturnType<typeof planFor>>,
  provider: string,
  model: string,
  source: "user" | "auto",
  hasOrigin = true,
) {
  assert(plan.status === "ok");
  expect(plan).toMatchObject({
    resolvedModel: `${provider}/${model}`,
    modelApplied: true,
    initialSessionPatch: { modelProvider: provider, model, modelOverrideSource: source },
  });
  expect([
    plan.initialSessionPatch.modelOverrideFallbackOriginProvider,
    plan.initialSessionPatch.modelOverrideFallbackOriginModel,
  ]).toEqual(hasOrigin ? [provider, model] : [undefined, undefined]);
}

it("threads explicit fast mode into the initial child session patch", async () => {
  const plan = await planFor({ fastMode: "ultrafast" });
  expect(plan).toMatchObject({ status: "ok", initialSessionPatch: { fastMode: "ultrafast" } });
});
it("applies an explicit native model instead of ACP defaults", async () => {
  const plan = await planFor({
    cfg: configFor({ subagents: { model: nativeModel } }),
    targetAgentConfig: acpAgent,
    modelOverride: "openrouter/meta-llama/llama-3.3-70b:free",
  });
  expectModelPlan(plan, "openrouter", "meta-llama/llama-3.3-70b:free", "user", false);
});

it("rejects invalid thinking before preparing a model", async () => {
  expect(await planFor({ thinkingOverrideRaw: "banana" })).toMatchObject({
    status: "error",
    error: expect.stringMatching(/Invalid thinking level/i),
  });
  expect(modelChoice).not.toHaveBeenCalled();
});

it("uses the target default provider for a bare configured subagent model", async () => {
  expectModelPlan(
    await planFor({
      cfg: configFor({ model: { primary: "openai/gpt-5.5" }, subagents: { model: "gpt-5.4" } }, {}),
    }),
    "openai",
    "gpt-5.4",
    "auto",
  );
});

it.each([
  ["agent subagent model", "opencode/claude", nativeModel, "opencode", "claude", true],
  ["default subagent model", undefined, nativeModel, "minimax", "MiniMax-M2.7", true],
  ["native default, not ACP primary", undefined, undefined, "minimax", "MiniMax-M2.7", false],
] as const)(
  "selects %s for a native child",
  async (_name, agentModel, defaultModel, provider, model, hasOrigin) => {
    const targetAgentConfig = { ...acpAgent, subagents: { model: agentModel } };
    const plan = await planFor({
      cfg: configFor(
        { model: { primary: nativeModel }, subagents: { model: defaultModel } },
        targetAgentConfig,
      ),
      targetAgentConfig,
    });
    expectModelPlan(plan, provider, model, "auto", hasOrigin);
  },
);
it.each([
  ["requester over target", "low", "medium", "high", "high", undefined, "low", "low"],
  ["target off over global", undefined, "off", "high", "high", undefined, "off", "off"],
  ["global over caller", undefined, undefined, "high", "medium", undefined, "high", "high"],
  ["inherited caller off", undefined, undefined, undefined, "off", undefined, "off", undefined],
  ["request over requester", "low", "medium", "high", "off", "xhigh", "xhigh", "xhigh"],
] as const)(
  "preserves subagent thinking precedence: %s",
  (_name, requester, target, global, caller, requestOverride, expected, override) => {
    expect(
      resolveSubagentThinkingOverride({
        cfg: { agents: { defaults: { subagents: { thinking: global } } } },
        requesterAgentConfig: { subagents: { thinking: requester } },
        targetAgentConfig: { subagents: { thinking: target } },
        thinkingOverrideRaw: requestOverride,
        callerThinkingRaw: caller,
      }),
    ).toEqual({
      status: "ok",
      thinkingOverride: override,
      initialSessionPatch: expected === undefined ? {} : { thinkingLevel: expected },
    });
  },
);
