// OpenRouter failover tests keep vendor error policy at its owning plugin boundary.
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { beforeAll, describe, expect, it } from "vitest";
import openrouterPlugin from "./index.js";

let provider: Awaited<ReturnType<typeof registerSingleProviderPlugin>>;

beforeAll(async () => {
  provider = await registerSingleProviderPlugin(openrouterPlugin);
});

function classifyOpenRouterFailure(errorMessage: string, providerId?: string, status?: number) {
  return provider.classifyFailoverReason?.({ provider: providerId, errorMessage, status });
}

describe("OpenRouter failover classification", () => {
  it.each([
    ["Key limit exceeded", "billing"],
    ["HTTP 401: 401 Key limit reached (monthly limit)", "billing"],
    ["Key limit hit", "billing"],
    [
      "HTTP 403: 403 API key budget limit exceeded (monthly limit). Contact your org admin.",
      "billing",
    ],
    ["API key budget limit reached", "billing"],
    ["API key budget limit hit", "billing"],
    ["Provider returned error", "timeout"],
  ] as const)("maps %s to %s", (errorMessage, expected) => {
    expect(classifyOpenRouterFailure(errorMessage, "openrouter")).toBe(expected);
  });

  it("recognizes documented spending budgets without treating other 403s as billing", () => {
    // https://openrouter.ai/docs/api_reference/errors-and-debugging#budget-errors
    for (const limitSource of [
      "openrouter_guardrail_budget",
      "openrouter_workspace_budget",
      "openrouter_key_limit",
    ]) {
      const error = {
        code: 403,
        message: "Request rejected",
        metadata: { limit_source: limitSource },
      };
      // The transport preserves both a full response and its inner error as body details.
      for (const body of [error, { error }]) {
        const text = JSON.stringify(body);
        expect(classifyOpenRouterFailure(text, "openrouter", 403)).toBe("billing");
        for (const status of [401, 402, 408, 410, 429, undefined]) {
          expect(classifyOpenRouterFailure(text, "openrouter", status)).toBeUndefined();
        }
        expect(classifyOpenRouterFailure(text, "custom-openrouter", 403)).toBeUndefined();
      }
    }
    for (const message of [
      "Budget limit exceeded (daily limit). Contact your org admin.",
      "403 Org member budget limit exceeded (weekly limit). Contact your org admin. $52.00 of $50.00 used; resets 2026-10-12T00:00:00.000Z.",
      "Workspace monthly budget of $500.00 exceeded. Contact your org admin.",
      "Workspace lifetime budget of $500.00 exceeded. Contact your org admin.",
    ]) {
      expect(classifyOpenRouterFailure(message, "openrouter", 403)).toBe("billing");
    }
    for (const message of [
      "Invalid API key",
      "Request blocked: prompt injection patterns detected",
      "The token budget is exceeded",
      '{"error":{"metadata":{"limit_source":"openrouter_workspace_budget"}',
      JSON.stringify({
        error: {
          message: "Forbidden",
          metadata: {
            limit_source: "openrouter_in_flight_budget",
            remedy_hint: "Budget limit exceeded (daily limit).",
          },
        },
      }),
      JSON.stringify({
        message: "Permission denied",
        detail: "Workspace monthly budget of $500.00 exceeded.",
      }),
    ]) {
      expect(classifyOpenRouterFailure(message, "openrouter", 403)).toBeUndefined();
    }
  });

  it.each([undefined, "anthropic", "custom-openrouter"])(
    "does not apply OpenRouter policy to provider %s",
    (providerId) => {
      expect(classifyOpenRouterFailure("Key limit exceeded", providerId)).toBeUndefined();
      expect(classifyOpenRouterFailure("Provider returned error", providerId)).toBeUndefined();
    },
  );
});
