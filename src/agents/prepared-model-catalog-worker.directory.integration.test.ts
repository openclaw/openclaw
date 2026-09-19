import fs from "node:fs";
import path from "node:path";
import { threadId } from "node:worker_threads";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { unregisterResolvedAgentDir } from "./agent-dir-registry.js";
import { resolveAgentDir } from "./agent-scope-config.js";
import { saveAuthProfileStore } from "./auth-profiles/store-runtime.js";
import {
  createPreparedModelCatalogWorker,
  getPreparedModelCatalogWorkerPoolSnapshot,
} from "./prepared-model-catalog-worker.js";
import {
  createCatalogFixture,
  EXTERNAL_AUTH_PATH_ENV,
  PROVIDER_ID,
  REF_ONLY_API_ENV,
  REF_ONLY_TOKEN_ENV,
} from "./prepared-model-catalog-worker.test-support.js";
import { getPreparedModelFullCatalogAuth } from "./prepared-model-runtime-auth.js";
import { prepareWorkspaceBuildGroup } from "./prepared-model-runtime.facts.js";
import { retainPreparedPluginGeneration } from "./prepared-model-runtime.plugin-lifetime.js";
import {
  readCatalogDiscoveryCaptures,
  usePreparedCatalogWorkerFixtures,
} from "./test-helpers/prepared-model-catalog-worker-fixture.js";

const { makeTempDir, retireAfterTest } = usePreparedCatalogWorkerFixtures();

describe("catalog worker captured directory ownership", () => {
  beforeEach(() => {
    vi.stubEnv("CODEX_HOME", makeTempDir("openclaw-directory-empty-codex-"));
  });

  it.each([
    { owner: "Gateway", directory: "state/agents/main/agent" },
    { owner: "Gateway", directory: "custom-owner/agent" },
    { owner: "Gateway", directory: "custom-catalog" },
    { owner: "standalone", directory: "custom-owner/agent" },
    { owner: "standalone", directory: "custom-catalog" },
  ])("$owner catalog discovers main in $directory", async ({ owner, directory }) => {
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
        entries: {
          main: {
            agentDir: path.join(fixture.root, directory),
            workspace: fixture.workspaceDir,
          },
        },
      },
    } satisfies OpenClawConfig;
    const agentDir = resolveAgentDir(config, "main", fixture.env);
    let current = true;
    const retirement = new AbortController();
    retireAfterTest(() => {
      current = false;
      retirement.abort();
      unregisterResolvedAgentDir({ agentId: "main", agentDir, env: fixture.env });
    });
    const profileId = `${PROVIDER_ID}:directory-main`;
    const profile = {
      type: "api_key" as const,
      provider: PROVIDER_ID,
      key: "directory-main-key-not-real",
    };
    saveAuthProfileStore({ version: 1, profiles: { [profileId]: profile } }, agentDir);
    expect(fs.existsSync(path.join(agentDir, "openclaw-agent.sqlite"))).toBe(true);
    const prepared = await prepareWorkspaceBuildGroup(
      [
        {
          agentId: "main",
          agentDir,
          inheritedAuthDir: agentDir,
          workspaceDir: fixture.workspaceDir,
          config,
          ...(owner === "Gateway" ? { allowGatewaySubagentBinding: true } : { env: fixture.env }),
        },
      ],
      "static",
    );
    retireAfterTest(retainPreparedPluginGeneration(prepared.pluginGeneration));
    const worker = createPreparedModelCatalogWorker({
      agentFacts: prepared.agentFacts[0]!,
      pluginMetadataSnapshot: prepared.pluginGeneration.pluginMetadataSnapshot,
      pluginRegistry: prepared.pluginGeneration.pluginRegistry,
      isCurrent: () => current,
      retirementSignal: retirement.signal,
    });
    expect(fs.existsSync(fixture.marker)).toBe(false);
    for (const attempt of [1, 2]) {
      const { modelCatalog } = await worker.loadCatalog();
      expect(modelCatalog.entries).toContainEqual(
        expect.objectContaining({ provider: PROVIDER_ID, id: "plugin-generation-v1" }),
      );
      expect(getPreparedModelFullCatalogAuth(modelCatalog)?.authStore.profiles[profileId]).toEqual(
        profile,
      );
      expect(fs.readFileSync(fixture.marker, "utf8")).toBe("start\ndone\n".repeat(attempt));
    }
    const workerThreads = new Set(
      readCatalogDiscoveryCaptures(fixture.root)
        .filter((capture) => capture.threadId !== threadId)
        .map((capture) => capture.threadId),
    );
    expect(workerThreads.size).toBe(1);
    if (owner === "Gateway") {
      expect(getPreparedModelCatalogWorkerPoolSnapshot()).toMatchObject({
        workersCreated: 1,
        workers: 1,
        activeTasks: 0,
        pendingTasks: 0,
      });
    }
  });

  it("isolates custom-directory agents and releases ownership after successful and failed requests", async () => {
    const fixture = createCatalogFixture(makeTempDir, 0);
    vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
    vi.stubEnv("OPENCLAW_STATE_DIR", fixture.env.OPENCLAW_STATE_DIR);
    const observations = path.join(fixture.root, "directory-catalog.jsonl");
    const pluginDir = path.join(fixture.root, "plugin");
    const pluginFile = path.join(pluginDir, "index.cjs");
    fs.writeFileSync(
      pluginFile,
      `const fs = require("node:fs");
module.exports = {
  id: ${JSON.stringify(PROVIDER_ID)},
  register(api) {
    api.registerProvider({
      id: ${JSON.stringify(PROVIDER_ID)}, label: "Directory catalog", auth: [],
      staticCatalog: { run: async () => ({ provider: {
        baseUrl: "https://directory.invalid/v1", api: "openai-completions", models: [],
      } }) },
      catalog: { run: async (context) => {
        const auth = context.resolveProviderApiKey(${JSON.stringify(PROVIDER_ID)});
        const modelId = { "alpha-key-not-real": "alpha-model", "beta-key-not-real": "beta-model" }[auth.discoveryApiKey];
        fs.appendFileSync(${JSON.stringify(observations)}, JSON.stringify({
          agentDir: context.agentDir, profileId: auth.profileId,
          threadId: require("node:worker_threads").threadId,
        }) + "\\n");
        if (!modelId) throw new Error("Unexpected directory credential");
        return { provider: {
          baseUrl: "https://directory.invalid/v1", api: "openai-completions",
          models: [{ id: modelId, name: modelId }],
        } };
      } },
    });
  },
};`,
    );
    fs.writeFileSync(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: PROVIDER_ID,
        providers: [PROVIDER_ID],
        providerCatalogEntry: "./index.cjs",
        modelCatalog: { discovery: { [PROVIDER_ID]: "runtime" } },
        configSchema: { type: "object", additionalProperties: false, properties: {} },
      }),
    );
    const entries = {
      alpha: { agentDir: path.join(fixture.root, "custom-owner", "agent") },
      beta: { agentDir: path.join(fixture.root, "custom-catalog") },
      foreign: { agentDir: path.join(fixture.root, "other-parent", "agent") },
    };
    const config: OpenClawConfig = {
      agents: { defaults: { model: `${PROVIDER_ID}/selected-model` }, entries },
      plugins: {
        allow: [PROVIDER_ID],
        load: { paths: [pluginFile] },
        entries: { [PROVIDER_ID]: { enabled: true } },
      },
    };
    let current = true;
    const retirement = new AbortController();
    retireAfterTest(() => {
      current = false;
      retirement.abort();
      for (const [agentId, { agentDir }] of Object.entries(entries)) {
        unregisterResolvedAgentDir({ agentId, agentDir });
      }
    });
    for (const agentId of ["alpha", "beta", "foreign"] as const) {
      saveAuthProfileStore(
        {
          version: 1,
          profiles: {
            [`${PROVIDER_ID}:${agentId}`]: {
              type: "api_key",
              provider: PROVIDER_ID,
              key: `${agentId}-key-not-real`,
            },
          },
        },
        resolveAgentDir(config, agentId),
      );
    }
    const prepared = await prepareWorkspaceBuildGroup(
      (["alpha", "beta"] as const).map((agentId) => ({
        agentId,
        agentDir: entries[agentId].agentDir,
        inheritedAuthDir: entries[agentId].agentDir,
        workspaceDir: fixture.workspaceDir,
        allowGatewaySubagentBinding: true,
        config,
      })),
      "static",
    );
    retireAfterTest(retainPreparedPluginGeneration(prepared.pluginGeneration));
    const createWorker = (agentFacts: (typeof prepared.agentFacts)[number]) =>
      createPreparedModelCatalogWorker({
        agentFacts,
        pluginMetadataSnapshot: prepared.pluginGeneration.pluginMetadataSnapshot,
        pluginRegistry: prepared.pluginGeneration.pluginRegistry,
        isCurrent: () => current,
        retirementSignal: retirement.signal,
      });
    const workers = prepared.agentFacts.map(createWorker);
    for (const attempt of [1, 2]) {
      const catalogs = await Promise.all(workers.map((worker) => worker.loadCatalog()));
      for (const [index, agentId] of ["alpha", "beta"].entries()) {
        const catalog = catalogs[index]!.modelCatalog;
        expect(catalog.entries).toContainEqual(
          expect.objectContaining({ provider: PROVIDER_ID, id: `${agentId}-model` }),
        );
        expect(catalog.entries).not.toContainEqual(
          expect.objectContaining({ id: `${agentId === "alpha" ? "beta" : "alpha"}-model` }),
        );
        expect(getPreparedModelFullCatalogAuth(catalog)?.authStore.profiles).toEqual({
          [`${PROVIDER_ID}:${agentId}`]: {
            type: "api_key",
            provider: PROVIDER_ID,
            key: `${agentId}-key-not-real`,
          },
        });
      }
      expect(fs.readFileSync(observations, "utf8").trim().split("\n")).toHaveLength(attempt * 2);
    }
    const alpha = prepared.agentFacts[0]!;
    const anonymous = createWorker({ ...alpha, input: { ...alpha.input, agentId: undefined } });
    const beforeRejection = fs.readFileSync(observations, "utf8");
    await expect(anonymous.loadCatalog()).rejects.toThrow(
      "belongs to agent alpha; requested agent custom-owner",
    );
    const wrongOwner = createWorker({
      ...alpha,
      input: {
        ...alpha.input,
        agentDir: entries.foreign.agentDir,
        inheritedAuthDir: entries.foreign.agentDir,
      },
    });
    await expect(wrongOwner.loadCatalog()).rejects.toThrow(
      "belongs to agent foreign; requested agent alpha",
    );
    const anonymousAfterFailure = createWorker({
      ...alpha,
      input: {
        ...alpha.input,
        agentId: undefined,
        agentDir: entries.foreign.agentDir,
        inheritedAuthDir: entries.foreign.agentDir,
      },
    });
    await expect(anonymousAfterFailure.loadCatalog()).rejects.toThrow(
      "belongs to agent foreign; requested agent other-parent",
    );
    expect(fs.readFileSync(observations, "utf8")).toBe(beforeRejection);
    const next = await workers[1]!.loadCatalog();
    expect(next.modelCatalog.entries).toContainEqual(
      expect.objectContaining({ provider: PROVIDER_ID, id: "beta-model" }),
    );
    const events: Array<{ agentDir: string; profileId: string; threadId: number }> = fs
      .readFileSync(observations, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      events
        .map(({ agentDir, profileId }) => ({ agentDir, profileId }))
        .toSorted((left, right) => left.profileId.localeCompare(right.profileId)),
    ).toEqual(
      ["alpha", "alpha", "beta", "beta", "beta"].map((agentId) => ({
        agentDir: agentId === "alpha" ? entries.alpha.agentDir : entries.beta.agentDir,
        profileId: `${PROVIDER_ID}:${agentId}`,
      })),
    );
    expect(new Set(events.map((event) => event.threadId)).size).toBe(1);
    expect(events.every((event) => event.threadId !== threadId)).toBe(true);
    expect(getPreparedModelCatalogWorkerPoolSnapshot()).toMatchObject({
      workersCreated: 1,
      workers: 1,
      activeTasks: 0,
      pendingTasks: 0,
    });
  });
});
