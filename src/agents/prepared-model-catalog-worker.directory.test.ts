import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { captureClawInstallSchemaVersionFacts } from "../claws/provenance-runtime-read.js";
import "../claws/tool-policy-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as sqliteSnapshots from "../infra/sqlite-snapshot-source.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  registerResolvedAgentDir,
  resolveRegisteredAgentIdForDir,
  unregisterResolvedAgentDir,
} from "./agent-dir-registry.js";
import { resolveAgentDir } from "./agent-scope-config.js";
import { saveAuthProfileStore } from "./auth-profiles/store-runtime.js";
import { createPreparedModelCatalogWorkerInput } from "./prepared-model-catalog-worker.js";
import {
  createCatalogFixture,
  EXTERNAL_AUTH_PATH_ENV,
  PROVIDER_ID,
  REF_ONLY_API_ENV,
  REF_ONLY_TOKEN_ENV,
} from "./prepared-model-catalog-worker.test-support.js";
import { runPreparedModelCatalogWorkerRequest } from "./prepared-model-catalog.worker.js";
import { prepareWorkspaceBuildGroup } from "./prepared-model-runtime.facts.js";
import { retainPreparedPluginGeneration } from "./prepared-model-runtime.plugin-lifetime.js";
import { usePreparedCatalogWorkerFixtures } from "./test-helpers/prepared-model-catalog-worker-fixture.js";

vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  parentPort: null,
}));

const { makeTempDir, retireAfterTest } = usePreparedCatalogWorkerFixtures();

describe("catalog request existing directory ownership", () => {
  beforeEach(() => {
    vi.stubEnv("CODEX_HOME", makeTempDir("openclaw-directory-request-empty-codex-"));
  });

  it("serves repeated catalog requests from prepared provenance without copying shared state", async () => {
    const fixture = createCatalogFixture(makeTempDir, 0);
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
    const prepared = await prepareWorkspaceBuildGroup(
      [{ agentId: "main", agentDir: fixture.agentDir, config: fixture.config, env: fixture.env }],
      "static",
    );
    retireAfterTest(retainPreparedPluginGeneration(prepared.pluginGeneration));
    const value = createPreparedModelCatalogWorkerInput({
      agentFacts: prepared.agentFacts[0]!,
      pluginMetadataSnapshot: prepared.pluginGeneration.pluginMetadataSnapshot,
    });
    const database = openOpenClawStateDatabase({ env: fixture.env });
    const clawInstallSchemaVersions = captureClawInstallSchemaVersionFacts({ env: fixture.env });
    await closeOpenClawStateDatabaseByPathAsync(database.path);
    const copy = vi.spyOn(sqliteSnapshots, "prepareSqliteReadOnlyLocationSync");
    try {
      for (let tick = 0; tick < 3; tick++) {
        const result = await runPreparedModelCatalogWorkerRequest(
          structuredClone(value),
          structuredClone({ kind: "catalog", syntheticAuth: [], clawInstallSchemaVersions }),
        );
        expect(result).toMatchObject({
          status: "ok",
          kind: "catalog",
          snapshot: {
            entries: expect.arrayContaining([
              expect.objectContaining({ provider: PROVIDER_ID, id: "plugin-generation-v1" }),
            ]),
          },
        });
      }
      expect(copy).not.toHaveBeenCalled();
    } finally {
      copy.mockRestore();
      await closeOpenClawStateDatabaseByPathAsync(database.path);
    }
  });

  it.each([
    { label: "same normalized owner", existing: ["MAIN"], conflict: false },
    { label: "foreign owner", existing: ["foreign"], conflict: true },
    { label: "ambiguous owners", existing: ["main", "foreign"], conflict: true },
  ])("preserves $label across the request", async ({ existing, conflict }) => {
    const fixture = createCatalogFixture(makeTempDir, 0);
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
    const config = {
      ...fixture.config,
      agents: {
        ...fixture.config.agents,
        entries: { main: { agentDir: path.join(fixture.root, "custom-owner", "agent") } },
      },
    } satisfies OpenClawConfig;
    const agentDir = resolveAgentDir(config, "main", fixture.env);
    retireAfterTest(() => {
      unregisterResolvedAgentDir({ agentId: "main", agentDir, env: fixture.env });
      unregisterResolvedAgentDir({ agentId: "foreign", agentDir, env: fixture.env });
    });
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [`${PROVIDER_ID}:main`]: {
            type: "api_key",
            provider: PROVIDER_ID,
            key: "existing-owner-key-not-real",
          },
        },
      },
      agentDir,
    );
    const prepared = await prepareWorkspaceBuildGroup(
      [{ agentId: "main", agentDir, inheritedAuthDir: agentDir, config, env: fixture.env }],
      "static",
    );
    retireAfterTest(retainPreparedPluginGeneration(prepared.pluginGeneration));
    const value = structuredClone(
      createPreparedModelCatalogWorkerInput({
        agentFacts: prepared.agentFacts[0]!,
        pluginMetadataSnapshot: prepared.pluginGeneration.pluginMetadataSnapshot,
      }),
    );
    unregisterResolvedAgentDir({ agentId: "main", agentDir, env: fixture.env });
    for (const agentId of existing) {
      registerResolvedAgentDir({ agentId, agentDir, env: fixture.env });
    }
    const result = await runPreparedModelCatalogWorkerRequest(value, {
      kind: "catalog",
      syntheticAuth: [],
      clawInstallSchemaVersions: captureClawInstallSchemaVersionFacts({ env: fixture.env }),
    });
    if (conflict) {
      expect(result).toEqual({
        status: "failed",
        error: `Conflicting registered agent owners for ${agentDir}`,
      });
      expect(fs.existsSync(fixture.marker)).toBe(false);
      expect(unregisterResolvedAgentDir({ agentId: "foreign", agentDir, env: fixture.env })).toBe(
        true,
      );
    } else {
      expect(result).toMatchObject({
        status: "ok",
        kind: "catalog",
        snapshot: {
          entries: expect.arrayContaining([
            expect.objectContaining({ provider: PROVIDER_ID, id: "plugin-generation-v1" }),
          ]),
        },
      });
      expect(fs.readFileSync(fixture.marker, "utf8")).toBe("start\ndone\n");
    }
    expect(resolveRegisteredAgentIdForDir(agentDir, fixture.env)).toBe(
      existing.some((agentId) => agentId.toLowerCase() === "main") ? "main" : undefined,
    );
  });
});
