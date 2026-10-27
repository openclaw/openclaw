import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelDecisionCapabilities } from "@openclaw/model-catalog-core/model-catalog-types";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import type { DecisionProviderContextV2 } from "../decisions/provider-context.js";
import type { DecisionBatchResultV2, DecisionRuntimeV2 } from "../decisions/types-v2.js";
import {
  createContext,
  createOperatorClient,
} from "../gateway/server-plugin-in-process-dispatch.test-support.js";
import {
  assertProviderAuthAuthority,
  getProviderAuthAuthority,
} from "../plugins/provider-auth-authority.js";
import * as modelRoutes from "../plugins/provider-model-routes.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { getPluginRuntimeGenerationRegistry } from "../plugins/runtime/generation-state.js";
import { createColdPluginFixture } from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as profileReader from "../state/user-profile-list.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { VERSION } from "../version.js";
import { executePreparedDecision } from "./decision-inference.js";
import * as harness from "./decision-inference.test-support.js";
import * as modelAuth from "./model-auth-provider.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "./prepared-model-runtime.test-support.js";
import {
  getModelProviderRequestTransport,
  resolveProviderRequestHeaders,
} from "./provider-request-config.js";

const roots = useAutoCleanupTempDirTracker(afterEach);
const traceKey = Symbol.for("openclaw.test.decision-prepared-path");
let profileState: OpenClawTestState | undefined;
const textBatch = (text = "synthetic evidence") => ({
  state: { type: "text" as const, text },
  questions: { q: { type: "boolean" as const } },
});
const decision: ModelDecisionCapabilities = {
  protocol: "fixture",
  input: ["text"],
  questions: { boolean: { probabilities: "none", abstention: true } },
};
const catalogTransport = {
  api: "openai-completions" as const,
  baseUrl: "https://catalog.fixture.invalid/v1",
};
const nativeModel = { id: "native", name: "Native fixture" };
type Trace = {
  calls: number;
  context?: DecisionProviderContextV2;
  onDispatch?: () => void;
  prepare?: () => Promise<void>;
  exchange?: () => Promise<void>;
  exchangeCalls?: number;
  beforeRequest?: (context: DecisionProviderContextV2) => void;
  fetch?: typeof fetch;
  work?: Promise<void>;
  usage?: DecisionBatchResultV2["usage"];
  resultReads?: number;
  resultOverride?: { value: unknown };
  preparedApi?: string;
  preparedCapability?: string;
  preparedModelKeys?: string[];
  evaluate?: DecisionRuntimeV2["evaluateV2"];
};
afterEach(async () => {
  await harness.resetDecisionTestRuntime(traceKey, () => {
    vi.restoreAllMocks();
  });
  await profileState?.cleanup();
  profileState = undefined;
});

it.each([
  "plugin",
  "plugin-route-fresh",
  "plugin-route-missing",
  "plugin-route-multiple",
  "plugin-route-cleared",
  "agent",
  "profile",
  "missing",
  "exchange",
  "exchange-bearer",
  "exchange-bearer-override",
  "legacy-exchange",
  "exchange-deadline",
  "plugin-revoked-context",
  "plugin-revoked-model",
  "plugin-revoked-disabled",
  "plugin-preparation-deadline",
  "plugin-physical-deadline",
] as const)(
  "runs the retained decision SDK through real preparation without primary fallback or fabricated chat fields (%s)",
  async (authScope) => {
    const pluginAuth = authScope.startsWith("plugin");
    const deadlinePhase =
      authScope === "plugin-preparation-deadline"
        ? "preparation"
        : authScope === "plugin-physical-deadline"
          ? "provider"
          : authScope === "exchange-deadline"
            ? "exchange"
            : undefined;
    const exchange = authScope.startsWith("exchange");
    const exchangedRequestAuth =
      authScope === "exchange-bearer"
        ? undefined
        : authScope === "exchange-bearer-override"
          ? { mode: "authorization-bearer", token: "synthetic-request-bearer" }
          : {
              mode: "header",
              headerName: "x-fixture-auth",
              value: "synthetic-exchanged-header",
            };
    const root = roots.make("decision-prepared-integration-");
    const pluginRoot = path.join(root, "plugin");
    for (const directory of [pluginRoot, path.join(root, "bundled")]) {
      fs.mkdirSync(directory);
    }
    const id = "decision-prepared-fixture";
    const fixture = createColdPluginFixture({
      rootDir: pluginRoot,
      pluginId: id,
      providerId: id,
      manifest: {
        channels: [],
        channelConfigs: {},
        providerAuthChoices: [],
        contracts: { decisionProviders: [id] },
        modelCatalog: {
          providers: {
            [id]: {
              authScope: pluginAuth ? "plugin" : "agent",
              ...(pluginAuth ? {} : catalogTransport),
              models: [
                {
                  ...nativeModel,
                  inference: {
                    chat: false,
                    decision: {
                      ...decision,
                      billing: {
                        unit: "tokens",
                        source: "provider-catalog",
                        usdPerMillion: { input: 2, output: 0 },
                      },
                    },
                  },
                },
              ],
            },
          },
        },
      },
    });
    fs.writeFileSync(
      fixture.runtimeSource,
      [
        'const trace = globalThis[Symbol.for("openclaw.test.decision-prepared-path")];',
        "module.exports = { id: " + JSON.stringify(id) + ", register(api) {",
        "api.registerDecisionProvider({ id: " + JSON.stringify(id) + ", contractVersion: 2,",
        'provider: { label: "Synthetic", auth: [], authScope: ' +
          JSON.stringify(pluginAuth ? "plugin" : "agent") +
          ", " +
          "async augmentModelCatalog({ entries }) { await trace.prepare?.(); return entries; }," +
          (authScope === "profile" || authScope === "missing"
            ? ""
            : 'resolveSyntheticAuth() { return {apiKey: "synthetic-prepared-token", mode: "api-key", source: "synthetic fixture"}; },') +
          (authScope === "agent" || authScope === "profile" || authScope === "missing" || exchange
            ? 'normalizeTransport() { return { api: "openai-responses" }; },'
            : "") +
          (exchange
            ? "async prepareRuntimeAuthV2(context) { trace.exchangeCalls = (trace.exchangeCalls ?? 0) + 1; trace.preparedApi=context.model.api; trace.preparedCapability=context.capability; trace.preparedModelKeys=Object.keys(context.model); await trace.exchange?.(); return " +
              JSON.stringify({
                apiKey: "synthetic-exchanged-token",
                baseUrl: "https://entitlement.fixture.invalid/v1",
                request: {
                  headers: { "x-fixture-entitlement": "synthetic-entitlement" },
                  auth: exchangedRequestAuth,
                },
              }) +
              "; },"
            : authScope === "legacy-exchange"
              ? "prepareRuntimeAuth(context) { trace.exchangeCalls = (trace.exchangeCalls ?? 0) + 1; return { apiKey: context.apiKey }; },"
              : "") +
          "} ,",
        'async evaluate(batch, context) { trace.calls++; trace.context=context; trace.onDispatch?.(); await trace.work; trace.beforeRequest?.(context); if (!context.isAdmissible()) return { status: "unavailable", reason: "unsupported-input" }; await trace.fetch?.("https://dispatch.fixture.invalid/v1/decisions", { method: "POST" }); let reads = 0; return { status: "ok", get result() { trace.resultReads = ++reads; if (trace.resultOverride) return trace.resultOverride.value; return { model: context.model.id, answers: { q: reads === 1 ? { type: "boolean", answer: null } : { type: "boolean", probabilityTrue: 0.75 } }, usage: trace.usage }; } }; }',
        "}); trace.evaluate = api.runtime.decisions.evaluateV2; } };",
      ].join("\n"),
    );
    const trace: Trace = { calls: 0, usage: { inputTokens: 100, costUsd: 0 } };
    Reflect.set(globalThis, traceKey, trace);
    if (authScope === "profile" || deadlinePhase) {
      profileState = await createOpenClawTestState({
        label: "decision-agent-profile",
        applyEnv: false,
      });
    }
    if (authScope === "profile") {
      // A synthetic key exists only in the operation agent store: no config/env credential.
      await profileState!.writeAuthProfiles({
        version: 1,
        profiles: {
          [id + ":agent"]: { type: "api_key", provider: id, key: "synthetic-prepared-token" },
        },
      });
    }
    const cfg = harness.decisionConfig(
      root,
      id + "/native" + (authScope === "profile" ? "@" + id + ":agent" : ""),
      {
        load: { paths: [pluginRoot] },
        entries: {
          [id]: { enabled: true, llm: { allowedCompletionModels: [id + "/native"] } },
        },
      },
    );
    if (!pluginAuth) {
      cfg.models = {
        providers: {
          [id]: {
            ...catalogTransport,
            authHeader: true,
            headers: {
              "x-provider": "provider",
              "X-Precedence": "provider",
              authorization: "Bearer stale-fixture-token",
            },
            request: { headers: { "x-precedence": "request", "x-request": "request" } },
            models: [
              {
                ...nativeModel,
                headers: { "x-model": "model", "X-PRECEDENCE": "model" },
                maxTokens: 256,
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
            ...(authScope === "profile" || authScope === "missing"
              ? {}
              : { apiKey: "synthetic-prepared-token" }),
          },
        },
      };
    }
    const env = harness.decisionEnv(root, {
      ...profileState?.envVars,
      OPENCLAW_STATE_DIR: profileState?.stateDir ?? path.join(root, "state"),
    });
    await withEnvAsync(env, async () => {
      const registry = await harness.activateDecisionRegistry(cfg, { env });
      const evaluate = trace.evaluate;
      if (!evaluate) {
        throw new Error("Decision registration omitted its runtime capability");
      }
      const usageEvents = harness.trackDecisionUsage();
      if (deadlinePhase) {
        const entered = createDeferredCore();
        const release = createDeferredCore();
        if (deadlinePhase === "preparation") {
          trace.prepare = async () => {
            entered.resolve();
            await release.promise;
          };
        } else if (deadlinePhase === "exchange") {
          trace.exchange = async () => {
            entered.resolve();
            await release.promise;
          };
        } else {
          trace.onDispatch = () => entered.resolve();
          trace.work = release.promise;
        }
        const context = createContext();
        context.getRuntimeConfig = () => cfg;
        const client = createOperatorClient({
          profileName: "decision-native-deadline",
          scopes: ["operator.write"],
        });
        let now = 1_000;
        const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
        const originalPrepare = profileReader.prepareUserProfileIdentity;
        const preparation = vi
          .spyOn(profileReader, "prepareUserProfileIdentity")
          .mockImplementationOnce(async (...args) => {
            const prepared = await originalPrepare(...args);
            now += 200;
            // Real authority I/O completes before the host's remaining-budget timer starts.
            vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
            return prepared;
          });
        const controller = new AbortController();
        const pending = withPluginRuntimeGatewayRequestScope(
          { client, context, hasCurrentClientAuthority: () => true, isWebchatConnect: () => false },
          () =>
            evaluate(
              textBatch("synthetic deadline"),
              harness.decisionOptions({ timeoutMs: 500, signal: controller.signal }),
            ),
        );
        let settled = false;
        const settlement = pending.then(
          (outcome) => {
            settled = true;
            return { outcome };
          },
          (error: unknown) => {
            settled = true;
            return { error };
          },
        );
        const providerHost = registry.decisionProviders[0]!.host;
        try {
          await Promise.race([entered.promise, settlement]);
          expect(preparation).toHaveBeenCalledOnce();
          expect(settled).toBe(false);
          expect(trace.calls).toBe(deadlinePhase === "provider" ? 1 : 0);
          now += 299;
          await vi.advanceTimersByTimeAsync(299);
          if (deadlinePhase === "provider") {
            expect(trace.context).toMatchObject({
              deadlineMonotonicMs: 1_500,
              signal: { aborted: false },
            });
          }
          now += 1;
          await vi.advanceTimersByTimeAsync(1);
          if (deadlinePhase === "provider") {
            expect(trace.context?.signal.aborted).toBe(true);
          }
          // Deadline cancellation retains the slot until catalog/provider work really settles.
          expect(settled).toBe(false);
          expect(providerHost.inspect(cfg).activeRequests).toBe(1);
          release.resolve();
          expect(await settlement).toEqual({ outcome: harness.unavailable("deadline") });
          expect(trace.calls).toBe(deadlinePhase === "provider" ? 1 : 0);
          expect(providerHost.inspect(cfg).activeRequests).toBe(0);
          expect(usageEvents).toEqual([]);
        } finally {
          release.resolve();
          controller.abort();
          await settlement;
          vi.useRealTimers();
          preparation.mockRestore();
          clock.mockRestore();
        }
        return;
      }
      const credentialPreparation = vi.spyOn(modelAuth, "resolveApiKeyForProviderCore");
      if (authScope.startsWith("plugin-route-")) {
        const candidate = {
          api: "openai-responses" as const,
          baseUrl: "https://selected.fixture.invalid/v1",
          authRequirement: "api-key" as const,
          requestTransportOverrides: "none" as const,
        };
        const original = modelRoutes.resolveProviderModelRoutes;
        const selected = {
          ...candidate,
          ...(authScope === "plugin-route-fresh"
            ? { inference: { chat: false, decision } }
            : authScope === "plugin-route-cleared"
              ? { inference: { chat: false } }
              : {}),
        };
        vi.spyOn(modelRoutes, "resolveProviderModelRoutes").mockImplementation((params) => {
          if (params.provider !== id || params.capability !== "decision") {
            return original(params);
          }
          return {
            kind: "routes",
            routes:
              authScope === "plugin-route-multiple"
                ? [candidate, { ...candidate, baseUrl: "https://other.fixture.invalid/v1" }]
                : [selected],
          };
        });
      }
      const http = vi.fn<typeof fetch>(async () => new Response("{}"));
      let admitted = true;
      if (authScope.startsWith("plugin-revoked")) {
        trace.fetch = http;
        trace.beforeRequest = (context) => {
          expect(context.auth.apiKey).toBe("synthetic-prepared-token");
          expect(getProviderAuthAuthority(context.model)).toBeTypeOf("function");
          // Revoke the captured prepared owner; a replaced root registry cannot revoke retained work.
          const prepared = getPluginRuntimeGenerationRegistry();
          expect(prepared).toBeDefined();
          const provider = prepared!.providers.find((entry) => entry.provider.id === id)!.provider;
          provider.resolveSyntheticAuth = undefined;
          if (authScope === "plugin-revoked-disabled") {
            admitted = false;
          }
          if (authScope !== "plugin-revoked-context") {
            assertProviderAuthAuthority(context.model);
          }
        };
      }
      const invoke: DecisionRuntimeV2["evaluateV2"] =
        authScope === "plugin-revoked-disabled"
          ? async (batch, options) => {
              const provider = registry.decisionProviders[0]!.host.provider;
              if (provider.contractVersion !== 2) {
                throw new Error("Fixture requires prepared Decision execution");
              }
              const outcome = await executePreparedDecision({
                provider,
                batch,
                modelId: "native",
                registration: registry.providers.find((entry) => entry.provider.id === id)!,
                config: cfg,
                options,
                signal: options.signal,
                deadlineMonotonicMs: performance.now() + options.timeoutMs,
                isAdmissible: () => admitted,
              });
              if (outcome.status === "ok") {
                throw new Error("Revoked prepared admission unexpectedly returned a result");
              }
              return outcome;
            }
          : evaluate;
      const evaluateFixture = () =>
        invoke(
          textBatch(),
          harness.decisionOptions(authScope === "profile" ? { agentId: "main" } : {}),
        );
      const outcome = await evaluateFixture();
      const rejectedRoute =
        authScope.startsWith("plugin-route-") && authScope !== "plugin-route-fresh";
      const revoked = authScope.startsWith("plugin-revoked");
      if (rejectedRoute || revoked || authScope === "missing") {
        expect(outcome).toEqual(
          harness.unavailable(
            rejectedRoute || authScope === "plugin-revoked-disabled"
              ? "unsupported-input"
              : "credentials-unavailable",
          ),
        );
        expect(trace.calls).toBe(revoked ? 1 : 0);
        expect(usageEvents).toEqual([]);
        if (rejectedRoute) {
          expect(
            credentialPreparation.mock.calls.filter(([params]) => params.capability === "decision"),
          ).toEqual([]);
        }
        if (revoked) {
          expect(http).not.toHaveBeenCalled();
          expect(registry.decisionProviders[0]!.host.inspect(cfg).callable).toBe(true);
        }
        return;
      }
      if (authScope === "plugin-route-fresh") {
        expect(trace.context?.model).toMatchObject({
          baseUrl: "https://selected.fixture.invalid/v1",
          api: "openai-responses",
        });
        expect(trace.context?.model.inference?.decision?.billing).toBeUndefined();
      }
      if (authScope === "legacy-exchange") {
        expect(outcome).toEqual({ status: "unavailable", reason: "unsupported-input" });
        expect(trace.calls).toBe(0);
        expect(trace.exchangeCalls).toBeUndefined();
        expect(usageEvents).toEqual([]);
        return;
      }
      expect(
        credentialPreparation.mock.calls.filter(([params]) => params.capability === "decision"),
      ).toHaveLength(1);
      expect(
        outcome,
        JSON.stringify({
          outcome,
          providerCalls: trace.calls,
        }),
      ).toMatchObject({
        status: "ok",
        result: { answers: { q: { answer: null } }, usage: { costUsd: 0 } },
      });
      expect(trace).toMatchObject({
        calls: 1,
        resultReads: 1,
        context: {
          auth: { apiKey: exchange ? "synthetic-exchanged-token" : "synthetic-prepared-token" },
        },
      });
      if (authScope === "profile") {
        expect(trace.context).toMatchObject({
          auth: { profileId: id + ":agent" },
          agentId: "main",
        });
      }
      expect(usageEvents).toMatchObject([
        { provider: id, model: "native", usage: { input: 100 }, costUsd: 0 },
      ]);
      trace.usage = { inputTokens: 100 };
      const unpriced = await evaluateFixture();
      expect(unpriced).toMatchObject({ status: "ok" });
      expect(unpriced.status === "ok" && unpriced.result.usage).toEqual({ inputTokens: 100 });
      expect(usageEvents).toHaveLength(2);
      if (authScope === "plugin") {
        expect(usageEvents[1]?.costUsd).toBe(0.0002);
      } else {
        // API normalization and exchanged endpoints both invalidate catalog-route prices.
        expect(usageEvents[1]).not.toHaveProperty("costUsd");
      }
      if (exchange) {
        expect(trace.exchangeCalls).toBe(2);
        expect(trace.preparedCapability).toBe("decision");
        for (const key of ["cost", "contextWindow", "maxTokens"]) {
          expect(trace.preparedModelKeys).not.toContain(key);
        }
        expect(trace.context!.model.baseUrl).toBe("https://entitlement.fixture.invalid/v1");
        expect(trace.preparedApi).toBe("openai-responses");
        expect(trace.context!.model.api).toBe(trace.preparedApi);
        expect(trace.context?.model.inference?.decision?.billing).toBeUndefined();
        expect(getModelProviderRequestTransport(trace.context!.model)).toMatchObject({
          headers: { "x-fixture-entitlement": "synthetic-entitlement" },
          ...(exchangedRequestAuth ? { auth: exchangedRequestAuth } : {}),
        });
        expect(trace.context!.model.headers).toMatchObject({
          "x-fixture-entitlement": "synthetic-entitlement",
          ...(exchangedRequestAuth?.mode === "header"
            ? { "x-fixture-auth": "synthetic-exchanged-header" }
            : {
                Authorization:
                  authScope === "exchange-bearer-override"
                    ? "Bearer synthetic-request-bearer"
                    : "Bearer synthetic-exchanged-token",
              }),
        });
        expect(trace.context!.model.headers).not.toHaveProperty("authorization");
        if (exchangedRequestAuth?.mode === "header") {
          expect(trace.context!.model.headers).not.toHaveProperty("Authorization");
        }
        expect(
          resolveProviderRequestHeaders({
            provider: id,
            defaultHeaders: trace.context!.model.headers,
            request: getModelProviderRequestTransport(trace.context!.model),
          }),
        ).toEqual(trace.context!.model.headers);
      }
      expect(Object.keys(trace.context!.model)).not.toContain("cost");
      expect(Object.keys(trace.context!.model)).not.toContain("maxTokens");
      expect(trace.context!.model.contextWindow).toBeUndefined();
      if (authScope === "agent" || authScope === "profile") {
        expect(trace.context?.model.headers).toEqual({
          "x-provider": "provider",
          "x-model": "model",
          "x-precedence": "request",
          "x-request": "request",
          Authorization: "Bearer synthetic-prepared-token",
        });
        expect(getModelProviderRequestTransport(trace.context!.model)).toMatchObject({
          headers: { "x-precedence": "request", "x-request": "request" },
        });
        expect(trace.context?.model.api).toBe("openai-responses");
        setRuntimeConfigSnapshot({
          ...cfg,
          agents: {
            ...cfg.agents,
            defaults: {
              ...cfg.agents?.defaults,
              decisionModel: id + "/native@missing-fixture-profile",
            },
          },
        });
        await expect(
          evaluate(textBatch("explicit profile"), harness.decisionOptions()),
        ).resolves.toMatchObject(harness.unavailable("credentials-unavailable"));
        expect(trace.calls).toBe(2);
        setRuntimeConfigSnapshot(cfg);
      }

      if (authScope === "plugin") {
        for (const invalid of [
          { model: "native", answers: { q: { type: "boolean", probabilityTrue: 0.75 } } },
          { model: "native", answers: {} },
        ]) {
          trace.resultOverride = { value: invalid };
          expect(await evaluateFixture()).toEqual(harness.unavailable("invalid-response"));
          expect(trace.resultReads).toBe(1);
          expect(usageEvents).toHaveLength(2);
        }
        delete trace.resultOverride;
      }

      const dispatched = createDeferredCore();
      const work = createDeferredCore();
      trace.work = work.promise;
      trace.onDispatch = () => dispatched.resolve();
      const controller = new AbortController();
      const pending = evaluate(
        textBatch("synthetic cancellation"),
        harness.decisionOptions({ signal: controller.signal }),
      );
      let settled = false;
      void pending
        .finally(() => {
          settled = true;
        })
        .catch(() => {});
      await dispatched.promise;
      controller.abort(new Error("fixture cancelled"));
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(registry.decisionProviders[0]!.host.inspect(cfg).activeRequests).toBe(1);
      work.resolve();
      await expect(pending).rejects.toThrow("fixture cancelled");
      expect(usageEvents).toHaveLength(2);
      expect(registry.decisionProviders[0]!.host.inspect(cfg).activeRequests).toBe(0);
      await resetPreparedModelRuntimeSnapshotsForTest();
    });
  },
);

it("runs both SDK versions through the source TypeSafe plugin, prepared auth, and loopback transport", async () => {
  const root = roots.make("decision-typesafe-host-");
  const consumerId = "decision-consumer-fixture";
  const { consumerRoot, trace } = harness.createDecisionConsumer(root, consumerId, traceKey);
  let status = 200;
  await harness.withDecisionServer(
    () => ({
      status,
      body:
        status === 200
          ? {
              model: "kev-latest",
              answers: { q: { type: "noul", noul: 0.37 } },
              usage: { input_tokens: 3, output_tokens: 1 },
            }
          : "synthetic-private-provider-body",
    }),
    async ({ origin: baseUrl, requests: received }) => {
      const cfg = harness.decisionConfig(root, "typesafe/kev-latest", {
        load: {
          paths: [
            fileURLToPath(new URL("../../extensions/typesafe", import.meta.url)),
            consumerRoot,
          ],
        },
        entries: {
          typesafe: { enabled: true, config: { baseUrl } },
          [consumerId]: { enabled: true },
        },
      });
      await withEnvAsync(
        harness.decisionEnv(root, {
          OPENCLAW_COMPATIBILITY_HOST_VERSION: VERSION,
        }),
        async () => {
          await harness.activateDecisionRegistry(cfg);
          // Retain the prepared owner across SDK assertions; releasing it forces cold setup.
          await using prepared = await harness.prepareDecisionRuntime(
            cfg,
            "typesafe",
            "kev-latest",
          );
          expect(prepared.snapshot.modelCatalog.entries).toContainEqual(
            expect.objectContaining({ provider: "typesafe", id: "kev-latest" }),
          );
          const runtime = trace.runtime;
          if (!runtime) {
            throw new Error("Missing registered decision SDK");
          }
          const typesafeOptions = () =>
            harness.decisionOptions({ purpose: "actual-engine-fixture", rubricVersion: "1" });
          const batch = textBatch();
          const evaluate = (reasoning?: "auto" | "on" | "off") =>
            runtime.evaluateV2(batch, { ...typesafeOptions(), reasoning });
          const outcome = await evaluate("auto");
          expect(outcome).toMatchObject({
            status: "ok",
            result: {
              answers: { q: { type: "boolean", probabilityTrue: 0.37 } },
              usage: { inputTokens: 3, outputTokens: 1 },
            },
          });
          expect(
            await runtime.evaluate(
              { state: "synthetic evidence", questions: batch.questions },
              typesafeOptions(),
            ),
          ).toMatchObject({ status: "ok", result: { answers: { q: { probabilityTrue: 0.37 } } } });
          for (const reasoning of ["off", "on"] as const) {
            await expect(evaluate(reasoning)).resolves.toMatchObject(
              harness.unavailable("unsupported-input"),
            );
          }
          for (const rejection of [413, 422]) {
            status = rejection;
            expect(await evaluate()).toMatchObject(harness.unavailable("unsupported-input"));
          }
          expect(received).toHaveLength(4);
          for (const request of received) {
            expect(request.headers.get("authorization")).toBeNull();
            expect(request.url).toBe(baseUrl + "/v1/systemone");
            expect(request.body).toMatchObject({
              model: "kev-latest",
              questions: { q: { type: "noul" } },
            });
          }
        },
      );
    },
  );
});
