import { validateJsonSchemaValue } from "openclaw/plugin-sdk/json-schema-runtime";
import { describe, expect, it } from "vitest";
import manifest from "../../openclaw.plugin.json" with { type: "json" };
import { resolveRuntimeForTest } from "./config.test-support.js";

describe("Codex network proxy config admission", () => {
  it.each([
    {
      name: "invalid proxy profile",
      appServer: {
        networkProxy: { enabled: true, profileName: "", domains: { "example.com": "allow" } },
      },
    },
    {
      name: "invalid sibling field",
      appServer: {
        remoteWorkspaceRoot: " ",
        networkProxy: { enabled: true, domains: { "example.com": "allow" } },
      },
    },
  ])(
    "rejects a manifest-valid enabled allowlist with $name without exposing config",
    ({ appServer }) => {
      const validated = validateJsonSchemaValue({
        schema: manifest.configSchema,
        value: {
          appServer: {
            ...appServer,
            authToken: "synthetic-secret-token",
            headers: { Authorization: "Bearer synthetic-secret-header" },
          },
        },
        applyDefaults: true,
      });
      expect(validated.ok).toBe(true);
      if (!validated.ok) {
        throw new Error("Expected manifest-valid config");
      }
      expect(() => resolveRuntimeForTest({ pluginConfig: validated.value })).toThrow(
        new Error(
          "Invalid plugins.entries.codex.config with appServer.networkProxy.enabled=true; fix the plugin configuration before starting Codex with network restrictions.",
        ),
      );
    },
  );

  it("preserves invalid-config fallback when the network proxy is disabled", () => {
    const runtime = resolveRuntimeForTest({
      pluginConfig: {
        appServer: {
          networkProxy: { enabled: false, profileName: "", domains: { "example.com": "allow" } },
        },
      },
    });
    expect(runtime.networkProxy).toBeUndefined();
    expect(runtime.sandbox).toBe(resolveRuntimeForTest().sandbox);
  });
});
