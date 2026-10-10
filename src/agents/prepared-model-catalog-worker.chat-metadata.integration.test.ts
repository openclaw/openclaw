import fs from "node:fs";
import path from "node:path";
import pMap from "p-map";
import { describe, expect, it, vi } from "vitest";
import type { AgentEntryConfig } from "../config/types.agents.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { ChatMetadataSnapshotUnavailableError } from "../gateway/server-methods/chat-metadata-facts.js";
import { createGatewayChatMetadataRuntime } from "../gateway/server-methods/chat-metadata-runtime.js";
import type { GatewayRequestContext } from "../gateway/server-methods/types.js";
import { unregisterResolvedAgentDir } from "./agent-dir-registry.js";
import { resolveAgentDir } from "./agent-scope-config.js";
import {
  encodePluginModelCatalogRelativePath,
  loadPersistedPluginModelCatalogsReadOnly,
  replacePersistedPluginModelCatalogs,
} from "./plugin-model-catalog.js";
import {
  createCatalogFixture,
  EXTERNAL_AUTH_PATH_ENV,
  PROVIDER_ID,
  REF_ONLY_API_ENV,
  REF_ONLY_TOKEN_ENV,
} from "./prepared-model-catalog-worker.test-support.js";
import { getPublishedPreparedModelCatalogOwnerSnapshot } from "./prepared-model-catalog.js";
import {
  refreshPreparedModelRuntimeSnapshots,
  prepareModelRuntimeSnapshot,
  type PreparedModelRuntimeSnapshot,
} from "./prepared-model-runtime.js";
import { usePreparedCatalogWorkerFixtures } from "./test-helpers/prepared-model-catalog-worker-fixture.js";

const { makeTempDir, retireAfterTest } = usePreparedCatalogWorkerFixtures();

describe("chat metadata with published model owners", () => {
  it.each([{ shape: "entries", count: 64 }] as const)(
    "bounds unchanged refresh work for $count $shape agents and observes roster replacement",
    async ({ count }) => {
      const fixture = await createCatalogFixture(makeTempDir, 0);
      const pluginCatalogWrites = Object.fromEntries(
        loadPersistedPluginModelCatalogsReadOnly(fixture.agentDir).map(({ pluginId, contents }) => [
          encodePluginModelCatalogRelativePath(pluginId),
          contents,
        ]),
      );
      const expectedModel = expect.objectContaining({ provider: PROVIDER_ID, id: "sqlite-model" });
      for (const name of [
        "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
        "OPENCLAW_STATE_DIR",
        "OPENCLAW_WORKER_CATALOG_MARKER",
        EXTERNAL_AUTH_PATH_ENV,
        REF_ONLY_API_ENV,
        REF_ONLY_TOKEN_ENV,
      ] as const) {
        vi.stubEnv(name, fixture.env[name]);
      }
      let counting = false;
      let reads = 0;
      const entries: Record<string, AgentEntryConfig> = {};
      const config: OpenClawConfig = {
        ...fixture.config,
        agents: {
          ...fixture.config.agents,
          defaults: {
            ...fixture.config.agents.defaults,
            authInheritance: { agentId: "main" },
          },
          entries,
        },
      };
      // Publication consumes config data; read-counting proxies belong only to the observer.
      const observedConfig: OpenClawConfig = {
        ...config,
        agents: {
          ...config.agents,
          entries: new Proxy(entries, {
            get(target, key, receiver) {
              reads += counting && Object.hasOwn(target, key) ? 1 : 0;
              return Reflect.get(target, key, receiver);
            },
          }),
        },
      };
      const add = async (id: string) => {
        const entry = {
          id,
          agentDir: path.join(fixture.root, "agents", id),
          workspace: path.join(fixture.root, "workspaces", id),
        };
        fs.mkdirSync(entry.agentDir, { recursive: true });
        fs.mkdirSync(entry.workspace, { recursive: true });
        entries[id] = { agentDir: entry.agentDir, workspace: entry.workspace };
        retireAfterTest(() => {
          unregisterResolvedAgentDir({ agentId: id, agentDir: entry.agentDir, env: fixture.env });
        });
        await replacePersistedPluginModelCatalogs({
          agentDir: resolveAgentDir(config, id, fixture.env),
          pluginCatalogWrites,
        });
        return entry;
      };
      // Exercise a large roster without exhausting broker slots during fixture writes.
      const configured = await pMap(
        Array.from({ length: count }, (_, index) => (index === 0 ? "main" : `agent-${index}`)),
        add,
        { concurrency: 2, stopOnError: false },
      );
      const published = new Map<string, PreparedModelRuntimeSnapshot>();
      const publicationOptions = {
        gatewayLifecycle: true,
        catalogMode: "static" as const,
        allowGatewaySubagentBinding: true,
      };
      const observePublication = async (entry: Awaited<ReturnType<typeof add>>) => {
        const snapshot = await prepareModelRuntimeSnapshot({
          agentId: entry.id,
          agentDir: entry.agentDir,
          config,
        });
        expect(snapshot.modelCatalog.entries).toContainEqual(expectedModel);
        published.set(entry.id, snapshot);
        expect(getPublishedPreparedModelCatalogOwnerSnapshot({ agentId: entry.id, config })).toBe(
          snapshot,
        );
        return snapshot;
      };
      const publish = async (entry: Awaited<ReturnType<typeof add>>) => {
        await refreshPreparedModelRuntimeSnapshots(config, {
          ...publicationOptions,
          agentIds: new Set([entry.id]),
        });
        return await observePublication(entry);
      };
      await refreshPreparedModelRuntimeSnapshots(config, publicationOptions);
      await Promise.all(configured.map(observePublication));
      let builds = 0;
      // Projection leaves are supplied below; the real roster and published-owner chain is retained.
      const context = {} as GatewayRequestContext;
      const runtime = createGatewayChatMetadataRuntime({
        getConfig: () => observedConfig,
        getContext: () => context,
        log: {
          warn: (message) => {
            throw new Error(message);
          },
        },
        deps: {
          buildCommands: async ({ agentId }) => ({ commands: [{ name: agentId }] }),
          buildProjection: async ({ facts }) => {
            builds += 1;
            expect(facts.owner).toBe(published.get(facts.agentId));
            return {
              modelCatalog: facts.modelCatalog.entries,
              read: () => ({ models: facts.modelCatalog.entries }),
              isCurrent: facts.owner.isCurrent,
            };
          },
        },
      });
      try {
        await runtime.refresh();
        expect(builds).toBe(0);
        counting = true;
        try {
          await runtime.refresh();
        } finally {
          counting = false;
        }
        const unchangedReads = reads;
        expect(unchangedReads).toBeGreaterThan(0);
        expect(builds).toBe(0);
        for (const entry of configured) {
          await expect(runtime.readStartup({ agentId: entry.id })).resolves.toBeUndefined();
          expect((await runtime.read({ agentId: entry.id })).models).toContainEqual(expectedModel);
          const output = await runtime.readStartup({ agentId: entry.id, readPolicy: "ready" });
          expect(output).toEqual({
            defaultModelCatalog: published.get(entry.id)!.modelCatalog.entries,
            sessionModelCatalog: published.get(entry.id)!.modelCatalog.entries,
          });
        }
        const replacement = await publish(configured[0]!);
        await runtime.refresh();
        expect(builds).toBe(count);
        expect(getPublishedPreparedModelCatalogOwnerSnapshot({ agentId: "main", config })).toBe(
          replacement,
        );
        expect((await runtime.read({ agentId: "main" })).models).toContainEqual(expectedModel);
        expect(builds).toBe(count + 1);
        const added = await add("added");
        await expect(runtime.refresh()).rejects.toBeInstanceOf(
          ChatMetadataSnapshotUnavailableError,
        );
        await publish(added);
        await runtime.refresh();
        expect((await runtime.read({ agentId: "added" })).models).toContainEqual(expectedModel);
        expect(builds).toBe(count + 2);
        delete entries.added;
        await runtime.refresh();
        await expect(runtime.read({ agentId: "added" })).rejects.toBeInstanceOf(
          ChatMetadataSnapshotUnavailableError,
        );
        expect(builds).toBe(count + 2);
        // Leave substantial linear headroom; fail repeated per-agent roster traversal.
        expect(unchangedReads).toBeLessThanOrEqual(8 * count);
      } finally {
        await runtime.stop();
      }
    },
  );
});
