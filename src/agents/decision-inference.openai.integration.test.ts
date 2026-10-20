import dns from "node:dns/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { evaluateDecisionInRegistry, evaluateDecisionV2InRegistry } from "../decisions/runtime.js";
import { DecisionContractError } from "../decisions/validation.js";
import {
  onTrustedInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import { markTrustedOtelDiagnosticListener } from "../infra/diagnostic-otel-listener-provenance.js";
import { withGuardedFetchRequestAuthority } from "../infra/net/fetch-request-authority.js";
import { withServer } from "../plugin-sdk/test-helpers/http-test-server.js";
import { loadAndActivateRootPluginRegistry } from "../plugins/loader.js";
import { resetPluginLoaderTestStateForTest } from "../plugins/loader.test-fixtures.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { createColdPluginHermeticEnv } from "../plugins/test-helpers/cold-plugin-fixtures.js";
import {
  clearSecretsRuntimeSnapshot,
  getActiveSecretsRuntimeSnapshotRevision,
} from "../secrets/runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveAgentDir, resolveDefaultAgentId } from "./agent-scope.js";
import * as authProfiles from "./auth-profiles.js";
import { acquireAgentRunPreparedModelRuntime } from "./prepared-model-runtime.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "./prepared-model-runtime.test-support.js";
import { closeProviderTransportDispatcherPool } from "./provider-transport-dispatcher-pool.js";

afterEach(async () => {
  await resetPreparedModelRuntimeSnapshotsForTest();
  await closeProviderTransportDispatcherPool();
  clearRuntimeConfigSnapshot();
  clearPluginMetadataLifecycleCaches();
  resetPluginLoaderTestStateForTest();
  resetDiagnosticEventsForTest();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  syncBuiltinESMExports();
});

it.each([
  { route: "platform", baseUrl: "https://api.openai.com/v1" },
  { route: "configured model", baseUrl: "https://decision.fixture.invalid/v1" },
  { route: "mixed profiles", baseUrl: "https://api.openai.com/v1" },
  { route: "locked subscription", baseUrl: "https://api.openai.com/v1" },
  { route: "unresolved header", baseUrl: "https://api.openai.com/v1" },
  { route: "private allowed", baseUrl: "" },
  { route: "private denied", baseUrl: "" },
  { route: "private retired", baseUrl: "" },
])(
  "prepares the registered OpenAI image Decision route before auth ($route)",
  async ({ route, baseUrl: selectedBaseUrl }) => {
    const requests: Array<{ url: string; headers: Headers; body: unknown }> = [];
    const response = {
      model: "gpt-6-luna",
      answers: [{ name: "visible", type: "predicate", probability: 0.9 }],
      usage: { input_tokens: 12, output_tokens: 0 },
    };
    await withServer(
      (request, reply) => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(request.headers)) {
          if (typeof value === "string") {
            headers.set(name, value);
          }
        }
        const received: (typeof requests)[number] = {
          url: `http://${request.headers.host}${request.url}`,
          headers,
          body: undefined,
        };
        // Count dispatch at headers, including a request aborted before its body ends.
        requests.push(received);
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          received.body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          reply.writeHead(200, { "content-type": "application/json" });
          reply.end(JSON.stringify(response));
        });
      },
      async (origin) => {
        const privateRoute = route.startsWith("private ");
        const baseUrl = privateRoute ? `${origin}/v1` : selectedBaseUrl;
        const state = await createOpenClawTestState({ applyEnv: false });
        const pluginRoot = fileURLToPath(new URL("../../extensions/openai", import.meta.url));
        const workspaceDir = path.join(state.root, "workspace");
        const config: OpenClawConfig = {
          diagnostics: { enabled: true },
          agents: {
            defaults: {
              workspace: workspaceDir,
              decisionModel:
                "openai/gpt-6-luna" +
                (route === "locked subscription" ? "@openai:subscription-fixture" : ""),
            },
          },
          models: {
            providers: {
              openai: {
                baseUrl,
                headers: { "X-Provider": "provider", "X-Precedence": "provider" },
                request: {
                  ...(privateRoute && route !== "private denied"
                    ? { allowPrivateNetwork: true }
                    : {}),
                  headers: {
                    "X-Precedence": "request",
                    ...(route === "unresolved header"
                      ? {
                          "X-Unresolved": {
                            source: "env" as const,
                            provider: "default",
                            id: "OPENAI_FIXTURE_ABSENT",
                          },
                        }
                      : {}),
                  },
                  ...(route === "configured model"
                    ? {
                        auth: {
                          mode: "header" as const,
                          headerName: "X-Credential",
                          value: "synthetic-custom-auth",
                        },
                      }
                    : {}),
                },
                ...(route === "mixed profiles" || route === "locked subscription"
                  ? {}
                  : { apiKey: "synthetic-openai-key" }),
                ...(route === "configured model" || privateRoute
                  ? {
                      ...(route === "configured model"
                        ? { baseUrl: "https://provider.fixture.invalid/v1" }
                        : {}),
                      models: [
                        {
                          id: "gpt-6-luna",
                          name: "GPT-6 Luna",
                          baseUrl,
                          reasoning: false,
                          input: ["text", "image"],
                          maxTokens: 128000,
                          headers: { "X-Model": "model", "X-Precedence": "model" },
                          cost: { input: 42, output: 42, cacheRead: 0, cacheWrite: 0 },
                        },
                      ],
                    }
                  : { models: [] }),
              },
            },
          },
          plugins: {
            allow: ["openai"],
            slots: { memory: "none" },
            entries: { openai: { enabled: true } },
          },
        };
        const env = {
          ...createColdPluginHermeticEnv(state.root, {
            bundledPluginsDir: path.dirname(pluginRoot),
          }),
          ...state.envVars,
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
          OPENAI_API_KEY: undefined,
          OPENAI_BASE_URL: undefined,
          OPENAI_FIXTURE_ABSENT: undefined,
          CODEX_HOME: path.join(state.root, "empty-codex"),
          HTTP_PROXY: undefined,
          HTTPS_PROXY: undefined,
          ALL_PROXY: undefined,
          http_proxy: undefined,
          https_proxy: undefined,
          all_proxy: undefined,
        };
        // Only the final HTTP exchange is synthetic; registration, catalog, routing,
        // credential selection, prepared authority and the guarded fetch remain intact.
        // Private-route cases instead use the owned server and real socket dispatch.
        if (!privateRoute) {
          vi.stubGlobal(
            "fetch",
            vi.fn<typeof fetch>(async (input, init) => {
              const url =
                typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
              if (!url.endsWith("/decisions")) {
                throw new Error("Unexpected OpenAI fixture request");
              }
              if (typeof init?.body !== "string") {
                throw new Error("Expected a serialized Decision request");
              }
              requests.push({
                url,
                headers: new Headers(init?.headers),
                body: JSON.parse(init.body),
              });
              return Response.json(response);
            }),
          );
        }
        try {
          await withEnvAsync(env, async () => {
            if (route === "mixed profiles" || route === "locked subscription") {
              await state.writeAuthProfiles({
                version: 1,
                profiles: {
                  "openai:subscription-fixture": {
                    type: "oauth",
                    provider: "openai",
                    access: "synthetic-subscription",
                    refresh: "synthetic-refresh",
                    expires: 1,
                  },
                  "openai:key-fixture": {
                    type: "api_key",
                    provider: "openai",
                    key: "synthetic-openai-key",
                  },
                },
                order: { openai: ["openai:subscription-fixture", "openai:key-fixture"] },
              });
            }
            setRuntimeConfigSnapshot(config);
            const registry = await loadAndActivateRootPluginRegistry({
              config,
              env,
              workspaceDir,
              onlyPluginIds: ["openai"],
              preferBuiltPluginArtifacts: false,
              pluginSdkResolution: "src",
            });
            expect(registry.diagnostics.filter((item) => item.level === "error")).toEqual([]);
            const agentId = resolveDefaultAgentId(config);
            // Unresolved config must fail through the public host, including preparation.
            // Successful cases retain the same prepared generation across timed dispatch.
            await using prepared =
              route === "unresolved header"
                ? undefined
                : await acquireAgentRunPreparedModelRuntime(
                    {
                      config,
                      agentId,
                      agentDir: resolveAgentDir(config, agentId),
                      workspaceDir,
                      loadRuntimePlugins: true,
                      runtimePluginSelections: [
                        { provider: "openai", modelId: "gpt-6-luna", agentId },
                      ],
                    },
                    { catalogMode: "static" },
                  );
            expect(registry.providers.find((entry) => entry.provider.id === "openai")?.source).toBe(
              path.join(pluginRoot, "index.ts"),
            );
            if (prepared) {
              expect(
                prepared.snapshot.pluginRegistry?.providers.find(
                  (entry) => entry.provider.id === "openai",
                )?.pluginId,
              ).toBe("openai");
              expect(
                prepared.snapshot.modelCatalog.entries.some(
                  (entry) => entry.provider === "openai" && entry.id === "gpt-6-luna",
                ),
              ).toBe(true);
            }
            const events: Array<Extract<DiagnosticEventPayload, { type: "model.usage" }>> = [];
            onTestFinished(
              onTrustedInternalDiagnosticEvent(
                markTrustedOtelDiagnosticListener((event) => {
                  if (event.type === "model.usage") {
                    events.push(event);
                  }
                }),
              ),
            );
            const credentialRead = vi.spyOn(authProfiles, "resolveApiKeyForProfile");
            const dataUri = "data:image/png;base64,AA==";
            const entered = createDeferredCore();
            const release = createDeferredCore();
            let finalAdmission = false;
            let dnsLookups = 0;
            let restoreDns: (() => void) | undefined;
            if (route === "private retired") {
              const lookup = dns.lookup;
              const hostname = new URL(baseUrl).hostname;
              const spy = vi.spyOn(dns, "lookup").mockImplementation(async (...args) => {
                if (args[0] === hostname) {
                  dnsLookups++;
                  entered.resolve();
                  await release.promise;
                }
                return lookup(...args);
              });
              // Loaded plugin SDK transports use native modules, outside Vitest's facade.
              // Pause their real DNS boundary without replacing the provider's final guard.
              syncBuiltinESMExports();
              restoreDns = () => {
                spy.mockRestore();
                syncBuiltinESMExports();
              };
            }
            const signal = new AbortController().signal;
            const pending = withGuardedFetchRequestAuthority(
              undefined,
              () =>
                evaluateDecisionV2InRegistry(
                  {
                    state: { type: "image", dataUri, text: "Synthetic image evidence" },
                    questions: {
                      visible: { type: "boolean", instructions: "Is the object visible?" },
                    },
                  },
                  {
                    agentId,
                    purpose: "openai-route-fixture",
                    rubricVersion: "1",
                    timeoutMs: 5000,
                    reasoning: "auto",
                    signal,
                  },
                  registry,
                  config,
                ),
              () => {
                finalAdmission = true;
              },
            );
            if (route === "private retired") {
              const settled = pending.then(
                (outcome) => ({ outcome }),
                (error: unknown) => ({ error }),
              );
              try {
                const first = await Promise.race([
                  entered.promise.then(() => ({ phase: "dns" })),
                  settled.then((result) => ({
                    phase: "settled",
                    ...("outcome" in result
                      ? {
                          status: result.outcome.status,
                          reason:
                            result.outcome.status === "unavailable"
                              ? result.outcome.reason
                              : undefined,
                        }
                      : {
                          errorName:
                            result.error instanceof Error ? result.error.name : "non-error",
                        }),
                  })),
                ]);
                // Report only phase, contract outcome and counts; never request or auth bytes.
                expect(
                  first,
                  JSON.stringify({
                    first,
                    dnsLookups,
                    requestCount: requests.length,
                    finalAdmission,
                  }),
                ).toEqual({ phase: "dns" });
                expect(dnsLookups).toBe(1);
                expect(requests).toEqual([]);
                const revision = getActiveSecretsRuntimeSnapshotRevision();
                clearSecretsRuntimeSnapshot();
                setRuntimeConfigSnapshot(config);
                expect(getActiveSecretsRuntimeSnapshotRevision()).toBeGreaterThan(revision);
                release.resolve();
                expect(await settled).toEqual({
                  outcome: { status: "unavailable", reason: "retiring" },
                });
                expect(signal.aborted).toBe(false);
                expect(finalAdmission).toBe(false);
                expect(requests).toEqual([]);
                expect(events).toEqual([]);
                expect(registry.decisionProviders[0]?.host.inspect(config).activeRequests).toBe(0);
              } finally {
                release.resolve();
                await settled;
                restoreDns?.();
              }
              return;
            }
            if (route === "unresolved header") {
              await expect(pending).rejects.toBeInstanceOf(DecisionContractError);
              expect(requests).toEqual([]);
              expect(credentialRead).not.toHaveBeenCalled();
              expect(events).toEqual([]);
              expect(registry.decisionProviders[0]?.host.inspect(config).activeRequests).toBe(0);
              return;
            }
            const outcome = await pending;
            if (route === "private denied") {
              expect(outcome).toEqual({ status: "unavailable", reason: "transport" });
              expect(requests).toEqual([]);
              expect(events).toEqual([]);
              expect(registry.decisionProviders[0]?.host.inspect(config).activeRequests).toBe(0);
              return;
            }
            if (route === "locked subscription") {
              expect(outcome).toEqual({ status: "unavailable", reason: "credentials-unavailable" });
              expect(credentialRead).not.toHaveBeenCalled();
              expect(requests).toEqual([]);
              expect(events).toEqual([]);
              expect(registry.decisionProviders[0]?.host.inspect(config).activeRequests).toBe(0);
              return;
            }
            if (route === "mixed profiles") {
              expect(credentialRead).toHaveBeenCalledTimes(1);
              expect(credentialRead).toHaveBeenCalledWith(
                expect.objectContaining({ profileId: "openai:key-fixture" }),
              );
            }
            expect(outcome).toMatchObject({
              status: "ok",
              result: {
                answers: { visible: { type: "boolean", probabilityTrue: 0.9 } },
                usage: { inputTokens: 12, outputTokens: 0 },
              },
            });
            expect(requests).toHaveLength(1);
            expect(finalAdmission).toBe(true);
            expect(requests[0]?.url).toBe(baseUrl + "/decisions");
            expect(requests[0]?.headers.get("authorization")).toBe(
              route === "configured model" ? null : "Bearer synthetic-openai-key",
            );
            expect(requests[0]?.headers.get("x-provider")).toBe("provider");
            expect(requests[0]?.headers.get("x-precedence")).toBe("request");
            if (route === "configured model") {
              expect(requests[0]?.headers.get("x-model")).toBe("model");
              expect(requests[0]?.headers.get("x-credential")).toBe("synthetic-custom-auth");
            }
            expect(events).toHaveLength(1);
            expect(events[0]).toMatchObject({
              provider: "openai",
              model: "gpt-6-luna",
              usage: { input: 12, output: 0 },
            });
            expect(events[0]).not.toHaveProperty("costUsd");
            expect(requests[0]?.body).toMatchObject({
              model: "gpt-6-luna",
              input: [
                {
                  role: "user",
                  content: [
                    { type: "input_text", text: "Synthetic image evidence" },
                    { type: "input_image", image_url: dataUri },
                  ],
                },
              ],
            });
            const legacy = await evaluateDecisionInRegistry(
              { state: "legacy text", questions: { visible: { type: "boolean" } } },
              {
                agentId,
                purpose: "openai-route-fixture",
                rubricVersion: "1",
                timeoutMs: 5000,
                signal: new AbortController().signal,
              },
              registry,
              config,
            );
            expect(legacy.status).toBe("ok");
            expect(requests).toHaveLength(2);
            expect(requests[1]?.body).toMatchObject({ input: "legacy text" });
            expect(registry.decisionProviders[0]?.host.inspect(config).activeRequests).toBe(0);
          });
        } finally {
          await resetPreparedModelRuntimeSnapshotsForTest();
          await state.cleanup();
        }
      },
    );
  },
);
