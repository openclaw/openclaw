import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { captureClawInstallSchemaVersionFacts } from "../claws/provenance-runtime-read.js";
import "../claws/tool-policy-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { unregisterResolvedAgentDir } from "./agent-dir-registry.js";
import { resolveAgentDir } from "./agent-scope-config.js";
import { saveAuthProfileStore } from "./auth-profiles/store-runtime.js";
import { createPreparedModelCatalogWorkerInput } from "./prepared-model-catalog-worker.js";
import { stubCatalogEnv } from "./prepared-model-catalog-worker.shared.test-support.js";
import {
  createCatalogFixture,
  catalogEntry,
  PROVIDER_ID,
} from "./prepared-model-catalog-worker.test-support.js";
import { prepareWorkspaceBuildGroup } from "./prepared-model-runtime.facts.js";
import { retainPreparedPluginGeneration } from "./prepared-model-runtime.plugin-lifetime.js";
import {
  createCatalogInspectionPool,
  type CatalogInspectionTask,
} from "./test-helpers/prepared-model-catalog-inspection.js";
import { usePreparedCatalogWorkerFixtures } from "./test-helpers/prepared-model-catalog-worker-fixture.js";

const { makeTempDir, retireAfterTest } = usePreparedCatalogWorkerFixtures();

async function createFixture() {
  const fixture = await createCatalogFixture(makeTempDir, 0);
  stubCatalogEnv(fixture.env);
  return fixture;
}

async function prepareInput(input: Parameters<typeof prepareWorkspaceBuildGroup>[0][number]) {
  const prepared = await prepareWorkspaceBuildGroup([input], "static");
  retireAfterTest(retainPreparedPluginGeneration(prepared.pluginGeneration));
  return createPreparedModelCatalogWorkerInput({
    agentFacts: prepared.agentFacts[0]!,
    pluginMetadataSnapshot: prepared.pluginGeneration.pluginMetadataSnapshot,
  });
}

const catalogResult = {
  status: "ok",
  kind: "catalog",
  snapshot: { entries: expect.arrayContaining([catalogEntry("plugin-generation-v1")]) },
};

function createInspector(env: NodeJS.ProcessEnv) {
  const { pool } = createCatalogInspectionPool(env);
  const request = {
    kind: "catalog" as const,
    syntheticAuth: [],
    clawInstallSchemaVersions: captureClawInstallSchemaVersionFacts({ env }),
  };
  return {
    run: (
      value: CatalogInspectionTask["value"],
      inspection?: CatalogInspectionTask["inspection"],
    ) => pool.run({ value, request, inspection }, { timeoutMs: 30_000 }),
    [Symbol.asyncDispose]: () => pool.close(),
  };
}

describe("catalog request existing directory ownership", () => {
  beforeEach(() => {
    vi.stubEnv("CODEX_HOME", makeTempDir("openclaw-directory-request-empty-codex-"));
  });

  it("serves repeated catalog requests from prepared provenance without copying shared state", async () => {
    const fixture = await createFixture();
    const value = await prepareInput({
      agentId: "main",
      agentDir: fixture.agentDir,
      config: fixture.config,
      env: fixture.env,
    });
    const database = openOpenClawStateDatabase({ env: fixture.env });
    try {
      await using inspector = createInspector(fixture.env);
      await closeOpenClawStateDatabaseByPathAsync(database.path);
      // Worker startup and the copy probe are real; this contract does not measure their latency.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
      for (let tick = 0; tick < 3; tick++) {
        const { inspection, ...result } = await inspector.run(
          value,
          tick === 0 ? { copyProbePath: database.path } : undefined,
        );
        expect(result).toMatchObject(catalogResult);
        expect(inspection.sqliteCopies).toBe(0);
        if (tick === 0) {
          expect(inspection.copyHookObserved).toBe(true);
        }
      }
    } finally {
      vi.useRealTimers();
      await closeOpenClawStateDatabaseByPathAsync(database.path);
    }
  });

  it.each([
    { label: "same normalized owner", existing: ["MAIN"], conflict: false },
    { label: "foreign owner", existing: ["foreign"], conflict: true },
    { label: "ambiguous owners", existing: ["main", "foreign"], conflict: true },
  ])("preserves $label across the request", async ({ existing, conflict }) => {
    const fixture = await createFixture();
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
    const value = structuredClone(
      await prepareInput({
        agentId: "main",
        agentDir,
        inheritedAuthDir: agentDir,
        config,
        env: fixture.env,
      }),
    );
    unregisterResolvedAgentDir({ agentId: "main", agentDir, env: fixture.env });
    await using inspector = createInspector(fixture.env);
    const { inspection, ...result } = await inspector.run(value, { existingAgentIds: existing });
    if (conflict) {
      expect(result).toEqual({
        status: "failed",
        authCredentials: [],
        error: `Conflicting registered agent owners for ${agentDir}`,
      });
      expect(fs.existsSync(fixture.marker)).toBe(false);
      expect(inspection.foreignReleased).toBe(true);
    } else {
      expect(result).toMatchObject(catalogResult);
      expect(fs.readFileSync(fixture.marker, "utf8")).toBe("start\ndone\n");
    }
    expect(inspection.registeredAgentId).toBe(
      existing.some((agentId) => agentId.toLowerCase() === "main") ? "main" : undefined,
    );
  });
});
