import type { Model } from "@openclaw/llm-core";
import { expect, it } from "vitest";
import { resolveAnthropicTransportOptions } from "./anthropic-transport-options.js";

const model = (id: string): Model<"anthropic-messages"> => ({
  id,
  name: id,
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "https://api.anthropic.com",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000_000,
  maxTokens: 128_000,
});

// Claude 5 models think by default; the 32k compatibility clamp starves thinking plus output.
it.each([
  ["claude-fable-5-2", 128_000],
  ["claude-zzz-9-9", 128_000],
  ["claude-opus-5-5", 128_000],
  ["claude-sonnet-4-6", 32_000],
])("uses the catalog output cap for %s", (id, expected) => {
  expect(resolveAnthropicTransportOptions(model(id), {}, "sk-test").maxTokens).toBe(expected);
});
