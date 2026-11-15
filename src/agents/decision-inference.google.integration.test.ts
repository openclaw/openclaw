import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { evaluateDecisionV2InRegistry } from "../decisions/runtime.js";
import { withGuardedFetchRequestAuthority } from "../infra/net/fetch-request-authority.js";
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
          const outcome = await withGuardedFetchRequestAuthority(undefined, () =>
            evaluateDecisionV2InRegistry(
              {
                state: { type: "text", text: "Checkout is failing for all customers." },
                questions: {
                  urgent: { type: "boolean", instructions: "Does this need incident response?" },
                },
              },
              options,
              registry,
              config,
            ),
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
        });
      } finally {
        await resetPreparedModelRuntimeSnapshotsForTest();
        await state.cleanup();
      }
    },
  );
});
