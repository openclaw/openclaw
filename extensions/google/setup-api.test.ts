// Google tests cover setup api plugin behavior.
import type { CliBackendPlugin } from "openclaw/plugin-sdk/cli-backend";
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { afterEach, describe, expect, it } from "vitest";
import { GOOGLE_GEMINI_CLI_HARNESS_ENV } from "./gemini-cli-harness-policy.js";
import setupEntry from "./setup-api.js";

afterEach(() => {
  delete process.env[GOOGLE_GEMINI_CLI_HARNESS_ENV];
});

describe("google setup entry", () => {
  function collectSetupRegistrations() {
    const providerIds: string[] = [];
    const cliBackendIds: string[] = [];

    setupEntry.register({
      registerProvider(provider: ProviderPlugin) {
        providerIds.push(provider.id);
      },
      registerCliBackend(backend: CliBackendPlugin) {
        cliBackendIds.push(backend.id);
      },
    } as never);

    return { providerIds, cliBackendIds };
  }

  it("registers official setup providers without the deprecated Gemini CLI harness by default", () => {
    delete process.env[GOOGLE_GEMINI_CLI_HARNESS_ENV];

    expect(collectSetupRegistrations()).toEqual({
      providerIds: ["google-vertex"],
      cliBackendIds: [],
    });
  });

  it("registers the Gemini CLI harness only after explicit opt-in", () => {
    process.env[GOOGLE_GEMINI_CLI_HARNESS_ENV] = "1";

    expect(collectSetupRegistrations()).toEqual({
      providerIds: ["google-vertex"],
      cliBackendIds: ["google-gemini-cli"],
    });
  });
});
