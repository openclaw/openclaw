import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { prepareDecisionProviderReload } from "../decisions/provider-reload.js";
import { evaluateDecisionV2InRegistry } from "../decisions/runtime.js";
import { withGuardedFetchRequestAuthority } from "../infra/net/fetch-request-authority.js";
import { clearSecretsRuntimeSnapshot } from "../secrets/runtime.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveDefaultAgentId } from "./agent-scope.js";
import * as harness from "./decision-inference.test-support.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "./prepared-model-runtime.test-support.js";
import { closeProviderTransportDispatcherPool } from "./provider-transport-dispatcher-pool.js";

const endpoint = "https://generativelanguage.googleapis.com/v1beta/decisions";

afterEach(async () => {
  await harness.resetDecisionTestRuntime(undefined, closeProviderTransportDispatcherPool);
});

it("routes the selected Gemini Decision model through the registered Google plugin", async () => {
  const response = {
    answers: { urgent: { type: "noul", noul: 0.81, confidence: 0.81 } },
    usage: {
      total_input_tokens: 21,
      input_tokens_by_modality: [{ modality: "text", tokens: 21 }],
      total_output_tokens: 0,
      total_tokens: 21,
    },
  };
  await harness.withDecisionServer(
    () => ({ status: 200, body: response }),
    async ({ requests, mockFetch }) => {
      const state = await createOpenClawTestState({ applyEnv: false });
      const pluginRoot = fileURLToPath(new URL("../../extensions/google", import.meta.url));
      const config = harness.decisionConfig(state.root, "google/gemini-decision-1", {
        allow: ["google"],
        entries: { google: { enabled: true } },
      });
      delete config.agents!.defaults!.model;
      const env = harness.decisionEnv(
        state.root,
        {
          ...state.envVars,
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
          GEMINI_API_KEY: "synthetic-gemini-key",
          GOOGLE_API_KEY: undefined,
          HTTP_PROXY: undefined,
          HTTPS_PROXY: undefined,
          ALL_PROXY: undefined,
          http_proxy: undefined,
          https_proxy: undefined,
          all_proxy: undefined,
        },
        path.dirname(pluginRoot),
      );
      mockFetch(endpoint);
      try {
        await withEnvAsync(env, async () => {
          const registry = await harness.activateDecisionRegistry(config, {
            env,
            onlyPluginIds: ["google"],
            preferBuiltPluginArtifacts: false,
            pluginSdkResolution: "src",
          });
          await using prepared = await harness.prepareDecisionRuntime(
            config,
            "google",
            "gemini-decision-1",
          );
          expect(prepared.snapshot.modelCatalog.entries).toContainEqual(
            expect.objectContaining({ provider: "google", id: "gemini-decision-1" }),
          );
          const events = harness.trackDecisionUsage();
          const options = harness.decisionOptions({
            agentId: resolveDefaultAgentId(config),
            purpose: "google-route-fixture",
            rubricVersion: "1",
          });
          const batch = {
            state: { type: "text" as const, text: "Checkout is failing for all customers." },
            questions: {
              urgent: {
                type: "boolean" as const,
                instructions: "Does this need incident response?",
              },
            },
          };
          const outcome = await withGuardedFetchRequestAuthority(undefined, () =>
            evaluateDecisionV2InRegistry(batch, options, registry, config),
          );
          expect(outcome, JSON.stringify(outcome)).toMatchObject({
            status: "ok",
            result: {
              model: "gemini-decision-1",
              answers: { urgent: { type: "boolean", probabilityTrue: 0.81 } },
              usage: { inputTokens: 21, outputTokens: 0 },
            },
            provenance: { providerId: "google" },
          });
          expect(requests).toHaveLength(1);
          expect(requests[0]!.headers.get("x-goog-api-key")).toBe("synthetic-gemini-key");
          expect(requests[0]!.body).toEqual({
            model: "gemini-decision-1",
            input: "Checkout is failing for all customers.",
            questions: {
              urgent: { type: "noul", instructions: "Does this need incident response?" },
            },
          });
          expect(events).toMatchObject([
            { provider: "google", model: "gemini-decision-1", usage: { input: 21, output: 0 } },
          ]);
          // Google's published Decision rate: $0.10 per million input tokens, no output charge.
          expect(events[0]?.costUsd).toBeCloseTo((21 * 0.1) / 1_000_000, 12);
          expect(registry.decisionProviders[0]?.host.inspect(config).activeRequests).toBe(0);

          // Authority revoked after preparation must stop the real guarded dispatch.
          const host = registry.decisionProviders.find(
            (entry) => entry.host.provider.id === "google",
          )!.host;
          const evaluate = host.provider.evaluate.bind(host.provider);
          const evaluateWithRevocation = async (revoke: () => void) => {
            let revoked = false;
            const spy = vi.spyOn(host.provider, "evaluate").mockImplementationOnce((...args) => {
              // Guarded fetch yields while preparing its dispatcher, before beforeRequest.
              queueMicrotask(() => {
                revoked = true;
                revoke();
              });
              return evaluate(...args);
            });
            const denied = await withGuardedFetchRequestAuthority(undefined, () =>
              evaluateDecisionV2InRegistry(batch, options, registry, config),
            );
            spy.mockRestore();
            expect(revoked).toBe(true);
            return denied;
          };
          const cases = {
            selection: () =>
              setRuntimeConfigSnapshot({
                ...config,
                agents: { defaults: { ...config.agents!.defaults, decisionModel: "" } },
              }),
            credentials: () => {
              clearSecretsRuntimeSnapshot();
              setRuntimeConfigSnapshot(config);
            },
            generation: () => prepareDecisionProviderReload(registry, new Set(["google"])),
          };
          for (const [name, revoke] of Object.entries(cases)) {
            expect(await evaluateWithRevocation(revoke), name).toEqual(
              harness.unavailable("retiring"),
            );
            setRuntimeConfigSnapshot(config);
          }
          // Only the allowed control reached the transport boundary.
          expect(requests).toHaveLength(1);
          expect(events).toHaveLength(1);
        });
      } finally {
        await resetPreparedModelRuntimeSnapshotsForTest();
        await state.cleanup();
      }
    },
  );
});
