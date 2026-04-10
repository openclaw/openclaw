import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { registerSingleProviderPlugin } from "../../test/helpers/plugins/plugin-registration.js";
import plugin from "./index.js";

describe("zai provider plugin", () => {
  it("owns replay policy for OpenAI-compatible Z.ai transports", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(
      provider.buildReplayPolicy?.({
        provider: "zai",
        modelApi: "openai-completions",
        modelId: "glm-5.1",
      } as never),
    ).toMatchObject({
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
      applyAssistantFirstOrderingFix: true,
      validateGeminiTurns: true,
      validateAnthropicTurns: true,
    });

    expect(
      provider.buildReplayPolicy?.({
        provider: "zai",
        modelApi: "openai-responses",
        modelId: "glm-5.1",
      } as never),
    ).toMatchObject({
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
      applyAssistantFirstOrderingFix: false,
      validateGeminiTurns: false,
      validateAnthropicTurns: false,
    });
  });

  it("resolves persisted GLM-5 family models with provider-owned metadata", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const template = {
      id: "glm-4.7",
      name: "GLM-4.7",
      provider: "zai",
      api: "openai-completions",
      baseUrl: "https://api.z.ai/api/paas/v4",
      reasoning: true,
      input: ["text"],
      cost: { input: 0.6, output: 2.2, cacheRead: 0.11, cacheWrite: 0 },
      contextWindow: 204800,
      maxTokens: 131072,
    };

    const cases = [
      {
        modelId: "glm-5.1",
        expected: {
          input: ["text"],
          reasoning: true,
          contextWindow: 202800,
          maxTokens: 131100,
        },
      },
      {
        modelId: "glm-5v-turbo",
        expected: {
          input: ["text", "image"],
          reasoning: true,
          contextWindow: 202800,
          maxTokens: 131100,
        },
      },
    ] as const;

    for (const testCase of cases) {
      expect(
        provider.resolveDynamicModel?.({
          provider: "zai",
          modelId: testCase.modelId,
          modelRegistry: {
            find: (_provider: string, modelId: string) => (modelId === "glm-4.7" ? template : null),
          },
        } as never),
      ).toMatchObject({
        provider: "zai",
        api: "openai-completions",
        baseUrl: "https://api.z.ai/api/paas/v4",
        id: testCase.modelId,
        ...testCase.expected,
      });
    }
  });

  it("returns an already-registered GLM-5 variant as-is", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const registered = {
      id: "glm-5-turbo",
      name: "GLM-5-Turbo",
      provider: "zai",
      api: "openai-completions",
      baseUrl: "https://api.z.ai/api/paas/v4",
      reasoning: false,
      input: ["text"],
      cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 123456,
      maxTokens: 54321,
    };
    const template = {
      id: "glm-4.7",
      name: "GLM-4.7",
      provider: "zai",
      api: "openai-completions",
      baseUrl: "https://api.z.ai/api/paas/v4",
      reasoning: true,
      input: ["text"],
      cost: { input: 0.6, output: 2.2, cacheRead: 0.11, cacheWrite: 0 },
      contextWindow: 204800,
      maxTokens: 131072,
    };

    expect(
      provider.resolveDynamicModel?.({
        provider: "zai",
        modelId: "glm-5-turbo",
        modelRegistry: {
          find: (_provider: string, modelId: string) =>
            modelId === "glm-5-turbo" ? registered : modelId === "glm-4.7" ? template : null,
        },
      } as never),
    ).toEqual(registered);
  });

  it("still synthesizes unknown GLM-5 variants from the GLM-4.7 template", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const template = {
      id: "glm-4.7",
      name: "GLM-4.7",
      provider: "zai",
      api: "openai-completions",
      baseUrl: "https://api.z.ai/api/paas/v4",
      reasoning: true,
      input: ["text"],
      cost: { input: 0.6, output: 2.2, cacheRead: 0.11, cacheWrite: 0 },
      contextWindow: 204800,
      maxTokens: 131072,
    };

    expect(
      provider.resolveDynamicModel?.({
        provider: "zai",
        modelId: "glm-5-turbo",
        modelRegistry: {
          find: (_provider: string, modelId: string) => (modelId === "glm-4.7" ? template : null),
        },
      } as never),
    ).toMatchObject({
      id: "glm-5-turbo",
      name: "GLM-5 Turbo",
      provider: "zai",
      api: "openai-completions",
      baseUrl: "https://api.z.ai/api/paas/v4",
      reasoning: true,
      input: ["text"],
    });
  });

  it("wires tool-stream defaults through the shared stream family hook", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    let capturedPayload: Record<string, unknown> | undefined;
    const baseStreamFn: StreamFn = (model, _context, options) => {
      const payload: Record<string, unknown> = {};
      options?.onPayload?.(payload as never, model as never);
      capturedPayload = payload;
      return {} as ReturnType<StreamFn>;
    };

    const defaultWrapped = provider.wrapStreamFn?.({
      provider: "zai",
      modelId: "glm-5.1",
      extraParams: {},
      streamFn: baseStreamFn,
    } as never);

    void defaultWrapped?.(
      {
        api: "openai-completions",
        provider: "zai",
        id: "glm-5.1",
      } as Model<"openai-completions">,
      { messages: [] } as Context,
      {},
    );

    expect(capturedPayload).toMatchObject({
      tool_stream: true,
    });

    const disabledWrapped = provider.wrapStreamFn?.({
      provider: "zai",
      modelId: "glm-5.1",
      extraParams: { tool_stream: false },
      streamFn: baseStreamFn,
    } as never);

    void disabledWrapped?.(
      {
        api: "openai-completions",
        provider: "zai",
        id: "glm-5.1",
      } as Model<"openai-completions">,
      { messages: [] } as Context,
      {},
    );

    expect(capturedPayload).not.toHaveProperty("tool_stream");
  });

  it("exposes runtime-only auth profiles for multiple env API keys", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    const profiles = provider.resolveExternalAuthProfiles?.({
      env: {
        ZAI_API_KEYS: "sk-zai-a; sk-zai-b",
        ZAI_API_KEY: "sk-zai-primary",
        ZAI_API_KEY_2: "sk-zai-2",
        ZAI_API_KEY_1: "sk-zai-1",
        Z_AI_API_KEY: "sk-zai-legacy",
      },
      store: {
        version: 1,
        profiles: {
          "zai:default": {
            type: "api_key",
            provider: "zai",
            key: "sk-zai-primary",
          },
        },
      },
    } as never);

    expect(profiles).toEqual([
      {
        profileId: "zai:runtime-env-1",
        persistence: "runtime-only",
        credential: {
          type: "api_key",
          provider: "zai",
          key: "sk-zai-a",
          displayName: "Z.AI env key 1",
        },
      },
      {
        profileId: "zai:runtime-env-2",
        persistence: "runtime-only",
        credential: {
          type: "api_key",
          provider: "zai",
          key: "sk-zai-b",
          displayName: "Z.AI env key 2",
        },
      },
      {
        profileId: "zai:runtime-env-3",
        persistence: "runtime-only",
        credential: {
          type: "api_key",
          provider: "zai",
          key: "sk-zai-1",
          displayName: "Z.AI env key 3",
        },
      },
      {
        profileId: "zai:runtime-env-4",
        persistence: "runtime-only",
        credential: {
          type: "api_key",
          provider: "zai",
          key: "sk-zai-2",
          displayName: "Z.AI env key 4",
        },
      },
      {
        profileId: "zai:runtime-env-5",
        persistence: "runtime-only",
        credential: {
          type: "api_key",
          provider: "zai",
          key: "sk-zai-legacy",
          displayName: "Z.AI env key 5",
        },
      },
    ]);
  });

  it("creates a runtime auth profile for a single live override key", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    const profiles = provider.resolveExternalAuthProfiles?.({
      env: {
        OPENCLAW_LIVE_ZAI_KEY: "sk-zai-live",
        ZAI_API_KEYS: "sk-zai-a,sk-zai-b",
      },
      store: {
        version: 1,
        profiles: {},
      },
    } as never);

    expect(profiles).toEqual([
      {
        profileId: "zai:runtime-live-override",
        persistence: "runtime-only",
        selectionPriority: "highest",
        credential: {
          type: "api_key",
          provider: "zai",
          key: "sk-zai-live",
          displayName: "Z.AI live override",
        },
      },
    ]);
  });

  it("emits a new runtime profile when one env key complements a persisted key", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    const profiles = provider.resolveExternalAuthProfiles?.({
      env: {
        ZAI_API_KEY_1: "sk-zai-next",
      },
      store: {
        version: 1,
        profiles: {
          "zai:default": {
            type: "api_key",
            provider: "zai",
            key: "sk-zai-primary",
          },
        },
      },
    } as never);

    expect(profiles).toEqual([
      {
        profileId: "zai:runtime-env-1",
        persistence: "runtime-only",
        credential: {
          type: "api_key",
          provider: "zai",
          key: "sk-zai-next",
          displayName: "Z.AI env key 1",
        },
      },
    ]);
  });

  it("counts keyRef-backed stored api-key profiles when deciding to emit env rotation", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    const profiles = provider.resolveExternalAuthProfiles?.({
      env: {
        ZAI_API_KEY: "sk-zai-primary",
        ZAI_API_KEY_1: "sk-zai-next",
      },
      store: {
        version: 1,
        profiles: {
          "zai:default": {
            type: "api_key",
            provider: "zai",
            keyRef: {
              source: "env",
              provider: "default",
              id: "ZAI_API_KEY",
            },
          },
        },
      },
    } as never);

    expect(profiles).toEqual([
      {
        profileId: "zai:runtime-env-1",
        persistence: "runtime-only",
        credential: {
          type: "api_key",
          provider: "zai",
          key: "sk-zai-next",
          displayName: "Z.AI env key 1",
        },
      },
    ]);
  });

  it("deduplicates keyRef-backed primary env keys before env rotation", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    const profiles = provider.resolveExternalAuthProfiles?.({
      env: {
        ZAI_API_KEY: "sk-zai-primary",
        ZAI_API_KEY_1: "sk-zai-next",
      },
      store: {
        version: 1,
        profiles: {
          "zai:default": {
            type: "api_key",
            provider: "zai",
            keyRef: {
              source: "env",
              provider: "default",
              id: "ZAI_API_KEY",
            },
          },
        },
      },
    } as never);

    expect(profiles).toEqual([
      {
        profileId: "zai:runtime-env-1",
        persistence: "runtime-only",
        credential: {
          type: "api_key",
          provider: "zai",
          key: "sk-zai-next",
          displayName: "Z.AI env key 1",
        },
      },
    ]);
  });

  it("rebuilds the same runtime env profiles when the store already includes them", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    const profiles = provider.resolveExternalAuthProfiles?.({
      env: {
        ZAI_API_KEYS: "sk-zai-a,sk-zai-b",
      },
      store: {
        version: 1,
        profiles: {
          "zai:runtime-env-1": {
            type: "api_key",
            provider: "zai",
            key: "sk-zai-a",
          },
          "zai:runtime-env-2": {
            type: "api_key",
            provider: "zai",
            key: "sk-zai-b",
          },
        },
      },
    } as never);

    expect(profiles?.map((profile) => profile.profileId)).toEqual([
      "zai:runtime-env-1",
      "zai:runtime-env-2",
    ]);
  });
});
