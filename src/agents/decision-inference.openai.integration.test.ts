import dns from "node:dns/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import type { ModelProviderConfig } from "../config/types.models.js";
import { evaluateDecisionInRegistry, evaluateDecisionV2InRegistry } from "../decisions/runtime.js";
import { DecisionContractError } from "../decisions/validation.js";
import { withGuardedFetchRequestAuthority } from "../infra/net/fetch-request-authority.js";
import {
  clearSecretsRuntimeSnapshot,
  getActiveSecretsRuntimeSnapshotRevision,
} from "../secrets/runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveDefaultAgentId } from "./agent-scope.js";
import * as authProfiles from "./auth-profiles.js";
import * as harness from "./decision-inference.test-support.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "./prepared-model-runtime.test-support.js";
import { closeProviderTransportDispatcherPool } from "./provider-transport-dispatcher-pool.js";

afterEach(async () => {
  await harness.resetDecisionTestRuntime(undefined, closeProviderTransportDispatcherPool);
  syncBuiltinESMExports();
});

it.each([
  "platform",
  "configured model",
  "mixed profiles",
  "locked subscription",
  "unresolved header",
  "private allowed",
  "private denied",
  "private retired",
])(
  "prepares the registered OpenAI image Decision route before auth and enforces request authority (%s)",
  async (route) => {
    const response = {
      model: "gpt-6-luna",
      answers: [{ name: "visible", type: "predicate", probability: 0.9 }],
      usage: { input_tokens: 12, output_tokens: 0 },
    };
    await harness.withDecisionServer(
      () => ({ status: 200, body: response }),
      async ({ origin, requests, mockFetch }) => {
        const privateRoute = route.startsWith("private ");
        const configured = route === "configured model";
        const profiles = route === "mixed profiles" || route === "locked subscription";
        const baseUrl = privateRoute
          ? `${origin}/v1`
          : configured
            ? "https://decision.fixture.invalid/v1"
            : "https://api.openai.com/v1";
        const state = await createOpenClawTestState({ applyEnv: false });
        const pluginRoot = fileURLToPath(new URL("../../extensions/openai", import.meta.url));
        const provider: ModelProviderConfig = {
          baseUrl,
          apiKey: "synthetic-openai-key",
          models: [],
          headers: { "X-Provider": "provider", "X-Precedence": "provider" },
          request: { headers: { "X-Precedence": "request" } },
        };
        const request = provider.request!;
        if (profiles) {
          delete provider.apiKey;
        }
        if (privateRoute && route !== "private denied") {
          request.allowPrivateNetwork = true;
        }
        if (route === "unresolved header") {
          request.headers!["X-Unresolved"] = {
            source: "env",
            provider: "default",
            id: "OPENAI_FIXTURE_ABSENT",
          };
        }
        if (configured) {
          provider.baseUrl = "https://provider.fixture.invalid/v1";
          request.auth = {
            mode: "header",
            headerName: "X-Credential",
            value: "synthetic-custom-auth",
          };
        }
        if (configured || privateRoute) {
          provider.models = [
            {
              id: "gpt-6-luna",
              name: "GPT-6 Luna",
              baseUrl,
              reasoning: false,
              input: ["text", "image"],
              maxTokens: 128000,
              // Configured header values are guarded as credentials; avoid response field names.
              headers: { "X-Model": "synthetic-model-header", "X-Precedence": "model" },
              cost: { input: 42, output: 42, cacheRead: 0, cacheWrite: 0 },
            },
          ];
        }
        const config = harness.decisionConfig(
          state.root,
          "openai/gpt-6-luna" +
            (route === "locked subscription" ? "@openai:subscription-fixture" : ""),
          {
            allow: ["openai"],
            entries: { openai: { enabled: true } },
          },
        );
        delete config.agents!.defaults!.model;
        config.diagnostics = { enabled: true };
        config.models = { providers: { openai: provider } };
        const env = harness.decisionEnv(
          state.root,
          {
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
          },
          path.dirname(pluginRoot),
        );
        // Private routes retain real sockets and guarded fetch; only public HTTP is synthetic.
        if (!privateRoute) {
          mockFetch(baseUrl + "/decisions");
        }
        try {
          await withEnvAsync(env, async () => {
            if (profiles) {
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
            const registry = await harness.activateDecisionRegistry(config, {
              env,
              onlyPluginIds: ["openai"],
              preferBuiltPluginArtifacts: false,
              pluginSdkResolution: "src",
            });
            const agentId = resolveDefaultAgentId(config);
            // Unresolved config must fail through the public host, including preparation.
            await using prepared =
              route === "unresolved header"
                ? undefined
                : await harness.prepareDecisionRuntime(config, "openai", "gpt-6-luna");
            expect(registry.providers.find((entry) => entry.provider.id === "openai")?.source).toBe(
              path.join(pluginRoot, "index.ts"),
            );
            if (prepared) {
              const { modelCatalog, pluginRegistry } = prepared.snapshot;
              const owner = pluginRegistry?.providers.find(
                ({ provider: candidate }) => candidate.id === "openai",
              );
              expect(owner?.pluginId).toBe("openai");
              expect(modelCatalog.entries).toContainEqual(
                expect.objectContaining({ provider: "openai", id: "gpt-6-luna" }),
              );
            }
            const events = harness.trackDecisionUsage();
            const expectNoEffects = () => {
              expect({
                requests,
                events,
                active: registry.decisionProviders[0]?.host.inspect(config).activeRequests,
              }).toEqual({ requests: [], events: [], active: 0 });
            };
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
              // The loaded SDK uses native modules, outside Vitest's facade.
              syncBuiltinESMExports();
              restoreDns = () => {
                spy.mockRestore();
                syncBuiltinESMExports();
              };
            }
            const signal = new AbortController().signal;
            const options = harness.decisionOptions({
              agentId,
              signal,
              purpose: "openai-route-fixture",
              rubricVersion: "1",
            });
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
                  { ...options, reasoning: "auto" },
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
                  settled.then(() => ({ phase: "settled" })),
                ]);
                expect(first).toEqual({ phase: "dns" });
                expect(dnsLookups).toBe(1);
                expect(requests).toEqual([]);
                const revision = getActiveSecretsRuntimeSnapshotRevision();
                clearSecretsRuntimeSnapshot();
                setRuntimeConfigSnapshot(config);
                expect(getActiveSecretsRuntimeSnapshotRevision()).toBeGreaterThan(revision);
                release.resolve();
                expect({ settled: await settled, aborted: signal.aborted, finalAdmission }).toEqual(
                  {
                    settled: { outcome: harness.unavailable("retiring") },
                    aborted: false,
                    finalAdmission: false,
                  },
                );
                expectNoEffects();
              } finally {
                release.resolve();
                await settled;
                restoreDns?.();
              }
              return;
            }
            if (route === "unresolved header") {
              await expect(pending).rejects.toBeInstanceOf(DecisionContractError);
              expect(credentialRead).not.toHaveBeenCalled();
              expectNoEffects();
              return;
            }
            const outcome = await pending;
            if (route === "private denied" || route === "locked subscription") {
              expect(outcome).toEqual(
                harness.unavailable(
                  route === "private denied" ? "transport" : "credentials-unavailable",
                ),
              );
              if (route === "locked subscription") {
                expect(credentialRead).not.toHaveBeenCalled();
              }
              expectNoEffects();
              return;
            }
            if (route === "mixed profiles") {
              expect(credentialRead).toHaveBeenCalledTimes(1);
              expect(credentialRead).toHaveBeenCalledWith(
                expect.objectContaining({ profileId: "openai:key-fixture" }),
              );
            }
            expect(outcome, JSON.stringify(outcome)).toMatchObject({
              status: "ok",
              result: {
                answers: { visible: { type: "boolean", probabilityTrue: 0.9 } },
                usage: { inputTokens: 12, outputTokens: 0 },
              },
            });
            expect(requests).toHaveLength(1);
            expect(finalAdmission).toBe(true);
            const sent = requests[0]!;
            expect(sent.url).toBe(baseUrl + "/decisions");
            expect(
              ["authorization", "x-provider", "x-precedence"].map((key) => sent.headers.get(key)),
            ).toEqual([configured ? null : "Bearer synthetic-openai-key", "provider", "request"]);
            if (configured) {
              expect(["x-model", "x-credential"].map((key) => sent.headers.get(key))).toEqual([
                "synthetic-model-header",
                "synthetic-custom-auth",
              ]);
            }
            expect(events).toMatchObject([
              {
                provider: "openai",
                model: "gpt-6-luna",
                usage: { input: 12, output: 0 },
              },
            ]);
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
              options,
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
