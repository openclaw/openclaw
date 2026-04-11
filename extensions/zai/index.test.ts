import { createHash } from "node:crypto";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model } from "@mariozechner/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerSingleProviderPlugin } from "../../test/helpers/plugins/plugin-registration.js";
import plugin from "./index.js";

const detectZaiEndpoint = vi.hoisted(() => vi.fn(async () => undefined));
const upsertAuthProfile = vi.hoisted(() => vi.fn());

vi.mock("./detect.js", async () => {
  const actual = await vi.importActual<typeof import("./detect.js")>("./detect.js");
  return {
    ...actual,
    detectZaiEndpoint,
  };
});

vi.mock("openclaw/plugin-sdk/provider-auth-api-key", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/provider-auth-api-key")>(
    "openclaw/plugin-sdk/provider-auth-api-key",
  );
  return {
    ...actual,
    upsertAuthProfile,
  };
});

function resolveRuntimeEnvProfileId(apiKey: string): string {
  return `zai:runtime-env-${createHash("sha256").update(apiKey, "utf8").digest("hex").slice(0, 12)}`;
}

function resolveProfileApiKey(profile: {
  credential: { type: string; key?: string };
  profileId: string;
}): string {
  expect(profile.credential.type).toBe("api_key");
  if (!profile.credential.key) {
    throw new Error(`expected api_key credential for ${profile.profileId}`);
  }
  return profile.credential.key;
}

beforeEach(() => {
  detectZaiEndpoint.mockReset();
  detectZaiEndpoint.mockResolvedValue(undefined);
  upsertAuthProfile.mockReset();
});

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
        profileId: resolveRuntimeEnvProfileId("sk-zai-a"),
        persistence: "runtime-only",
        credential: {
          type: "api_key",
          provider: "zai",
          key: "sk-zai-a",
          displayName: "Z.AI env key 1",
        },
      },
      {
        profileId: resolveRuntimeEnvProfileId("sk-zai-b"),
        persistence: "runtime-only",
        credential: {
          type: "api_key",
          provider: "zai",
          key: "sk-zai-b",
          displayName: "Z.AI env key 2",
        },
      },
      {
        profileId: resolveRuntimeEnvProfileId("sk-zai-1"),
        persistence: "runtime-only",
        credential: {
          type: "api_key",
          provider: "zai",
          key: "sk-zai-1",
          displayName: "Z.AI env key 3",
        },
      },
      {
        profileId: resolveRuntimeEnvProfileId("sk-zai-2"),
        persistence: "runtime-only",
        credential: {
          type: "api_key",
          provider: "zai",
          key: "sk-zai-2",
          displayName: "Z.AI env key 4",
        },
      },
      {
        profileId: resolveRuntimeEnvProfileId("sk-zai-legacy"),
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
        profileId: resolveRuntimeEnvProfileId("sk-zai-next"),
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

  it("treats a single-item ZAI_API_KEYS list as usable auth when no stored profile exists", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    const profiles = provider.resolveExternalAuthProfiles?.({
      env: {
        ZAI_API_KEYS: "sk-zai-single",
      },
      store: {
        version: 1,
        profiles: {},
      },
    } as never);

    expect(profiles).toEqual([
      {
        profileId: resolveRuntimeEnvProfileId("sk-zai-single"),
        persistence: "runtime-only",
        credential: {
          type: "api_key",
          provider: "zai",
          key: "sk-zai-single",
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
        profileId: resolveRuntimeEnvProfileId("sk-zai-next"),
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
        profileId: resolveRuntimeEnvProfileId("sk-zai-next"),
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

  it("ignores unregistered numbered Z.AI API key env vars beyond the documented pair", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    const profiles = provider.resolveExternalAuthProfiles?.({
      env: {
        ZAI_API_KEY_1: "sk-zai-next",
        ZAI_API_KEY_3: "sk-zai-ignored",
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
        profileId: resolveRuntimeEnvProfileId("sk-zai-next"),
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
          [resolveRuntimeEnvProfileId("sk-zai-a")]: {
            type: "api_key",
            provider: "zai",
            key: "sk-zai-a",
          },
          [resolveRuntimeEnvProfileId("sk-zai-b")]: {
            type: "api_key",
            provider: "zai",
            key: "sk-zai-b",
          },
        },
      },
    } as never);

    expect(profiles?.map((profile) => profile.profileId)).toEqual([
      resolveRuntimeEnvProfileId("sk-zai-a"),
      resolveRuntimeEnvProfileId("sk-zai-b"),
    ]);
  });

  it("keeps runtime env profile ids stable when env key ordering changes", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    const forward = provider.resolveExternalAuthProfiles?.({
      env: {
        ZAI_API_KEYS: "sk-zai-a,sk-zai-b",
      },
      store: {
        version: 1,
        profiles: {},
      },
    } as never);
    const reversed = provider.resolveExternalAuthProfiles?.({
      env: {
        ZAI_API_KEYS: "sk-zai-b,sk-zai-a",
      },
      store: {
        version: 1,
        profiles: {},
      },
    } as never);

    expect(
      forward
        ?.map((profile) => [resolveProfileApiKey(profile), profile.profileId] as const)
        .toSorted(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey)),
    ).toEqual(
      reversed
        ?.map((profile) => [resolveProfileApiKey(profile), profile.profileId] as const)
        .toSorted(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey)),
    );
  });

  it("keeps ZAI_API_KEYS as an env ref in non-interactive ref mode", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const method = provider.auth.find((entry) => entry.id === "api-key");
    expect(method?.runNonInteractive).toBeDefined();

    const resolveApiKey = vi.fn(async () => ({ key: "sk-zai-single", source: "profile" as const }));
    const toApiKeyCredential = vi.fn(({ provider, resolved }) => ({
      type: "api_key" as const,
      provider,
      ...(resolved.source === "env" && resolved.envVarName
        ? {
            keyRef: {
              source: "env" as const,
              provider: "default",
              id: resolved.envVarName,
            },
          }
        : { key: resolved.key }),
    }));
    const previousZaiApiKeys = process.env.ZAI_API_KEYS;
    process.env.ZAI_API_KEYS = "sk-zai-single";

    try {
      const result = await method?.runNonInteractive?.({
        authChoice: "zai-api-key",
        config: { agents: { defaults: {} } },
        baseConfig: { agents: { defaults: {} } },
        opts: {},
        runtime: {
          error: vi.fn(),
          exit: vi.fn(),
          log: vi.fn(),
        } as never,
        secretInputMode: "ref",
        resolveApiKey,
        toApiKeyCredential,
      } as never);

      expect(resolveApiKey).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "zai",
          envVar: "ZAI_API_KEY",
        }),
      );
      expect(toApiKeyCredential).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "zai",
          resolved: {
            key: "sk-zai-single",
            source: "env",
            envVarName: "ZAI_API_KEYS",
          },
        }),
      );
      expect(upsertAuthProfile).toHaveBeenCalledWith(
        expect.objectContaining({
          profileId: "zai:default",
          credential: expect.objectContaining({
            keyRef: {
              source: "env",
              provider: "default",
              id: "ZAI_API_KEYS",
            },
          }),
        }),
      );
      expect(result?.auth?.profiles?.["zai:default"]).toEqual({
        provider: "zai",
        mode: "api_key",
      });
    } finally {
      if (previousZaiApiKeys === undefined) {
        delete process.env.ZAI_API_KEYS;
      } else {
        process.env.ZAI_API_KEYS = previousZaiApiKeys;
      }
    }
  });

  it("persists a single-item ZAI_API_KEYS list when non-interactive auth resolves through profile fallback", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const method = provider.auth.find((entry) => entry.id === "api-key");
    expect(method?.runNonInteractive).toBeDefined();

    const resolveApiKey = vi.fn(async () => ({ key: "sk-zai-single", source: "profile" as const }));
    const toApiKeyCredential = vi.fn(({ provider, resolved }) => ({
      type: "api_key" as const,
      provider,
      key: resolved.key,
    }));
    const previousZaiApiKeys = process.env.ZAI_API_KEYS;
    process.env.ZAI_API_KEYS = "sk-zai-single";

    try {
      const result = await method?.runNonInteractive?.({
        authChoice: "zai-api-key",
        config: { agents: { defaults: {} } },
        baseConfig: { agents: { defaults: {} } },
        opts: {},
        runtime: {
          error: vi.fn(),
          exit: vi.fn(),
          log: vi.fn(),
        } as never,
        resolveApiKey,
        toApiKeyCredential,
      } as never);

      expect(toApiKeyCredential).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "zai",
          resolved: {
            key: "sk-zai-single",
            source: "env",
            envVarName: "ZAI_API_KEYS",
          },
        }),
      );
      expect(upsertAuthProfile).toHaveBeenCalledWith(
        expect.objectContaining({
          profileId: "zai:default",
          credential: {
            type: "api_key",
            provider: "zai",
            key: "sk-zai-single",
          },
        }),
      );
      expect(result?.auth?.profiles?.["zai:default"]).toEqual({
        provider: "zai",
        mode: "api_key",
      });
    } finally {
      if (previousZaiApiKeys === undefined) {
        delete process.env.ZAI_API_KEYS;
      } else {
        process.env.ZAI_API_KEYS = previousZaiApiKeys;
      }
    }
  });
});
