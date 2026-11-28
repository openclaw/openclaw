// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { usePreparedModelRuntimeHarness } from "./prepared-model-runtime.test-harness.js";
import path from "node:path";
import { expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import {
  acquireAgentRunPreparedModelRuntime,
  getPreparedModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";

const fixture = usePreparedModelRuntimeHarness();
const { mocks } = fixture;

const ready = { provider: "fixture", status: "ready" as const };

function config(apiKey: string): OpenClawConfig {
  return {
    agents: { entries: { pro: {} } },
    models: {
      providers: {
        fixture: {
          baseUrl: "https://fixture.example.test/v1",
          apiKey,
          models: [
            {
              id: "fixture-model",
              name: "fixture-model",
              reasoning: false,
              input: ["text"],
              contextWindow: 32_000,
              maxTokens: 4096,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    },
  };
}

const agentInput = (cfg: OpenClawConfig) => ({
  config: cfg,
  agentId: "pro",
  agentDir: fixture.state.agentDir("pro"),
});

function outcomesOf(snapshot: {
  readFullModelCatalog?: () => ModelCatalogSnapshot | undefined;
  modelCatalog?: ModelCatalogSnapshot;
}) {
  return (snapshot.readFullModelCatalog?.() ?? snapshot.modelCatalog)?.providerOutcomes ?? [];
}

// The access check reads providerOutcomes; a turn that runs in a managed worktree must see what
// the same account sees in the main workspace, and never another credential's facts.
it.each([
  ["the same direct key", "key-a", [ready]],
  ["a different direct key", "key-b", []],
] as const)(
  "gives a worktree run with %s the account facts of its credential",
  async (_name, runKey, expected) => {
    const main = config("key-a");
    mocks.configuredAgentIds = ["pro"];
    mocks.runPreparedModelCatalogWorker.mockImplementation(async () => ({
      entries: [{ provider: "fixture", id: "fixture-model", name: "fixture-model" }],
      routeVariants: [],
      providerOutcomes: [ready],
    }));
    await refreshPreparedModelRuntimeSnapshots(main, {
      gatewayLifecycle: true,
      catalogMode: "static",
      allowGatewaySubagentBinding: true,
    });
    const configured = getPreparedModelRuntimeSnapshot(agentInput(main))!;
    await configured.loadFullModelCatalog!({ refresh: true });
    expect(outcomesOf(configured)).toEqual([expect.objectContaining(ready)]);
    // A report turn reuses its dispatch's plugin generation, as admission does for worktree parents.
    await using dispatch = await acquireAgentRunPreparedModelRuntime(
      { ...agentInput(main), allowGatewaySubagentBinding: true },
      { catalogMode: "static" },
    );
    // Static turns never rediscover; only the agent's inventory can supply the facts.
    mocks.runPreparedModelCatalogWorker.mockReset().mockRejectedValue(new Error("no discovery"));

    await using worktree = await acquireAgentRunPreparedModelRuntime(
      {
        ...agentInput(runKey === "key-a" ? main : config(runKey)),
        allowGatewaySubagentBinding: true,
        workspaceDir: path.join(fixture.state.agentDir("pro"), "worktrees", runKey),
      },
      { catalogMode: "static", pluginGeneration: dispatch.pluginGeneration },
    );

    expect(worktree.snapshot).not.toBe(configured);

    expect(outcomesOf(worktree.snapshot)).toEqual(
      expected.map((row) => expect.objectContaining(row)),
    );
  },
);
