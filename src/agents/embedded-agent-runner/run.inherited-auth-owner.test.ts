import { createApiRegistry, createNodeLlmRuntime } from "@openclaw/ai";
import { registerBuiltInApiProviders } from "@openclaw/ai/providers";
import { expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareSharedAuthStoreOwnershipForNative } from "../auth-profiles/path-resolve.native.js";
import type { AgentHarness } from "../harness/types.js";
import { getApiKeyForModelCore } from "../model-auth.js";
import type { PreparedModelRuntimeSnapshot } from "../prepared-model-runtime.js";
import { AuthStorage } from "../sessions/auth-storage.js";
import { ModelRegistry } from "../sessions/model-registry.js";
import { prepareEmbeddedRunAuthPlan } from "./run/auth-plan.js";

it.each([false, true])(
  "sends the prepared owner's credential with local override=%s",
  async (localOverride) => {
    await withOpenClawTestState({ label: "inherited-attempt-owner" }, async (state) => {
      prepareSharedAuthStoreOwnershipForNative(state.env);
      const provider = "inherited-fixture";
      const profileId = provider + ":account";
      await state.writeAuthProfiles(
        {
          version: 1,
          profiles: { [profileId]: { type: "api_key", provider, key: "owner-fixture-key" } },
        },
        "owner",
      );
      await state.writeAuthProfiles(
        {
          version: 1,
          profiles: localOverride
            ? { [profileId]: { type: "api_key", provider, key: "local-fixture-key" } }
            : {},
        },
        "inheritor",
      );
      const model = {
        id: "fixture",
        name: "Fixture",
        provider,
        api: "openai-completions" as const,
        baseUrl: "https://fixture.invalid/v1",
        reasoning: false,
        input: ["text" as const],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32000,
        maxTokens: 1024,
      };
      const config: OpenClawConfig = {
        models: {
          providers: { [provider]: { api: model.api, baseUrl: model.baseUrl, models: [model] } },
        },
      };
      const authStorage = AuthStorage.inMemory();
      const modelRegistry = ModelRegistry.inMemory(authStorage);
      const harness = { id: "openclaw", label: "OpenClaw" } as AgentHarness;
      let runtimeModel = model;
      const prepared = await prepareEmbeddedRunAuthPlan({
        assertCurrent: () => {},
        runParams: {
          agentId: "inheritor",
          sessionId: "fixture",
          workspaceDir: state.workspaceDir,
          prompt: "fixture",
          timeoutMs: 1000,
          runId: "fixture",
          config,
        },
        provider,
        modelId: model.id,
        model,
        agentDir: state.agentDir("inheritor"),
        workspaceDir: state.workspaceDir,
        nativeModelOwned: false,
        authStorage,
        modelRegistry,
        preparedModelRuntime: {
          inheritedAuthDir: state.agentDir("owner"),
          findConfiguredRuntimeModel: () => model,
          metadataSnapshot: createPluginMetadataSnapshotFixture(),
        } as unknown as PreparedModelRuntimeSnapshot,
        getAgentHarness: () => harness,
        setAgentHarness: () => {},
        getRuntimeModel: () => runtimeModel,
        getEffectiveModel: () => runtimeModel,
        applyResolvedRuntimeModel: (next) => {
          runtimeModel = next as typeof model;
        },
        selectHarnessForPreparedAttempts: () => harness,
      });
      const attempt = prepared.preparedAuthAttempts[0];
      const auth = await getApiKeyForModelCore({
        model: runtimeModel,
        cfg: config,
        agentDir: state.agentDir("inheritor"),
        profileId: attempt?.profileId,
        store: prepared.attemptAuthProfileStore,
      });
      const requests: Request[] = [];
      const registry = createApiRegistry();
      registerBuiltInApiProviders(registry);
      const runtime = createNodeLlmRuntime(registry, {
        buildModelFetch: () => async (input, init) => {
          requests.push(new Request(input, init));
          return new Response(
            'data: {"id":"fixture","object":"chat.completion.chunk","created":0,"model":"fixture","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      });
      const result = await runtime
        .stream(
          runtimeModel,
          { messages: [{ role: "user", content: "Reply ok", timestamp: 1 }] },
          { apiKey: auth.apiKey },
        )
        .result();
      expect(result.errorMessage).toBeUndefined();
      expect(result.stopReason).toBe("stop");
      expect(requests).toHaveLength(1);
      expect(requests[0]?.headers.get("authorization")).toBe(
        "Bearer " + (localOverride ? "local-fixture-key" : "owner-fixture-key"),
      );
    });
  },
);
