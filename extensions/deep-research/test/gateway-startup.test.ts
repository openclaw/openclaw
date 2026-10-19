import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../src/config/types.openclaw.js";
import { resolveGatewayStartupPluginPlanFromRegistry } from "../../../src/plugins/gateway-startup-plugin-plan.js";
import { createInstalledPluginIndexFixture } from "../../../src/plugins/gateway-startup.test-helpers.js";
import type { PluginManifestRegistry } from "../../../src/plugins/manifest-registry.js";
import { loadPluginManifest } from "../../../src/plugins/manifest.js";

function plan(config: OpenClawConfig) {
  const registry: PluginManifestRegistry = {
    diagnostics: [],
    plugins: ["deep-research", "google"].map((id) => {
      const rootDir = fileURLToPath(new URL(`../../${id}/`, import.meta.url));
      const loaded = loadPluginManifest(rootDir);
      if (!loaded.ok) {
        throw new Error(loaded.error);
      }
      const manifest = loaded.manifest;
      return Object.assign({}, manifest, {
        origin: "bundled" as const,
        providers: manifest.providers ?? [],
        channels: manifest.channels ?? [],
        cliBackends: manifest.cliBackends ?? [],
        skills: manifest.skills ?? [],
        hooks: [],
        rootDir,
        source: `${rootDir}/index.ts`,
        manifestPath: loaded.manifestPath,
      });
    }),
  };
  return resolveGatewayStartupPluginPlanFromRegistry({
    config,
    env: {},
    manifestRegistry: registry,
    index: createInstalledPluginIndexFixture(registry),
  }).pluginIds;
}

describe("research manifest activation", () => {
  it("activates the bundled feature without activating an unconfigured managed provider", () => {
    expect(plan({})).toEqual(["deep-research"]);
  });
  it("honors feature/provider disablement and configured provider activation", () => {
    expect(plan({ plugins: { entries: { "deep-research": { enabled: false } } } })).toEqual([]);
    const research = { enabled: true, profileId: "google:research" };
    expect(plan({ plugins: { entries: { google: { config: { research } } } } })).toEqual([
      "deep-research",
      "google",
    ]);
    expect(
      plan({ plugins: { entries: { google: { enabled: false, config: { research } } } } }),
    ).toEqual(["deep-research"]);
  });
});
