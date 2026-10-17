import fs from "node:fs";
import { setImmediate as nextTurn } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadAndActivateRootPluginRegistry } from "../plugins/loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  resetPluginLoaderTestStateForTest,
} from "../plugins/loader.test-fixtures.js";
import { getPluginInstance, type PluginInstanceHandle } from "../plugins/plugin-instance-scope.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { getPluginRegistryInspectionResources } from "../plugins/registry-inspection-resources.js";
import { clearActivePluginRegistry } from "../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { createColdPluginFixture } from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { makeModel } from "./embedded-agent-runner/model.test-harness.js";
import { createContextEngineLogicalTurnLease } from "./harness/context-engine-logical-turn.js";
import {
  acquireAgentRunPreparedModelRuntime,
  markPreparedModelRuntimeSnapshotsStale,
  refreshPreparedModelRuntimeSnapshots,
  type PreparedModelRuntimeLease,
} from "./prepared-model-runtime.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "./prepared-model-runtime.test-support.js";

const engineId = "stale-owner-engine";
const providerId = "stale-owner-provider";
type Retention = "gateway" | "direct";

// Off-chain provider selection acquires an inspection borrowing the full-only Gateway engine.
async function withStaleResourceFixture(
  retention: Retention,
  run: (fixture: {
    donor: PluginInstanceHandle;
    acquire: (agentId?: string) => Promise<PreparedModelRuntimeLease>;
    useEngine: (lease: PreparedModelRuntimeLease) => Promise<void>;
  }) => Promise<void>,
) {
  await withOpenClawTestState(
    {
      label: "stale-runtime-resources",
      env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
    },
    async (state) => {
      const pluginPaths = [engineId, providerId].map((id) => {
        const rootDir = state.path(id);
        fs.mkdirSync(rootDir);
        const fixture = createColdPluginFixture({
          rootDir,
          pluginId: id,
          manifest: {
            providers: id === providerId ? [providerId] : [],
            channels: [],
            channelConfigs: {},
            providerAuthChoices: [],
          },
        });
        fs.writeFileSync(
          fixture.runtimeSource,
          id === engineId
            ? `module.exports = { id: ${JSON.stringify(id)}, register(api) {
              if (api.registrationMode !== "full") return;
              api.registerContextEngine(${JSON.stringify(id)}, () => ({
                info: { id: ${JSON.stringify(id)}, name: "Retained donor" },
                ingest: async () => ({ ingested: false }),
                assemble: async ({ messages }) => ({ messages, estimatedTokens: 0,
                  systemPromptAddition: "live donor" }),
                compact: async () => ({ ok: true, compacted: false }),
                dispose: async () => {},
              }));
            } };`
            : `module.exports = { id: ${JSON.stringify(id)}, register(api) {
              api.registerProvider({ id: ${JSON.stringify(id)}, label: "Selected provider", auth: [] });
            } };`,
        );
        return rootDir;
      });
      const provider = () => ({
        api: "openai-completions" as const,
        apiKey: "synthetic-test-key",
        baseUrl: "https://fixture.invalid/v1",
        models: [{ ...makeModel("model"), contextWindow: 8192, maxTokens: 1024 }],
      });
      const config: OpenClawConfig = {
        agents: {
          entries: { main: {}, sibling: {} },
          defaults: {
            workspace: state.workspaceDir,
            model: { primary: "base/model" },
            models: { "base/model": {}, [`${providerId}/model`]: {} },
          },
        },
        models: {
          mode: "replace",
          providers: { base: provider(), [providerId]: provider() },
        },
        plugins: {
          allow: [engineId, providerId],
          load: { paths: pluginPaths },
          entries: { [engineId]: { enabled: true }, [providerId]: { enabled: true } },
          slots: { memory: "none", contextEngine: engineId },
        },
      };
      await resetPreparedModelRuntimeSnapshotsForTest();
      clearPluginMetadataLifecycleCaches();
      try {
        await using leases = new AsyncDisposableStack();
        const root = await loadAndActivateRootPluginRegistry({
          config,
          cache: false,
          onlyPluginIds: [engineId],
          workspaceDir: state.workspaceDir,
        });
        const record = expectDefined(
          root.plugins.find((plugin) => plugin.id === engineId),
          "Gateway context engine record",
        );
        const donor = expectDefined(getPluginInstance(record), "Gateway context engine instance");
        if (retention === "gateway") {
          await refreshPreparedModelRuntimeSnapshots(config, {
            gatewayLifecycle: true,
            catalogMode: "static",
          });
        }
        await run({
          donor,
          acquire: async (agentId = "main") => {
            const lease = leases.use(
              await acquireAgentRunPreparedModelRuntime(
                {
                  config,
                  agentId,
                  agentDir: state.agentDir(agentId),
                  workspaceDir: state.workspaceDir,
                  runtimePluginSelections: [{ provider: providerId, modelId: "model", agentId }],
                },
                { retainIdleRunOwner: retention === "direct" },
              ),
            );
            expect(
              getPluginRegistryInspectionResources(
                expectDefined(lease.snapshot.pluginRegistry, "selected run registry"),
              ),
            ).toBeDefined();
            return lease;
          },
          useEngine: async (lease) => {
            const sessionId = "stale-resources-session";
            const engine = await withPluginRuntimeRegistryScope(
              expectDefined(lease.snapshot.pluginRegistry, "selected run registry"),
              () =>
                createContextEngineLogicalTurnLease({
                  identity: {
                    runId: "stale-resources-turn",
                    sessionId,
                  },
                  config,
                  workspaceDir: state.workspaceDir,
                }),
            );
            await using _ = { [Symbol.asyncDispose]: () => engine.dispose() };
            expect(engine.degraded).toBe(false);
            await expect(
              engine.begin().engine.assemble({ sessionId, messages: [] }),
            ).resolves.toMatchObject({
              systemPromptAddition: "live donor",
            });
          },
        });
      } finally {
        await resetPreparedModelRuntimeSnapshotsForTest();
        await clearActivePluginRegistry();
        resetPluginLoaderTestStateForTest();
        cleanupPluginLoaderFixturesForTest();
        clearPluginMetadataLifecycleCaches();
      }
    },
  );
}

it.each(["direct", "gateway"] as const)(
  "releases stale %s publication consumers after the last active lease",
  async (retention) => {
    await withStaleResourceFixture(retention, async ({ acquire, donor, useEngine }) => {
      const lease = await acquire();
      if (retention === "direct") {
        await useEngine(lease);
        await lease[Symbol.asyncDispose]();
        expect(donor.hasRetainedConsumers).toBe(true);
      }
      markPreparedModelRuntimeSnapshotsStale("plugin replacement", { waitForReplacement: true });
      let draining: ReturnType<typeof donor.drain> | undefined;
      if (retention === "gateway") {
        let drained = false;
        draining = donor.drain({ includeConsumers: true }).then((result) => {
          drained = true;
          return result;
        });
        await nextTurn();
        expect(drained).toBe(false);
        expect(donor.hasRetainedConsumers).toBe(true);
        await useEngine(lease);
        await lease[Symbol.asyncDispose]();
      }
      await expect.poll(() => donor.hasRetainedConsumers).toBe(false);
      await expect(draining ?? donor.drain({ includeConsumers: true })).resolves.toMatchObject({
        errors: [],
      });
    });
  },
);

it("preserves an unaffected agent's retained resources until that scope becomes stale", async () => {
  await withStaleResourceFixture("gateway", async ({ acquire, donor, useEngine }) => {
    const main = await acquire();
    const sibling = await acquire("sibling");
    await main[Symbol.asyncDispose]();
    await sibling[Symbol.asyncDispose]();
    markPreparedModelRuntimeSnapshotsStale("main agent refresh", { agentIds: new Set(["main"]) });
    await nextTurn();

    expect(donor.hasRetainedConsumers).toBe(true);
    const retained = await acquire("sibling");
    expect(retained.snapshot).toBe(sibling.snapshot);
    await useEngine(retained);
    await retained[Symbol.asyncDispose]();
    markPreparedModelRuntimeSnapshotsStale("sibling agent refresh", {
      agentIds: new Set(["sibling"]),
    });

    await expect.poll(() => donor.hasRetainedConsumers).toBe(false);
    await expect(donor.drain({ includeConsumers: true })).resolves.toMatchObject({ errors: [] });
  });
});
