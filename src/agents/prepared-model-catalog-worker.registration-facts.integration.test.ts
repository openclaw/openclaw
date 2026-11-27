import fs from "node:fs";
import "../templates/tool-policy-runtime.js";
import { createServer } from "node:http";
import path from "node:path";
import { threadId } from "node:worker_threads";
import { describe, vi, onTestFinished, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { resolvePluginRuntimeLoadContext } from "../plugins/runtime/load-context.resolve.js";
import { captureTemplateInstallSchemaVersionFacts } from "../templates/provenance-runtime-read.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import { unregisterResolvedAgentDir } from "./agent-dir-registry.js";
import { resolveAgentDir } from "./agent-scope-config.js";
import { saveAuthProfileStore } from "./auth-profiles/store-runtime.js";
import { prepareModelCatalogWorkerContext } from "./prepared-model-catalog-fingerprints.js";
import { createPreparedModelCatalogWorkerInput } from "./prepared-model-catalog-worker.js";
import {
  stubCatalogEnv,
  readFixtureLines,
} from "./prepared-model-catalog-worker.shared.test-support.js";
import {
  createCatalogFixture,
  catalogInput,
  makeCatalogAgentFacts,
  PLUGIN_ID,
  PROVIDER_ID,
  writeFixtureFiles,
} from "./prepared-model-catalog-worker.test-support.js";
import type { PreparedModelCatalogWorkerInput } from "./prepared-model-catalog-worker.types.js";
import { prepareWorkspaceBuildGroup } from "./prepared-model-runtime.facts.js";
import { retainPreparedPluginGeneration } from "./prepared-model-runtime.plugin-lifetime.js";
import { createCatalogFleetFixture } from "./test-helpers/prepared-model-catalog-fleet-fixture.js";
import {
  createCatalogInspectionPool,
  type CatalogInspectionTask,
} from "./test-helpers/prepared-model-catalog-inspection.js";
import {
  catalogTask,
  loadCompletedFullCatalog,
  usePreparedCatalogWorkerFixtures,
} from "./test-helpers/prepared-model-catalog-worker-fixture.js";

const { makeTempDir, retireAfterTest, createCatalogPool } = usePreparedCatalogWorkerFixtures();
const createFleetFixture = createCatalogFleetFixture(makeTempDir);

it.each([true, false])(
  "keeps unrelated setup outside catalog requests (explicit allowlist=%s)",
  async (explicitAllowlist) => {
    const setupId = "unrelated-setup-fixture";
    const fixture = await createFleetFixture(
      (seed) => {
        const observations = path.join(seed.root, "setup-observations.jsonl");
        fs.writeFileSync(observations, "");
        const observe = (event: string) =>
          `require("node:fs").appendFileSync(${JSON.stringify(observations)}, JSON.stringify({ event: ${JSON.stringify(event)}, threadId: require("node:worker_threads").threadId }) + "\\n");`;
        const setupDir = path.join(seed.root, setupId);
        fs.mkdirSync(setupDir);
        writeFixtureFiles(setupDir, {
          "package.json": {
            name: setupId,
            version: "1.0.0",
            type: "commonjs",
            openclaw: { extensions: ["./index.cjs"], setupEntry: "./setup-api.cjs" },
          },
          "openclaw.plugin.json": {
            id: setupId,
            setup: { requiresRuntime: true },
            configSchema: { type: "object", properties: { configured: { type: "boolean" } } },
          },
          "index.cjs": `module.exports = { id: ${JSON.stringify(setupId)}, register() {} };`,
          "setup-api.cjs": `${observe("setup-import")}
module.exports = { id: ${JSON.stringify(setupId)}, register(api) {
  api.registerAutoEnableProbe(({ config }) => {
    ${observe("setup-probe")}
    return config.acp?.enabled ? "fixture setup configured" : null;
  });
} };`,
        });
        seed.config.plugins.allow.push(setupId);
        if (!explicitAllowlist) {
          const plugins: NonNullable<OpenClawConfig["plugins"]> = seed.config.plugins;
          delete plugins.allow;
        }
        seed.config.plugins.load.paths.push(setupDir);
        seed.config.plugins.entries[setupId] = { enabled: true, config: { configured: true } };
      },
      true,
      { agentCount: 1, publication: "individual" },
    );
    const readObservations = (): Array<{ event: string; threadId: number }> =>
      readFixtureLines(fixture.root, "setup-observations.jsonl")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    const snapshot = fixture.snapshots[0]!;
    const catalog = await loadCompletedFullCatalog(snapshot);
    expect(catalog.entries).toContainEqual(expect.objectContaining({ provider: PROVIDER_ID }));
    const refreshed = await snapshot.loadFullModelCatalog!({ refresh: true, wait: true });
    expect(refreshed.entries).toContainEqual(expect.objectContaining({ provider: PROVIDER_ID }));
    expect.soft(readObservations().filter((entry) => entry.threadId !== threadId)).toEqual([]);
    // Setup remains available at its explicit parent-owned preparation boundary.
    const setup = resolvePluginRuntimeLoadContext({
      config: {
        ...fixture.config,
        acp: { enabled: true },
        plugins: { ...fixture.config.plugins, allow: [PROVIDER_ID] },
      },
      env: process.env,
      workspaceDir: fixture.workspaceDir,
      metadataSnapshot: snapshot.metadataSnapshot,
    });
    expect(setup.autoEnabledReasons[setupId]).toContain("fixture setup configured");
    expect(readObservations()).toContainEqual({ event: "setup-probe", threadId });
  },
);

it.each([false])(
  "denies prepared synthetic auth outside its workspace or after credential removal (aliased: %s)",
  async (aliased) => {
    const fixture = await createCatalogFixture(makeTempDir, 0);
    const syntheticProvider = `${PROVIDER_ID}-synthetic`;
    const requests: Array<string | undefined> = [];
    let expectedAuth: string | null = null;
    const server = await reserveTestPortListener({
      offsets: [0],
      createListener: () =>
        createServer((request, response) => {
          // Count rejected requests too: an HTTP 401 does not prove denial before egress.
          requests.push(request.headers.authorization);
          const accepted =
            expectedAuth !== null && request.headers.authorization === `Bearer ${expectedAuth}`;
          response.writeHead(accepted ? 200 : 401);
          response.end(accepted ? "catalog-auth-ok" : "unexpected-credential");
        }),
    });
    onTestFinished(async () => {
      server.listener.closeAllConnections();
      try {
        await server.releaseListener();
      } finally {
        await server.claim.release();
      }
    });
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
  const requestCapturedAuth = async workspaceDir => {
    const { apiKey } = await api.runtime.modelAuth.resolveApiKeyForProvider({
      cfg: api.config, workspaceDir, provider: ${JSON.stringify(syntheticProvider)}
    });
    const response = await fetch("http://127.0.0.1:${server.claim.port}/models", {
      headers: { authorization: "Bearer " + apiKey }
    });
    const marker = await response.text();
    if (!response.ok) throw new Error("Provider HTTP rejected: " + response.status);
    return { auth: apiKey, marker };
  };
  const observeCapturedAuth = workspaceDir => requestCapturedAuth(workspaceDir)
    .catch(error => ({ error: error.message, code: error.code ?? null }));
  const registrationAuth = observeCapturedAuth(api.config.agents.defaults.workspace);
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
      const capturedHttp = await observeCapturedAuth(context.workspaceDir);
      const neighboringHttp = await observeCapturedAuth(context.workspaceDir + "/neighbor");
      fs.appendFileSync(process.env.OPENCLAW_WORKER_CATALOG_MARKER, JSON.stringify({
        runtimeId: id(current), registrations: state.registrations,
        callbackId: id(requestCapturedAuth), capturedHttp, neighboringHttp,
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
              models: Array.from({ length: 1 }, (_, index) => ({
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
    let registrations = 0;
    const run = async (value: PreparedModelCatalogWorkerInput, omitMetadata = false) => {
      const task = catalogTask(value);
      const authKey =
        value.remoteCatalog!.generatedAt === 3
          ? null
          : `synthetic-${value.remoteCatalog!.revision}`;
      expectedAuth = authKey;
      const requestsBefore = requests.length;
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
      const registrationMatchesWorkspace =
        value.input.config.agents?.defaults?.workspace === value.input.workspaceDir;
      const expectedRequests = authKey
        ? 1 + Number(observed.registrations > registrations && registrationMatchesWorkspace)
        : 0;
      expect(requests.slice(requestsBefore)).toEqual(
        Array.from({ length: expectedRequests }, () => `Bearer ${authKey}`),
      );
      expect(observed.capturedHttp).toEqual(
        authKey
          ? { auth: authKey, marker: "catalog-auth-ok" }
          : expect.objectContaining({ code: "missing-provider-auth" }),
      );
      expect(observed.neighboringHttp).toEqual({
        error: "Prepared synthetic auth environment or workspace does not match",
        code: null,
      });
      registrations = observed.registrations;
      expect(observed).toMatchObject({
        runtimeAuth: authKey,
        capturedAuth: authKey,
        requestAuth: authKey,
      });
      return observed;
    };
    try {
      await run(input("one", 1));
      await run(input("two", 2));
      await run(input("one", 3));
      const foreign = await run(input("three", 4, "resolved-fixture-key", "one"));
      expect(foreign.registrationAuth).toEqual({
        error: "Prepared synthetic auth environment or workspace does not match",
        code: null,
      });
    } finally {
      await pool.close();
    }
  },
  120_000,
);

describe("catalog directory ownership", () => {
  async function createDirectoryOwnershipFixture() {
    const fixture = await createCatalogFixture(makeTempDir, 0);
    stubCatalogEnv(fixture.env);
    return fixture;
  }
  async function prepareDirectoryOwnershipInput(
    input: Parameters<typeof prepareWorkspaceBuildGroup>[0][number],
  ) {
    const prepared = await prepareWorkspaceBuildGroup([input], "static");
    retireAfterTest(retainPreparedPluginGeneration(prepared.pluginGeneration));
    return createPreparedModelCatalogWorkerInput({
      agentFacts: prepared.agentFacts[0]!,
      pluginMetadataSnapshot: prepared.pluginGeneration.pluginMetadataSnapshot,
    });
  }
  function createDirectoryOwnershipInspector(env: NodeJS.ProcessEnv) {
    const { pool } = createCatalogInspectionPool(env);
    const request = {
      kind: "catalog" as const,
      syntheticAuth: [],
      templateInstallSchemaVersions: captureTemplateInstallSchemaVersionFacts({ env }),
    };
    return {
      run: (
        value: CatalogInspectionTask["value"],
        inspection?: CatalogInspectionTask["inspection"],
      ) =>
        pool.run(
          { context: prepareModelCatalogWorkerContext(value), value, request, inspection },
          { timeoutMs: 30_000 },
        ),
      [Symbol.asyncDispose]: () => pool.close(),
    };
  }
  it.each([
    { label: "foreign owner", existing: ["foreign"] },
    { label: "ambiguous owners", existing: ["main", "foreign"] },
  ])("preserves $label across the request", async ({ existing }) => {
    vi.stubEnv("CODEX_HOME", makeTempDir("openclaw-directory-request-empty-codex-"));
    const fixture = await createDirectoryOwnershipFixture();
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
      await prepareDirectoryOwnershipInput({
        agentId: "main",
        agentDir,
        inheritedAuthDir: agentDir,
        config,
        env: fixture.env,
      }),
    );
    unregisterResolvedAgentDir({ agentId: "main", agentDir, env: fixture.env });
    await using inspector = createDirectoryOwnershipInspector(fixture.env);
    const { inspection, ...result } = await inspector.run(value, { existingAgentIds: existing });

    expect(result).toEqual({
      status: "failed",
      authCredentials: [],
      error: `Conflicting registered agent owners for ${agentDir}`,
    });
    expect(fs.existsSync(fixture.marker)).toBe(false);
    expect(inspection.foreignReleased).toBe(true);

    expect(inspection.registeredAgentId).toBe(
      existing.some((agentId) => agentId.toLowerCase() === "main") ? "main" : undefined,
    );
  });
});
