// Github Copilot tests cover index plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  ensureAuthProfileStore,
  saveAuthProfileStore,
} from "openclaw/plugin-sdk/agent-runtime";
import { MAX_DATE_TIMESTAMP_MS } from "openclaw/plugin-sdk/number-runtime";
import type {
  OpenClawConfig,
  OpenClawPluginApi,
  ProviderAuthResult,
} from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import type { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { markdownToIR } from "openclaw/plugin-sdk/text-chunking";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { runGitHubCopilotDeviceFlow } from "./login.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { CopilotRuntimeAuthError } from "./runtime-auth-error.js";

const mocks = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn<typeof fetchWithSsrFGuard>(async (params) => ({
    response: await fetch(params.url, params.init),
    finalUrl: params.url,
    release: vi.fn(async () => {}),
  })),
  resolveCopilotRuntimeAuth: vi.fn(),
  resolveCopilotStarterModel: vi.fn(async () => "github-copilot/claude-sonnet-5"),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/ssrf-runtime")>(
    "openclaw/plugin-sdk/ssrf-runtime",
  );
  return {
    ...actual,
    fetchWithSsrFGuard: mocks.fetchWithSsrFGuard,
  };
});

vi.mock("./register.runtime.js", () => ({
  DEFAULT_COPILOT_API_BASE_URL: "https://api.githubcopilot.test",
  resolveCopilotRuntimeAuth: mocks.resolveCopilotRuntimeAuth,
  resolveCopilotStarterModel: mocks.resolveCopilotStarterModel,
  fetchCopilotUsage: vi.fn(),
}));

import plugin from "./index.js";
import {
  interactiveContext,
  registerProviderWithPluginConfig,
  requireAuthMethod,
} from "./provider.test-support.js";

const tempDirs: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  mocks.fetchWithSsrFGuard.mockImplementation(async (params) => ({
    response: await fetch(params.url, params.init),
    finalUrl: params.url,
    release: vi.fn(async () => {}),
  }));
  clearRuntimeAuthProfileStoreSnapshots();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

afterAll(() => {
  vi.doUnmock("./register.runtime.js");
  vi.resetModules();
});

async function runDeviceAuthWithFakeTimers<T>(
  run: (openUrl: (url: string) => Promise<void>) => T | Promise<T>,
): Promise<T> {
  vi.useFakeTimers();
  try {
    let notifyDeviceCodeShown!: () => void;
    const deviceCodeShown = new Promise<void>((resolve) => {
      notifyDeviceCodeShown = resolve;
    });
    const pending = Promise.resolve(run(async () => notifyDeviceCodeShown()));
    const openedBeforeCompletion = await Promise.race([
      deviceCodeShown.then(() => true),
      pending.then(() => false),
    ]);
    expect(openedBeforeCompletion).toBe(true);
    // Browser handoff follows the profile, device-code, and prompt work.
    await vi.advanceTimersByTimeAsync(1_000);
    return await pending;
  } finally {
    vi.useRealTimers();
  }
}

async function createAgentDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-github-copilot-test-"));
  tempDirs.push(dir);
  return dir;
}

function createModelRegistry() {
  return {
    getAll: vi.fn(() => []),
    getAvailable: vi.fn(() => []),
    find: vi.fn(() => undefined),
    hasConfiguredAuth: vi.fn(() => false),
  };
}

function writeProfiles(
  agentDir: string,
  profiles: Parameters<typeof saveAuthProfileStore>[0]["profiles"],
) {
  saveAuthProfileStore({ version: 1, profiles }, agentDir, {
    filterExternalAuthProfiles: false,
    syncExternalCli: false,
  });
}

function writeExistingCopilotTokenProfile(agentDir: string) {
  writeProfiles(agentDir, {
    "github-copilot:github": {
      type: "token",
      provider: "github-copilot",
      token: "existing-token",
    },
  });
}

function nonInteractiveContext(agentDir: string) {
  return {
    authChoice: "github-copilot",
    config: {},
    baseConfig: {},
    opts: {},
    agentDir,
    toApiKeyCredential: vi.fn(),
  };
}

describe("github-copilot plugin", () => {
  it("registers embedding provider", () => {
    const registerEmbeddingProviderMock = vi.fn<OpenClawPluginApi["registerEmbeddingProvider"]>();

    plugin.register(
      createTestPluginApi({
        id: "github-copilot",
        name: "GitHub Copilot",
        source: "test",
        config: {},
        pluginConfig: {},
        runtime: {} as never,
        registerProvider: vi.fn(),
        registerEmbeddingProvider: registerEmbeddingProviderMock,
      }),
    );

    expect(registerEmbeddingProviderMock).toHaveBeenCalledTimes(1);
    const adapter = expectDefined(
      registerEmbeddingProviderMock.mock.calls[0]?.[0],
      "embedding provider registration",
    );
    expect(adapter.id).toBe("github-copilot");
  });

  it("normalizes legacy OAuth profiles without losing tenant metadata", async () => {
    const provider = registerProviderWithPluginConfig({});
    const credential = {
      type: "oauth" as const,
      provider: "github-copilot",
      access: "short-lived-copilot-token",
      refresh: "durable-github-token",
      expires: 1,
      enterpriseUrl: "acme.ghe.com",
    };

    await expect(provider.refreshOAuth?.(credential)).resolves.toEqual({
      ...credential,
      access: "durable-github-token",
      expires: MAX_DATE_TIMESTAMP_MS,
    });
    expect(credential).toEqual({
      type: "oauth",
      provider: "github-copilot",
      access: "short-lived-copilot-token",
      refresh: "durable-github-token",
      expires: 1,
      enterpriseUrl: "acme.ghe.com",
    });
  });

  it("rejects unsafe legacy OAuth tenants before formatting or refresh", async () => {
    const provider = registerProviderWithPluginConfig({});
    const credential = {
      type: "oauth" as const,
      provider: "github-copilot",
      access: "short-lived-copilot-token",
      refresh: "durable-github-token",
      expires: 1,
      enterpriseUrl: "attacker.example",
    };

    expect(() => provider.formatApiKey?.(credential)).toThrow(/attacker\.example/);
    await expect(provider.refreshOAuth?.(credential)).rejects.toThrow(/attacker\.example/);
  });

  it("moves unsupported legacy OAuth doctor guidance into the provider", async () => {
    const provider = registerProviderWithPluginConfig({});
    const store = {
      version: 1,
      profiles: {
        "github-copilot:default": {
          type: "oauth" as const,
          provider: "github-copilot",
          access: "fake",
          refresh: "fake",
          expires: 0,
          enterpriseUrl: "attacker.example",
        },
      },
    };

    expect(
      await provider.buildAuthDoctorHint?.({
        store,
        provider: "github-copilot",
        profileId: "github-copilot:default",
      }),
    ).toContain("unsupported enterprise domain");
    store.profiles["github-copilot:default"].enterpriseUrl = "acme.ghe.com";
    expect(
      await provider.buildAuthDoctorHint?.({
        store,
        provider: "github-copilot",
        profileId: "github-copilot:default",
      }),
    ).toBeUndefined();
  });

  it("rejects an unresolved integration SecretRef before catalog fallback or inference", async () => {
    const provider = registerProviderWithPluginConfig({});
    const agentDir = await createAgentDir();
    const config = {
      models: {
        providers: {
          "github-copilot": {
            request: {
              headers: {
                "Copilot-Integration-Id": { source: "env", provider: "default", id: "IDENTITY" },
              },
            },
          },
        },
      },
    };
    mocks.resolveCopilotRuntimeAuth.mockResolvedValue({
      apiKey: "github-source-token",
      baseUrl: "https://copilot-api.acme.ghe.com",
    });
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      provider.catalog.run({
        agentDir,
        config,
        env: { COPILOT_GITHUB_TOKEN: "github-source-token" },
      }),
    ).rejects.toMatchObject({ name: "UnresolvedSecretInputError" });
    await expect(
      provider.prepareRuntimeAuth({
        config,
        env: {},
        provider: "github-copilot",
        modelId: "claude-sonnet-5",
        model: { id: "claude-sonnet-5", provider: "github-copilot" },
        apiKey: "github-source-token",
        authMode: "token",
      } as never),
    ).rejects.toMatchObject({ name: "UnresolvedSecretInputError" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("isolates live catalog results by the configured integration header", async () => {
    const agentDir = await createAgentDir();
    writeExistingCopilotTokenProfile(agentDir);
    const provider = registerProviderWithPluginConfig({});
    const modelRegistry = createModelRegistry();
    mocks.resolveCopilotRuntimeAuth.mockResolvedValue({
      apiKey: "identity-catalog-token",
      baseUrl: "https://copilot-api.acme.ghe.com",
    });
    const observedHeaders: Headers[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (_url, init) => {
        const headers = new Headers(init?.headers);
        observedHeaders.push(headers);
        return Response.json({
          data: [
            {
              id: "gpt-5-mini",
              model_picker_enabled: true,
              policy: { state: "enabled" },
              capabilities: {
                type: "chat",
                supports: { streaming: true, tool_calls: true },
                limits: {
                  max_context_window_tokens:
                    headers.get("copilot-integration-id") === "vscode-chat" ? 100_000 : 200_000,
                },
              },
            },
          ],
        });
      }),
    );

    for (const identity of ["vscode-chat", "copilot-developer-cli"]) {
      const config = {
        models: {
          providers: {
            "github-copilot": {
              baseUrl: "https://copilot-api.acme.ghe.com",
              models: [],
              headers: {
                "copilot-integration-id": identity,
                "X-Private-Header": "not-for-catalog",
              },
            },
          },
        },
      };
      const result = await provider.catalog.run({
        agentDir,
        env: { COPILOT_GITHUB_TOKEN: "identity-catalog-token" },
        config,
      });
      const contextWindow = identity === "vscode-chat" ? 100_000 : 200_000;
      expect(result && "provider" in result ? result.provider.models : []).toMatchObject([
        { id: "gpt-5-mini", contextWindow },
      ]);
      const context = {
        config,
        agentDir,
        modelRegistry,
        provider: "github-copilot",
        modelId: "gpt-5-mini",
        authProfileId: "github-copilot:github",
      };
      await provider.prepareDynamicModel(context);
      expect(provider.resolveDynamicModel(context)).toMatchObject({
        id: "gpt-5-mini",
        contextWindow,
      });
    }
    expect(observedHeaders).toHaveLength(2);
    expect(observedHeaders.every((headers) => !headers.has("x-private-header"))).toBe(true);
  });

  it.each([
    {
      label: "a public OAuth account with stale enterprise configuration",
      profile: {
        type: "oauth" as const,
        provider: "github-copilot",
        access: "short-lived-copilot-token",
        refresh: "durable-github-token",
        expires: Date.now() + 60_000,
      },
      expectedToken: "durable-github-token",
      expectedDomain: "github.com",
      configuredDomain: "other.ghe.com",
    },
    {
      label: "an enterprise OAuth account with an explicit environment domain",
      profile: {
        type: "oauth" as const,
        provider: "github-copilot",
        access: "short-lived-copilot-token",
        refresh: "durable-github-token",
        expires: Date.now() + 60_000,
        enterpriseUrl: "acme.ghe.com",
      },
      expectedToken: "durable-github-token",
      expectedDomain: "override.ghe.com",
      configuredDomain: "other.ghe.com",
      envDomain: "override.ghe.com",
    },
  ])("uses $label when discovering its live Copilot model catalog", async (testCase) => {
    const agentDir = await createAgentDir();
    writeProfiles(agentDir, {
      "github-copilot:first": {
        type: "token",
        provider: "github-copilot",
        token: "first-token",
      },
      "github-copilot:preferred": testCase.profile,
    });
    mocks.resolveCopilotRuntimeAuth.mockResolvedValueOnce({
      apiKey: "preferred-copilot-token",
      baseUrl: "https://api.githubcopilot.preferred",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          data: [
            {
              id: "gpt-5.4",
              name: "GPT-5.4",
              model_picker_enabled: true,
              policy: { state: "enabled" },
              capabilities: {
                type: "chat",
                limits: { max_context_window_tokens: 200_000, max_output_tokens: 64_000 },
                supports: { streaming: true, tool_calls: true },
              },
            },
          ],
        }),
      ),
    );
    const provider = registerProviderWithPluginConfig({});

    const env = testCase.envDomain ? { COPILOT_GITHUB_DOMAIN: testCase.envDomain } : {};
    const result = await provider.catalog.run({
      config: {
        auth: { order: { "github-copilot": ["github-copilot:preferred"] } },
        ...(testCase.configuredDomain
          ? {
              models: {
                providers: {
                  "github-copilot": {
                    baseUrl: "https://api.githubcopilot.com",
                    models: [],
                    params: { githubDomain: testCase.configuredDomain },
                  },
                },
              },
            }
          : {}),
      },
      agentDir,
      env,
    });

    expect(mocks.resolveCopilotRuntimeAuth).toHaveBeenCalledWith({
      githubToken: testCase.expectedToken,
      env,
      githubDomain: testCase.expectedDomain,
    });
    expect(
      result && "provider" in result ? result.provider.models.map((model) => model.id) : [],
    ).toEqual(["gpt-5.4"]);
  });

  it.each(["GITHUB_TOKEN"])("ignores %s during catalog discovery", async (key) => {
    const provider = registerProviderWithPluginConfig({});
    const agentDir = await createAgentDir();
    const result = await provider.catalog.run({
      config: {},
      agentDir,
      env: { [key]: "generic-token" },
    });
    expect(result).toBeNull();
    expect(mocks.resolveCopilotRuntimeAuth).not.toHaveBeenCalled();
  });

  it("does not exchange auth or discover models for an unavailable direct SecretRef", async () => {
    const agentDir = await createAgentDir();
    const provider = registerProviderWithPluginConfig({});

    await expect(
      provider.catalog.run({
        config: {
          models: {
            providers: {
              "github-copilot": {
                apiKey: {
                  source: "env",
                  provider: "default",
                  id: "OPENCLAW_MISSING_COPILOT_CATALOG_TOKEN",
                },
              },
            },
          },
        },
        agentDir,
        env: { COPILOT_GITHUB_TOKEN: "ambient-token" },
      }),
    ).rejects.toThrow("models.providers.github-copilot.apiKey");

    expect(mocks.resolveCopilotRuntimeAuth).not.toHaveBeenCalled();
    expect(mocks.fetchWithSsrFGuard).not.toHaveBeenCalled();
  });

  it("exposes xhigh and max thinking for the bundled Claude Opus 5 model", () => {
    const provider = registerProviderWithPluginConfig({});
    const model = expectDefined(
      manifest.modelCatalog.providers["github-copilot"].models.find(
        (candidate) => candidate.id === "claude-opus-5",
      ),
      "bundled GitHub Copilot Claude Opus 5 model",
    );

    const profile = provider.resolveThinkingProfile({
      provider: "github-copilot",
      modelId: model.id,
      compat: model.compat,
    });

    expect(profile?.levels.map((level) => level.id)).toEqual(
      expect.arrayContaining(["xhigh", "max"]),
    );
  });

  it("exposes xhigh thinking for non-Claude Copilot models with catalog xhigh effort", () => {
    const provider = registerProviderWithPluginConfig({});
    const profile = provider.resolveThinkingProfile({
      provider: "github-copilot",
      modelId: "gpt-5.4-mini",
      compat: { supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh"] },
    });
    expect(profile?.levels.map((level) => level.id)).toContain("xhigh");
  });

  it("omits xhigh for non-Claude Copilot models whose catalog effort lacks it", () => {
    // Negative half of the #59416 regression: live-first must not over-grant.
    // gpt-5-mini reports only [low, medium, high] live, so xhigh must stay off
    // even though the reporter asked for the whole mini family to gain it.
    const provider = registerProviderWithPluginConfig({});

    const profile = provider.resolveThinkingProfile({
      provider: "github-copilot",
      modelId: "gpt-5-mini",
      compat: { supportedReasoningEfforts: ["low", "medium", "high"] },
    });

    expect(profile?.levels.map((level) => level.id)).not.toContain("xhigh");
  });

  it("publishes only picker-visible, policy-enabled tool models in the live catalog", async () => {
    mocks.resolveCopilotRuntimeAuth.mockResolvedValueOnce({
      apiKey: "catalog-policy-token",
      baseUrl: "https://api.githubcopilot.policy-test",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          data: [
            {
              id: "eligible",
              name: "Eligible",
              model_picker_enabled: true,
              model_picker_category: "versatile",
              policy: { state: "enabled" },
              capabilities: {
                type: "chat",
                limits: { max_context_window_tokens: 200_000, max_output_tokens: 64_000 },
                supports: { streaming: true, tool_calls: true },
              },
            },
            {
              id: "disabled",
              name: "Disabled",
              model_picker_enabled: true,
              policy: { state: "disabled" },
              capabilities: {
                type: "chat",
                supports: { streaming: true, tool_calls: true },
              },
            },
            {
              id: "hidden",
              name: "Hidden",
              model_picker_enabled: false,
              policy: { state: "enabled" },
              capabilities: {
                type: "chat",
                supports: { streaming: true, tool_calls: true },
              },
            },
            {
              id: "chat-only",
              name: "Chat only",
              model_picker_enabled: true,
              policy: { state: "enabled" },
              capabilities: {
                type: "chat",
                supports: { streaming: false, tool_calls: false },
              },
            },
          ],
        }),
      ),
    );
    const provider = registerProviderWithPluginConfig({});

    const result = await provider.catalog.run({
      config: {},
      agentDir: "/tmp/agent",
      env: { COPILOT_GITHUB_TOKEN: "catalog-source-token" },
    } as never);

    expect(
      result && "provider" in result ? result.provider.models.map((model) => model.id) : [],
    ).toEqual(["eligible", "chat-only"]);
  });

  it.each([
    { stage: "user", status: 503, expected: "unavailable" },
    { stage: "models", status: 503, expected: "unavailable" },
  ])(
    "records the catalog attempt at $stage with HTTP $status",
    async ({ stage, status, expected }) => {
      const agentDir = await createAgentDir();
      writeExistingCopilotTokenProfile(agentDir);
      const provider = registerProviderWithPluginConfig({});
      mocks.resolveCopilotRuntimeAuth.mockReset();
      if (stage === "user") {
        mocks.resolveCopilotRuntimeAuth.mockRejectedValue(
          new CopilotRuntimeAuthError({ reason: "http_error", status }),
        );
      } else {
        mocks.resolveCopilotRuntimeAuth.mockResolvedValue({
          apiKey: "catalog-attempt-token",
          baseUrl: `https://api.githubcopilot.attempt-${status}`,
        });
      }
      const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ data: [] }, { status }));
      vi.stubGlobal("fetch", fetchMock);
      const result = await provider.catalog.run({ config: {}, agentDir, env: {} });
      expect(result?.outcomes).toEqual([
        {
          provider: "github-copilot",
          profileId: "github-copilot:github",
          status: expected,
        },
      ]);
      expect(mocks.resolveCopilotRuntimeAuth).toHaveBeenCalledOnce();
      expect(fetchMock).toHaveBeenCalledTimes(stage === "user" ? 0 : 1);
      expect(result && "providers" in result ? result.providers : undefined).toEqual({});
    },
  );

  it.each([true, false])(
    "returns a supplied token with credentialOnly=%s without replacing stored credentials or starting login",
    async (credentialOnly) => {
      const provider = registerProviderWithPluginConfig({});
      const method = requireAuthMethod(provider.auth, 0);
      const agentDir = await createAgentDir();
      writeExistingCopilotTokenProfile(agentDir);
      const before = structuredClone(ensureAuthProfileStore(agentDir));
      const prompter = { confirm: vi.fn(), note: vi.fn(), text: vi.fn() };
      const openUrl = vi.fn();

      const result = await method.run({
        config: {},
        credentialOnly,
        env: {},
        agentDir,
        prompter,
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        opts: { tokenProvider: "github-copilot", token: "supplied-setup-token" },
        isRemote: true,
        openUrl,
        oauth: { createVpsAwareHandlers: vi.fn() },
      });

      expect(result).toMatchObject({
        profiles: [
          {
            profileId: "github-copilot:github",
            credential: {
              type: "token",
              provider: "github-copilot",
              token: "supplied-setup-token",
            },
            secretStorage: { kind: "store", namePrefix: "GITHUB_COPILOT_TOKEN" },
          },
        ],
      });
      if (credentialOnly) {
        expect(result?.defaultModel).toBeUndefined();
      } else {
        expect(result?.defaultModel).toBeTruthy();
      }
      expect(ensureAuthProfileStore(agentDir)).toEqual(before);
      expect(prompter.confirm).not.toHaveBeenCalled();
      expect(prompter.text).not.toHaveBeenCalled();
      expect(openUrl).not.toHaveBeenCalled();
      expect(mocks.resolveCopilotRuntimeAuth).not.toHaveBeenCalled();
      expect(mocks.resolveCopilotStarterModel).not.toHaveBeenCalled();
    },
  );

  it("keeps valid interactive auth when live starter-model discovery is unavailable", async () => {
    mocks.resolveCopilotStarterModel.mockRejectedValueOnce(new Error("catalog unavailable"));
    const provider = registerProviderWithPluginConfig({});
    const method = requireAuthMethod(provider.auth, 0);
    const agentDir = await createAgentDir();
    writeExistingCopilotTokenProfile(agentDir);

    const result = await method.run({
      ...interactiveContext(agentDir),
      prompter: {
        confirm: vi.fn(async () => false),
        note: vi.fn(),
      },
      secretInputMode: "plaintext",
      openUrl: vi.fn(),
    } as never);

    expect(result).toMatchObject({
      profiles: [
        {
          profileId: "github-copilot:github",
          credential: { type: "token", provider: "github-copilot", token: "existing-token" },
        },
      ],
      notes: [expect.stringContaining("authentication succeeded")],
    });
    expect(result?.defaultModel).toBeUndefined();
  });

  describe("github-copilot dynamic model resolution", () => {
    it("uses live catalog metadata for request-time model resolution", async () => {
      const agentDir = await createAgentDir();
      writeProfiles(agentDir, {
        "github-copilot:first": {
          type: "token",
          provider: "github-copilot",
          token: "first",
        },
        "github-copilot:selected": {
          type: "token",
          provider: "github-copilot",
          token: "chosen",
        },
      });
      mocks.resolveCopilotRuntimeAuth
        .mockResolvedValueOnce({
          apiKey: "chosen",
          baseUrl: "https://api.githubcopilot.live",
        })
        .mockResolvedValueOnce({
          apiKey: "first",
          baseUrl: "https://api.githubcopilot.first",
        });
      const catalogResponse = (contextWindow: number, promptTokens: number) =>
        Response.json({
          data: [
            {
              id: "gpt-5.6-sol",
              name: "GPT-5.6 Sol",
              object: "model",
              vendor: "OpenAI",
              capabilities: {
                type: "chat",
                limits: {
                  max_context_window_tokens: contextWindow,
                  max_prompt_tokens: promptTokens,
                  max_output_tokens: 128_000,
                },
                supports: {
                  vision: true,
                  reasoning_effort: ["none", "low", "medium", "high", "xhigh"],
                },
              },
            },
          ],
        });
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce(catalogResponse(1_050_000, 922_000))
          .mockResolvedValueOnce(catalogResponse(400_000, 272_000)),
      );
      const provider = registerProviderWithPluginConfig({});
      const modelRegistry = createModelRegistry();
      const selectedContext = {
        config: {},
        agentDir,
        provider: "github-copilot",
        modelId: "gpt-5.6-sol",
        modelRegistry,
        authProfileId: "github-copilot:selected",
      } as Parameters<typeof provider.prepareDynamicModel>[0];
      const firstContext = {
        ...selectedContext,
        authProfileId: "github-copilot:first",
      };

      await provider.prepareDynamicModel(selectedContext);
      await provider.prepareDynamicModel(firstContext);

      expect(mocks.resolveCopilotRuntimeAuth).toHaveBeenNthCalledWith(1, {
        githubToken: "chosen",
        env: process.env,
        githubDomain: "github.com",
      });
      expect(mocks.resolveCopilotRuntimeAuth).toHaveBeenNthCalledWith(2, {
        githubToken: "first",
        env: process.env,
        githubDomain: "github.com",
      });
      expect(provider.preferRuntimeResolvedModel(selectedContext)).toBe(true);
      expect(provider.resolveDynamicModel(selectedContext)).toMatchObject({
        id: "gpt-5.6-sol",
        provider: "github-copilot",
        baseUrl: "https://api.githubcopilot.live",
        contextWindow: 1_050_000,
        contextTokens: 922_000,
        maxTokens: 128_000,
      });
      expect(provider.resolveDynamicModel(firstContext)).toMatchObject({
        id: "gpt-5.6-sol",
        provider: "github-copilot",
        baseUrl: "https://api.githubcopilot.first",
        contextWindow: 400_000,
        contextTokens: 272_000,
        maxTokens: 128_000,
      });
    });

    it("rematerializes direct-config metadata after a profile fallback", async () => {
      const agentDir = await createAgentDir();
      writeProfiles(agentDir, {
        "github-copilot:first": {
          type: "token",
          provider: "github-copilot",
          token: "test-auth-token",
        },
      });
      mocks.resolveCopilotRuntimeAuth
        .mockResolvedValueOnce({
          apiKey: "test-auth-token",
          baseUrl: "https://api.githubcopilot.profile",
        })
        .mockResolvedValueOnce({
          apiKey: "test-token-placeholder",
          baseUrl: "https://api.githubcopilot.direct",
        });
      const catalogResponse = (contextWindow: number, promptTokens: number) =>
        Response.json({
          data: [
            {
              id: "gpt-5.6-sol",
              name: "GPT-5.6 Sol",
              object: "model",
              vendor: "OpenAI",
              capabilities: {
                type: "chat",
                limits: {
                  max_context_window_tokens: contextWindow,
                  max_prompt_tokens: promptTokens,
                  max_output_tokens: 128_000,
                },
              },
            },
          ],
        });
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce(catalogResponse(200_000, 150_000))
          .mockResolvedValueOnce(catalogResponse(1_050_000, 922_000)),
      );
      const provider = registerProviderWithPluginConfig({});
      const modelRegistry = createModelRegistry();
      const config = {
        models: {
          providers: {
            "github-copilot": {
              apiKey: "test-token-placeholder",
              baseUrl: "https://api.githubcopilot.test",
              models: [],
            },
          },
        },
      } as OpenClawConfig;
      const profileContext = {
        config,
        agentDir,
        provider: "github-copilot",
        modelId: "gpt-5.6-sol",
        modelRegistry,
        authProfileId: "github-copilot:first",
      } as Parameters<typeof provider.prepareDynamicModel>[0];
      const directContext = {
        ...profileContext,
        authProfileId: undefined,
        authProfileMode: "api_key" as const,
      };

      // The first profile's credential can fail later during runtime auth. The
      // prepared direct fallback must then replace its account-scoped limits.
      await provider.prepareDynamicModel(profileContext);
      await provider.prepareDynamicModel(directContext);

      expect(mocks.resolveCopilotRuntimeAuth).toHaveBeenNthCalledWith(1, {
        githubToken: "test-auth-token",
        env: process.env,
        githubDomain: "github.com",
      });
      expect(mocks.resolveCopilotRuntimeAuth).toHaveBeenNthCalledWith(2, {
        githubToken: "test-token-placeholder",
        env: process.env,
        githubDomain: "github.com",
      });
      expect(provider.resolveDynamicModel(profileContext)).toMatchObject({
        baseUrl: "https://api.githubcopilot.profile",
        contextWindow: 200_000,
        contextTokens: 150_000,
      });
      expect(provider.resolveDynamicModel(directContext)).toMatchObject({
        baseUrl: "https://api.githubcopilot.direct",
        contextWindow: 1_050_000,
        contextTokens: 922_000,
      });
    });
  });

  function buildDeviceFlowFetchMock(domain: string, accessToken: string) {
    return vi.fn(async (input: unknown, _init?: RequestInit) => {
      const target =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input instanceof Request
              ? input.url
              : String(input);
      if (target === `https://${domain}/login/device/code`) {
        return Response.json({
          device_code: "device-code-stub",
          user_code: "ABCD-1234",
          verification_uri: `https://${domain}/login/device`,
          expires_in: 900,
          interval: 0,
        });
      }
      if (target === `https://${domain}/login/oauth/access_token`) {
        return Response.json({ access_token: accessToken, token_type: "bearer" });
      }
      throw new Error(`unexpected fetch in github-copilot device flow test: ${target}`);
    });
  }

  it("threads provider authority into the guarded device request", async () => {
    const method = requireAuthMethod(registerProviderWithPluginConfig({}).auth, 0);
    const agentDir = await createAgentDir();
    let current = true;
    const dispatch = vi.fn();
    mocks.fetchWithSsrFGuard.mockImplementation(async (params) => {
      await Promise.resolve();
      current = false;
      params.beforeRequest?.();
      dispatch();
      throw new Error("Request dispatched after authority was revoked");
    });

    await expect(
      method.run({
        config: {},
        credentialOnly: true,
        env: {},
        agentDir,
        prompter: { confirm: vi.fn(), note: vi.fn() },
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        isRemote: true,
        openUrl: vi.fn(),
        oauth: { createVpsAwareHandlers: vi.fn() },
        assertCurrent: () => {
          if (!current) {
            throw new Error("Login revoked");
          }
        },
      }),
    ).rejects.toThrow("Login revoked");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each([
    { methodIndex: 1, domain: "acme.ghe.com", existing: false, credentialOnly: true },
    { methodIndex: 0, domain: "github.com", existing: true, credentialOnly: false },
  ])(
    "starts fresh $domain login with stored=$existing, credentialOnly=$credentialOnly",
    async ({ methodIndex, domain, existing, credentialOnly }) => {
      const method = requireAuthMethod(registerProviderWithPluginConfig({}).auth, methodIndex);
      const agentDir = await createAgentDir();
      if (existing) {
        writeExistingCopilotTokenProfile(agentDir);
      }
      const fetchMock = buildDeviceFlowFetchMock(domain, "connected-token");
      mocks.fetchWithSsrFGuard.mockImplementation(async (params) => ({
        response: await fetchMock(params.url, params.init),
        finalUrl: params.url,
        release: async () => {},
      }));
      const prompter = {
        confirm: vi.fn(async () => {
          throw new Error("Login must not offer unauthorized stored credentials");
        }),
        text: vi.fn(async () => domain),
        note: vi.fn(),
      };
      const result = await runDeviceAuthWithFakeTimers((openUrl) =>
        method.run({
          config: {},
          credentialOnly,
          env: {},
          agentDir,
          prompter,
          runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
          isRemote: true,
          openUrl,
          oauth: { createVpsAwareHandlers: vi.fn() },
        }),
      );

      expect(result?.profiles).toEqual([
        {
          profileId: "github-copilot:github",
          credential: { type: "token", provider: "github-copilot", token: "connected-token" },
          secretStorage: { kind: "store", namePrefix: "GITHUB_COPILOT_TOKEN" },
        },
      ]);
      expect(result?.defaultModel).toBe(
        credentialOnly ? undefined : "github-copilot/claude-sonnet-5",
      );
      expect(mocks.resolveCopilotStarterModel).toHaveBeenCalledTimes(credentialOnly ? 0 : 1);
      expect(result?.configPatch).toEqual(
        methodIndex === 1
          ? { models: { providers: { "github-copilot": { params: { githubDomain: domain } } } } }
          : undefined,
      );
      expect(prompter.confirm).not.toHaveBeenCalled();
      expect(prompter.text).toHaveBeenCalledTimes(methodIndex);
      expect(mocks.resolveCopilotRuntimeAuth).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );

  it("forces re-login and clears the domain when switching from a tenant back to github.com", async () => {
    const method = requireAuthMethod(registerProviderWithPluginConfig({}).auth, 0);
    const agentDir = await createAgentDir();
    writeExistingCopilotTokenProfile(agentDir);
    const fetchMock = buildDeviceFlowFetchMock("github.com", "public-fresh-token");
    vi.stubGlobal("fetch", fetchMock);
    const prompter = {
      confirm: vi.fn(async () => false),
      text: vi.fn(async () => ""),
      note: vi.fn(async (_message: string, _title?: string) => {}),
    };

    const result = await runDeviceAuthWithFakeTimers(
      async (openUrl) =>
        await method.run({
          ...interactiveContext(agentDir),
          config: {
            models: {
              providers: { "github-copilot": { params: { githubDomain: "acme.ghe.com" } } },
            },
          },
          prompter,
          openUrl,
        } as never),
    );
    if (!result) {
      throw new Error("Expected GitHub Copilot auth result");
    }

    // Domain switch must not offer to reuse the tenant-scoped token.
    expect(prompter.confirm).not.toHaveBeenCalled();
    const deviceNote = prompter.note.mock.calls.find(
      ([, title]) => title === "Authorize GitHub Copilot",
    );
    expect(deviceNote).toBeDefined();
    const [message] = expectDefined(deviceNote, "device-code note");
    expect(markdownToIR(message, { linkify: false }).links.map((link) => link.href)).toEqual([
      "https://github.com/login/device",
    ]);
    expect(message).toContain("\nCode: ABCD-1234\n");
    expect(result.profiles[0]?.credential).toEqual({
      type: "token",
      provider: "github-copilot",
      token: "public-fresh-token",
    });
    expect(result.profiles[0]?.secretStorage).toEqual({
      kind: "store",
      namePrefix: "GITHUB_COPILOT_TOKEN",
    });
    const params = (
      result.configPatch as {
        models?: { providers?: Record<string, { params?: Record<string, unknown> }> };
      }
    )?.models?.providers?.["github-copilot"]?.params;
    expect(params && Object.hasOwn(params, "githubDomain")).toBe(true);
    expect(params?.githubDomain).toBeUndefined();
  });

  it("forces re-login when an existing public profile meets an env-only tenant domain", async () => {
    const provider = registerProviderWithPluginConfig({});
    const method = requireAuthMethod(provider.auth, 1);
    const agentDir = await createAgentDir();
    // Stored profile was minted for public github.com; config has no tenant.
    writeExistingCopilotTokenProfile(agentDir);
    // Tenant comes ONLY from the env override. The reuse gate must derive the
    // previous domain from persisted config (github.com), not from the env, so
    // the domain change is detected and the public token is not reused.
    const fetchMock = buildDeviceFlowFetchMock("acme.ghe.com", "tenant-fresh-token");
    vi.stubGlobal("fetch", fetchMock);
    const prompter = {
      confirm: vi.fn(async () => false),
      text: vi.fn(async () => "typed-tenant.ghe.com"),
      note: vi.fn(),
    };

    const result = await runDeviceAuthWithFakeTimers(
      async (openUrl) =>
        await method.run({
          ...interactiveContext(agentDir),
          env: { COPILOT_GITHUB_DOMAIN: "acme.ghe.com" },
          prompter,
          secretInputMode: "plaintext",
          openUrl,
        } as never),
    );
    if (!result) {
      throw new Error("Expected GitHub Copilot auth result");
    }

    // Env is authoritative for the chosen domain, so the interactive prompt is
    // skipped; the stale public token must NOT be reused for the tenant.
    expect(prompter.text).not.toHaveBeenCalled();
    expect(prompter.confirm).not.toHaveBeenCalled();
    expect(result.profiles[0]?.credential).toEqual({
      type: "token",
      provider: "github-copilot",
      token: "tenant-fresh-token",
    });
    const params = (
      result.configPatch as {
        models?: { providers?: Record<string, { params?: Record<string, unknown> }> };
      }
    )?.models?.providers?.["github-copilot"]?.params;
    expect(params?.githubDomain).toBe("acme.ghe.com");
  });

  it("reuses the host-authorized token reference for the same enterprise tenant", async () => {
    const method = requireAuthMethod(registerProviderWithPluginConfig({}).auth, 1);
    const agentDir = await createAgentDir();
    writeExistingCopilotTokenProfile(agentDir);
    const authorizedProfile: ProviderAuthResult["profiles"][number] = {
      profileId: "github-copilot:authorized",
      credential: {
        type: "token",
        provider: "github-copilot",
        tokenRef: { source: "env", provider: "default", id: "AUTHORIZED_COPILOT_TOKEN" },
      },
    };
    const prompter = {
      confirm: vi.fn(async () => false),
      text: vi.fn(async () => "acme.ghe.com"),
      note: vi.fn(),
    };

    const result = await method.run({
      ...interactiveContext(agentDir),
      env: { AUTHORIZED_COPILOT_TOKEN: "authorized-token" },
      existingProfiles: [authorizedProfile],
      config: {
        models: { providers: { "github-copilot": { params: { githubDomain: "acme.ghe.com" } } } },
      },
      prompter,
      secretInputMode: "plaintext",
      openUrl: vi.fn(),
    } as never);
    expect(prompter.confirm).toHaveBeenCalledWith({
      message: "GitHub Copilot auth already exists. Re-run login?",
      initialValue: false,
    });
    expect(result?.profiles).toEqual([authorizedProfile]);
    expect(mocks.resolveCopilotStarterModel).toHaveBeenCalledWith(
      expect.objectContaining({ githubToken: "authorized-token", githubDomain: "acme.ghe.com" }),
    );
    expect(result?.configPatch?.models?.providers?.["github-copilot"]?.params?.githubDomain).toBe(
      "acme.ghe.com",
    );
  });

  it("rejects unsafe GitHub device code lifetimes before polling", async () => {
    const release = vi.fn(async () => {});
    mocks.fetchWithSsrFGuard.mockImplementation(async () => ({
      response: new Response(
        '{"device_code":"device-code-stub","user_code":"ABCD-1234","verification_uri":"https://github.com/login/device","expires_in":1e309,"interval":0}',
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
      finalUrl: "https://github.com/login/device/code",
      release,
    }));

    const showCode = vi.fn();
    await expect(runGitHubCopilotDeviceFlow({ showCode })).rejects.toThrow(
      "GitHub device code response missing fields",
    );
    expect(showCode).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("does not persist a new token when non-interactive starter-model discovery fails", async () => {
    mocks.resolveCopilotStarterModel.mockRejectedValueOnce(new Error("no eligible models"));
    const provider = registerProviderWithPluginConfig({});
    const method = requireAuthMethod(provider.auth, 0);
    const agentDir = await createAgentDir();

    await expect(
      method.runNonInteractive({
        ...nonInteractiveContext(agentDir),
        opts: { githubCopilotToken: "ghu_invalid_for_catalog" },
        runtime: { error: vi.fn(), exit: vi.fn() },
        resolveApiKey: vi.fn(async () => ({
          key: "ghu_invalid_for_catalog",
          source: "flag" as const,
        })),
      }),
    ).rejects.toThrow("no eligible models");

    expect(ensureAuthProfileStore(agentDir).profiles["github-copilot:github"]).toBeUndefined();
  });

  it("persists COPILOT_GITHUB_DOMAIN during non-interactive onboarding", async () => {
    vi.stubEnv("COPILOT_GITHUB_DOMAIN", "acme.ghe.com");
    const provider = registerProviderWithPluginConfig({});
    const method = requireAuthMethod(provider.auth, 0);
    const agentDir = await createAgentDir();
    const runtime = { error: vi.fn(), exit: vi.fn() };

    const result = await method.runNonInteractive({
      ...nonInteractiveContext(agentDir),
      opts: { githubCopilotToken: "ghu_test123" },
      runtime,
      resolveApiKey: vi.fn(async () => ({
        key: "ghu_test123",
        source: "flag" as const,
      })),
    });

    expect(runtime.error).not.toHaveBeenCalled();
    expect(result?.models?.providers?.["github-copilot"]?.params?.githubDomain).toBe(
      "acme.ghe.com",
    );
    expect(result?.auth?.profiles?.["github-copilot:github"]).toEqual({
      provider: "github-copilot",
      mode: "token",
    });

    const profile = ensureAuthProfileStore(agentDir).profiles["github-copilot:github"];
    expect(profile).toEqual({
      type: "token",
      provider: "github-copilot",
      token: "ghu_test123",
    });
  });

  it("clears a persisted enterprise domain during public non-interactive onboarding", async () => {
    vi.stubEnv("COPILOT_GITHUB_DOMAIN", "github.com");
    const provider = registerProviderWithPluginConfig({});
    const method = requireAuthMethod(provider.auth, 0);
    const agentDir = await createAgentDir();
    const runtime = { error: vi.fn(), exit: vi.fn() };

    const result = await method.runNonInteractive({
      ...nonInteractiveContext(agentDir),
      config: {
        models: { providers: { "github-copilot": { params: { githubDomain: "acme.ghe.com" } } } },
      },
      opts: { githubCopilotToken: "ghu_public" },
      runtime,
      resolveApiKey: vi.fn(async () => ({
        key: "ghu_public",
        source: "flag" as const,
      })),
    });

    expect(runtime.error).not.toHaveBeenCalled();
    expect(result?.models?.providers?.["github-copilot"]?.params?.githubDomain).toBeUndefined();
  });

  it("stores env-backed token refs for non-interactive onboarding ref mode", async () => {
    const provider = registerProviderWithPluginConfig({});
    const method = requireAuthMethod(provider.auth, 0);
    const agentDir = await createAgentDir();
    const runtime = { error: vi.fn(), exit: vi.fn() };

    const result = await method.runNonInteractive({
      ...nonInteractiveContext(agentDir),
      config: { agents: { defaults: { model: { fallbacks: ["openai/gpt-5.4"] } } } },
      opts: { secretInputMode: "ref" },
      runtime,
      resolveApiKey: vi.fn(async () => ({
        key: "ghu_from_env",
        source: "env" as const,
        envVarName: "COPILOT_GITHUB_TOKEN",
      })),
    });

    expect(runtime.error).not.toHaveBeenCalled();
    expect(result?.agents?.defaults?.model).toEqual({
      fallbacks: ["openai/gpt-5.4"],
      primary: "github-copilot/claude-sonnet-5",
    });

    const profile = ensureAuthProfileStore(agentDir).profiles["github-copilot:github"];
    expect(profile).toEqual({
      type: "token",
      provider: "github-copilot",
      tokenRef: {
        source: "env",
        provider: "default",
        id: "COPILOT_GITHUB_TOKEN",
      },
    });
  });

  it.each(["GITHUB_TOKEN"])("ignores %s during non-interactive onboarding", async (key) => {
    const provider = registerProviderWithPluginConfig({});
    const method = requireAuthMethod(provider.auth, 0);
    const agentDir = await createAgentDir();
    const runtime = { error: vi.fn(), exit: vi.fn() };
    const pending = method.runNonInteractive({
      authChoice: "github-copilot",
      config: {},
      baseConfig: {},
      opts: {},
      runtime,
      agentDir,
      resolveApiKey: vi.fn(async ({ envVar }: { envVar?: string }) =>
        envVar === key ? { key: "generic-token", source: "env", envVarName: key } : null,
      ),
      toApiKeyCredential: vi.fn(),
    });
    await expect(pending).rejects.toThrow("Missing --github-copilot-token");
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
    expect(ensureAuthProfileStore(agentDir).profiles).toEqual({});
  });

  it("preserves an existing primary model during non-interactive onboarding", async () => {
    mocks.resolveCopilotRuntimeAuth.mockResolvedValueOnce({
      apiKey: "ghu_test",
      baseUrl: "https://api.individual.githubcopilot.com",
    });
    const provider = registerProviderWithPluginConfig({});
    const method = requireAuthMethod(provider.auth, 0);
    const agentDir = await createAgentDir();
    const runtime = { error: vi.fn(), exit: vi.fn() };

    const result = await method.runNonInteractive({
      ...nonInteractiveContext(agentDir),
      config: {
        agents: {
          defaults: {
            model: {
              primary: "github-copilot/gpt-5.4",
              fallbacks: ["openai/gpt-5.4"],
            },
            models: {
              "github-copilot/gpt-5.4": { label: "Existing" },
            },
          },
        },
      },
      opts: { githubCopilotToken: "ghu_test" },
      runtime,
      resolveApiKey: vi.fn(async () => ({
        key: "ghu_test",
        source: "flag" as const,
      })),
    });

    expect(runtime.error).not.toHaveBeenCalled();
    expect(result?.agents?.defaults?.model).toEqual({
      primary: "github-copilot/gpt-5.4",
      fallbacks: ["openai/gpt-5.4"],
    });
    expect(result?.agents?.defaults?.models).toEqual({
      "github-copilot/gpt-5.4": { label: "Existing" },
    });
    expect(mocks.resolveCopilotStarterModel).not.toHaveBeenCalled();
    expect(mocks.resolveCopilotRuntimeAuth).toHaveBeenCalledWith({
      githubToken: "ghu_test",
      env: process.env,
      githubDomain: "github.com",
      config: {
        agents: {
          defaults: {
            model: {
              primary: "github-copilot/gpt-5.4",
              fallbacks: ["openai/gpt-5.4"],
            },
            models: {
              "github-copilot/gpt-5.4": { label: "Existing" },
            },
          },
        },
      },
    });
  });

  it("does not overwrite stored auth when a fresh token fails explicit-model validation", async () => {
    mocks.resolveCopilotRuntimeAuth.mockRejectedValueOnce(new Error("invalid credential"));
    const provider = registerProviderWithPluginConfig({});
    const method = requireAuthMethod(provider.auth, 0);
    const agentDir = await createAgentDir();
    writeExistingCopilotTokenProfile(agentDir);

    await expect(
      method.runNonInteractive({
        ...nonInteractiveContext(agentDir),
        config: { agents: { defaults: { model: { primary: "github-copilot/gpt-5.4" } } } },
        opts: { githubCopilotToken: "fresh-invalid-token" },
        runtime: { error: vi.fn(), exit: vi.fn() },
        resolveApiKey: vi.fn(async () => ({
          key: "fresh-invalid-token",
          source: "flag" as const,
        })),
      }),
    ).rejects.toThrow("invalid credential");

    expect(ensureAuthProfileStore(agentDir).profiles["github-copilot:github"]).toMatchObject({
      token: "existing-token",
    });
  });

  it("reuses an existing token profile during non-interactive onboarding", async () => {
    const provider = registerProviderWithPluginConfig({});
    const method = requireAuthMethod(provider.auth, 0);
    const agentDir = await createAgentDir();
    const runtime = { error: vi.fn(), exit: vi.fn() };
    writeExistingCopilotTokenProfile(agentDir);

    const result = await method.runNonInteractive({
      ...nonInteractiveContext(agentDir),
      runtime,
      resolveApiKey: vi.fn(async () => null),
    });

    expect(runtime.error).not.toHaveBeenCalled();
    expect(result?.auth?.profiles?.["github-copilot:github"]).toEqual({
      provider: "github-copilot",
      mode: "token",
    });
  });

  it.each([
    {
      name: "a flag without a matching environment credential",
      resolveApiKey: async () => null,
      error:
        "--github-copilot-token cannot be used with --secret-input-mode ref unless COPILOT_GITHUB_TOKEN is set in env. Set COPILOT_GITHUB_TOKEN and omit --github-copilot-token, or use --secret-input-mode plaintext.",
    },
    {
      name: "an environment credential without its reference name",
      resolveApiKey: async () => ({
        key: ["synthetic", "credential"].join("-"),
        source: "env" as const,
      }),
      error:
        '--secret-input-mode ref requires an explicit environment variable for provider "github-copilot".',
    },
  ])(
    "propagates ref-mode validation for $name before persisting auth",
    async ({ resolveApiKey, error }) => {
      const provider = registerProviderWithPluginConfig({});
      const method = requireAuthMethod(provider.auth, 0);
      const agentDir = await createAgentDir();
      const runtime = { error: vi.fn(), exit: vi.fn() };

      await expect(
        method.runNonInteractive({
          ...nonInteractiveContext(agentDir),
          opts: {
            githubCopilotToken: ["synthetic", "credential"].join("-"),
            secretInputMode: "ref",
          },
          runtime,
          resolveApiKey: vi.fn(resolveApiKey),
        }),
      ).rejects.toThrow(error);
      expect(runtime.error).not.toHaveBeenCalled();
      expect(runtime.exit).not.toHaveBeenCalled();
      expect(ensureAuthProfileStore(agentDir).profiles).toEqual({});
    },
  );
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
