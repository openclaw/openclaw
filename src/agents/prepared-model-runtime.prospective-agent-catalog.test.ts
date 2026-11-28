// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { usePreparedModelRuntimeHarness } from "./prepared-model-runtime.test-harness.js";
import { describe, expect, it } from "vitest";
import { applyAgentConfig } from "../commands/agents.config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSystemAgentConfiguredRouteFromConfig } from "../system-agent/inference-route.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import { readAdmittedPublishedModelCatalog } from "./prepared-model-runtime.capture.js";
import {
  acquireReadOnlyPreparedModelRuntime,
  prepareModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";

const fixture = usePreparedModelRuntimeHarness();

describe("prospective agent creation inherits published subscription catalog", () => {
  it("reuses the default agent's published subscription catalog when verifying a new agent candidate", async () => {
    const { mocks } = fixture;
    mocks.configuredAgentIds = ["main"];
    mocks.resolveNativeModelPrimary.mockReturnValue("openai/gpt-6.1-terra");
    const subscriptionEntry: ModelCatalogEntry = {
      provider: "openai",
      id: "gpt-6.1-terra",
      name: "GPT-6.1 Terra",
      api: "openai-chatgpt-responses",
      contextWindow: 128000,
      reasoning: true,
    };
    mocks.runPreparedModelCatalogWorker.mockResolvedValue({
      entries: [subscriptionEntry],
      routeVariants: [subscriptionEntry],
    });
    const config: OpenClawConfig = {
      agents: { defaults: { model: "openai/gpt-6.1-terra" }, entries: { main: {} } },
    };
    await refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
      catalogMode: "static",
    });
    const mainPublished = await prepareModelRuntimeSnapshot(fixture.agentInput("main", config));
    await mainPublished.loadFullModelCatalog!({ refresh: true, wait: true });

    const candidate = applyAgentConfig(config, { agentId: "research" });
    const route = await resolveSystemAgentConfiguredRouteFromConfig(candidate, "research", {
      pluginMetadataPlugins: [],
    });
    expect(route).toMatchObject({
      agentId: "research",
      provider: "openai",
      model: "gpt-6.1-terra",
    });

    const mainDir = fixture.agentInput("main", config).agentDir;
    await using readOnlyLease = await acquireReadOnlyPreparedModelRuntime(
      {
        ...fixture.agentInput("research", candidate),
        inheritedAuthDir: mainDir,
      },
      { catalogMode: "static" },
    );
    const readOnlyCatalog = readAdmittedPublishedModelCatalog(readOnlyLease.snapshot);
    expect(readOnlyCatalog?.entries).toContainEqual(
      expect.objectContaining({
        provider: "openai",
        id: "gpt-6.1-terra",
        api: "openai-chatgpt-responses",
      }),
    );
  });

  it("does not inherit the default agent's catalog when candidate provider config diverges", async () => {
    const { mocks } = fixture;
    mocks.configuredAgentIds = ["main"];
    const subscriptionEntry: ModelCatalogEntry = {
      provider: "openai",
      id: "gpt-6.1-terra",
      name: "GPT-6.1 Terra",
      api: "openai-chatgpt-responses",
      contextWindow: 128000,
      reasoning: true,
    };
    mocks.runPreparedModelCatalogWorker.mockResolvedValue({
      entries: [subscriptionEntry],
      routeVariants: [subscriptionEntry],
    });
    const config: OpenClawConfig = {
      agents: { defaults: { model: "openai/gpt-6.1-terra" }, entries: { main: {} } },
    };
    await refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
      catalogMode: "static",
    });
    const mainPublished = await prepareModelRuntimeSnapshot(fixture.agentInput("main", config));
    await mainPublished.loadFullModelCatalog!({ refresh: true, wait: true });

    const candidate: OpenClawConfig = {
      ...applyAgentConfig(config, { agentId: "research" }),
      models: {
        providers: {
          openai: {
            baseUrl: "https://custom.example.invalid/v1",
            models: [],
          },
        },
      },
    };
    const mainDir = fixture.agentInput("main", config).agentDir;
    await using readOnlyLease = await acquireReadOnlyPreparedModelRuntime(
      {
        ...fixture.agentInput("research", candidate),
        inheritedAuthDir: mainDir,
      },
      { catalogMode: "static" },
    );
    const readOnlyCatalog = readAdmittedPublishedModelCatalog(readOnlyLease.snapshot);
    expect(readOnlyCatalog?.entries ?? []).not.toContainEqual(
      expect.objectContaining({ api: "openai-chatgpt-responses" }),
    );
  });
});
