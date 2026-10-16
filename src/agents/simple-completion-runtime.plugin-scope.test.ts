import dns from "node:dns/promises";
import fs from "node:fs";
import { createServer } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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

const tempRoots = createSyncSuiteTempRootTracker("openclaw-simple-completion-plugin-scope");

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

describe("simple completion prepared plugin scope", () => {
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
      const server = createServer((request, response) => {
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
        response.end(
          `data: ${JSON.stringify({
            id: "plugin-auth-response",
            object: "chat.completion.chunk",
            model: "selected-model",
            choices: [
              { index: 0, delta: { content: "plugin-owned completion" }, finish_reason: "stop" },
            ],
          })}\n\ndata: [DONE]\n\n`,
        );
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      let preparedResource: AsyncDisposable | undefined;
      const readAgentStore = vi.fn(async () => {
        throw new Error("agent auth storage unavailable");
      });
      let restoreStoreRead: (() => void) | undefined;
      let restoreDns: (() => void) | undefined;
      let dnsRevoked = false;
      try {
        const address = server.address();
        if (!address || typeof address === "string") {
          throw new Error("Missing completion fixture port");
        }
        const cfg: OpenClawConfig = {
          agents: {
            defaults: {
              workspace: selected.rootDir,
              model: `${selected.providerId}/selected-model`,
            },
          },
          auth: { order: { [selected.providerId]: ["missing-agent-profile"] } },
          models: {
            providers: {
              [selected.providerId]: {
                api: stream?.startsWith("google") ? "google-generative-ai" : "openai-completions",
                baseUrl: `http://127.0.0.1:${address.port}/v1`,
                models: [
                  {
                    id: "selected-model",
                    name: "Selected",
                    reasoning: false,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 8192,
                    maxTokens: 1024,
                  },
                ],
              },
            },
          },
          plugins: {
            load: { paths: [selected.rootDir] },
            slots: { memory: "none" },
            entries: { [selected.pluginId]: { enabled: true } },
          },
        };
        await withEnvAsync(
          {
            ...createColdPluginHermeticEnv(tempRoot, {
              bundledPluginsDir: tempRoots.makeTempDir(),
            }),
            OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
            OPENCLAW_STATE_DIR: path.join(tempRoot, "state"),
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
            if ("error" in prepared) {
              throw new Error(prepared.error);
            }
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
                const context = {
                  messages: [{ role: "user" as const, content: "Complete", timestamp: 1 }],
                };
                if (stream === "builtin" || stream === "plugin") {
                  if (!preparedStream) {
                    throw new Error("Missing retained provider stream");
                  }
                  return await (
                    await preparedStream(current.model, context, { apiKey: current.auth.apiKey })
                  ).result();
                }
                return completeWithPreparedSimpleCompletionModel({ ...current, cfg, context });
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
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    },
  );

  it.each([
    {
      name: "caller-selected provider and model",
      expectedModelId: "selected-model",
      mode: "direct",
    },
    {
      name: "agent-selected manifest utility model",
      expectedModelId: "utility-model",
      mode: "agent",
    },
  ])("loads only the selected plugin generation for $name", async ({ expectedModelId, mode }) => {
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
      runtimeMessage: "unrelated provider runtime must remain cold",
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
        load: { paths: [selected.rootDir, unrelated.rootDir] },
        slots: { memory: "none" },
        entries: {
          [selected.pluginId]: { enabled: true },
          [unrelated.pluginId]: { enabled: true },
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
    const env = {
      ...createColdPluginHermeticEnv(tempRoot, { bundledPluginsDir: tempRoots.makeTempDir() }),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_STATE_DIR: path.join(tempRoot, "state"),
    };

    let acquiredResource: AsyncDisposable | undefined;
    try {
      const result = await withEnvAsync(env, async () => {
        if (mode === "agent") {
          const acquired = await acquireSimpleCompletionModelForAgent({
            cfg: config,
            agentId: "main",
            useUtilityModel: true,
            modelResolver,
          });
          if (!("error" in acquired)) {
            acquiredResource = acquired;
          }
          return acquired;
        }
        const acquired = await acquireSimpleCompletionModelWithSelection(
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
      expect(modelResolver).toHaveBeenCalledOnce();
      expect(isColdPluginRuntimeLoaded(selected)).toBe(true);
      expect(isColdPluginRuntimeLoaded(unrelated)).toBe(false);
      expect(preparedRuntime?.metadataSnapshot.pluginIds).toContain(selected.pluginId);
      expect(preparedRuntime?.metadataSnapshot.pluginIds).not.toContain(unrelated.pluginId);
      expect(preparedRuntime?.metadataSnapshot.plugins.map((plugin) => plugin.id)).toEqual([
        selected.pluginId,
      ]);
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
      const server = createServer((request, response) => {
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
        response.end(
          `data: ${JSON.stringify({
            id: "completion-owner-response",
            object: "chat.completion.chunk",
            model: "selected-model",
            choices: [{ index: 0, delta: { content: text }, finish_reason: "stop" }],
          })}\n\ndata: [DONE]\n\n`,
        );
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      try {
        const address = server.address();
        if (!address || typeof address === "string") {
          throw new Error("Completion owner fixture did not expose a TCP port");
        }
        const configFor = (fixture: typeof selected): OpenClawConfig => ({
          agents: {
            defaults: { workspace: fixture.rootDir, model: `${fixture.providerId}/selected-model` },
          },
          models: {
            providers: {
              [fixture.providerId]: {
                api: "openai-completions",
                apiKey: "fixture-auth-source",
                baseUrl: `http://127.0.0.1:${address.port}/v1`,
                models: [
                  {
                    id: "selected-model",
                    name: "Selected",
                    reasoning: false,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 8192,
                    maxTokens: 1024,
                  },
                ],
              },
            },
          },
          plugins: {
            load: { paths: [fixture.rootDir, unrelated.rootDir] },
            slots: { memory: "none" },
            entries: {
              [fixture.pluginId]: { enabled: true },
              [unrelated.pluginId]: { enabled: true },
            },
          },
        });
        const cfg = configFor(selected);
        const env = {
          ...createColdPluginHermeticEnv(tempRoot, { bundledPluginsDir: tempRoots.makeTempDir() }),
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          OPENCLAW_STATE_DIR: path.join(tempRoot, "state"),
        };
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
            let prepared: Awaited<ReturnType<typeof prepareSimpleCompletionModel>>;
            if (lease) {
              prepared = await prepareSimpleCompletionModel({
                ...modelParams,
                preparedModelRuntime: lease.snapshot,
              });
            } else {
              const acquired = await acquireSimpleCompletionModelForAgent({
                cfg,
                agentId: "main",
                agentDir: input.agentDir,
                modelRef: `${selected.providerId}/selected-model`,
              });
              if (!("error" in acquired)) {
                preparedResource = acquired;
              }
              prepared = acquired;
            }
            if ("error" in prepared) {
              throw new Error(prepared.error);
            }
            if (mode === "acquired") {
              const repeatedPreparation = await acquireSimpleCompletionModelForAgent({
                cfg,
                agentId: "main",
                agentDir: input.agentDir,
                modelRef: `${selected.providerId}/selected-model`,
              });
              if ("error" in repeatedPreparation) {
                throw new Error(repeatedPreparation.error);
              }
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
                context: { messages: [{ role: "user", content: `Turn ${turn}`, timestamp: turn }] },
                options: { reasoning },
              });
              const wrapperState =
                mode === "empty" ? "none|none" : `${turn}|${reasoning ?? "omitted"}`;
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
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    },
  );

  it.each([
    { name: "reloads before the request", failReconciliation: false },
    { name: "fails closed before the request", failReconciliation: true },
  ])("$name for managed simple completions", async ({ failReconciliation }) => {
    const tempRoot = fs.realpathSync(tempRoots.makeTempDir());
    const selected = createTransportOwnerFixture(path.join(tempRoot, "selected"), "A", false);
    const requestPaths: string[] = [];
    let preparedResource: AsyncDisposable | undefined;
    const server = createServer((request, response) => {
      request.resume();
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      requestPaths.push(`${requestUrl.pathname}${requestUrl.search}`);
      if (requestUrl.pathname === "/health" || requestUrl.pathname === "/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"ok":true}');
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify({
          id: "managed-completion-response",
          object: "chat.completion.chunk",
          model: "selected-model",
          choices: [{ index: 0, delta: { content: "done" }, finish_reason: "stop" }],
        })}\n\ndata: [DONE]\n\n`,
      );
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Managed completion fixture did not expose a TCP port");
      }
      const origin = `http://127.0.0.1:${address.port}`;
      const cfg: OpenClawConfig = {
        agents: {
          defaults: { workspace: selected.rootDir, model: `${selected.providerId}/selected-model` },
        },
        models: {
          providers: {
            [selected.providerId]: {
              api: "openai-completions",
              apiKey: "fixture-auth-source",
              baseUrl: `${origin}/v1`,
              localService: {
                command: process.execPath,
                args: ["--version"],
                healthUrl: `${origin}/health`,
                idleStopMs: 1,
              },
              models: [
                {
                  id: "selected-model",
                  name: "Selected",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 8192,
                  maxTokens: 1024,
                },
              ],
            },
          },
        },
        plugins: {
          load: { paths: [selected.rootDir] },
          slots: { memory: "none" },
          entries: { [selected.pluginId]: { enabled: true } },
        },
      };
      const env = {
        ...createColdPluginHermeticEnv(tempRoot, { bundledPluginsDir: tempRoots.makeTempDir() }),
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_STATE_DIR: path.join(tempRoot, "state"),
      };
      await withEnvAsync(env, async () => {
        const prepared = await acquireSimpleCompletionModelForAgent({
          cfg,
          agentId: "main",
          agentDir: path.join(tempRoot, "agent"),
          modelRef: `${selected.providerId}/selected-model`,
        });
        if ("error" in prepared) {
          throw new Error(prepared.error);
        }
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
          await expect(
            completeWithPreparedSimpleCompletionModel({
              model: prepared.model,
              auth: prepared.auth,
              cfg,
              context: { messages: [{ role: "user", content: "Complete", timestamp: 1 }] },
            }),
          ).resolves.toMatchObject({ stopReason: "error", content: [] });
        } else {
          await expect(
            completeWithPreparedSimpleCompletionModel({
              model: prepared.model,
              auth: prepared.auth,
              cfg,
              context: { messages: [{ role: "user", content: "Complete", timestamp: 1 }] },
            }),
          ).resolves.toMatchObject({
            stopReason: "stop",
            content: [{ type: "text", text: "done" }],
          });
        }
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
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

function readHostMetadataReaders(): readonly unknown[] {
  const readers = Reflect.get(globalThis, Symbol.for("openclaw.pluginMetadataSnapshotReaders")) as
    | Record<string, unknown>
    | undefined;
  return [readers?.getCurrentPluginMetadataSnapshot, readers?.resolvePluginMetadataSnapshot];
}
