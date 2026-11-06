import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { MessagePort } from "node:worker_threads";
import { expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { createPreparedModelCatalogWorkerInput } from "./prepared-model-catalog-worker.js";
import {
  createCatalogFixture,
  catalogInput,
  makeCatalogAgentFacts,
  writeFixtureFiles,
  PLUGIN_ID,
  PROVIDER_ID,
} from "./prepared-model-catalog-worker.test-support.js";
import type { PreparedModelCatalogWorkerInput } from "./prepared-model-catalog-worker.types.js";
import {
  catalogTask,
  usePreparedCatalogWorkerFixtures,
} from "./test-helpers/prepared-model-catalog-worker-fixture.js";

const { makeTempDir, observeWorkers, createCatalogPool } = usePreparedCatalogWorkerFixtures();

it.each([false, true])(
  "reuses immutable configs across workspaces and remote refreshes (aliased: %s)",
  async (aliased) => {
    const fixture = await createCatalogFixture(makeTempDir, 0);
    const syntheticProvider = `${PROVIDER_ID}-synthetic`;
    writeFixtureFiles(path.join(fixture.root, "plugin"), {
      "index.cjs": `
const fs = require("node:fs");
const state = globalThis[Symbol.for("catalog.config.identities")] ??= {
  ids: new WeakMap(), next: 0, registrations: 0, probes: 0
};
const id = value => {
  if (!state.ids.has(value)) state.ids.set(value, ++state.next);
  return state.ids.get(value);
};
module.exports = { id: ${JSON.stringify(PLUGIN_ID)}, register(api) {
  state.registrations++;
  api.registerProvider({ id: ${JSON.stringify(syntheticProvider)}, label: "Synthetic fixture", auth: [],
    prepareSyntheticAuth() { state.probes++; throw new Error("Unexpected worker auth probe"); }
  });
  const resolveAuth = async (cfg, workspaceDir) => {
    try {
      return (await api.runtime.modelAuth.resolveApiKeyForProvider({
        cfg, workspaceDir, provider: ${JSON.stringify(syntheticProvider)}
      })).apiKey;
    } catch (error) {
      if (error.code !== "missing-provider-auth") throw error;
      return null;
    }
  };
  const registrationAuth = resolveAuth(api.config, api.config.agents.defaults.workspace)
    .then(auth => ({ auth }), error => ({ error: error.message }));
  api.registerProvider({ id: ${JSON.stringify(PROVIDER_ID)}, label: "Config fixture", auth: [],
    catalog: { async run(context) {
      const current = api.runtime.config.current();
      const clone = api.runtime.config.current({ clone: true });
      clone.models.providers[${JSON.stringify(PROVIDER_ID)}].apiKey = "changed-clone";
      const remote = globalThis[Symbol.for("openclaw.asyncContext")].getStore()
        [Symbol.for("openclaw.remoteModelCatalogScope")].catalog;
      const runtimeAuth = await resolveAuth(current, context.workspaceDir);
      const capturedAuth = await resolveAuth(api.config, context.workspaceDir)
        .catch(error => ({ error: error.message }));
      fs.appendFileSync(process.env.OPENCLAW_WORKER_CATALOG_MARKER, JSON.stringify({
        runtimeId: id(current), registrations: state.registrations,
        runtimeAuth, capturedAuth, registrationAuth: await registrationAuth, probes: state.probes,
        requestAuth: context.resolveProviderApiKey(${JSON.stringify(syntheticProvider)}).discoveryApiKey ?? null,
        frozen: Object.isFrozen(current) && Object.isFrozen(current.models.providers),
        allow: current.plugins.allow, registrationAllow: api.config.plugins.allow,
        key: current.models.providers[${JSON.stringify(PROVIDER_ID)}].apiKey,
        requestKey: context.config.models.providers[${JSON.stringify(PROVIDER_ID)}].apiKey,
        credential: context.resolveProviderApiKey(${JSON.stringify(PROVIDER_ID)}).discoveryApiKey
      }) + "\\n");
      return { provider: { api: "openai-completions", baseUrl: "https://catalog.invalid/v1",
        models: [{ id: remote.revision, name: remote.revision, contextWindow: 8192,
          maxTokens: 4096, cost: { input: remote.generatedAt, output: 0, cacheRead: 0, cacheWrite: 0 } }]
      } };
    } }
  });
} };`,
      "openclaw.plugin.json": {
        id: PLUGIN_ID,
        providers: [PROVIDER_ID, syntheticProvider],
        configSchema: { type: "object", additionalProperties: false },
        modelCatalog: { discovery: { [PROVIDER_ID]: "runtime" } },
      },
    });
    const memory = Promise.withResolvers<MessagePort>();
    const observer = observeWorkers((worker) => {
      worker.on("message", (message: { status?: string; port?: MessagePort }) => {
        if (message.status === "memory" && message.port instanceof MessagePort) {
          memory.resolve(message.port);
        }
      });
    });
    observer.subscribe();
    const pool = createCatalogPool(fixture.env);
    const input = (
      workspace: string,
      revision: number,
      key = "resolved-fixture-key",
      configWorkspace = workspace,
    ) => {
      const workspaceDir = path.join(fixture.root, workspace);
      fs.mkdirSync(workspaceDir, { recursive: true });
      const config: OpenClawConfig = {
        plugins: { ...fixture.config.plugins, allow: [] },
        agents: { defaults: { workspace: path.join(fixture.root, configWorkspace) } },
        models: {
          providers: {
            [PROVIDER_ID]: {
              api: "openai-completions",
              baseUrl: "https://catalog.invalid/v1",
              apiKey: key,
              models: Array.from({ length: 256 }, (_, index) => ({
                id: `configured-${index}`,
                name: `Configured model ${index}`,
                reasoning: false,
                input: ["text"],
                cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 8192,
                maxTokens: 4096,
              })),
            },
          },
        },
      };
      const source = aliased ? config : structuredClone(config);
      if (!aliased) {
        source.models!.providers![PROVIDER_ID]!.apiKey = {
          source: "store",
          provider: "default",
          id: "CATALOG_FIXTURE_KEY",
        };
      }
      return {
        ...createPreparedModelCatalogWorkerInput({
          agentFacts: makeCatalogAgentFacts(catalogInput(fixture, { workspaceDir, config })),
          pluginMetadataSnapshot: loadPluginMetadataSnapshot({
            config,
            env: fixture.env,
            workspaceDir,
          }),
        }),
        sourceConfigForSecrets: source,
        remoteCatalog: {
          sourceUrl: "https://catalog.openclaw.ai/models/v2/catalog.json",
          revision: `remote-${revision}`,
          generatedAt: revision,
          providers: {},
          recommendations: {},
          pricing: {},
          upstreamPricing: {},
        },
      };
    };
    const run = async (value: PreparedModelCatalogWorkerInput, omitMetadata = false) => {
      const task = catalogTask(value);
      const authKey =
        value.remoteCatalog!.generatedAt === 3
          ? null
          : `synthetic-${value.remoteCatalog!.revision}`;
      task.request = {
        ...task.request,
        kind: "catalog",
        refresh: true,
        syntheticAuth: [
          {
            providerRef: syntheticProvider,
            result: authKey ? { apiKey: authKey, source: "fixture", mode: "api-key" } : null,
          },
        ],
      };
      if (omitMetadata) {
        const { remoteCatalog: _remote, pluginMetadataSnapshot: _metadata, ...rest } = value;
        task.value = rest;
      }
      const before = fs.existsSync(fixture.marker) ? fs.readFileSync(fixture.marker, "utf8") : "";
      const result = await pool.run(task, { timeoutMs: 30_000 });
      expect(result).toMatchObject({ status: "ok", kind: "catalog" });
      const records = fs
        .readFileSync(fixture.marker, "utf8")
        .slice(before.length)
        .trim()
        .split("\n");
      expect(records).toHaveLength(1);
      const observed = JSON.parse(records[0]!);
      if (result.status === "ok" && result.kind === "catalog") {
        expect(result.runtimeModels.get(PROVIDER_ID)).toContainEqual(
          expect.objectContaining({
            id: value.remoteCatalog!.revision,
            cost: expect.objectContaining({ input: value.remoteCatalog!.generatedAt }),
          }),
        );
      }
      expect(observed).toMatchObject({
        allow: [],
        registrationAllow: [PLUGIN_ID],
        key: value.input.config.models!.providers![PROVIDER_ID]!.apiKey,
        requestKey: value.sourceConfigForSecrets.models!.providers![PROVIDER_ID]!.apiKey,
        credential: value.input.config.models!.providers![PROVIDER_ID]!.apiKey,
        runtimeAuth: authKey,
        capturedAuth: authKey,
        requestAuth: authKey,
        probes: 0,
      });
      const port = await memory.promise;
      const sample = once(port, "message");
      port.postMessage(undefined);
      const [retained] = await sample;
      const census = retained.retainedData.find(
        (row: { structure: string }) => row.structure === "catalog-config",
      );
      expect(census.truncated).toBe(false);
      return { observed, census };
    };
    try {
      const first = await run(input("one", 1));
      const second = await run(input("two", 1));
      expect(first.observed.registrationAuth).toEqual({ auth: "synthetic-remote-1" });
      expect(second.observed.registrationAuth).toEqual({ auth: "synthetic-remote-1" });
      for (const revision of [2, 3]) {
        for (const [workspace, initial] of [
          ["one", first],
          ["two", second],
        ] as const) {
          for (const omitted of [false, true]) {
            const current = await run(input(workspace, revision), omitted);
            if (revision === 2 && workspace === "one" && !omitted) {
              console.info("catalog-config explicit roots", {
                aliased,
                initial: second.census,
                refreshed: current.census,
              });
            }
            expect(current.observed).toMatchObject({
              runtimeId: initial.observed.runtimeId,
              registrations: 2,
              frozen: true,
            });
            expect(current.census).toEqual(second.census);
          }
        }
      }
      const changed = input("one", 4, "changed-fixture-key");
      const replacement = await run(changed);
      expect(replacement.observed.registrations).toBe(3);
      expect(replacement.observed.runtimeId).not.toBe(first.observed.runtimeId);
      // Equal values from another registration may keep the current publication identity.
      const deduplicated = await run(input("three", 5, "changed-fixture-key", "one"));
      expect(deduplicated.observed.runtimeId).toBe(replacement.observed.runtimeId);
      expect(deduplicated.observed.registrations).toBe(4);
      // The authored default workspace is deliberately different from this request's scope.
      expect(deduplicated.observed.registrationAuth).toEqual({
        error: "Prepared synthetic auth environment or workspace does not match",
      });
      for (const revision of [2, 3]) {
        const repeated = await run(input("three", revision, "changed-fixture-key", "one"));
        expect(repeated.observed.runtimeId).toBe(replacement.observed.runtimeId);
        expect(repeated.observed.registrations).toBe(4);
        expect(repeated.census).toEqual(deduplicated.census);
      }
      // Equal config values with different source provenance still replace the registration.
      const changedProvenance = {
        ...changed,
        sourceConfigForSecrets: structuredClone(changed.sourceConfigForSecrets),
        sourceConfigResolutionFacts: { unresolvedPaths: [], envSecretRefs: [] },
      };
      const provenance = await run(changedProvenance);
      expect(provenance.observed.registrations).toBe(5);
      expect(provenance.observed.runtimeId).not.toBe(replacement.observed.runtimeId);
      // Splitting an aliased source for new provenance adds one authored root.
      expect(provenance.census.entries).toBe(deduplicated.census.entries + Number(aliased));
    } finally {
      await pool.close();
      observer.close();
    }
  },
  120_000,
);
