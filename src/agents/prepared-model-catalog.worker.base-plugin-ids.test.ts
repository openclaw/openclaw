// Regression: the model-catalog worker's default plugin-id scope must not regress below a
// previously-proven scope-expansion once discovery has established it, or the resulting registry
// can never be reused again (forcing a full rebuild on every request that needs the wider scope).
import { describe, expect, it } from "vitest";
import { normalizePluginsConfig } from "../plugins/config-state.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { resolveWorkerGenerationBasePluginIds } from "./prepared-model-catalog.worker.js";

function makeMetadata(pluginIds: readonly string[]): PluginMetadataSnapshot {
  return {
    plugins: pluginIds.map((id) => ({
      id,
      origin: "installed",
      providers: [],
      modelCatalog: { runtimeAugment: false },
      // Static eligibility is deliberately false for every plugin here: these fixture ids
      // represent plugins (like "openai" in the live bug report) that are only proven necessary
      // by runtime provider discovery, not by the static model-catalog-augment manifest flag.
    })),
  } as unknown as PluginMetadataSnapshot;
}

describe("resolveWorkerGenerationBasePluginIds", () => {
  it("carries a prior scope-expansion's plugin ids forward as the new default base scope", () => {
    const metadata = makeMetadata(["acpx", "amazon-bedrock", "codex", "openai"]);
    const normalizedConfig = normalizePluginsConfig(undefined);

    // Step 1: first call for this workspace -- no prior generation, so the default scope is
    // whatever the (empty, in this fixture) static eligibility filter produces.
    const firstCallBase = resolveWorkerGenerationBasePluginIds({
      metadata,
      config: {},
      env: process.env,
      normalizedConfig,
    });
    expect(firstCallBase).toEqual([]);

    // Step 2: a scope-expansion elsewhere in the worker (triggered by provider discovery) proved
    // {acpx, amazon-bedrock, codex, openai} were actually needed and built them successfully.
    // That generation's `pluginIds` (mirroring WorkerGeneration.pluginIds) is the reuse candidate
    // passed to the next default-scope call.
    const expandedPluginIds = new Set(["acpx", "amazon-bedrock", "codex", "openai"]);

    // Step 3: a later call recomputes the default (non-expansion) base scope from scratch. It
    // must not silently drop back to the static-only (empty) scope -- doing so is exactly the bug:
    // the previously-built 4-plugin registry becomes a superset of the new request, which fails
    // reusableAgentRuntimeRegistry's exact containment check forever.
    const thirdCallBase = resolveWorkerGenerationBasePluginIds({
      metadata,
      config: {},
      env: process.env,
      normalizedConfig,
      previousPluginIds: expandedPluginIds,
    });
    expect(thirdCallBase).toEqual(["acpx", "amazon-bedrock", "codex", "openai"]);

    // A fourth call with the same previous scope must stay stable (idempotent), which is what
    // lets `reusableAgentRuntimeRegistry` finally reuse the built registry instead of rebuilding.
    const fourthCallBase = resolveWorkerGenerationBasePluginIds({
      metadata,
      config: {},
      env: process.env,
      normalizedConfig,
      previousPluginIds: new Set(thirdCallBase),
    });
    expect(fourthCallBase).toEqual(thirdCallBase);
  });

  it("drops previously-known plugin ids that are no longer installed", () => {
    const metadata = makeMetadata(["acpx", "codex"]);
    const normalizedConfig = normalizePluginsConfig(undefined);

    const base = resolveWorkerGenerationBasePluginIds({
      metadata,
      config: {},
      env: process.env,
      normalizedConfig,
      previousPluginIds: new Set(["acpx", "codex", "uninstalled-plugin"]),
    });

    expect(base).toEqual(["acpx", "codex"]);
  });
});
