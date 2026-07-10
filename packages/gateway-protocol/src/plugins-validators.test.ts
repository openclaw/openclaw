import { describe, expect, it } from "vitest";
import {
  validatePluginsInstallParams,
  validatePluginsInstallResult,
  validatePluginsListParams,
  validatePluginsListResult,
  validatePluginsSearchParams,
  validatePluginsSearchResult,
  validatePluginsSetEnabledParams,
  validatePluginsSetEnabledResult,
} from "./index.js";

const installedPlugin = {
  id: "workboard",
  name: "Workboard",
  packageName: "@openclaw/workboard",
  description: "Coordinate work across agents",
  version: "1.0.0",
  kind: ["tool"],
  origin: "bundled",
  installed: true,
  enabled: false,
  state: "disabled",
  featured: true,
  order: 10,
  install: { source: "official", pluginId: "workboard" },
} as const;

describe("plugin lifecycle protocol validators", () => {
  it("accepts cold catalog payloads and rejects runtime-only states", () => {
    expect(validatePluginsListParams({})).toBe(true);
    expect(validatePluginsListParams({ unexpected: true })).toBe(false);
    expect(
      validatePluginsListResult({
        plugins: [installedPlugin],
        diagnostics: [],
        mutationAllowed: true,
      }),
    ).toBe(true);
    expect(
      validatePluginsListResult({
        plugins: [{ ...installedPlugin, state: "loaded" }],
        diagnostics: [],
        mutationAllowed: true,
      }),
    ).toBe(false);
  });

  it("validates bounded plugin search requests and projected results", () => {
    expect(validatePluginsSearchParams({ query: "memory", limit: 20 })).toBe(true);
    expect(validatePluginsSearchParams({ query: "memory", limit: 101 })).toBe(false);
    expect(
      validatePluginsSearchResult({
        results: [
          {
            score: 0.95,
            package: {
              name: "memory-plus",
              displayName: "Memory Plus",
              family: "code-plugin",
              channel: "community",
              isOfficial: false,
              summary: "Long-term memory tools",
              latestVersion: "2.1.0",
              runtimeId: "memory-plus",
            },
          },
        ],
      }),
    ).toBe(true);
  });

  it("keeps official and ClawHub install requests distinct", () => {
    expect(
      validatePluginsInstallParams({
        source: "clawhub",
        packageName: "memory-plus",
        version: "2.1.0",
        acknowledgeClawHubRisk: true,
      }),
    ).toBe(true);
    expect(validatePluginsInstallParams({ source: "official", pluginId: "workboard" })).toBe(true);
    expect(
      validatePluginsInstallParams({
        source: "official",
        pluginId: "workboard",
        packageName: "memory-plus",
      }),
    ).toBe(false);
    expect(
      validatePluginsInstallResult({
        ok: true,
        plugin: { ...installedPlugin, enabled: true, state: "enabled" },
        restartRequired: true,
        warnings: ["Restart the gateway to load this plugin."],
      }),
    ).toBe(true);
  });

  it("validates enablement mutations and dynamic restart metadata", () => {
    expect(validatePluginsSetEnabledParams({ pluginId: "workboard", enabled: true })).toBe(true);
    expect(validatePluginsSetEnabledParams({ pluginId: "workboard", enabled: "yes" })).toBe(false);
    expect(
      validatePluginsSetEnabledResult({
        ok: true,
        plugin: { ...installedPlugin, enabled: true, state: "enabled" },
        restartRequired: false,
        warnings: ['Exclusive slot "memory" switched to "memory-plus".'],
      }),
    ).toBe(true);
  });
});
