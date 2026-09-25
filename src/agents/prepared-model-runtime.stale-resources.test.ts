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
import { withEnvAsync } from "../test-utils/env.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
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

// A selected provider outside the configured chain forces an acquired inspection to borrow
// the full-only Gateway engine. No network request or synthetic publication owner is needed.
async function withStaleResourceFixture(
  retention: Retention,
  run: (fixture: {
    donor: PluginInstanceHandle;
    acquire: (agentId?: string) => Promise<PreparedModelRuntimeLease>;
    useEngine: (lease: PreparedModelRuntimeLease) => Promise<void>;
  }) => Promise<void>,
) {
  await withOpenClawTestState({ label: "stale-runtime-resources" }, async (state) => {
    const bundled = state.path("bundled");
    fs.mkdirSync(bundled);
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
    const config: OpenClawConfig = {
      agents: {
        entries: { main: { default: true }, sibling: {} },
        defaults: {
          workspace: state.workspaceDir,
          model: { primary: "base/model" },
          models: { "base/model": {}, [`${providerId}/model`]: {} },
        },
      },
      models: {
        mode: "replace",
        providers: Object.fromEntries(
          ["base", providerId].map((id) => [
            id,
            {
              api: "openai-completions",
              apiKey: "synthetic-test-key",
              baseUrl: "https://fixture.invalid/v1",
              models: [
                {
                  id: "model",
                  name: "Fixture model",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 8192,
                  maxTokens: 1024,
                },
              ],
            },
          ]),
        ),
      },
      plugins: {
        allow: [engineId, providerId],
        load: { paths: pluginPaths },
        entries: { [engineId]: { enabled: true }, [providerId]: { enabled: true } },
        slots: { memory: "none", contextEngine: engineId },
      },
    };
    const leases: PreparedModelRuntimeLease[] = [];
    await withEnvAsync(
      { OPENCLAW_BUNDLED_PLUGINS_DIR: bundled, OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
      async () => {
        await resetPreparedModelRuntimeSnapshotsForTest();
        clearPluginMetadataLifecycleCaches();
        try {
          const root = loadAndActivateRootPluginRegistry({
            config,
            cache: false,
            onlyPluginIds: [engineId],
            workspaceDir: state.workspaceDir,
          });
          const donor = expectDefined(
            getPluginInstance(
              expectDefined(
                root.plugins.find((record) => record.id === engineId),
                "Gateway context engine record",
              ),
            ),
            "Gateway context engine instance",
          );
          if (retention === "gateway") {
            await refreshPreparedModelRuntimeSnapshots(config, {
              gatewayLifecycle: true,
              catalogMode: "static",
            });
          }
          await run({
            donor,
            acquire: async (agentId = "main") => {
              const lease = await acquireAgentRunPreparedModelRuntime(
                {
                  config,
                  agentId,
                  agentDir: state.agentDir(agentId),
                  workspaceDir: state.workspaceDir,
                  runtimePluginSelections: [{ provider: providerId, modelId: "model", agentId }],
                },
                { retainIdleRunOwner: retention === "direct" },
              );
              leases.push(lease);
              expect(
                getPluginRegistryInspectionResources(
                  expectDefined(lease.snapshot.pluginRegistry, "selected run registry"),
                ),
              ).toBeDefined();
              return lease;
            },
            useEngine: async (lease) => {
              const engine = await withPluginRuntimeRegistryScope(
                expectDefined(lease.snapshot.pluginRegistry, "selected run registry"),
                () =>
                  createContextEngineLogicalTurnLease({
                    identity: {
                      runId: "stale-resources-turn",
                      sessionId: "stale-resources-session",
                    },
                    config,
                    workspaceDir: state.workspaceDir,
                  }),
              );
              try {
                expect(engine.degraded).toBe(false);
                await expect(
                  engine
                    .begin()
                    .engine.assemble({ sessionId: "stale-resources-session", messages: [] }),
                ).resolves.toMatchObject({ systemPromptAddition: "live donor" });
              } finally {
                await engine.dispose();
              }
            },
          });
        } finally {
          for (const lease of leases) {
            await lease[Symbol.asyncDispose]();
          }
          await resetPreparedModelRuntimeSnapshotsForTest();
          await clearActivePluginRegistry();
          resetPluginLoaderTestStateForTest();
          cleanupPluginLoaderFixturesForTest();
          clearPluginMetadataLifecycleCaches();
        }
      },
    );
  });
}

it.each(["gateway", "direct"] as const)(
  "releases idle %s publication consumers before rebuilding the stale runtime",
  async (retention) => {
    await withStaleResourceFixture(retention, async ({ acquire, donor, useEngine }) => {
      const lease = await acquire();
      await useEngine(lease);
      await lease[Symbol.asyncDispose]();
      expect(donor.hasRetainedConsumers).toBe(true);

      markPreparedModelRuntimeSnapshotsStale("plugin replacement", { waitForReplacement: true });

      await expect.poll(() => donor.hasRetainedConsumers).toBe(false);
      await expect(donor.drain({ includeConsumers: true })).resolves.toMatchObject({ errors: [] });
    });
  },
);

it("retains an active lease through staling and settles donor consumers on its final release", async () => {
  await withStaleResourceFixture("gateway", async ({ acquire, donor, useEngine }) => {
    const lease = await acquire();
    markPreparedModelRuntimeSnapshotsStale("plugin replacement", { waitForReplacement: true });
    let drained = false;
    const draining = donor.drain({ includeConsumers: true }).then((result) => {
      drained = true;
      return result;
    });
    await nextTurn();
    expect(drained).toBe(false);
    expect(donor.hasRetainedConsumers).toBe(true);
    await useEngine(lease);
    await lease[Symbol.asyncDispose]();

    await expect.poll(() => donor.hasRetainedConsumers).toBe(false);
    await expect(draining).resolves.toMatchObject({ errors: [] });
  });
});

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
