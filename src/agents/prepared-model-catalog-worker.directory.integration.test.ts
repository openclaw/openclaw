import fs from "node:fs";
import path from "node:path";
import { threadId } from "node:worker_threads";
import { beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { unregisterResolvedAgentDir } from "./agent-dir-registry.js";
import { resolveAgentDir } from "./agent-scope-config.js";
import { saveAuthProfileStore } from "./auth-profiles/store-runtime.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import {
  createPreparedModelCatalogWorker,
  getPreparedModelCatalogWorkerPoolSnapshot,
} from "./prepared-model-catalog-worker.js";
import {
  catalogEntry,
  createCatalogFixture,
  PROVIDER_ID,
  writeFixtureFiles,
} from "./prepared-model-catalog-worker.test-support.js";
import { getPreparedModelFullCatalogAuth } from "./prepared-model-runtime-auth.js";
import { prepareWorkspaceBuildGroup } from "./prepared-model-runtime.facts.js";
import { retainPreparedPluginGeneration } from "./prepared-model-runtime.plugin-lifetime.js";
import { usePreparedCatalogWorkerFixtures } from "./test-helpers/prepared-model-catalog-worker-fixture.js";

const { makeTempDir, retireAfterTest } = usePreparedCatalogWorkerFixtures();

beforeEach(() => {
  vi.stubEnv("CODEX_HOME", makeTempDir("openclaw-directory-empty-codex-"));
});

it.each(["Gateway", "standalone"])(
  "%s isolates custom-directory agents and releases ownership after successful and failed requests",
  async (owner) => {
    const fixture = await createCatalogFixture(makeTempDir, 0);
    vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
    vi.stubEnv("OPENCLAW_STATE_DIR", fixture.env.OPENCLAW_STATE_DIR);
    const observations = path.join(fixture.root, "directory-catalog.jsonl");
    const readObservations = () => fs.readFileSync(observations, "utf8");
    const pluginDir = path.join(fixture.root, "plugin");
    const pluginFile = path.join(pluginDir, "index.cjs");
    writeFixtureFiles(pluginDir, {
      "index.cjs": `const fs = require("node:fs");
const id = ${JSON.stringify(PROVIDER_ID)};
const catalog = (models) => ({ provider: { baseUrl: "https://directory.invalid/v1", api: "openai-completions", models } });
module.exports = { id, register(api) {
    api.registerProvider({ id, label: "Directory catalog", auth: [],
      staticCatalog: { run: async () => catalog([]) },
      catalog: { run: async (context) => {
        const auth = context.resolveProviderApiKey(${JSON.stringify(PROVIDER_ID)});
        const modelId = { "alpha-key-not-real": "alpha-model", "beta-key-not-real": "beta-model" }[auth.discoveryApiKey];
        fs.appendFileSync(${JSON.stringify(observations)}, JSON.stringify({
          agentDir: context.agentDir, profileId: auth.profileId,
          threadId: require("node:worker_threads").threadId,
        }) + "\\n");
        if (!modelId) throw new Error("Unexpected directory credential");
        return catalog([{ id: modelId, name: modelId }]);
      } },
    });
} };`,
      "openclaw.plugin.json": {
        id: PROVIDER_ID,
        providers: [PROVIDER_ID],
        providerCatalogEntry: "./index.cjs",
        modelCatalog: { discovery: { [PROVIDER_ID]: "runtime" } },
        configSchema: { type: "object", additionalProperties: false, properties: {} },
      },
    });
    const directory = (...parts: string[]) => ({ agentDir: path.join(fixture.root, ...parts) });
    const entries = {
      alpha: directory("custom-owner", "agent"),
      beta: directory("custom-catalog"),
      foreign: directory("other-parent", "agent"),
    };
    const profiles = (agentId: string): AuthProfileStore["profiles"] => ({
      [`${PROVIDER_ID}:${agentId}`]: {
        type: "api_key",
        provider: PROVIDER_ID,
        key: `${agentId}-key-not-real`,
      },
    });
    const config: OpenClawConfig = {
      agents: { defaults: { model: `${PROVIDER_ID}/selected-model` }, entries },
      plugins: {
        allow: [PROVIDER_ID],
        load: { paths: [pluginFile] },
        entries: { [PROVIDER_ID]: { enabled: true } },
      },
    };
    const retirement = new AbortController();
    retireAfterTest(() => {
      retirement.abort();
      for (const [agentId, { agentDir }] of Object.entries(entries)) {
        unregisterResolvedAgentDir({ agentId, agentDir });
      }
    });
    for (const agentId of ["alpha", "beta", "foreign"] as const) {
      saveAuthProfileStore(
        { version: 1, profiles: profiles(agentId) },
        resolveAgentDir(config, agentId),
      );
    }
    const prepared = await prepareWorkspaceBuildGroup(
      (["alpha", "beta"] as const).map((agentId) =>
        Object.assign(
          {
            agentId,
            agentDir: entries[agentId].agentDir,
            inheritedAuthDir: entries[agentId].agentDir,
            workspaceDir: fixture.workspaceDir,
            config,
          },
          owner === "Gateway" ? { allowGatewaySubagentBinding: true } : { env: fixture.env },
        ),
      ),
      "static",
    );
    retireAfterTest(retainPreparedPluginGeneration(prepared.pluginGeneration));
    const createWorker = (agentFacts: (typeof prepared.agentFacts)[number]) =>
      createPreparedModelCatalogWorker({
        agentFacts,
        pluginMetadataSnapshot: prepared.pluginGeneration.pluginMetadataSnapshot,
        pluginRegistry: prepared.pluginGeneration.pluginRegistry,
        isCurrent: () => !retirement.signal.aborted,
        retirementSignal: retirement.signal,
      });
    const workers = prepared.agentFacts.map(createWorker);
    for (const attempt of [1, 2]) {
      const catalogs = await Promise.all(workers.map((worker) => worker.loadCatalog()));
      for (const [index, agentId] of ["alpha", "beta"].entries()) {
        const catalog = catalogs[index]!.modelCatalog;
        expect(catalog.entries).toContainEqual(catalogEntry(`${agentId}-model`));
        expect(catalog.entries).not.toContainEqual(
          expect.objectContaining({ id: `${agentId === "alpha" ? "beta" : "alpha"}-model` }),
        );
        expect(getPreparedModelFullCatalogAuth(catalog)?.authStore.profiles).toEqual(
          profiles(agentId),
        );
      }
      expect(readObservations().trim().split("\n")).toHaveLength(attempt * 2);
    }
    const alpha = prepared.agentFacts[0]!;
    const foreign = {
      agentDir: entries.foreign.agentDir,
      inheritedAuthDir: entries.foreign.agentDir,
    };
    const beforeRejection = readObservations();
    for (const [input, message] of [
      [{ agentId: undefined }, "belongs to agent alpha; requested agent custom-owner"],
      [foreign, "belongs to agent foreign; requested agent alpha"],
      [
        { ...foreign, agentId: undefined },
        "belongs to agent foreign; requested agent other-parent",
      ],
    ] as const) {
      await expect(
        createWorker({ ...alpha, input: { ...alpha.input, ...input } }).loadCatalog(),
      ).rejects.toThrow(message);
    }
    expect(readObservations()).toBe(beforeRejection);
    const next = await workers[1]!.loadCatalog();
    expect(next.modelCatalog.entries).toContainEqual(catalogEntry("beta-model"));
    const events: Array<{ agentDir: string; profileId: string; threadId: number }> =
      readObservations()
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
    expect(new Set(events.map((event) => event.threadId)).size).toBe(owner === "Gateway" ? 1 : 2);
    expect(events.every((event) => event.threadId !== threadId)).toBe(true);
    if (owner === "Gateway") {
      expect(getPreparedModelCatalogWorkerPoolSnapshot()).toMatchObject({
        workersCreated: 1,
        workers: 1,
        activeTasks: 0,
        pendingTasks: 0,
      });
    }
  },
);
