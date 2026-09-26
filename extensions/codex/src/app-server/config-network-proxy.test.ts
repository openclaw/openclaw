import { validateJsonSchemaValue } from "openclaw/plugin-sdk/json-schema-runtime";
import { describe, expect, it } from "vitest";
import manifest from "../../openclaw.plugin.json" with { type: "json" };
import { resolveRuntimeForTest } from "./config.test-support.js";

describe("Codex network proxy config admission", () => {
  it.each([
    {
      name: "invalid proxy profile",
      field: "appServer.networkProxy.profileName",
      appServer: {
        networkProxy: { enabled: true, profileName: "", domains: { "example.com": "allow" } },
      },
    },
    {
      name: "invalid sibling field",
      field: "appServer.remoteWorkspaceRoot",
      appServer: {
        remoteWorkspaceRoot: " ",
        networkProxy: { enabled: true, domains: { "example.com": "allow" } },
      },
    },
  ])(
    "rejects a manifest-valid enabled allowlist with $name and identifies supported repair",
    ({ appServer, field }) => {
      const pluginConfig = {
        appServer: {
          ...appServer,
          authToken: "synthetic-secret-token",
          headers: { Authorization: "Bearer synthetic-secret-header" },
        },
      };
      const validated = validateJsonSchemaValue({
        schema: manifest.configSchema,
        value: pluginConfig,
        applyDefaults: true,
      });
      expect(validated.ok).toBe(true);
      if (!validated.ok) {
        throw new Error("Expected manifest-valid config");
      }
      expect(() => resolveRuntimeForTest({ pluginConfig: validated.value })).toThrow(
        new Error(
          `Invalid plugins.entries.codex.config.${field}; fix this field before starting Codex with network restrictions. Run "openclaw doctor --fix" for supported repairs.`,
        ),
      );
    },
  );

  it("rejects a manifest-valid malformed auth input without dropping the enabled allowlist", () => {
    const validated = validateJsonSchemaValue({
      schema: manifest.configSchema,
      value: {
        appServer: {
          authToken: { unexpected: "synthetic-secret" },
          networkProxy: { enabled: true, domains: { "example.com": "allow" } },
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
        'Invalid plugins.entries.codex.config.appServer.authToken; fix this field before starting Codex with network restrictions. Run "openclaw doctor --fix" for supported repairs.',
      ),
    );
  });

  it("identifies an invalid domains map without exposing its keys or values", () => {
    expect(() =>
      resolveRuntimeForTest({
        pluginConfig: {
          appServer: {
            networkProxy: {
              enabled: true,
              domains: { "synthetic-private-domain.example": "synthetic-invalid-permission" },
            },
          },
        },
      }),
    ).toThrow(
      new Error(
        'Invalid plugins.entries.codex.config.appServer.networkProxy.domains; fix this field before starting Codex with network restrictions. Run "openclaw doctor --fix" for supported repairs.',
      ),
    );
  });

  it("preserves blank-field admission and fallback without an enabled proxy", () => {
    for (const appServer of [
      {
        remoteWorkspaceRoot: " ",
        networkProxy: { enabled: false, profileName: "", domains: { "example.com": "allow" } },
      },
      { remoteWorkspaceRoot: " " },
    ]) {
      const pluginConfig = { appServer };
      expect(
        validateJsonSchemaValue({
          schema: manifest.configSchema,
          value: pluginConfig,
          applyDefaults: true,
        }).ok,
      ).toBe(true);
      const runtime = resolveRuntimeForTest({ pluginConfig });
      expect(runtime.networkProxy).toBeUndefined();
      expect(runtime.sandbox).toBe(resolveRuntimeForTest().sandbox);
    }
  });
});
