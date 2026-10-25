import dns from "node:dns/promises";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getModelCompletionTransport } from "../llm/model-runtime-binding.js";
import { streamSimple } from "../llm/stream.js";
import { loadAndActivateRootPluginRegistry } from "../plugins/loader.js";
import { resetPluginLoaderTestStateForTest } from "../plugins/loader.test-fixtures.js";
import { getPluginValueInstance } from "../plugins/plugin-instance-scope.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { getModelProviderRuntimePluginHandle } from "../plugins/provider-hook-runtime.js";
import {
  createColdPluginFixture,
  createColdPluginHermeticEnv,
  isColdPluginRuntimeLoaded,
} from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { createSyncSuiteTempRootTracker } from "../plugins/test-helpers/fs-fixtures.js";
import { clearSecretsRuntimeSnapshotState } from "../secrets/runtime-state.js";
import { withEnvAsync } from "../test-utils/env.js";
import * as authProfileStoreRuntime from "./auth-profiles/store-runtime.js";
import { resolveModelAsync } from "./embedded-agent-runner/model.js";
import { withPreparedModelInference } from "./prepared-model-inference.js";
import {
  acquireAgentRunPreparedModelRuntime,
  type PreparedModelRuntimeSnapshot,
} from "./prepared-model-runtime.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "./prepared-model-runtime.test-support.js";
import { getModelProviderLocalServiceReconciler } from "./provider-local-service-reconcile.js";
import { getModelProviderLocalService } from "./provider-local-service.js";
import { registerProviderStreamForModel } from "./provider-stream.js";
import { AuthStorage, ModelRegistry } from "./sessions/index.js";
import { completeWithAuthProfileFailover } from "./simple-completion-profile-failover.js";
import {
  completeWithPreparedSimpleCompletionModel,
  prepareSimpleCompletionModel,
  acquireSimpleCompletionModelWithSelection,
  acquireSimpleCompletionModelForAgent,
} from "./simple-completion-runtime.js";
import type { SimpleCompletionModelResolver } from "./simple-completion-scope.js";
import {
  assertPrepared,
  completionChunk,
  completionConfig,
  completionContext,
  completionModelDefinition,
  startCompletionServer,
} from "./simple-completion.test-support.js";

const tempRoots = createSyncSuiteTempRootTracker("openclaw-simple-completion-plugin-scope");
type PluginFixture = ReturnType<typeof createColdPluginFixture>;
function fixtureEnv(tempRoot: string) {
  return {
    ...createColdPluginHermeticEnv(tempRoot, { bundledPluginsDir: tempRoots.makeTempDir() }),
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    OPENCLAW_STATE_DIR: path.join(tempRoot, "state"),
  };
}
function fixtureConfig(
  fixture: PluginFixture,
  baseUrl: string,
  provider: Partial<ModelProviderConfig> = {},
  others: PluginFixture[] = [],
): OpenClawConfig {
  const plugins = [fixture, ...others];
  return completionConfig(
    fixture.providerId,
    {
      api: "openai-completions",
      baseUrl,
      models: [completionModelDefinition({ id: "selected-model", name: "Selected" })],
      ...provider,
    },
    {
      agents: {
        defaults: { workspace: fixture.rootDir, model: `${fixture.providerId}/selected-model` },
      },
      plugins: {
        load: { paths: plugins.map((plugin) => plugin.rootDir) },
        slots: { memory: "none" },
        entries: Object.fromEntries(plugins.map((plugin) => [plugin.pluginId, { enabled: true }])),
      },
    },
  );
}
function createTransportOwnerFixture(
  rootDir: string,
  owner: "A" | "B",
  registerProviderStream = true,
  authScope: "agent" | "plugin" = "agent",
) {
  fs.mkdirSync(rootDir);
  const fixture = createColdPluginFixture({
    rootDir,
    pluginId: `completion-owner-${owner.toLowerCase()}`,
    providerId: "completion-owner-provider",
    manifest: {
      modelCatalog: { providers: { "completion-owner-provider": { authScope, models: [] } } },
    },
  });
  const reconcileFailureMarker = path.join(rootDir, "fail-reconcile");
  const ownerEvent = `completion-owner:${rootDir}`;
  const createStreamSource = registerProviderStream
    ? `createStreamFn() {
        const source = getApiProvider("openai-completions");
        if (!source) throw new Error("OpenAI completion transport is not registered");
        return (model, context, options) => source.streamSimple(
          { ...model, api: "openai-completions" }, context,
          { ...options, headers: { ...options?.headers, "x-completion-stream": owner } },
        );
      },`
    : "";
  fs.writeFileSync(
    fixture.runtimeSource,
    `const fs = require("node:fs");
const { getApiProvider } = require("openclaw/plugin-sdk/llm");
const owner = ${JSON.stringify(owner)};
const reconcileFailureMarker = ${JSON.stringify(reconcileFailureMarker)};
fs.writeFileSync(${JSON.stringify(fixture.runtimeMarker)}, "loaded", "utf8");
module.exports = {
  id: ${JSON.stringify(fixture.pluginId)},
  register(api) {
    process.on(${JSON.stringify(ownerEvent)}, () => {});
    api.registerProvider({
      id: ${JSON.stringify(fixture.providerId)}, label: owner, auth: [], authScope: ${JSON.stringify(authScope)},
      resolveSyntheticAuth() { return { apiKey: "fixture-auth-source", mode: "api-key", source: "plugin:fixture" }; },
      async prepareRuntimeAuth() { return { apiKey: "fixture-auth-" + owner }; },
      ${createStreamSource}
      async reconcileLocalService({ baseUrl, signal }) {
        if (fs.existsSync(reconcileFailureMarker)) {
          throw new Error("fixture reconciliation failed");
        }
        const origin = new URL(baseUrl).origin;
        const response = await fetch(origin + "/models?reload=1", { signal });
        if (!response.ok) throw new Error("fixture reload failed: HTTP " + response.status);
      },
      wrapSimpleCompletionStreamFn({ streamFn }) {
        let invocation = 0;
        return (model, context, options) => streamFn(model, context, {
          ...options, headers: {
            ...options?.headers,
            "x-completion-wrapper": owner,
            "x-completion-sequence": String(++invocation),
            "x-completion-reasoning": options?.reasoning ?? "omitted",
          },
        });
      },
    });
  },
};
`,
    "utf8",
  );
  return { ...fixture, reconcileFailureMarker, ownerEvent };
}

afterEach(async () => {
  await resetPreparedModelRuntimeSnapshotsForTest();
  clearPluginMetadataLifecycleCaches();
  resetPluginLoaderTestStateForTest();
  tempRoots.cleanup();
});

it.each([
  { authorityState: "current" },
  { authorityState: "current", plaintext: true, exchange: true },
  { authorityState: "disabled" },
  { authorityState: "revoked" },
  { authorityState: "registration-replaced" },
  { authorityState: "secrets-replaced" },
  { authorityState: "secrets-replaced", plaintext: true },
  { authorityState: "current", noAuth: true },
  { authorityState: "secrets-replaced", noAuth: true },
  { authorityState: "secrets-replaced", exchange: true },
  { authorityState: "during-dns" },
  { authorityState: "during-dns", plaintext: true, exchange: true },
  { authorityState: "secrets-replaced", stream: "builtin" },
  { authorityState: "current", stream: "builtin" },
  { authorityState: "secrets-replaced", stream: "plugin" },
  { authorityState: "current", stream: "plugin" },
  { authorityState: "current", stream: "google" },
  { authorityState: "during-dns", stream: "google" },
  { authorityState: "current", stream: "google-builtin" },
  { authorityState: "during-dns", stream: "google-builtin" },
])(
  "uses plugin credential authority at retained dispatch: %j",
  async ({ authorityState, plaintext, noAuth, exchange, stream }) => {
    const tempRoot = fs.realpathSync(tempRoots.makeTempDir());
    const pluginRoot = path.join(tempRoot, "plugin");
    fs.mkdirSync(pluginRoot);
    const selected = createColdPluginFixture({
      rootDir: pluginRoot,
      pluginId: "completion-auth-owner",
      providerId: "completion-auth-provider",
      manifest: {
        modelCatalog: {
          providers: { "completion-auth-provider": { authScope: "plugin", models: [] } },
        },
      },
    });
    fs.writeFileSync(
      selected.runtimeSource,
      `const { getApiProvider } = require("openclaw/plugin-sdk/llm");
module.exports = {
  id: ${JSON.stringify(selected.pluginId)},
  register(api) {
    api.registerProvider({
      id: ${JSON.stringify(selected.providerId)}, label: "Completion auth", auth: [], authScope: "plugin",
      resolveSyntheticAuth() {
        return {
          apiKey: ${JSON.stringify(noAuth ? "custom-local" : "live-plugin-key")}, mode: "api-key", source: "plugin:completion-auth",
        };
      },
      ${exchange ? 'async prepareRuntimeAuth() { await Promise.resolve(); return { apiKey: "exchanged-plugin-key", request: { headers: { "x-exchange": "exchanged-header" } } }; },' : ""}
      ${stream === "plugin" || stream === "google" ? `createStreamFn() { return (model, context, options) => getApiProvider(${JSON.stringify(stream === "google" ? "google-generative-ai" : "openai-completions")}).streamSimple(model, context, options); },` : ""}
    });
  },
};
`,
    );
    const authorizations: Array<string | undefined> = [];
    await using server = await startCompletionServer((request, response) => {
      request.resume();
      authorizations.push(request.headers.authorization);
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (stream?.startsWith("google")) {
        response.end(
          `data: ${JSON.stringify({
            candidates: [
              {
                content: { parts: [{ text: "plugin-owned completion" }], role: "model" },
                finishReason: "STOP",
              },
            ],
          })}\n\n`,
        );
        return;
      }
      response.end(completionChunk("plugin-owned completion"));
    });
    let preparedResource: AsyncDisposable | undefined;
    const readAgentStore = vi.fn(async () => {
      throw new Error("agent auth storage unavailable");
    });
    let restoreStoreRead: (() => void) | undefined;
    let restoreDns: (() => void) | undefined;
    let dnsRevoked = false;
    try {
      const cfg: OpenClawConfig = {
        ...fixtureConfig(selected, server.baseUrl, {
          api: stream?.startsWith("google") ? "google-generative-ai" : "openai-completions",
        }),
        auth: { order: { [selected.providerId]: ["missing-agent-profile"] } },
      };
      await withEnvAsync(
        {
          ...fixtureEnv(tempRoot),
          OPENCLAW_SECRET_SENTINELS: plaintext ? "off" : undefined,
        },
        async () => {
          const params = {
            cfg,
            agentId: "main",
            agentDir: path.join(tempRoot, "agent"),
            profileFailover: true,
            modelRef: `${selected.providerId}/selected-model`,
            modelResolver: (async (...args) => {
              const result = await resolveModelAsync(...args);
              // Leave model discovery real; poison only the subsequent credential-planning phase.
              const spy = vi
                .spyOn(authProfileStoreRuntime, "ensureAuthProfileStoreAsync")
                .mockImplementation(readAgentStore);
              restoreStoreRead = () => spy.mockRestore();
              return result;
            }) satisfies SimpleCompletionModelResolver,
          };
          const prepared = await acquireSimpleCompletionModelForAgent(params);
          assertPrepared(prepared);
          preparedResource = prepared;
          expect(prepared.auth.profileId).toBeUndefined();
          expect(prepared.authProfiles).toBeUndefined();
          const authHook = getModelProviderRuntimePluginHandle(prepared.model)?.plugin
            ?.resolveSyntheticAuth;
          const instance = authHook && getPluginValueInstance(authHook);
          if (!instance?.owner) {
            throw new Error("Missing completion credential owner");
          }
          const preparedStream =
            stream === "builtin" || stream === "plugin"
              ? (registerProviderStreamForModel({ model: prepared.model, cfg }) ??
                (stream === "builtin" ? streamSimple : undefined))
              : undefined;
          if (authorityState === "disabled") {
            instance.owner.record.enabled = false;
          } else if (authorityState === "revoked") {
            instance.owner.revoked = true;
          } else if (authorityState === "registration-replaced") {
            const registry = instance.owner.registry;
            const registration = registry?.providers.find(
              (entry) => entry.pluginId === selected.pluginId,
            );
            if (!registration || !registry) {
              throw new Error("Missing completion credential registration");
            }
            registry.providers[registry.providers.indexOf(registration)] = { ...registration };
          } else if (authorityState === "secrets-replaced") {
            clearSecretsRuntimeSnapshotState();
          } else if (authorityState === "during-dns") {
            const lookup = dns.lookup;
            const spy = vi.spyOn(dns, "lookup").mockImplementation(async (...args) => {
              const resolved = await lookup(...args);
              clearSecretsRuntimeSnapshotState();
              dnsRevoked = true;
              return resolved;
            });
            // Source and loaded plugin SDK transports share the native DNS boundary.
            syncBuiltinESMExports();
            restoreDns = () => {
              spy.mockRestore();
              syncBuiltinESMExports();
            };
          }
          const result = await completeWithAuthProfileFailover({
            prepared,
            cfg,
            agentDir: params.agentDir,
            assertCurrent: () => {},
            warn: vi.fn(),
            complete: async (current) => {
              if (stream === "builtin" || stream === "plugin") {
                if (!preparedStream) {
                  throw new Error("Missing retained provider stream");
                }
                return await (
                  await preparedStream(current.model, completionContext(), {
                    apiKey: current.auth.apiKey,
                  })
                ).result();
              }
              return completeWithPreparedSimpleCompletionModel({
                ...current,
                cfg,
                context: completionContext(),
              });
            },
          }).catch((error: unknown) => ({
            stopReason: "error",
            errorMessage: error instanceof Error ? error.message : String(error),
          }));
          if (authorityState === "current") {
            expect(result, JSON.stringify(result)).toMatchObject({
              stopReason: "stop",
              content: [{ type: "text", text: "plugin-owned completion" }],
            });
            expect(authorizations).toEqual([
              noAuth || stream?.startsWith("google")
                ? undefined
                : `Bearer ${exchange ? "exchanged-plugin-key" : "live-plugin-key"}`,
            ]);
          } else {
            expect(result).toMatchObject({ stopReason: "error" });
            if (authorityState === "during-dns") {
              expect(dnsRevoked).toBe(true);
            } else if (stream !== "builtin") {
              expect(result).toMatchObject({
                errorMessage: expect.stringContaining("credential owner was retired or replaced"),
              });
            }
            expect(authorizations).toEqual([]);
          }
          expect(readAgentStore).not.toHaveBeenCalled();
        },
      );
    } finally {
      restoreStoreRead?.();
      restoreDns?.();
      await preparedResource?.[Symbol.asyncDispose]();
    }
  },
);

it.each([
  { expectedModelId: "selected-model", mode: "direct" },
  { expectedModelId: "utility-model", mode: "agent" },
  { expectedModelId: "selected-model", mode: "decision" },
])("loads only the $mode selected plugin generation", async ({ expectedModelId, mode }) => {
  const tempRoot = tempRoots.makeTempDir();
  const selectedRoot = path.join(tempRoot, "selected");
  const unrelatedRoot = path.join(tempRoot, "unrelated");
  fs.mkdirSync(selectedRoot, { recursive: true });
  fs.mkdirSync(unrelatedRoot, { recursive: true });
  const selected = createColdPluginFixture({
    rootDir: selectedRoot,
    pluginId: "selected-provider-plugin",
    providerId: "selected-provider",
    manifest: {
      modelCatalog: {
        providers: {
          "selected-provider": {
            defaultUtilityModel: "utility-model",
            models: [{ id: "primary-model" }, { id: "utility-model" }],
          },
        },
      },
    },
  });
  const unrelated = createColdPluginFixture({
    rootDir: unrelatedRoot,
    pluginId: "unrelated-provider-plugin",
    providerId: "unrelated-provider",
  });
  const agentOwners = ["memory", "context"].map((kind) => {
    const rootDir = path.join(tempRoot, kind);
    fs.mkdirSync(rootDir);
    return createColdPluginFixture({
      rootDir,
      pluginId: `expensive-${kind}`,
      manifest: kind === "memory" ? { kind: "memory" } : {},
      runtimeMessage: "Simple completions must not evaluate agent-owned plugins",
    });
  });
  fs.writeFileSync(
    selected.runtimeSource,
    `const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(selected.runtimeMarker)}, "loaded", "utf8");
module.exports = {
  id: ${JSON.stringify(selected.pluginId)},
  register(api) {
    api.registerProvider({ id: ${JSON.stringify(selected.providerId)}, label: "Selected", auth: [] });
  },
};
`,
    "utf8",
  );
  const config = {
    agents: {
      defaults: { model: `${selected.providerId}/primary-model@work` },
    },
    plugins: {
      load: {
        paths: [
          selected.rootDir,
          unrelated.rootDir,
          ...agentOwners.map((plugin) => plugin.rootDir),
        ],
      },
      slots: { memory: "expensive-memory", contextEngine: "expensive-context" },
      entries: {
        [selected.pluginId]: { enabled: true },
        [unrelated.pluginId]: { enabled: true },
        "expensive-memory": { enabled: true },
        "expensive-context": { enabled: true },
      },
    },
  } satisfies OpenClawConfig;
  let preparedRuntime: PreparedModelRuntimeSnapshot | undefined;
  const modelResolver: SimpleCompletionModelResolver = vi.fn(
    async (provider, modelId, _agentDir, _cfg, options) => {
      preparedRuntime = options?.preparedModelRuntime;
      return {
        error: `stop after selected resolver ${provider}/${modelId}`,
        authStorage: options?.authStorage ?? AuthStorage.inMemory({}),
        modelRegistry: options?.modelRegistry ?? ModelRegistry.inMemory(AuthStorage.inMemory({})),
      };
    },
  );
  const env = fixtureEnv(tempRoot);

  let acquiredResource: AsyncDisposable | undefined;
  try {
    const result = await withEnvAsync(env, async () => {
      if (mode === "decision") {
        return await withPreparedModelInference(
          { cfg: config, agentId: "main", signal: new AbortController().signal },
          { provider: selected.providerId, modelId: expectedModelId },
          async ({ preparedModelRuntime }) => {
            preparedRuntime = preparedModelRuntime;
            return {
              error: `stop after selected resolver ${selected.providerId}/${expectedModelId}`,
            };
          },
        );
      }
      const acquired =
        mode === "agent"
          ? await acquireSimpleCompletionModelForAgent({
              cfg: config,
              agentId: "main",
              useUtilityModel: true,
              modelResolver,
            })
          : await acquireSimpleCompletionModelWithSelection(
              { cfg: config, agentId: "main", modelResolver },
              () => ({ selection: { provider: selected.providerId, modelId: expectedModelId } }),
            );
      if (!("error" in acquired)) {
        acquiredResource = acquired;
      }
      return acquired;
    });
    expect(result).toMatchObject({
      error: `stop after selected resolver ${selected.providerId}/${expectedModelId}`,
    });
    expect(modelResolver).toHaveBeenCalledTimes(mode === "decision" ? 0 : 1);
    expect(isColdPluginRuntimeLoaded(selected)).toBe(true);
    expect(isColdPluginRuntimeLoaded(unrelated)).toBe(false);
    for (const owner of agentOwners) {
      expect(isColdPluginRuntimeLoaded(owner)).toBe(false);
    }
    expect(preparedRuntime?.metadataSnapshot.pluginIds).toContain(selected.pluginId);
    expect(preparedRuntime?.metadataSnapshot.pluginIds).not.toContain(unrelated.pluginId);
    expect(
      preparedRuntime?.pluginRegistry?.plugins
        .filter((plugin) => plugin.status === "loaded")
        .map((plugin) => plugin.id),
    ).toEqual([selected.pluginId]);
  } finally {
    await acquiredResource?.[Symbol.asyncDispose]();
  }
});

it.each([
  { mode: "acquired", authScope: "agent" },
  { mode: "borrowed", authScope: "agent" },
  { mode: "empty", authScope: "agent" },
  { mode: "acquired", authScope: "plugin" },
  { mode: "borrowed", authScope: "plugin" },
] as const)(
  "keeps $mode $authScope ownership across ambient replacement and repeated completion",
  async ({ mode, authScope }) => {
    const tempRoot = fs.realpathSync(tempRoots.makeTempDir());
    const selected = createTransportOwnerFixture(
      path.join(tempRoot, "selected"),
      "A",
      true,
      authScope,
    );
    const ambient = createTransportOwnerFixture(path.join(tempRoot, "ambient"), "B");
    const unrelatedRoot = path.join(tempRoot, "unrelated");
    fs.mkdirSync(unrelatedRoot);
    const unrelated = createColdPluginFixture({
      rootDir: unrelatedRoot,
      pluginId: "unrelated-provider-plugin",
      providerId: "unrelated-provider",
    });
    let requestCount = 0;
    await using server = await startCompletionServer((request, response) => {
      request.resume();
      requestCount += 1;
      const text = [
        requestCount,
        request.headers["x-completion-stream"] ?? "none",
        request.headers["x-completion-wrapper"] ?? "none",
        request.headers["x-completion-sequence"] ?? "none",
        request.headers["x-completion-reasoning"] ?? "none",
        request.headers.authorization,
      ].join("|");
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(completionChunk(text));
    });
    const configFor = (fixture: PluginFixture) =>
      fixtureConfig(fixture, server.baseUrl, { apiKey: "fixture-auth-source" }, [unrelated]);
    const cfg = configFor(selected);
    const env = fixtureEnv(tempRoot);
    await withEnvAsync(env, async () => {
      const input = {
        config: cfg,
        agentId: "main",
        agentDir: path.join(tempRoot, "agent"),
        workspaceDir: selected.rootDir,
      };
      const lease =
        mode === "acquired"
          ? undefined
          : await acquireAgentRunPreparedModelRuntime(
              {
                ...input,
                readOnly: mode === "empty",
                loadRuntimePlugins: mode === "borrowed",
                ...(mode === "borrowed"
                  ? {
                      runtimePluginSelections: [
                        {
                          provider: selected.providerId,
                          modelId: "selected-model",
                          agentId: "main",
                        },
                      ],
                    }
                  : {}),
              },
              { catalogMode: "static" },
            );
      let preparedResource: AsyncDisposable | undefined;
      try {
        if (mode === "empty") {
          expect(lease?.snapshot.pluginRegistry).toBeUndefined();
        }
        const activateAmbient = () =>
          loadAndActivateRootPluginRegistry({
            config: configFor(ambient),
            workspaceDir: ambient.rootDir,
            onlyPluginIds: [ambient.pluginId],
            throwOnLoadError: true,
          });
        if (mode !== "acquired") {
          await activateAmbient();
        }
        // Loading the public SDK must retain the host's registered metadata owners.
        const metadataReaders = readHostMetadataReaders();
        expect(metadataReaders.every((reader) => typeof reader === "function")).toBe(true);
        const modelParams = {
          cfg,
          agentId: "main",
          agentDir: input.agentDir,
          workspaceDir: input.workspaceDir,
          provider: selected.providerId,
          modelId: "selected-model",
        };
        const acquire = () =>
          acquireSimpleCompletionModelForAgent({
            ...modelParams,
            modelRef: `${selected.providerId}/selected-model`,
          });
        let prepared: Awaited<ReturnType<typeof prepareSimpleCompletionModel>>;
        if (lease) {
          prepared = await prepareSimpleCompletionModel({
            ...modelParams,
            preparedModelRuntime: lease.snapshot,
          });
        } else {
          const acquired = await acquire();
          if (!("error" in acquired)) {
            preparedResource = acquired;
          }
          prepared = acquired;
        }
        assertPrepared(prepared);
        if (mode === "acquired") {
          const repeatedPreparation = await acquire();
          assertPrepared(repeatedPreparation);
          await using repeated = repeatedPreparation;
          expect(repeated).not.toHaveProperty("error");
          expect(process.listenerCount(selected.ownerEvent)).toBe(1);
          await activateAmbient();
        }
        // Callers use the logical API before dispatch, including CLI system-prompt selection.
        expect(prepared.model.api).toBe("openai-completions");
        expect(isColdPluginRuntimeLoaded(ambient)).toBe(true);
        const owner = mode === "empty" ? "none" : "A";
        const auth = mode === "empty" ? "fixture-auth-source" : "fixture-auth-A";
        for (const [index, reasoning] of (["off", "max", undefined] as const).entries()) {
          const turn = index + 1;
          const result = await completeWithPreparedSimpleCompletionModel({
            model: prepared.model,
            auth: prepared.auth,
            cfg,
            context: completionContext(`Turn ${turn}`, turn),
            options: { reasoning },
          });
          const wrapperState = mode === "empty" ? "none|none" : `${turn}|${reasoning ?? "omitted"}`;
          expect(result).toMatchObject({
            stopReason: "stop",
            content: [
              {
                type: "text",
                text: `${turn}|${owner}|${owner}|${wrapperState}|Bearer ${auth}`,
              },
            ],
          });
        }
        expect(prepared.model.api).toBe("openai-completions");
        expect(isColdPluginRuntimeLoaded(unrelated)).toBe(false);
        expect(
          readHostMetadataReaders(),
          "public SDK loading must preserve registered host metadata readers",
        ).toEqual(metadataReaders);
      } finally {
        await preparedResource?.[Symbol.asyncDispose]();
        await lease?.[Symbol.asyncDispose]();
      }
    });
  },
);

it.each([false, true])(
  "reconciles before managed completions (failure: %s)",
  async (failReconciliation) => {
    const tempRoot = fs.realpathSync(tempRoots.makeTempDir());
    const selected = createTransportOwnerFixture(path.join(tempRoot, "selected"), "A", false);
    const requestPaths: string[] = [];
    let preparedResource: AsyncDisposable | undefined;
    await using server = await startCompletionServer((request, response) => {
      request.resume();
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      requestPaths.push(`${requestUrl.pathname}${requestUrl.search}`);
      if (requestUrl.pathname === "/health" || requestUrl.pathname === "/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"ok":true}');
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(completionChunk("done"));
    });
    try {
      const { origin } = server;
      const cfg = fixtureConfig(selected, `${origin}/v1`, {
        apiKey: "fixture-auth-source",
        localService: {
          command: process.execPath,
          args: ["--version"],
          healthUrl: `${origin}/health`,
          idleStopMs: 1,
        },
      });
      const env = fixtureEnv(tempRoot);
      await withEnvAsync(env, async () => {
        const prepared = await acquireSimpleCompletionModelForAgent({
          cfg,
          agentId: "main",
          agentDir: path.join(tempRoot, "agent"),
          modelRef: `${selected.providerId}/selected-model`,
        });
        assertPrepared(prepared);
        preparedResource = prepared;
        const completionTransport = getModelCompletionTransport(prepared.model);
        if (!completionTransport) {
          throw new Error("Managed completion transport was not prepared");
        }
        expect(getModelProviderLocalService(prepared.model)).toBeDefined();
        expect(getModelProviderLocalService(completionTransport)).toBeDefined();
        expect(getModelProviderLocalServiceReconciler(prepared.model)).toBeTypeOf("function");
        expect(getModelProviderLocalServiceReconciler(completionTransport)).toBeTypeOf("function");
        if (failReconciliation) {
          fs.writeFileSync(selected.reconcileFailureMarker, "fail", "utf8");
        }
        await expect(
          completeWithPreparedSimpleCompletionModel({
            model: prepared.model,
            auth: prepared.auth,
            cfg,
            context: completionContext(),
          }),
        ).resolves.toMatchObject(
          failReconciliation
            ? { stopReason: "error", content: [] }
            : { stopReason: "stop", content: [{ type: "text", text: "done" }] },
        );
      });
      const reloadIndex = requestPaths.indexOf("/models?reload=1");
      const modelRequestIndex = requestPaths.findIndex(
        (requestPath) => requestPath !== "/health" && requestPath !== "/models?reload=1",
      );
      if (failReconciliation) {
        expect(reloadIndex).toBe(-1);
        expect(modelRequestIndex).toBe(-1);
      } else {
        expect(reloadIndex).toBeGreaterThanOrEqual(0);
        expect(modelRequestIndex).toBeGreaterThan(reloadIndex);
      }
    } finally {
      await preparedResource?.[Symbol.asyncDispose]();
    }
  },
);

function readHostMetadataReaders(): readonly unknown[] {
  const readers = Reflect.get(globalThis, Symbol.for("openclaw.pluginMetadataSnapshotReaders")) as
    | Record<string, unknown>
    | undefined;
  return [readers?.getCurrentPluginMetadataSnapshot, readers?.resolvePluginMetadataSnapshot];
}
