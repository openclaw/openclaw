// Google tests cover default plugin harness registration behavior.
import type { CliBackendPlugin } from "openclaw/plugin-sdk/cli-backend";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { afterEach, describe, expect, it } from "vitest";
import { GOOGLE_GEMINI_CLI_HARNESS_ENV } from "./gemini-cli-harness-policy.js";
import googlePlugin from "./index.js";

afterEach(() => {
  delete process.env[GOOGLE_GEMINI_CLI_HARNESS_ENV];
});

describe("google plugin Gemini CLI harness registration", () => {
  function collectGooglePluginRegistrations() {
    const providerIds: string[] = [];
    const cliBackendIds: string[] = [];

    googlePlugin.register(
      createTestPluginApi({
        registerProvider(provider: ProviderPlugin) {
          providerIds.push(provider.id);
        },
        registerCliBackend(backend: CliBackendPlugin) {
          cliBackendIds.push(backend.id);
        },
      }),
    );

    return { providerIds, cliBackendIds };
  }

  it("keeps the default Google plugin on official provider paths", () => {
    delete process.env[GOOGLE_GEMINI_CLI_HARNESS_ENV];

    expect(collectGooglePluginRegistrations()).toEqual({
      providerIds: ["google"],
      cliBackendIds: [],
    });
  });

  it("registers Gemini CLI provider and backend only after explicit opt-in", () => {
    process.env[GOOGLE_GEMINI_CLI_HARNESS_ENV] = "1";

    expect(collectGooglePluginRegistrations()).toEqual({
      providerIds: ["google-gemini-cli", "google"],
      cliBackendIds: ["google-gemini-cli"],
    });
  });
});
