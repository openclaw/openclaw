import type { Context, Model } from "@openclaw/llm-core";
import { describe, expect, it } from "vitest";
import { buildOpenAIResponsesParams } from "./openai-responses-params-internal.js";
import {
  convertProviderResponsesMessages,
  convertResponsesMessages,
} from "./openai-responses-replay-messages-internal.js";

const context: Context = {
  systemPrompt: "Synthetic instructions",
  messages: [{ role: "user", content: "Hello", timestamp: 1 }],
};

describe("Responses prompt role", () => {
  it.each([
    ["openai-responses", true, undefined, "developer"],
    ["openai-responses", true, false, "system"],
    ["azure-openai-responses", true, true, "developer"],
    ["azure-openai-responses", false, true, "system"],
  ] as const)(
    "%s with reasoning=%s and developer=%s uses %s",
    (api, reasoning, supportsDeveloperRole, role) => {
      const model: Model = {
        id: "synthetic-opaque",
        name: "Synthetic name",
        provider: "synthetic-proxy",
        api,
        baseUrl: "https://broker.example.test/private/v1",
        reasoning,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 1024,
        ...(supportsDeveloperRole === undefined ? {} : { compat: { supportsDeveloperRole } }),
      };
      const expected = [
        { type: "message", role, content: [{ type: "input_text", text: context.systemPrompt }] },
        { type: "message", role: "user" },
      ];
      // The provider and transport entrypoints share the model's explicit role policy.
      expect(convertProviderResponsesMessages(model, context, new Set())).toMatchObject(expected);
      expect(convertResponsesMessages(model, context, new Set())).toMatchObject(expected);
      expect(buildOpenAIResponsesParams(model, context, undefined).input).toMatchObject(expected);
    },
  );
});
