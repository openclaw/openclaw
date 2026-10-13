import { beforeEach, describe, expect, it, vi } from "vitest";
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

describe("subagent initial model plan", () => {
  it("threads explicit fast mode into the initial child session patch", async () => {
    const plan = await resolveSubagentModelAndThinkingPlan({
      cfg: {},
      targetAgentId: "research",
      fastMode: "ultrafast",
    });
    expect(plan).toMatchObject({ status: "ok", initialSessionPatch: { fastMode: "ultrafast" } });
  });
  it("applies an explicit native model instead of ACP defaults", async () => {
    const plan = await resolveSubagentModelAndThinkingPlan({
      cfg: {
        agents: {
          defaults: { subagents: { model: "minimax/MiniMax-M2.7" } },
          entries: { research: acpAgent },
        },
      },
      targetAgentId: "research",
      targetAgentConfig: acpAgent,
      modelOverride: "openrouter/meta-llama/llama-3.3-70b:free",
    });
    expect(plan).toMatchObject({
      status: "ok",
      resolvedModel: "openrouter/meta-llama/llama-3.3-70b:free",
      modelApplied: true,
      initialSessionPatch: {
        model: "meta-llama/llama-3.3-70b:free",
        modelOverrideSource: "user",
      },
    });
    if (plan.status !== "ok") {
      throw new Error(plan.error);
    }
    expect(plan.initialSessionPatch.modelOverrideFallbackOriginProvider).toBeUndefined();
    expect(plan.initialSessionPatch.modelOverrideFallbackOriginModel).toBeUndefined();
  });

  it("rejects invalid thinking before preparing a model", async () => {
    expect(
      await resolveSubagentModelAndThinkingPlan({
        cfg: {},
        targetAgentId: "research",
        thinkingOverrideRaw: "banana",
      }),
    ).toMatchObject({ status: "error", error: expect.stringMatching(/Invalid thinking level/i) });
    expect(modelChoice).not.toHaveBeenCalled();
  });

  it("uses the target default provider for a bare configured subagent model", async () => {
    expect(
      await resolveSubagentModelAndThinkingPlan({
        cfg: {
          agents: {
            defaults: { model: { primary: "openai/gpt-5.5" }, subagents: { model: "gpt-5.4" } },
          },
        },
        targetAgentId: "research",
      }),
    ).toMatchObject({
      status: "ok",
      resolvedModel: "openai/gpt-5.4",
      initialSessionPatch: {
        model: "gpt-5.4",
        modelOverrideSource: "auto",
        modelOverrideFallbackOriginProvider: "openai",
        modelOverrideFallbackOriginModel: "gpt-5.4",
      },
    });
  });

  it.each([
    {
      name: "agent subagent model",
      agentModel: "opencode/claude",
      defaultModel: "minimax/MiniMax-M2.7",
      expected: "opencode/claude",
      originProvider: "opencode",
      originModel: "claude",
    },
    {
      name: "default subagent model",
      agentModel: undefined,
      defaultModel: "minimax/MiniMax-M2.7",
      expected: "minimax/MiniMax-M2.7",
      originProvider: "minimax",
      originModel: "MiniMax-M2.7",
    },
    {
      name: "native default instead of ACP harness primary",
      agentModel: undefined,
      defaultModel: undefined,
      expected: "minimax/MiniMax-M2.7",
      originProvider: undefined,
      originModel: undefined,
    },
  ])(
    "selects $name for a native child",
    async ({ agentModel, defaultModel, expected, originProvider, originModel }) => {
      const targetAgentConfig = { ...acpAgent, subagents: { model: agentModel } };
      const plan = await resolveSubagentModelAndThinkingPlan({
        cfg: {
          agents: {
            defaults: {
              model: { primary: "minimax/MiniMax-M2.7" },
              subagents: { model: defaultModel },
            },
            entries: { research: targetAgentConfig },
          },
        },
        targetAgentId: "research",
        targetAgentConfig,
      });
      expect(plan.status).toBe("ok");
      if (plan.status !== "ok") {
        throw new Error(plan.error);
      }
      expect(plan.resolvedModel).toBe(expected);
      expect(`${plan.initialSessionPatch.modelProvider}/${plan.initialSessionPatch.model}`).toBe(
        expected,
      );
      expect(plan.initialSessionPatch.modelOverrideSource).toBe("auto");
      expect(plan.initialSessionPatch.modelOverrideFallbackOriginProvider).toBe(originProvider);
      expect(plan.initialSessionPatch.modelOverrideFallbackOriginModel).toBe(originModel);
    },
  );
});

describe("subagent thinking precedence", () => {
  it.each([
    {
      name: "requester over target",
      requester: "low",
      target: "medium",
      global: "high",
      caller: "high",
      expected: "low",
      override: "low",
    },
    {
      name: "target off over global",
      requester: undefined,
      target: "off",
      global: "high",
      caller: "high",
      expected: "off",
      override: "off",
    },
    {
      name: "global over caller",
      requester: undefined,
      target: undefined,
      global: "high",
      caller: "medium",
      expected: "high",
      override: "high",
    },
    {
      name: "inherited caller off",
      requester: undefined,
      target: undefined,
      global: undefined,
      caller: "off",
      expected: "off",
      override: undefined,
    },
  ])("preserves $name", ({ requester, target, global, caller, expected, override }) => {
    expect(
      resolveSubagentThinkingOverride({
        cfg: { agents: { defaults: { subagents: { thinking: global } } } },
        requesterAgentConfig: { subagents: { thinking: requester } },
        targetAgentConfig: { subagents: { thinking: target } },
        callerThinkingRaw: caller,
      }),
    ).toEqual({
      status: "ok",
      thinkingOverride: override,
      initialSessionPatch: { thinkingLevel: expected },
    });
  });
});
