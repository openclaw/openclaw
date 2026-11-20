import { expect, it } from "vitest";
import {
  createBundledModelIdentityFactsResolver,
  createVendorModelFactsResolver,
} from "./bundled-model-identity-facts.js";

const resolve = createVendorModelFactsResolver();

it("projects the bundled Qwen reasoning boolean only for its exact model and API", () => {
  const facts = createBundledModelIdentityFactsResolver();
  const exact = {
    provider: "opencode-go",
    modelId: "qwen3.8-max",
    api: "anthropic-messages" as const,
  };
  expect(facts(exact)).toEqual({ reasoning: true, compat: { codeMode: "capable" } });
  for (const patch of [
    { provider: "opencode" },
    { modelId: "Qwen3.8-Max" },
    { modelId: "qwen3.8-max-latest" },
    { modelId: "qwen-future" },
    { api: "openai-completions" as const },
  ]) {
    expect(facts({ ...exact, ...patch })).toBeUndefined();
  }
});

it("gives a host's dated variant the vendor's reasoning replay over the same API", () => {
  expect(
    resolve({
      provider: "kilocode",
      id: "deepseek/deepseek-v4-pro-0813",
      api: "openai-completions",
    }),
  ).toEqual({ requiresReasoningContentOnAssistantMessages: true });
  expect(
    resolve({ provider: "venice", id: "kimi-k3-fast-api", api: "openai-completions" }),
  ).toEqual({ requiresReasoningContentOnAssistantMessages: true });
});

it("inherits nothing on the vendor's own route, another API, or an unknown model", () => {
  expect(resolve({ provider: "deepseek", id: "deepseek-v4-pro", api: "openai-completions" })).toBe(
    undefined,
  );
  expect(resolve({ provider: "ollama", id: "kimi-k3:cloud", api: "ollama" })).toBe(undefined);
  expect(resolve({ provider: "kilocode", id: "unknown-model", api: "openai-completions" })).toBe(
    undefined,
  );
});
