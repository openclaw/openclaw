// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { usePreparedModelRuntimeHarness } from "./prepared-model-runtime.test-harness.js";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSystemAgentConfiguredRouteFromConfig } from "../system-agent/inference-route.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import { readAdmittedPublishedModelCatalog } from "./prepared-model-runtime.capture.js";
import {
  acquireReadOnlyPreparedModelRuntime,
  prepareModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";
import { resolvePreparedModelRuntimeOwnerBySnapshot } from "./prepared-model-runtime.owner.js";

const fixture = usePreparedModelRuntimeHarness();

describe("setup read-only published catalog", () => {
  it("retains startup subscription routes through the real setup projection without sharing execution", async () => {
    const { mocks } = fixture;
    mocks.configuredAgentIds = ["pro"];
    mocks.resolveNativeModelPrimary.mockReturnValue("openai/subscription-model");
    const row: ModelCatalogEntry = {
      provider: "openai",
      id: "subscription-model",
      name: "Subscription model",
      api: "openai-chatgpt-responses",
      contextWindow: 128000,
      reasoning: true,
    };
    mocks.runPreparedModelCatalogWorker.mockResolvedValue({ entries: [row], routeVariants: [row] });
    const config: OpenClawConfig = {
      agents: { defaults: { model: "openai/subscription-model" }, entries: { pro: {} } },
    };
    await refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
      catalogMode: "static",
    });
    const published = await prepareModelRuntimeSnapshot(fixture.agentInput("pro", config));
    await published.loadFullModelCatalog!({ refresh: true, wait: true });
    const route = await resolveSystemAgentConfiguredRouteFromConfig(config, "pro", {
      pluginMetadataPlugins: [],
    });
    expect(route).not.toBeNull();
    expect(route!.runConfig.agents?.entries).toHaveProperty("openclaw");
    const calls = mocks.runPreparedModelCatalogWorker.mock.calls.length;
    await using lease = await acquireReadOnlyPreparedModelRuntime(
      {
        ...fixture.agentInput("pro", route!.runConfig),
        workspaceDir: "/synthetic/setup-workspace",
        loadRuntimePlugins: true,
        runtimePluginPurpose: "isolated-completion",
      },
      { catalogMode: "static" },
    );
    expect(readAdmittedPublishedModelCatalog(lease.snapshot)?.routeVariants).toEqual([
      expect.objectContaining(row),
    ]);
    expect(lease.snapshot).not.toBe(published);
    const configuredGeneration =
      resolvePreparedModelRuntimeOwnerBySnapshot(published)?.pluginGeneration;
    expect(configuredGeneration).toBeDefined();
    expect(lease.pluginGeneration).not.toBe(configuredGeneration);
    expect(lease.snapshot.config).toEqual(route!.runConfig);
    expect(lease.snapshot.workspaceDir).toBe("/synthetic/setup-workspace");
    expect(mocks.runPreparedModelCatalogWorker).toHaveBeenCalledTimes(calls);
  });

  it.each(["model", "plugins", "agent", "credentials"] as const)(
    "does not borrow the published catalog across changed %s facts",
    async (change) => {
      const { mocks } = fixture;
      mocks.configuredAgentIds = ["pro"];
      const row = { provider: "openai", id: "subscription-model", name: "Subscription model" };
      mocks.runPreparedModelCatalogWorker.mockResolvedValue({
        entries: [row],
        routeVariants: [row],
      });
      const config: OpenClawConfig = {
        agents: { defaults: { model: "openai/subscription-model" }, entries: { pro: {} } },
      };
      await refreshPreparedModelRuntimeSnapshots(config, {
        gatewayLifecycle: true,
        catalogMode: "static",
      });
      const published = await prepareModelRuntimeSnapshot(fixture.agentInput("pro", config));
      await published.loadFullModelCatalog!({ refresh: true, wait: true });
      const changed = structuredClone(config);
      if (change === "model") {
        changed.agents!.defaults!.model = "openai/other-model";
      }
      if (change === "plugins") {
        changed.plugins = { allow: ["other-plugin"] };
      }
      await using lease = await acquireReadOnlyPreparedModelRuntime(
        {
          ...fixture.agentInput("pro", changed),
          ...(change === "agent" ? { agentId: "other" } : {}),
          ...(change === "credentials" ? { skipCredentials: true } : {}),
        },
        { catalogMode: "static" },
      );
      expect(readAdmittedPublishedModelCatalog(lease.snapshot)).toBeUndefined();
    },
  );
});
