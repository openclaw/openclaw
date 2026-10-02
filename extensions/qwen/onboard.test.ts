import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-onboard";
import { describe, expect, it } from "vitest";
import {
  applyQwenConfig,
  applyQwenConfigCn,
  applyQwenStandardConfig,
  applyQwenStandardConfigCn,
  applyQwenTokenPlanConfig,
} from "./onboard.js";

const applyTokenPlanGlobal = (cfg: OpenClawConfig) => applyQwenTokenPlanConfig(cfg, "global");
const applyTokenPlanCn = (cfg: OpenClawConfig) => applyQwenTokenPlanConfig(cfg, "cn");

describe("Qwen setup", () => {
  it.each([
    { name: "coding global", provider: "qwen", apply: applyQwenConfig, mode: undefined },
    { name: "coding China", provider: "qwen", apply: applyQwenConfigCn, mode: "merge" },
    { name: "standard global", provider: "qwen", apply: applyQwenStandardConfig, mode: undefined },
    { name: "standard China", provider: "qwen", apply: applyQwenStandardConfigCn, mode: "merge" },
    {
      name: "Token Plan global",
      provider: "qwen-token-plan",
      apply: applyTokenPlanGlobal,
      mode: undefined,
    },
    {
      name: "Token Plan China",
      provider: "qwen-token-plan",
      apply: applyTokenPlanCn,
      mode: "merge",
    },
  ] as const)(
    "leaves $name $mode rows runtime-owned and retains aliases",
    ({ provider, apply, mode }) => {
      const input: OpenClawConfig = {
        models: { mode },
        agents: {
          defaults: {
            models: { "qwen/qwen3.5-plus": { alias: "Authored", params: { temperature: 0.2 } } },
          },
        },
      };
      const config = apply(input);

      expect(config.models?.providers?.[provider]?.models).toEqual([]);
      expect(config.agents?.defaults?.models?.["qwen/qwen3.5-plus"]).toEqual(
        input.agents?.defaults?.models?.["qwen/qwen3.5-plus"],
      );
      expect(config.agents?.defaults?.models?.[`${provider}/qwen3.7-plus`]).toBeDefined();
      if (provider === "qwen") {
        expect(config.agents?.defaults?.models?.["modelstudio/qwen3.7-plus"]).toBeDefined();
      }
      expect(apply(config)).toEqual(config);
    },
  );

  it.each([
    { name: "coding", provider: "qwen", apply: applyQwenConfig, rows: 10 },
    { name: "standard", provider: "qwen", apply: applyQwenStandardConfig, rows: 14 },
    { name: "Token Plan", provider: "qwen-token-plan", apply: applyTokenPlanGlobal, rows: 8 },
  ])("retains the shipped $name replace catalog", ({ provider, apply, rows }) => {
    const config = apply({ models: { mode: "replace" } });
    expect(config.models?.providers?.[provider]?.models).toHaveLength(rows);
  });
});
