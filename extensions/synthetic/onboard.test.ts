import { expect, it } from "vitest";
import { applySyntheticConfig, SYNTHETIC_DEFAULT_MODEL_REF } from "./api.js";

it("configures Synthetic's Anthropic endpoint and MiniMax default", () => {
  const cfg = applySyntheticConfig({});
  const provider = cfg.models?.providers?.synthetic;
  expect(provider).toMatchObject({
    baseUrl: "https://api.synthetic.new/anthropic",
    api: "anthropic-messages",
  });
  expect(provider?.models.map((model) => model.id)).toContain("hf:MiniMaxAI/MiniMax-M3");
  expect(cfg.agents?.defaults?.models?.[SYNTHETIC_DEFAULT_MODEL_REF]).toEqual({
    alias: "MiniMax M3",
  });
  expect(cfg.agents?.defaults?.model).toEqual({
    primary: "synthetic/hf:MiniMaxAI/MiniMax-M3",
  });
});
