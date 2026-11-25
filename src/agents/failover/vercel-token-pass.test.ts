import { beforeAll, describe, expect, it } from "vitest";
import { registerSingleProviderPlugin } from "../../plugin-sdk/plugin-test-runtime.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { classifyAssistantFailoverReason } from "../embedded-agent-helpers/assistant-message-failures.js";
import { makeAssistantMessageFixture } from "../test-helpers/assistant-message-fixtures.js";
import { classifyFailoverSignal } from "./classify.js";
import type { PreparedProviderFailoverOwner } from "./provider-patterns.js";

describe("Vercel Token Pass failover", () => {
  let provider: PreparedProviderFailoverOwner;

  beforeAll(async () => {
    const { default: plugin } = await loadBundledPluginFacade<{
      default: Parameters<typeof registerSingleProviderPlugin>[0];
    }>({ pluginId: "vercel-ai-gateway", artifactBasename: "index.js" });
    provider = await registerSingleProviderPlugin(plugin);
  });

  it.each([
    {
      message: "Your Vercel Token Pass credits are used up until your next billing cycle.",
      reason: "billing",
    },
    {
      message:
        "This API key is scoped to Vercel Token Pass and can only be used with Token Pass models.",
      reason: "model_not_found",
    },
  ] as const)("classifies $reason from the native transport body", ({ message, reason }) => {
    // The native Anthropic transport preserves the HTTP body separately from
    // its generic error message. The envelope here is a fixture, not a Vercel subcode.
    const assistant = makeAssistantMessageFixture({
      provider: "vercel-ai-gateway",
      errorMessage: "403 status code (no body)",
      errorType: "no_providers_available",
      errorBody: JSON.stringify({ error: { type: "no_providers_available", message } }),
    });
    expect(classifyAssistantFailoverReason(assistant, { providerOwner: provider })).toBe(reason);
    expect(
      classifyFailoverSignal(
        { provider: provider.id, status: 403, message },
        { providerPlugin: provider },
      ),
    ).toEqual({ kind: "reason", reason });
  });

  it.each([
    "Forbidden",
    "Selected provider is unavailable in this region.",
    "This request requires a Vercel Token Pass API key.",
    "This request requires an active Vercel Token Pass.",
  ])("does not infer exhaustion from ambiguous 403: %s", (message) => {
    expect(
      classifyFailoverSignal(
        { provider: provider.id, status: 403, errorType: "no_providers_available", message },
        { providerPlugin: provider },
      ),
    ).toEqual({ kind: "reason", reason: "auth" });
  });

  it("preserves an explicit permanent auth code over body prose", () => {
    expect(
      classifyFailoverSignal(
        {
          provider: provider.id,
          status: 403,
          code: "DEACTIVATED_WORKSPACE",
          message: "403 status code (no body)",
          details: ["Your Vercel Token Pass credits are used up until your next billing cycle."],
        },
        { providerPlugin: provider },
      ),
    ).toEqual({ kind: "reason", reason: "auth_permanent" });
  });
});
