import { once } from "node:events";
import fs from "node:fs";
import { createServer } from "node:http";
import { afterEach, beforeEach, expect, it } from "vitest";
import { captureClawInstallSchemaVersionFacts } from "../claws/provenance-runtime-read.js";
import { createConfigIoContext } from "../config/io.context.js";
import { readConfigFileSnapshotFromContext } from "../config/io.snapshot.js";
import { getConfigResolutionFacts } from "../config/resolution-facts.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { captureRuntimeConfig } from "../config/runtime-source-projection.js";
import type { ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { NON_ENV_SECRETREF_MARKER } from "../secrets/provider-credential-values.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "./auth-profiles/runtime-snapshots.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { resolveUsableCustomProviderApiKey } from "./model-auth-provider-config.js";
import { fingerprintPreparedModelCatalogPluginContext as fingerprint } from "./prepared-model-catalog-fingerprints.js";
import { createPreparedModelCatalogWorkerInput as workerInput } from "./prepared-model-catalog-worker.js";
import { prepareWorkspaceBuildGroup } from "./prepared-model-runtime.facts.js";
import { prepareAgentCatalogSource } from "./prepared-model-runtime.scoped-catalog.js";
import { createCatalogInspectionPool } from "./test-helpers/prepared-model-catalog-inspection.js";

const provider = "worker-secret-fixture";
let state: OpenClawTestState;
beforeEach(async () => {
  state = await createOpenClawTestState({ label: "catalog-worker-secrets" });
  await state.writeAuthProfiles({ version: 1, profiles: {} });
});
afterEach(async () => {
  clearRuntimeAuthProfileStoreSnapshots();
  clearRuntimeConfigSnapshot();
  await state.cleanup();
});

function withApiKey(config: OpenClawConfig, apiKey: ModelProviderConfig["apiKey"]): OpenClawConfig {
  const providers = config.models!.providers!;
  return {
    ...config,
    models: {
      ...config.models,
      providers: {
        ...providers,
        [provider]: { ...providers[provider]!, ...(apiKey === undefined ? {} : { apiKey }) },
      },
    },
  };
}

async function loadConfig(config: OpenClawConfig, env: NodeJS.ProcessEnv) {
  await state.writeConfig(config);
  const snapshot = await readConfigFileSnapshotFromContext(
    createConfigIoContext({
      configPath: state.configPath,
      env,
      homedir: () => state.home,
      observe: false,
    }),
  );
  expect(snapshot.valid).toBe(true);
  return snapshot;
}

type CredentialCase = [
  owner: "config" | "profile",
  value: string,
  loader?: { authored: string; env?: NodeJS.ProcessEnv; pending?: boolean; resolved?: boolean },
];
it.each<CredentialCase>([
  ["config", "synthetic-worker-config-key"],
  ["config", NON_ENV_SECRETREF_MARKER],
  ["config", "${OPAQUE_WORKER_KEY}"],
  ["profile", "synthetic-worker-profile-key"],
  [
    "config",
    "${LITERAL_KEY}",
    {
      authored: "${SOURCE_KEY}",
      env: { SOURCE_KEY: "${LITERAL_KEY}" },
      resolved: true,
    },
  ],
  ["config", "${LITERAL_KEY}", { authored: "$${LITERAL_KEY}" }],
  ["config", "$PENDING_KEY", { authored: "$PENDING_KEY", pending: true }],
])(
  "preserves %s credential %s (%j) through discovery and the writable plan",
  async (owner, value, loader) => {
    const requests: boolean[] = [];
    const server = createServer((request, response) => {
      requests.push(
        request.url === "/v1/models" && request.headers.authorization === `Bearer ${value}`,
      );
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({ data: [{ id: "discovered-model", name: "Discovered model" }] }),
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected loopback catalog server");
    }
    try {
      const baseUrl = `http://127.0.0.1:${address.port}/v1`;
      const pluginFile = await state.writeText(
        "catalog-plugin/index.cjs",
        `
module.exports = {
  id: ${JSON.stringify(provider)},
  register(api) {
    const baseUrl = ${JSON.stringify(baseUrl)};
    api.registerProvider({
      id: ${JSON.stringify(provider)}, label: "Worker secret fixture", auth: [],
      staticCatalog: { run: async () => ({ provider: { baseUrl, api: "openai-completions", models: [] } }) },
      catalog: { run: async (context) => {
        const auth = context.resolveProviderApiKey(${JSON.stringify(provider)});
        if (!auth.discoveryApiKey) return null;
        const response = await fetch(baseUrl + "/models", { headers: { authorization: "Bearer " + auth.discoveryApiKey } });
        const body = await response.json();
        return { provider: { baseUrl, api: "openai-completions", apiKey: auth.apiKey, models: body.data } };
      } },
    });
  },
};
`,
      );
      await state.writeJson("catalog-plugin/openclaw.plugin.json", {
        id: provider,
        providers: [provider],
        providerCatalogEntry: "./index.cjs",
        modelCatalog: { discovery: { [provider]: "runtime" } },
        configSchema: { type: "object", additionalProperties: false, properties: {} },
      });
      const ref = { source: "store", provider: "default", id: "WORKER_CONFIG_KEY" } as const;
      const source = {
        plugins: {
          allow: [provider],
          load: { paths: [pluginFile] },
          slots: { memory: "none" },
          entries: { [provider]: { enabled: true } },
        },
        agents: {
          defaults: {
            workspace: state.workspaceDir,
            model: { primary: "healthy-fixture/model" },
            modelPolicy: { allow: ["healthy-fixture/model", `${provider}/*`] },
          },
        },
        models: {
          providers: {
            "healthy-fixture": {
              baseUrl: "https://healthy.example/v1",
              api: "openai-completions",
              apiKey: "synthetic-healthy-key",
              models: [
                {
                  id: "model",
                  name: "Model",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 4096,
                  maxTokens: 512,
                },
              ],
            },
            [provider]: {
              baseUrl,
              api: "openai-completions",
              models: [],
              ...(owner === "config" ? { apiKey: loader?.authored ?? ref } : {}),
            },
          },
        },
      } satisfies OpenClawConfig;
      let runtime = withApiKey(source, owner === "config" ? value : undefined);
      const env = {
        ...state.env,
        LITERAL_KEY: undefined,
        PENDING_KEY: undefined,
        ...loader?.env,
      };
      let runtimeSource: OpenClawConfig = source;
      if (loader) {
        const snapshot = await loadConfig(source, env);
        runtime = snapshot.config;
        runtimeSource = snapshot.sourceConfig;
        expect(getConfigResolutionFacts(runtime)).not.toBeNull();
      }
      setRuntimeConfigSnapshot(runtime, runtimeSource);
      const prepared = await prepareWorkspaceBuildGroup(
        [
          {
            agentId: "main",
            agentDir: state.agentDir(),
            workspaceDir: state.workspaceDir,
            config: runtime,
            env,
            skipCredentials: true,
          },
        ],
        "static",
      );
      expect(requests).toEqual([]);
      const authStore: AuthProfileStore = {
        version: 1,
        profiles:
          owner === "profile"
            ? {
                [`${provider}:fixture`]: { type: "api_key", provider, keyRef: ref, key: value },
              }
            : {},
      };
      const params = {
        agentFacts: {
          ...prepared.agentFacts[0]!,
          authStore,
          input: { ...prepared.agentFacts[0]!.input, config: captureRuntimeConfig(runtime) },
        },
        pluginMetadataSnapshot: prepared.pluginGeneration.pluginMetadataSnapshot,
      };
      expect(params.agentFacts.providerIds).toContain(provider);
      const expectedAuth = loader?.pending ? undefined : value;
      if (loader) {
        expect(resolveUsableCustomProviderApiKey({ cfg: runtime, provider, env })?.apiKey).toBe(
          expectedAuth,
        );
        await prepareAgentCatalogSource(
          params.agentFacts,
          prepared.pluginGeneration,
          "live",
          false,
          { authStore },
        );
        expect(requests.splice(0)).toEqual(loader.pending ? [] : [true]);
      }
      const nativeRuntimeFacts = getConfigResolutionFacts(runtime);
      const nativeSourceFacts = getConfigResolutionFacts(runtimeSource);
      const serialized = structuredClone(workerInput(params));
      let alternativeFingerprint: string | undefined;
      if (owner === "config" && !loader?.pending) {
        const alternativeSource = withApiKey(
          source,
          loader ? value : { ...ref, id: "OTHER_WORKER_KEY" },
        );
        let alternativeRuntime = runtime;
        let alternativeRuntimeSource = alternativeSource;
        if (loader) {
          const snapshot = await loadConfig(alternativeSource, env);
          expect({ config: snapshot.config, sourceConfig: snapshot.sourceConfig }).toEqual({
            config: runtime,
            sourceConfig: runtimeSource,
          });
          alternativeRuntime = snapshot.config;
          alternativeRuntimeSource = snapshot.sourceConfig;
        }
        setRuntimeConfigSnapshot(alternativeRuntime, alternativeRuntimeSource);
        alternativeFingerprint = fingerprint(
          workerInput({
            ...params,
            agentFacts: {
              ...params.agentFacts,
              input: { ...params.agentFacts.input, config: alternativeRuntime },
            },
          }),
        );
      }
      // Workers inherit neither the parent's source snapshot nor its WeakMap resolution facts.
      clearRuntimeConfigSnapshot();
      clearRuntimeAuthProfileStoreSnapshots();
      const request = async (failCatalog = false) => {
        const { pool, captureDirectory } = createCatalogInspectionPool(env);
        try {
          const result = await pool.run(
            {
              value: serialized,
              request: {
                kind: "catalog",
                syntheticAuth: [],
                clawInstallSchemaVersions: captureClawInstallSchemaVersionFacts({ env }),
              },
              inspection: { provider, expectedCredential: expectedAuth, failCatalog },
            },
            { timeoutMs: 30_000 },
          );
          if (failCatalog) {
            expect(fs.readdirSync(captureDirectory)).toEqual([]);
          }
          return result;
        } finally {
          await pool.close();
          expect(fs.existsSync(captureDirectory)).toBe(false);
        }
      };
      const { inspection, ...result } = await request();
      expect(result.status).toBe("ok");
      expect(inspection).toMatchObject({
        runtimeFactsAbsent: nativeRuntimeFacts === null,
        sourceFactsAbsent: nativeSourceFacts === null,
        sameResolutionFacts: nativeRuntimeFacts === nativeSourceFacts,
      });
      if (loader) {
        expect(requests).toEqual(loader.pending ? [] : [true]);
        expect(inspection.credentialMatches).toBe(true);
        expect(inspection.authoredRef).toEqual(
          loader.pending ? { source: "env", provider: "default", id: "PENDING_KEY" } : null,
        );
        expect(inspection.resolvedEnvRef).toEqual(
          loader.resolved ? { source: "env", provider: "default", id: "SOURCE_KEY" } : null,
        );
        if (loader.pending) {
          return;
        }
      }
      expect(requests).toEqual([true]);
      expect(result).toMatchObject({
        snapshot: {
          entries: expect.arrayContaining([
            expect.objectContaining({ provider, id: "discovered-model" }),
          ]),
        },
      });
      const plans = inspection.plans;
      expect(plans).toHaveLength(1);
      const catalog = plans[0]!.pluginCatalogs.find((entry) => entry.pluginId === provider);
      expect(catalog).toBeDefined();
      expect(JSON.parse(catalog!.contents)).toMatchObject({
        providers: { [provider]: { apiKey: loader ? value : NON_ENV_SECRETREF_MARKER } },
      });
      expect(JSON.stringify(plans)).not.toContain("discoveryApiKey");
      if (!loader && value !== NON_ENV_SECRETREF_MARKER) {
        expect(JSON.stringify(plans).includes(value)).toBe(false);
      }
      if (alternativeFingerprint !== undefined) {
        expect(fingerprint(serialized)).not.toBe(alternativeFingerprint);
      }
      if (value === "synthetic-worker-config-key") {
        const { inspection: _inspection, ...failure } = await request(true);
        expect(failure).toEqual({
          status: "failed",
          authCredentials: [],
          error: "synthetic catalog construction failure",
        });
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  },
);
