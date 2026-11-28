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

function config(apiKey: string | undefined): OpenClawConfig {
  return {
    agents: { entries: { pro: {} } },
    models: {
      providers: {
        fixture: {
          baseUrl: "https://fixture.example.test/v1",
          ...(apiKey ? { apiKey } : {}),
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

const storedAccount = (key: string) => ({ fixture: { type: "api_key" as const, key } });

// Publishes the agent's main catalog with the fixture account's facts, as a Gateway does at start.
async function publishMainCatalog(main: OpenClawConfig) {
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
  const dispatch = await acquireAgentRunPreparedModelRuntime(
    { ...agentInput(main), allowGatewaySubagentBinding: true },
    { catalogMode: "static" },
  );
  // Static turns never rediscover; only the agent's inventory can supply the facts.
  mocks.runPreparedModelCatalogWorker.mockReset().mockRejectedValue(new Error("no discovery"));
  return { configured, dispatch };
}

function acquireWorktree(
  cfg: OpenClawConfig,
  pluginGeneration: Awaited<ReturnType<typeof publishMainCatalog>>["dispatch"]["pluginGeneration"],
  name: string,
) {
  return acquireAgentRunPreparedModelRuntime(
    {
      ...agentInput(cfg),
      allowGatewaySubagentBinding: true,
      workspaceDir: path.join(fixture.state.agentDir("pro"), "worktrees", name),
    },
    { catalogMode: "static", pluginGeneration },
  );
}

// The access check reads providerOutcomes; a turn that runs in a managed worktree must see what
// the same account sees in the main workspace, and never another account's or credential's facts.
it.each([
  ["the same direct key", { runConfig: "key-a" }, [ready]],
  ["a different direct key", { runConfig: "key-b" }, []],
  ["the same stored account", { mainAccount: "acct-a", runAccount: "acct-a" }, [ready]],
  ["a second stored account", { mainAccount: "acct-a", runAccount: "acct-b" }, []],
  ["a signed-out credential", { mainAccount: "acct-a", runAccount: undefined }, []],
] as const)(
  "gives a worktree run with %s only the account facts of its own credential",
  async (name, credential, expected) => {
    const direct = "runConfig" in credential;
    const main = config(direct ? "key-a" : undefined);
    if (!direct) {
      mocks.authStorage.getAll.mockReturnValue(storedAccount(credential.mainAccount));
    }
    const { configured, dispatch } = await publishMainCatalog(main);
    await using _dispatch = dispatch;
    if (!direct) {
      mocks.authStorage.getAll.mockReturnValue(
        credential.runAccount ? storedAccount(credential.runAccount) : {},
      );
    }

    await using worktree = await acquireWorktree(
      direct && credential.runConfig !== "key-a" ? config(credential.runConfig) : main,
      dispatch.pluginGeneration,
      name,
    );

    expect(worktree.snapshot).not.toBe(configured);
    expect(outcomesOf(worktree.snapshot)).toEqual(
      expected.map((row) => expect.objectContaining(row)),
    );
  },
);

it("drops the account facts on the next worktree turn after the credential rotates", async () => {
  mocks.authStorage.getAll.mockReturnValue(storedAccount("acct-a"));
  const main = config(undefined);
  const { dispatch } = await publishMainCatalog(main);
  await using _dispatch = dispatch;
  {
    await using first = await acquireWorktree(main, dispatch.pluginGeneration, "rotation");
    expect(outcomesOf(first.snapshot)).toEqual([expect.objectContaining(ready)]);
  }

  // The auth store reports a sign-in change; prepared owners holding the old account go stale.
  mocks.authStorage.getAll.mockReturnValue(storedAccount("acct-b"));
  mocks.credentialsRevision += 1;
  mocks.mutationListener?.({
    agentDir: fixture.state.agentDir("pro"),
    affectsInheritedStores: false,
  });
  // A turn still pinned to the old generation is refused, not served the old account's facts.
  await expect(acquireWorktree(main, dispatch.pluginGeneration, "rotation")).rejects.toThrow(
    "superseded",
  );
  // The next turn admits a fresh dispatch, as Gateway admission does.
  await using nextDispatch = await acquireAgentRunPreparedModelRuntime(
    { ...agentInput(main), allowGatewaySubagentBinding: true },
    { catalogMode: "static" },
  );
  await using next = await acquireWorktree(main, nextDispatch.pluginGeneration, "rotation");

  expect(outcomesOf(next.snapshot)).toEqual([]);
});
