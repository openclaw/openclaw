import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import { resolveImplicitProvidersForTest } from "./models-config.e2e-harness.js";
import * as discovery from "./models-config.providers.discovery.js";
import { buildKilocodeProvider } from "./models-config.providers.js";

const KILOCODE_MODEL_IDS = ["kilo/auto"];

describe("Kilo Gateway implicit provider", () => {
  it("should include kilocode when KILOCODE_API_KEY is configured", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const envSnapshot = captureEnv(["KILOCODE_API_KEY"]);
    process.env.KILOCODE_API_KEY = "test-key"; // pragma: allowlist secret

    try {
      const providers = await resolveImplicitProvidersForTest({ agentDir });
      expect(providers?.kilocode).toBeDefined();
      expect(providers?.kilocode?.models?.length).toBeGreaterThan(0);
    } finally {
      envSnapshot.restore();
    }
  });

  it("should not include kilocode when no API key is configured", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const envSnapshot = captureEnv(["KILOCODE_API_KEY"]);
    delete process.env.KILOCODE_API_KEY;

    try {
      const providers = await resolveImplicitProvidersForTest({ agentDir });
      expect(providers?.kilocode).toBeUndefined();
    } finally {
      envSnapshot.restore();
    }
  });

  it("should build kilocode provider with correct configuration", () => {
    const provider = buildKilocodeProvider();
    expect(provider.baseUrl).toBe("https://api.kilo.ai/api/gateway/");
    expect(provider.api).toBe("openai-completions");
    expect(provider.models).toBeDefined();
    expect(provider.models.length).toBeGreaterThan(0);
  });

  it("should include the default kilocode model", () => {
    const provider = buildKilocodeProvider();
    const modelIds = provider.models.map((m) => m.id);
    expect(modelIds).toContain("kilo/auto");
  });

  it("should include the static fallback catalog", () => {
    const provider = buildKilocodeProvider();
    const modelIds = provider.models.map((m) => m.id);
    for (const modelId of KILOCODE_MODEL_IDS) {
      expect(modelIds).toContain(modelId);
    }
    expect(provider.models).toHaveLength(KILOCODE_MODEL_IDS.length);
  });

  it("passes discoveryApiKey (resolved secret) to discovery, not the opaque apiKey marker (P1 fix)", async () => {
    // discoveryApiKey is the actual resolved value from the env var; apiKey is
    // the opaque marker/ref string stored in config. Discovery must receive the
    // resolved secret so the Authorization: Bearer header is valid.
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const envSnapshot = captureEnv(["KILOCODE_API_KEY"]);
    // Set the env var so discoveryApiKey resolves to the actual secret value.
    process.env.KILOCODE_API_KEY = "resolved-secret-token"; // pragma: allowlist secret

    const spy = vi.spyOn(discovery, "buildKilocodeProviderWithDiscovery").mockResolvedValue({
      baseUrl: "https://api.kilo.ai/api/gateway/",
      api: "openai-completions",
      models: [],
    });

    try {
      await resolveImplicitProvidersForTest({ agentDir });
      // First arg is the apiKey passed to discovery — must be the resolved secret
      // (discoveryApiKey), not the opaque marker string like "KILOCODE_API_KEY".
      const firstCall = spy.mock.calls[0];
      expect(firstCall).toBeDefined();
      const [calledApiKey] = firstCall ?? [];
      expect(calledApiKey).toBe("resolved-secret-token");
    } finally {
      spy.mockRestore();
      envSnapshot.restore();
    }
  });

  it("passes providerConfig to discovery so organizationId from config is respected (P2 fix)", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const envSnapshot = captureEnv(["KILOCODE_API_KEY", "KILOCODE_ORG_ID"]);
    process.env.KILOCODE_API_KEY = "test-key"; // pragma: allowlist secret
    delete process.env.KILOCODE_ORG_ID;

    const spy = vi.spyOn(discovery, "buildKilocodeProviderWithDiscovery").mockResolvedValue({
      baseUrl: "https://api.kilo.ai/api/gateway/",
      api: "openai-completions",
      models: [],
    });

    try {
      await resolveImplicitProvidersForTest({
        agentDir,
        config: {
          models: {
            providers: {
              kilocode: {
                baseUrl: "https://api.kilo.ai/api/gateway/",
                api: "openai-completions",
                organizationId: "config-org-999",
                models: [],
              },
            },
          },
        },
      });
      // Second arg must be the providerConfig carrying organizationId.
      expect(spy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ organizationId: "config-org-999" }),
      );
    } finally {
      spy.mockRestore();
      envSnapshot.restore();
    }
  });
});
