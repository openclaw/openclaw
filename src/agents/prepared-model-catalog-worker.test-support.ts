import fs from "node:fs";
import path from "node:path";
import { threadId } from "node:worker_threads";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, vi } from "vitest";
import { fixtureReceiptWorkerClientSource } from "../../test/helpers/fixture-receipts.js";
import type { AgentModelEntryConfig } from "../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginEntryConfig } from "../config/types.plugins.js";
import { createGatewayChatMetadataRuntime } from "../gateway/server-methods/chat-metadata-runtime.js";
import * as commandsRuntime from "../gateway/server-methods/commands-list-result.js";
import type { GatewayRequestContext } from "../gateway/server-methods/types.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import * as auth from "./auth-profiles.js";
import { prepareSharedAuthStoreOwnership } from "./auth-profiles/path-resolve.js";
import { replaceRuntimeAuthProfileStoreSnapshots } from "./auth-profiles/runtime-snapshots.js";
import { ensureAuthProfileStore } from "./auth-profiles/store-runtime.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { formatModelCatalogAuthLabel } from "./model-catalog-auth-labels.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import { preparePublishedModelCatalogOwnerIdentity } from "./prepared-model-catalog-owner.js";
import * as catalogRuntime from "./prepared-model-catalog.js";
import {
  getPreparedModelFullCatalogAuth,
  getPreparedModelRuntimeAuthLabels,
  getPreparedModelRuntimeAuthStore,
} from "./prepared-model-runtime-auth.js";
import { startSerializedSnapshotBuildBatch } from "./prepared-model-runtime.build.js";
import type { PreparedModelRuntimeAgentFacts } from "./prepared-model-runtime.catalog-contract.js";
import { retainPreparedPluginGeneration } from "./prepared-model-runtime.plugin-lifetime.js";
import type {
  PreparedModelRuntimeOwner,
  PreparedModelRuntimeInput,
  PreparedModelRuntimeSnapshot,
} from "./prepared-model-runtime.types.js";
import { AuthStorage } from "./sessions/auth-storage.js";
import {
  refreshNativeCatalogDuringBoundedRead,
  seedFixturePluginModelCatalog,
  writeCatalogFailureControl,
  writeSyntheticAuthDiscoveryFixture,
} from "./test-helpers/prepared-model-catalog-worker-fixture.js";

export const PROVIDER_ID = "worker-catalog-fixture";
export const CATALOG_ALIAS_ID = `${PROVIDER_ID}-alias`;
export const HARNESS_ID = "worker-catalog-fixture-harness";
export const DISCOVERED_HARNESS_ID = `${PROVIDER_ID}-discovered-harness`;
export const MISSING_AUTH_HARNESS_ID = `${PROVIDER_ID}-missing-auth-harness`;
export const UNRELATED_SYNTHETIC_AUTH_ID = `${PROVIDER_ID}-unrelated-harness`;
export const SHARED_AUTH_PROVIDER_ID = `${PROVIDER_ID}-shared-auth`;
export const PLUGIN_ID = "worker-catalog-fixture";
export const PROFILE_ID = `${SHARED_AUTH_PROVIDER_ID}:named`;
export const MATERIALIZED_SECRET = "materialized-worker-secret-not-real";
const UNRELATED_SECRET = "unrelated-worker-secret-not-real";
export const REF_ONLY_API_PROVIDER_ID = `${PROVIDER_ID}-ref-api`;
export const REF_ONLY_API_ENV = "OPENCLAW_WORKER_REF_ONLY_API_KEY";
export const REF_ONLY_TOKEN_PROVIDER_ID = `${PROVIDER_ID}-ref-token`;
export const REF_ONLY_TOKEN_ENV = "OPENCLAW_WORKER_REF_ONLY_TOKEN";
export const DURABLE_AUTH_PROVIDER_ID = `${PROVIDER_ID}-durable-auth`;
export const DURABLE_AUTH_KEY = "post-startup-durable-key-not-real";
export const EXTERNAL_AUTH_PROFILE_ID = `${PROVIDER_ID}:external`;
export const EXTERNAL_AUTH_PATH_ENV = "OPENCLAW_WORKER_EXTERNAL_AUTH_PATH";
export const UNRELATED_PLUGIN_ID = "worker-catalog-unrelated";
export const UNRELATED_PLUGIN_WORKER_MARKER_ENV = "OPENCLAW_WORKER_UNRELATED_PLUGIN_MARKER";

export function catalogEntry(
  id: string,
  fields: Partial<ModelCatalogEntry> & { available?: boolean } = {},
) {
  return expect.objectContaining({ provider: PROVIDER_ID, id, ...fields });
}

export function writeFixtureFiles(root: string, files: Record<string, unknown>) {
  for (const [name, value] of Object.entries(files)) {
    fs.writeFileSync(
      path.join(root, name),
      typeof value === "string" ? value : JSON.stringify(value),
      "utf8",
    );
  }
}

export function pendingCatalogWork(hold: string, retire: () => void = () => {}) {
  const requests: Promise<unknown>[] = [];
  return {
    track<T>(request: Promise<T>) {
      void request.catch(() => {});
      requests.push(request);
      return request;
    },
    async [Symbol.asyncDispose]() {
      retire();
      fs.rmSync(hold, { force: true });
      await Promise.allSettled(requests);
    },
  };
}

export function catalogInput(
  fixture: Pick<PreparedModelRuntimeInput, "agentDir" | "workspaceDir" | "config"> & {
    env: NodeJS.ProcessEnv;
  },
  overrides: Omit<Partial<PreparedModelRuntimeInput>, "env"> = {},
) {
  const { agentDir, workspaceDir, config, env } = fixture;
  return {
    agentId: "main",
    agentDir,
    inheritedAuthDir: agentDir,
    workspaceDir,
    config,
    env,
    ...overrides,
  };
}

export function startCatalogBuild(
  input: PreparedModelRuntimeInput,
  retirement: AbortController,
  inventoryOwner?: Pick<PreparedModelRuntimeOwner, "catalogInventory" | "provenance">,
) {
  const isCurrent = () => !retirement.signal.aborted;
  return startSerializedSnapshotBuildBatch(
    [
      {
        input,
        catalogOwner: preparePublishedModelCatalogOwnerIdentity(input),
        ...(inventoryOwner ? { inventoryOwner } : {}),
        isGenerationCurrent: isCurrent,
        retirementSignal: retirement.signal,
        isBuildCurrent: isCurrent,
      },
    ],
    new Map(),
    30_000,
    "static",
  );
}

export function makeCatalogAgentFacts(
  input: PreparedModelRuntimeInput & { env: NodeJS.ProcessEnv },
  overrides: Partial<Omit<PreparedModelRuntimeAgentFacts, "input" | "env">> = {},
): PreparedModelRuntimeAgentFacts {
  return {
    input,
    env: input.env,
    authStore: { version: 1, profiles: {} },
    credentials: {},
    templateAuthStorage: AuthStorage.inMemory({}),
    providerIds: [PROVIDER_ID],
    configuredModelRefs: [],
    configuredRuntimeModels: [],
    runtimeCapabilityModels: [],
    configuredGeneratedCatalogPluginIds: [],
    ...overrides,
  };
}

export function writeUnrelatedFixturePlugin(
  root: string,
  kind?: "memory" | "context-engine",
): string {
  const pluginDir = path.join(root, "unrelated-plugin");
  fs.mkdirSync(pluginDir, { recursive: true });
  const pluginFile = path.join(pluginDir, "index.cjs");
  writeFixtureFiles(pluginDir, {
    "index.cjs": `const fs = require("node:fs");
const { isMainThread } = require("node:worker_threads");
if (!isMainThread) {
  fs.writeFileSync(process.env.${UNRELATED_PLUGIN_WORKER_MARKER_ENV}, "loaded", "utf8");
}
module.exports = { id: ${JSON.stringify(UNRELATED_PLUGIN_ID)}, register() {} };
`,
    "openclaw.plugin.json": {
      id: UNRELATED_PLUGIN_ID,
      ...(kind ? { kind } : {}),
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    },
  });
  return pluginFile;
}

export function writeFixturePlugin(params: {
  root: string;
  spinMs: number;
  receiptBroadcastName?: string;
  pluginVersion?: string;
  builtPluginVersion?: string;
  nativeCatalog?: boolean;
  asyncSyntheticAuth?: boolean;
  syntheticAuthAvailable?: boolean;
  catalogControl?: boolean;
  /** Publishes the Codex client version handed to this worker request as a model id. */
  reportCodexClientVersion?: boolean;
}): string {
  const pluginDir = path.join(params.root, "plugin");
  fs.mkdirSync(pluginDir, { recursive: true });
  let pluginFile = path.join(pluginDir, "index.cjs");
  const syntheticAuthProbePath = path.join(params.root, "synthetic-auth-probes.txt");
  const catalogControlSource = params.catalogControl
    ? writeCatalogFailureControl(params.root, PROVIDER_ID, CATALOG_ALIAS_ID)
    : "";
  const route = { api: "openai-completions", baseUrl: "https://worker-catalog.invalid/v1" };
  const catalogRoute = JSON.stringify(params.nativeCatalog ? { nativeRuntime: HARNESS_ID } : route);
  writeSyntheticAuthDiscoveryFixture({
    root: params.root,
    pluginDir,
    harnessId: HARNESS_ID,
    unrelatedId: UNRELATED_SYNTHETIC_AUTH_ID,
    pluginVersion: params.pluginVersion ?? "v1",
    asyncSyntheticAuth: params.asyncSyntheticAuth,
    syntheticAuthAvailable: params.syntheticAuthAvailable,
  });
  fs.writeFileSync(
    pluginFile,
    `const fs = require("node:fs");
const model = (id, name, fields = {}) => ({ id, name, ...fields });
const route = ${JSON.stringify(route)};
if (require("node:worker_threads").threadId !== ${threadId}) {
  fs.appendFileSync(${JSON.stringify(path.join(params.root, "runtime-artifact-paths.txt"))}, __filename + "\\n");
}
module.exports = {
  id: ${JSON.stringify(PLUGIN_ID)},
  register(api) {
    let nativeCatalogObserved = false;
    api.registerAgentHarness({
      id: ${JSON.stringify(HARNESS_ID)},
      label: "Worker catalog fixture harness",
      authBootstrap: "harness",
      supports: () => ({ supported: true }),
      runAttempt: async () => ({ ok: false, error: "unused" }),
      loadModelCatalog: async () => {
        nativeCatalogObserved = true;
        return [
          model("account-scoped-model", "Account scoped model", { provider: ${JSON.stringify(PROVIDER_ID)}, ...${catalogRoute} }),
          model("discovered-native-model", "Discovered native model", { provider: ${JSON.stringify(DISCOVERED_HARNESS_ID)} }),
          model("missing-auth-native-model", "Missing auth native model", { provider: ${JSON.stringify(MISSING_AUTH_HARNESS_ID)} }),
        ];
      },
      ${params.nativeCatalog ? 'readModelCatalogReadiness: () => nativeCatalogObserved ? { accountType: "chatgpt" } : undefined,' : ""}
    });
    for (const [id, authenticated] of [
      [${JSON.stringify(DISCOVERED_HARNESS_ID)}, true],
      [${JSON.stringify(MISSING_AUTH_HARNESS_ID)}, false],
    ]) {
      api.registerProvider({
        id,
        label: id,
        auth: [],
        ${params.asyncSyntheticAuth ? "async prepareSyntheticAuth" : "resolveSyntheticAuth"}() {
          ${params.asyncSyntheticAuth ? `if (require("node:worker_threads").threadId !== ${threadId}) throw Error("native auth probe entered worker");` : ""}
          fs.appendFileSync(${JSON.stringify(syntheticAuthProbePath)}, id + "\\n");
          return authenticated
            ? { apiKey: "discovered-native-login-not-real", source: "fixture native login", mode: "oauth" }
            : undefined;
        },
      });
    }
    api.registerProvider({
      id: ${JSON.stringify(PROVIDER_ID)},
      ${params.catalogControl ? `aliases: [${JSON.stringify(CATALOG_ALIAS_ID)}],` : ""}
      label: "Worker catalog fixture",
      auth: [],
      resolveDynamicModel(context) {
        if (context.modelId !== "configured-dynamic-model") return undefined;
        const template = context.modelRegistry.find(context.provider, "sqlite-model");
        return template && { ...template, id: context.modelId, name: "Configured dynamic model" };
      },
      resolveExternalAuthProfiles() {
        const credentialPath = process.env[${JSON.stringify(EXTERNAL_AUTH_PATH_ENV)}];
        if (!credentialPath || !fs.existsSync(credentialPath)) return [];
        const credentialMarker = fs.readFileSync(credentialPath, "utf8").trim();
        return [{
          profileId: ${JSON.stringify(EXTERNAL_AUTH_PROFILE_ID)},
          credential: {
            type: "oauth",
            provider: ${JSON.stringify(PROVIDER_ID)},
            access: ${JSON.stringify(params.pluginVersion ?? "v1")} + ":" + credentialMarker,
            refresh: "refresh-" + credentialMarker + "-not-real",
            expires: Date.now() + 60_000,
          },
        }];
      },
      catalog: {
        run(context) {
          ${catalogControlSource}
          ${
            params.reportCodexClientVersion
              ? `const handedOff = globalThis[Symbol.for("openclaw.codexClientVersionHandoff")]?.getStore();
          const codexClientVersion = handedOff ? (handedOff.version ?? "unreported") : "not-handed-off";`
              : ""
          }
          const refOnlyApi = context.resolveProviderApiKey(${JSON.stringify(REF_ONLY_API_PROVIDER_ID)}).apiKey;
          const refOnlyToken = context.resolveProviderApiKey(${JSON.stringify(REF_ONLY_TOKEN_PROVIDER_ID)}).apiKey;
          const durableAuth = context.resolveProviderApiKey(${JSON.stringify(DURABLE_AUTH_PROVIDER_ID)}).apiKey;
          const hasRefOnlyApi = refOnlyApi === ${JSON.stringify(REF_ONLY_API_ENV)} || refOnlyApi === process.env[${JSON.stringify(REF_ONLY_API_ENV)}];
          const hasRefOnlyToken = refOnlyToken === ${JSON.stringify(REF_ONLY_TOKEN_ENV)} || refOnlyToken === process.env[${JSON.stringify(REF_ONLY_TOKEN_ENV)}];
          return { provider: {
            ...route,
            models: [
              ${params.catalogControl ? "...legacyModels," : ""}
              ${params.reportCodexClientVersion ? 'model("codex-client-" + codexClientVersion, "Codex client version proof"),' : ""}
              model("sqlite-model", "SQLite model"),
              model(${JSON.stringify(`plugin-generation-${params.pluginVersion ?? "v1"}`)}, "Plugin generation proof"),
              model(\`ref-proof-api-\${hasRefOnlyApi}-token-\${hasRefOnlyToken}\`, "Ref-only worker proof"),
              ...(durableAuth === ${JSON.stringify(DURABLE_AUTH_KEY)}
                ? [model("post-startup-auth-model", "Post-startup auth model")]
                : []),
            ],
          } };
        },
      },
      async augmentModelCatalog(context) {
        ${params.receiptBroadcastName ? `const { sendReceipt } = await import(${JSON.stringify("data:text/javascript," + encodeURIComponent(fixtureReceiptWorkerClientSource(params.receiptBroadcastName) + "\nexport { sendReceipt };"))});` : ""}
        const marker = process.env.OPENCLAW_WORKER_CATALOG_MARKER;
        const invocation = fs.existsSync(marker)
          ? fs.readFileSync(marker, "utf8").split("start\\n").length
          : 1;
        fs.appendFileSync(process.env.OPENCLAW_WORKER_CATALOG_MARKER, "start\\n");
        ${params.receiptBroadcastName ? 'sendReceipt(marker, "start");' : ""}
        const barrier = marker + ".hold";
        if (fs.existsSync(barrier)) {
          await new Promise((resolve) => {
            // Darwin's directory watch can start after removal; observe file state instead.
            const check = () => {
              if (!fs.existsSync(barrier)) { fs.unwatchFile(barrier, check); resolve(); }
            };
            fs.watchFile(barrier, { interval: 10 }, check);
            check();
          });
        }
        const until = Date.now() + ${params.spinMs};
        while (Date.now() < until) {}
        const hasSqlite = context.entries.some((entry) =>
          entry.provider === ${JSON.stringify(PROVIDER_ID)} && entry.id === "sqlite-model");
        const hasShared = context.resolveProviderApiKey(${JSON.stringify(SHARED_AUTH_PROVIDER_ID)}).apiKey === ${JSON.stringify(MATERIALIZED_SECRET)};
        const hasUnrelated = context.resolveProviderApiKey("unrelated-provider").apiKey === ${JSON.stringify(UNRELATED_SECRET)};
        fs.appendFileSync(process.env.OPENCLAW_WORKER_CATALOG_MARKER, "done\\n");
        return [
          ${params.catalogControl ? `model("configured-row", "Configured-only model", { provider: ${JSON.stringify(PROVIDER_ID)}, ...route, status: "available", statusReason: "refresh-" + invocation }),` : ""}
          model(\`proof-refresh-\${invocation}-sqlite-\${hasSqlite}-shared-\${hasShared}-unrelated-\${hasUnrelated}\`, "Worker boundary proof", { provider: ${JSON.stringify(PROVIDER_ID)} }),
        ];
      },
    });
  },
};
`,
    "utf8",
  );
  if (params.builtPluginVersion) {
    const sourceFile = path.join(pluginDir, "index.cts");
    const entrypoints = ["index", "provider-discovery"];
    for (const entry of entrypoints) {
      fs.renameSync(path.join(pluginDir, `${entry}.cjs`), path.join(pluginDir, `${entry}.cts`));
    }
    writeFixturePlugin({
      root: params.root,
      spinMs: params.spinMs,
      receiptBroadcastName: params.receiptBroadcastName,
      pluginVersion: params.builtPluginVersion,
      asyncSyntheticAuth: params.asyncSyntheticAuth,
      syntheticAuthAvailable: params.syntheticAuthAvailable,
      catalogControl: params.catalogControl,
    });
    const distDir = path.join(pluginDir, "dist");
    fs.mkdirSync(distDir);
    for (const entry of entrypoints) {
      fs.renameSync(path.join(pluginDir, `${entry}.cjs`), path.join(distDir, `${entry}.cjs`));
    }
    pluginFile = sourceFile;
  }
  const harnessIds = [
    HARNESS_ID,
    DISCOVERED_HARNESS_ID,
    MISSING_AUTH_HARNESS_ID,
    UNRELATED_SYNTHETIC_AUTH_ID,
  ];
  writeFixtureFiles(pluginDir, {
    "openclaw.plugin.json": {
      id: PLUGIN_ID,
      providers: [
        PROVIDER_ID,
        DISCOVERED_HARNESS_ID,
        MISSING_AUTH_HARNESS_ID,
        ...(params.catalogControl ? [CATALOG_ALIAS_ID] : []),
      ],
      cliBackends: harnessIds,
      syntheticAuthRefs: harnessIds,
      providerCatalogEntry: params.builtPluginVersion
        ? "./provider-discovery.cts"
        : "./provider-discovery.cjs",
      configSchema: { type: "object", additionalProperties: false, properties: {} },
      contracts: { externalAuthProviders: [PROVIDER_ID] },
      modelCatalog: {
        discovery: { [PROVIDER_ID]: "runtime" },
        runtimeAugment: true,
        ...(params.catalogControl
          ? { aliases: { [CATALOG_ALIAS_ID]: { provider: PROVIDER_ID } } }
          : {}),
      },
    },
  });
  return pluginFile;
}

export async function createCatalogFixture(
  makeTempDir: (prefix: string) => string,
  spinMs: number,
  envOverride: NodeJS.ProcessEnv = {},
  options?: Omit<
    Parameters<typeof writeFixturePlugin>[0],
    "root" | "spinMs" | "pluginVersion" | "syntheticAuthAvailable"
  > & {
    hydrateExternalCliProviderIds?: readonly string[];
    codexNativeOwner?: boolean;
    codexNativeHomeScope?: "agent" | "user";
  },
) {
  const root = makeTempDir("openclaw-model-catalog-worker-");
  const stateDir = path.join(root, "state");
  const agentDir = path.join(stateDir, "agents", "main", "agent");
  const workspaceDir = path.join(root, "workspace");
  const marker = path.join(root, "worker-marker.txt");
  const externalAuthPath = path.join(root, "external-auth.txt");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  const pluginFile = writeFixturePlugin({ root, spinMs, ...options });
  fs.writeFileSync(externalAuthPath, "A", "utf8");
  const env = {
    ...process.env,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: options?.codexNativeOwner ? undefined : "1",
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_WORKER_CATALOG_MARKER: marker,
    [EXTERNAL_AUTH_PATH_ENV]: externalAuthPath,
    ...envOverride,
    [REF_ONLY_API_ENV]: "ref-only-api-secret-not-real",
    [REF_ONLY_TOKEN_ENV]: "ref-only-token-secret-not-real",
  };
  await prepareSharedAuthStoreOwnership(env);
  const models: Record<string, AgentModelEntryConfig> = {
    [`${PROVIDER_ID}/sqlite-model`]: { agentRuntime: { id: HARNESS_ID } },
  };
  if (options?.nativeCatalog) {
    for (const [id, runtime] of [
      ["account-scoped-model", HARNESS_ID],
      ["configured-dynamic-model", "openclaw"],
      ["unresolved-configured-model", "openclaw"],
    ] as const) {
      models[`${PROVIDER_ID}/${id}`] = { agentRuntime: { id: runtime } };
    }
  }
  const entries: Record<string, PluginEntryConfig> = { [PLUGIN_ID]: { enabled: true } };
  if (options?.codexNativeOwner) {
    models["openai/gpt-5.4"] = { agentRuntime: { id: "codex" } };
    entries.openai = { enabled: true };
    entries.codex = {
      enabled: true,
      config: {
        discovery: { enabled: false },
        ...(options.codexNativeHomeScope
          ? { appServer: { homeScope: options.codexNativeHomeScope } }
          : {}),
      },
    };
  }
  const config = {
    agents: { defaults: { model: `${PROVIDER_ID}/sqlite-model`, models } },
    plugins: { allow: Object.keys(entries), load: { paths: [pluginFile] }, entries },
  } satisfies OpenClawConfig;
  await seedFixturePluginModelCatalog(agentDir, env, PLUGIN_ID, PROVIDER_ID);
  const profiles: AuthProfileStore["profiles"] = {
    [PROFILE_ID]: {
      type: "token",
      provider: SHARED_AUTH_PROVIDER_ID,
      token: MATERIALIZED_SECRET,
      tokenRef: { source: "env", provider: "default", id: "SHARED_SECRET_REF" },
    },
  };
  if (!options?.nativeCatalog) {
    profiles["unrelated-provider:default"] = {
      type: "api_key",
      provider: "unrelated-provider",
      key: UNRELATED_SECRET,
      keyRef: { source: "env", provider: "default", id: "UNRELATED_SECRET_REF" },
    };
  }
  replaceRuntimeAuthProfileStoreSnapshots([
    {
      agentDir,
      store: { version: 1, profiles, order: { [SHARED_AUTH_PROVIDER_ID]: [PROFILE_ID] } },
    },
  ]);
  const hydratedAuthStore = options?.hydrateExternalCliProviderIds
    ? ensureAuthProfileStore(agentDir, {
        allowKeychainPrompt: false,
        config,
        externalCliProviderIds: options.hydrateExternalCliProviderIds,
        readOnly: true,
        syncExternalCli: false,
      })
    : undefined;
  return { agentDir, config, env, marker, externalAuthPath, hydratedAuthStore, root, workspaceDir };
}

export async function expectNativeHarnessModelsPublishedFromWorker(params: {
  makeTempDir: (prefix: string) => string;
  retireAfterTest: (retire: () => void) => void;
}): Promise<void> {
  const inventoryOwner: Pick<PreparedModelRuntimeOwner, "catalogInventory" | "provenance"> = {
    provenance: "standalone",
  };
  const fixture = await createCatalogFixture(
    params.makeTempDir,
    0,
    { [EXTERNAL_AUTH_PATH_ENV]: "" },
    { nativeCatalog: true },
  );
  const { config } = fixture;
  const retirement = new AbortController();
  params.retireAfterTest(() => retirement.abort());
  const build = (
    await startCatalogBuild(catalogInput(fixture), retirement, inventoryOwner).pending
  )[0]!;
  // Direct builds need the same retained generation that publication gives real callers.
  await using _ = {
    [Symbol.asyncDispose]: retainPreparedPluginGeneration(build.pluginGeneration),
  };
  const { snapshot } = build;
  const previousRegistry = captureActivePluginRegistrySnapshot();
  setActivePluginRegistry(createEmptyPluginRegistry());
  const readAuthStore = vi.spyOn(auth, "getPreparedRuntimeAuthProfileStoreSnapshot");
  const ownerSpy = vi.spyOn(catalogRuntime, "getPublishedPreparedModelCatalogOwnerSnapshot");
  const commandsSpy = vi.spyOn(commandsRuntime, "buildCommandsListResult");
  try {
    expect(snapshot.modelCatalog.entries).toContainEqual(catalogEntry("configured-dynamic-model"));
    const catalog = await refreshNativeCatalogDuringBoundedRead({
      snapshot,
      inventoryOwner,
      harnessId: HARNESS_ID,
    });
    expect(catalog.staticEntries).toContainEqual(
      catalogEntry("configured-dynamic-model", { name: "Configured dynamic model" }),
    );
    expect(catalog.entries).toContainEqual(
      catalogEntry("account-scoped-model", { nativeRuntime: HARNESS_ID }),
    );
    const fullAuth = expectDefined(
      getPreparedModelFullCatalogAuth(catalog),
      "expected prepared full-catalog auth",
    );
    const context = {
      getRuntimeConfig: () => config,
      logGateway: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as unknown as GatewayRequestContext;
    expect(catalog.staticEntries).not.toContainEqual(catalogEntry("unresolved-configured-model"));

    readAuthStore.mockReturnValue(fullAuth.authStore);
    ownerSpy.mockReturnValue(snapshot);
    commandsSpy.mockResolvedValue({ commands: [] });
    const chatMetadata = createGatewayChatMetadataRuntime({
      getConfig: () => config,
      getContext: () => context,
      log: context.logGateway,
    });
    await chatMetadata.refresh();
    const metadata = await chatMetadata.read({ agentId: "main" });
    expect(metadata.models).toEqual(
      expect.arrayContaining([
        catalogEntry("account-scoped-model", { available: true }),
        catalogEntry("configured-dynamic-model", {
          name: "Configured dynamic model",
          available: false,
        }),
      ]),
    );
  } finally {
    ownerSpy.mockRestore();
    commandsSpy.mockRestore();
    readAuthStore.mockRestore();
    restoreActivePluginRegistrySnapshot(previousRegistry);
  }
  for (const key of ["entries", "routeVariants", "staticEntries"] as const) {
    expect(
      inventoryOwner.catalogInventory?.catalog[key]?.some(
        (entry) => entry.id === "configured-dynamic-model",
      ),
      key,
    ).toBe(false);
  }
}

export function expectCatalogAuth(snapshot: PreparedModelRuntimeSnapshot, provider: string) {
  const owner = catalogRuntime.materializePreparedModelCatalogOwner(snapshot);
  return expect(
    formatModelCatalogAuthLabel(
      getPreparedModelRuntimeAuthLabels(owner).get(provider)?.all ?? "missing",
      {
        cfg: owner.config,
        store: getPreparedModelRuntimeAuthStore(owner)!,
        metadataSnapshot: owner.metadataSnapshot,
      },
    ),
  );
}
