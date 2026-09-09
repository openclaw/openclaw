import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resolveUsableAgentCredentialModes } from "./agent-auth-credentials.js";
import {
  dualRoutes,
  platformRoute,
  routeResolverFactory,
} from "./model-auth-availability.test-support.js";
import { createModelCatalogDecisions } from "./model-catalog-decisions.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";

const entry: ModelCatalogEntry = { provider: "openai", id: "gpt-5.4", name: "GPT" };
const config: OpenClawConfig = {
  plugins: { entries: { codex: { enabled: true } } },
  agents: { defaults: { models: { "openai/gpt-5.4": { agentRuntime: { id: "codex" } } } } },
};
const metadata = createPluginMetadataSnapshotFixture({
  plugins: [{ id: "codex", providers: ["codex"], syntheticAuthRefs: ["codex"] }],
});
function nativeOwner(complete: boolean, loggedIn: boolean, isCurrent = () => true) {
  const registry = createEmptyPluginRegistry();
  registry.agentHarnesses.push({
    pluginId: "codex",
    source: "fixture",
    harness: {
      id: "codex",
      label: "Codex",
      supports: () => ({ supported: true }),
      async runAttempt() {
        throw new Error("Catalog reads must not execute a model");
      },
    },
  });
  return createModelCatalogDecisions({
    cfg: config,
    agentId: "main",
    agentDir: "/tmp/catalog-agent",
    workspaceDir: "/tmp/catalog-workspace",
    snapshot: { entries: [entry], routeVariants: [entry] },
    metadataSnapshot: metadata,
    preparedAuthStore: { version: 1, profiles: {} },
    preparedRuntimeAuthModes: loggedIn ? { codex: { source: "native", mode: "api_key" } } : {},
    preparedSyntheticAuthComplete: complete,
    pluginRegistry: registry,
    isCurrent,
    routeResolverFactory: routeResolverFactory(dualRoutes),
  });
}

describe("captured model decisions", () => {
  it("offers only the native runtime when no host credential exists", async () => {
    expect(await nativeOwner(true, true).runtimeChoices(entry)).toEqual(["codex"]);
  });

  it("distinguishes unknown choices from authoritative empty choices", async () => {
    expect(await nativeOwner(false, false).runtimeChoices(entry)).toBeUndefined();
    expect(await nativeOwner(true, false).runtimeChoices(entry)).toEqual([]);
  });

  it("rejects a replaced generation instead of returning its old choices", async () => {
    let current = true;
    const owner = nativeOwner(true, true, () => current);
    expect(await owner.runtimeChoices(entry)).toEqual(["codex"]);
    current = false;
    await expect(owner.runtimeChoices(entry)).rejects.toThrow("Model catalog changed");
  });

  it("keeps a different provider's account pin out of the selected route", async () => {
    const owner = createModelCatalogDecisions({
      cfg: {},
      agentId: "main",
      workspaceDir: "/tmp/catalog-workspace",
      snapshot: { entries: [entry], routeVariants: [entry] },
      metadataSnapshot: metadata,
      preferredProfileId: "anthropic:chosen",
      pinnedProfileId: "anthropic:chosen",
      profileProvider: "anthropic",
      preparedAuthStore: {
        version: 1,
        profiles: {
          "anthropic:chosen": { type: "api_key", provider: "anthropic", key: "synthetic-a" },
          "openai:chosen": { type: "api_key", provider: "openai", key: "synthetic-b" },
        },
      },
      routeResolverFactory: routeResolverFactory({ ...dualRoutes, routes: [platformRoute] }),
    });
    expect(await owner.evaluateEntry(entry, [entry], "openclaw")).toMatchObject({
      availability: true,
      selectedProfileId: "openai:chosen",
    });
  });

  it("retains native provenance and mode without blessing a same-name bearer credential", () => {
    expect(
      resolveUsableAgentCredentialModes({
        codex: {
          type: "api_key",
          key: "presence",
          nativeAuth: { runtime: "codex", mode: "oauth" },
        },
      }),
    ).toEqual({ codex: { source: "native", mode: "oauth" } });
    expect(
      resolveUsableAgentCredentialModes({ codex: { type: "api_key", key: "configured-bearer" } }),
    ).toEqual({ codex: "api_key" });
  });
});
