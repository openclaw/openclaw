import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { legacyConfigRules, normalizeCompatibilityConfig } from "./doctor-contract-api.js";
import { resolveRuntimeForTest } from "./src/app-server/config.test-support.js";

function createConfig() {
  return {
    plugins: {
      entries: {
        codex: {
          enabled: true,
          config: {
            appServer: {
              approvalPolicy: "never",
              sandbox: "workspace-write",
              authToken: "synthetic-secret-token",
              headers: { Authorization: "Bearer synthetic-secret-header" },
              networkProxy: {
                enabled: true,
                domains: { "example.com": "allow", "blocked.example.com": "deny" },
              },
            },
          },
        },
      },
    },
  } satisfies OpenClawConfig;
}

describe("Codex network proxy Doctor repair", () => {
  it("repairs blank optional fields and retains the requested runtime allowlist", () => {
    const original = createConfig();
    const appServer = original.plugins.entries.codex.config.appServer;
    Object.assign(appServer.networkProxy, { profileName: " \t" });
    Object.assign(appServer, { remoteWorkspaceRoot: "" });
    const before = structuredClone(original);

    const rule = legacyConfigRules.find((candidate) => candidate.match(appServer));
    expect(rule?.message).toContain('Run "openclaw doctor --fix"');
    expect(rule?.message).not.toContain("synthetic-secret");

    const result = normalizeCompatibilityConfig({ cfg: original });
    expect(result.config).toEqual(createConfig());
    expect(original).toEqual(before);
    expect(result.changes.length).toBeGreaterThan(0);
    expect(result.changes.join(" ")).not.toContain("synthetic-secret");
    const repeated = normalizeCompatibilityConfig({ cfg: result.config });
    expect(repeated.config).toBe(result.config);
    expect(repeated.changes).toEqual([]);

    const runtime = resolveRuntimeForTest({
      pluginConfig: result.config.plugins?.entries?.codex?.config,
    });
    expect(runtime.approvalPolicy).toBe("never");
    const networkProxy = runtime.networkProxy;
    if (!networkProxy) {
      throw new Error("Expected network proxy runtime config");
    }
    expect(networkProxy.profileName).toMatch(/^openclaw-network-[a-f0-9]{16}$/u);
    expect(networkProxy.configPatch.permissions).toEqual({
      [networkProxy.profileName]: expect.objectContaining({
        network: {
          enabled: true,
          domains: { "example.com": "allow", "blocked.example.com": "deny" },
        },
      }),
    });
  });

  it.each([true, false])("preserves unchanged config identity when enabled=%s", (enabled) => {
    const cfg = createConfig();
    const appServer = cfg.plugins.entries.codex.config.appServer;
    appServer.networkProxy.enabled = enabled;
    Object.assign(appServer.networkProxy, { profileName: enabled ? "existing-profile" : "" });
    Object.assign(appServer, { remoteWorkspaceRoot: enabled ? "/remote/workspace" : " " });
    const result = normalizeCompatibilityConfig({ cfg });
    expect(result.changes).toEqual([]);
    expect(result.config).toBe(cfg);
    expect(legacyConfigRules.some((rule) => rule.match(appServer))).toBe(false);
  });

  it.each([
    {
      name: "non-string optional fields",
      profile: { profileName: 42 },
      sibling: { remoteWorkspaceRoot: false },
    },
    { name: "unknown field", profile: {}, sibling: { unknownSetting: "synthetic-private-value" } },
  ])("keeps $name invalid after Doctor repair", ({ profile, sibling }) => {
    const cfg = createConfig();
    const appServer = cfg.plugins.entries.codex.config.appServer;
    Object.assign(appServer.networkProxy, { profileName: "" }, profile);
    Object.assign(appServer, { remoteWorkspaceRoot: "" }, sibling);
    const result = normalizeCompatibilityConfig({ cfg });
    expect(result.config.plugins?.entries?.codex?.config?.appServer).toMatchObject({
      networkProxy: profile,
      ...sibling,
    });
    expect(() =>
      resolveRuntimeForTest({ pluginConfig: result.config.plugins?.entries?.codex?.config }),
    ).toThrow("Invalid plugins.entries.codex.config");
  });
});
