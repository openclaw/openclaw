// Google tests cover default plugin harness registration behavior.
import type { CliBackendPlugin } from "openclaw/plugin-sdk/cli-backend";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { describe, expect, it } from "vitest";
import googlePlugin from "./index.js";

describe("google plugin CLI harness registration", () => {
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

  it("preserves shipped Google CLI provider and backend registration", () => {
    expect(collectGooglePluginRegistrations()).toEqual({
      providerIds: ["google-gemini-cli", "google-antigravity", "google"],
      cliBackendIds: ["google-gemini-cli"],
    });
  });

  it("keeps Google CLI registration deterministic", () => {
    expect(collectGooglePluginRegistrations()).toEqual({
      providerIds: ["google-gemini-cli", "google-antigravity", "google"],
      cliBackendIds: ["google-gemini-cli"],
    });
  });

  it("registers the API-backed Google provider alongside CLI runtimes", () => {
    const registrations = collectGooglePluginRegistrations();

    expect(registrations.providerIds).toContain("google");
    expect(registrations.providerIds).toContain("google-gemini-cli");
    expect(registrations.providerIds).toContain("google-antigravity");
    expect(registrations.cliBackendIds).toContain("google-gemini-cli");
  });
});
