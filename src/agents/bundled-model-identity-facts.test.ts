import { expect, it } from "vitest";
import { createVendorModelFactsResolver } from "./bundled-model-identity-facts.js";

const resolve = createVendorModelFactsResolver();

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
