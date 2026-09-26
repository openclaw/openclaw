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

  it.each([
    { name: "relative path", readOnlyPaths: ["app/node_modules/openclaw"] },
    { name: "root path", readOnlyPaths: ["/"] },
    { name: "special profile key", readOnlyPaths: [":minimal"] },
    { name: "glob path", readOnlyPaths: ["/app/*"] },
    { name: "traversal path", readOnlyPaths: ["/app/../etc"] },
    { name: "control character", readOnlyPaths: ["/app/node_modules/openclaw\n"] },
  ])("rejects malformed network proxy read-only paths: $name", ({ readOnlyPaths }) => {
    const pluginConfig = {
      appServer: {
        networkProxy: {
          enabled: true,
          domains: { "example.com": "allow" },
          readOnlyPaths,
        },
      },
    };
    const validated = validateJsonSchemaValue({
      schema: manifest.configSchema,
      value: pluginConfig,
      applyDefaults: true,
    });
    expect(validated.ok).toBe(true);
    if (!validated.ok) {
      throw new Error("Expected manifest-valid read-only path config");
    }
    expect(() => resolveRuntimeForTest({ pluginConfig: validated.value })).toThrow(
      new Error(
        'Invalid plugins.entries.codex.config.appServer.networkProxy.readOnlyPaths; fix this field before starting Codex with network restrictions. Run "openclaw doctor --fix" for supported repairs.',
      ),
    );
  });

  it("admits a stock Codex repository broker network profile", () => {
    const pluginConfig = {
      appServer: {
        networkProxy: {
          enabled: true,
          profileName: "repository-broker-test",
          mode: "full",
          allowLocalBinding: true,
          readOnlyPaths: [
            "/app/node_modules/openclaw",
            "/opt/oce/repository-credentials",
            "/run/oce/repository-credentials",
          ],
          domains: {
            "git.123-control.svc": "allow",
            "api.openai.com": "allow",
            "169.254.169.254": "deny",
            "blocked.example.com": "deny",
          },
        },
      },
    };

    const validated = validateJsonSchemaValue({
      schema: manifest.configSchema,
      value: pluginConfig,
      applyDefaults: true,
    });
    expect(validated.ok).toBe(true);
    if (!validated.ok) {
      throw new Error("Expected manifest-valid repository broker network profile");
    }

    expect(
      resolveRuntimeForTest({ pluginConfig: validated.value }).networkProxy?.configPatch,
    ).toMatchObject({
      permissions: {
        "repository-broker-test": {
          filesystem: {
            "/app/node_modules/openclaw": "read",
            "/opt/oce/repository-credentials": "read",
            "/run/oce/repository-credentials": "read",
          },
          network: {
            mode: "full",
            allow_local_binding: true,
            domains: {
              "git.123-control.svc": "allow",
              "api.openai.com": "allow",
              "169.254.169.254": "deny",
              "blocked.example.com": "deny",
            },
          },
        },
      },
    });
    const permissions = resolveRuntimeForTest({
      pluginConfig: validated.value,
    }).networkProxy?.configPatch.permissions as Record<
      string,
      { network: Record<string, unknown> }
    >;
    expect(permissions["repository-broker-test"]?.network).not.toHaveProperty("private_endpoints");
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
