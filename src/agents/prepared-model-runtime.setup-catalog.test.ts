// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { usePreparedModelRuntimeHarness } from "./prepared-model-runtime.test-harness.js";
import { expect, it } from "vitest";
import { retainLegacyDefaultAgentId } from "../config/legacy.default-agent-owner.js";
import { publishConfiguredModelRuntimeSnapshots } from "../gateway/server-startup-model-runtime.js";
import type { Model } from "../llm/types.js";
import { resolveSystemAgentConfiguredRouteFromConfig } from "../system-agent/inference-route.js";
import {
  acquireReadOnlyPreparedModelRuntime,
  prepareModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";

const fixture = usePreparedModelRuntimeHarness({ label: "setup-published-catalog" });
const model: Model = {
  id: "gpt-5.4-codex",
  name: "Subscription fixture",
  provider: "openai",
  api: "openai-chatgpt-responses",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 8192,
};

async function setupInput(
  ownerAllowsSubagents = true,
): Promise<Parameters<typeof acquireReadOnlyPreparedModelRuntime>[0]> {
  const config = retainLegacyDefaultAgentId(
    { agents: { defaults: { model: "openai/gpt-5.4-codex" }, entries: { default: {} } } },
    "default",
  );
  const { mocks } = fixture;
  mocks.configuredAgentIds = ["default"];
  if (ownerAllowsSubagents) {
    await publishConfiguredModelRuntimeSnapshots({
      cfg: config,
      workspaceDir: fixture.state.workspaceDir,
    });
  } else {
    await refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
      catalogMode: "static",
      defaultWorkspaceDir: fixture.state.workspaceDir,
    });
  }
  const input = fixture.agentInput("default", config);
  const owner = await prepareModelRuntimeSnapshot(input);
  mocks.runPreparedModelCatalogWorker.mockResolvedValue({
    entries: [model],
    routeVariants: [model],
  });
  mocks.publishedRuntimeModels = new Map([["openai", [model]]]);
  await owner.loadFullModelCatalog!({ refresh: true });
  mocks.resolveNativeModelPrimary.mockReturnValue("openai/gpt-5.4-codex");
  const route = await resolveSystemAgentConfiguredRouteFromConfig(config, "default");
  if (!route) throw new Error("Missing setup route");
  return {
    ...input,
    config: route.runConfig,
    workspaceDir: fixture.state.workspaceDir + "/probe",
    loadRuntimePlugins: true,
    runtimePluginPurpose: "isolated-completion" as const,
    runtimePluginSelections: [{ provider: "openai", modelId: model.id, runtime: "openclaw" }],
  };
}

it("keeps the configured subscription route in a read-only setup probe with its own workspace", async () => {
  const input = await setupInput();
  await using lease = await acquireReadOnlyPreparedModelRuntime(input, { catalogMode: "static" });
  expect(
    lease.snapshot
      .readPublishedModels?.()
      ?.get("openai")
      ?.map(({ api, baseUrl }) => ({ api, baseUrl })),
  ).toEqual([
    { api: "openai-chatgpt-responses", baseUrl: "https://chatgpt.com/backend-api/codex" },
  ]);
  expect(lease.snapshot.allowGatewaySubagentBinding).not.toBe(true);
});

it.each([
  "provider settings",
  "setup projection",
  "agent",
  "execution purpose",
  "binding demand",
] as const)("does not borrow configured routes after changing %s", async (change) => {
  const input = await setupInput(change !== "binding demand");
  if (change === "provider settings") {
    input.config = {
      ...input.config,
      models: {
        providers: {
          openai: {
            api: "openai-responses",
            baseUrl: "https://different.example.test/v1",
            models: [],
          },
        },
      },
    };
  } else if (change === "setup projection") {
    input.config = structuredClone(input.config);
    input.config.agents!.entries!.openclaw = { params: { temperature: 0.5 } };
  } else if (change === "agent") {
    input.agentId = "another-agent";
  } else if (change === "binding demand") {
    input.allowGatewaySubagentBinding = true;
  }
  await using lease = await acquireReadOnlyPreparedModelRuntime(
    change === "execution purpose" ? { ...input, runtimePluginPurpose: undefined } : input,
    { catalogMode: "static" },
  );
  expect(lease.snapshot.readPublishedModels?.()?.get("openai") ?? []).toEqual([]);
});
