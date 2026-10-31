import { afterEach, describe, expect, it, vi } from "vitest";
import { makeEmptyPluginMetadataOwners } from "../plugins/plugin-metadata-empty.test-support.js";

const providerEndpointPlugins = vi.hoisted(() => [
  {
    // Mirrors manifest-declared endpoint metadata without loading real plugins.
    providerEndpoints: [
      {
        endpointClass: "openai-public",
        hosts: ["api.openai.com"],
        hostSuffixes: [".api.openai.com"],
      },
      { endpointClass: "openai", hosts: ["chatgpt.com"] },
      { endpointClass: "anthropic-public", hosts: ["api.anthropic.com"] },
      { endpointClass: "mistral-public", hosts: ["api.mistral.ai"] },
      { endpointClass: "github-copilot-native", hostSuffixes: [".githubcopilot.com"] },
      {
        endpointClass: "opencode-native",
        baseUrls: ["https://opencode.ai/zen", "https://opencode.ai/zen/v1"],
      },
      {
        endpointClass: "opencode-go-native",
        baseUrls: ["https://opencode.ai/zen/go", "https://opencode.ai/zen/go/v1"],
      },
      { endpointClass: "openrouter", hostSuffixes: ["openrouter.ai"] },
      { endpointClass: "vercel-ai-gateway", hosts: ["ai-gateway.vercel.sh"] },
      { endpointClass: "google-generative-ai", hosts: ["generativelanguage.googleapis.com"] },
      {
        endpointClass: "google-vertex",
        hosts: ["aiplatform.googleapis.com"],
        googleVertexRegion: "global",
      },
      {
        endpointClass: "google-vertex",
        hosts: ["aiplatform.eu.rep.googleapis.com"],
        googleVertexRegion: "eu",
      },
      {
        endpointClass: "google-vertex",
        hosts: ["aiplatform.us.rep.googleapis.com"],
        googleVertexRegion: "us",
      },
      {
        endpointClass: "google-vertex",
        hostSuffixes: ["-aiplatform.googleapis.com"],
        googleVertexRegionHostSuffix: "-aiplatform.googleapis.com",
      },
      {
        endpointClass: "moonshot-native",
        baseUrls: ["https://api.moonshot.ai/v1", "https://api.moonshot.cn/v1"],
      },
      {
        endpointClass: "modelstudio-native",
        baseUrls: [
          "https://coding-intl.dashscope.aliyuncs.com/v1",
          "https://coding.dashscope.aliyuncs.com/v1",
          "https://dashscope.aliyuncs.com/compatible-mode/v1",
          "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
        ],
      },
      { endpointClass: "xai-native", hosts: ["api.x.ai"] },
    ],
    providerRequest: {
      providers: {
        anthropic: { family: "anthropic" },
        "github-copilot": { family: "github-copilot" },
        google: { family: "google" },
        mistral: { family: "mistral" },
        moonshot: { family: "moonshot", compatibilityFamily: "moonshot" },
        openrouter: { family: "openrouter" },
        qwen: { family: "modelstudio" },
        xai: { family: "xai" },
      },
    },
  },
]);

const providerMetadataState = vi.hoisted(() => ({
  defaultDiscoveryCompatible: true,
  pluginIdScoped: false,
  snapshot: undefined as unknown,
}));
const loadPluginMetadataSnapshot = vi.hoisted(() =>
  vi.fn(() => ({
    owners: {
      providerEndpoints: [],
      providerRequests: new Map(),
    },
  })),
);

vi.mock("../plugins/plugin-metadata-snapshot-required.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/plugin-metadata-snapshot-required.js")>()),
  loadPluginMetadataSnapshotRuntime: loadPluginMetadataSnapshot,
  getCurrentPluginMetadataSnapshotRequiredRuntime: (params?: {
    allowScopedSnapshot?: boolean;
    requireDefaultDiscoveryContext?: boolean;
  }) =>
    (providerMetadataState.pluginIdScoped && params?.allowScopedSnapshot !== true) ||
    (params?.requireDefaultDiscoveryContext === true &&
      !providerMetadataState.defaultDiscoveryCompatible)
      ? undefined
      : (providerMetadataState.snapshot ?? {
          owners: {
            providerEndpoints: providerEndpointPlugins.flatMap((manifest) =>
              (manifest.providerEndpoints ?? []).map((endpoint) =>
                Object.assign({}, endpoint, {
                  hosts: endpoint.hosts ?? [],
                  hostSuffixes: endpoint.hostSuffixes ?? [],
                  baseUrls: (endpoint.baseUrls ?? []).map((baseUrl) =>
                    baseUrl.toLowerCase().replace(/\/+$/, ""),
                  ),
                }),
              ),
            ),
            providerRequests: new Map(
              providerEndpointPlugins.flatMap((manifest) =>
                Object.entries(manifest.providerRequest?.providers ?? {}),
              ),
            ),
          },
        }),
}));

import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import {
  resolveProviderEndpoint,
  resolveProviderFastModeRequestCapabilities,
  resolveProviderRequestCapabilities,
  resolveProviderRequestPolicy,
} from "./provider-attribution.js";

function requestPolicy(input: Parameters<typeof resolveProviderRequestPolicy>[0]) {
  return resolveProviderRequestPolicy(
    { api: "openai-responses", transport: "stream", capability: "llm", ...input },
    { OPENCLAW_VERSION: "2026.3.22" },
  );
}

function requestCapabilities(input: Parameters<typeof resolveProviderRequestCapabilities>[0]) {
  return resolveProviderRequestCapabilities({ capability: "llm", transport: "stream", ...input });
}

function expectPolicy(
  input: Parameters<typeof requestPolicy>[0],
  expected: Record<string, unknown>,
) {
  expect(requestPolicy(input)).toMatchObject(expected);
}

function reloadSnapshot(endpointClass: string, family: string) {
  return {
    owners: {
      providerEndpoints: [
        { endpointClass, hosts: ["reload.example.com"], hostSuffixes: [], baseUrls: [] },
      ],
      providerRequests: new Map([["reload", { family }]]),
    },
  };
}

describe("provider attribution", () => {
  afterEach(() => {
    providerMetadataState.defaultDiscoveryCompatible = true;
    providerMetadataState.pluginIdScoped = false;
    providerMetadataState.snapshot = undefined;
    loadPluginMetadataSnapshot.mockClear();
    clearPluginMetadataLifecycleCaches();
  });

  it("uses provider facts from the replacement plugin snapshot after reload", () => {
    providerMetadataState.snapshot = reloadSnapshot("openai-public", "before-reload");
    expect(resolveProviderEndpoint("https://reload.example.com").endpointClass).toBe(
      "openai-public",
    );
    expect(resolveProviderRequestPolicy({ provider: "reload" }).knownProviderFamily).toBe(
      "before-reload",
    );

    providerMetadataState.snapshot = reloadSnapshot("anthropic-public", "after-reload");

    expect(resolveProviderEndpoint("https://reload.example.com").endpointClass).toBe(
      "anthropic-public",
    );
    expect(resolveProviderRequestPolicy({ provider: "reload" }).knownProviderFamily).toBe(
      "after-reload",
    );
  });

  it("resolves fallback provider facts in each operation's metadata generation", () => {
    providerMetadataState.pluginIdScoped = true;
    providerMetadataState.snapshot = undefined;
    try {
      for (const family of ["before-refresh", "after-refresh"]) {
        loadPluginMetadataSnapshot.mockReturnValue({
          owners: {
            providerEndpoints: [],
            providerRequests: new Map([["fallback-provider", { family }]]),
          },
        });
        expect(
          withPluginCache(
            createPluginCache(),
            () =>
              resolveProviderRequestPolicy({ provider: "fallback-provider" }).knownProviderFamily,
          ),
        ).toBe(family);
      }
    } finally {
      loadPluginMetadataSnapshot.mockReturnValue({
        owners: { providerEndpoints: [], providerRequests: new Map() },
      });
    }
  });

  it("uses explicitly prepared provider facts without reading process metadata", () => {
    providerMetadataState.pluginIdScoped = true;
    providerMetadataState.snapshot = undefined;
    const providerMetadataOwners = {
      ...makeEmptyPluginMetadataOwners(),
      providerEndpoints: [
        {
          endpointClass: "anthropic-public" as const,
          hosts: ["prepared.example"],
          hostSuffixes: [],
          baseUrls: [],
        },
      ],
      providerRequests: new Map([["prepared", { family: "prepared-family" }]]),
    };

    expect(
      resolveProviderRequestPolicy({
        provider: "prepared",
        baseUrl: "https://prepared.example",
        providerMetadataOwners,
      }),
    ).toMatchObject({
      endpointClass: "anthropic-public",
      knownProviderFamily: "prepared-family",
    });
    expect(loadPluginMetadataSnapshot).not.toHaveBeenCalled();
  });

  it.each([
    [
      "opencode-go",
      "https://opencode.ai/zen/go/v1",
      "opencode-go-native",
      "https://opencode.ai/zen/v1",
    ],
    ["opencode", "https://opencode.ai/zen/v1", "opencode-native", "https://opencode.ai/zen/go/v1"],
  ])(
    "identifies OpenClaw only on %s native routes",
    (provider, baseUrl, endpointClass, otherUrl) => {
      const nativeGo = requestPolicy({
        provider,
        api: "openai-completions",
        baseUrl,
      });

      expect(nativeGo).toMatchObject({
        endpointClass,
        attributionProvider: provider,
        allowsHiddenAttribution: false,
      });
      expect(nativeGo.attributionHeaders).toEqual({ "User-Agent": "openclaw/2026.3.22" });

      expect(
        requestPolicy({
          provider,
          api: "openai-completions",
          baseUrl: "https://proxy.example.com/v1",
        }).attributionHeaders,
      ).toBeUndefined();
      expectPolicy(
        { provider, api: "openai-completions", baseUrl: otherUrl },
        { attributionProvider: undefined, attributionHeaders: undefined },
      );
    },
  );

  it("authorizes hidden xAI attribution on api.x.ai and the default xAI route", () => {
    const native = requestPolicy({ provider: "xai", baseUrl: "https://api.x.ai/v1" });
    expect(native).toMatchObject({
      endpointClass: "xai-native",
      attributionProvider: "xai",
      allowsHiddenAttribution: true,
    });
    expect(native.attributionHeaders).toEqual({
      originator: "openclaw",
      version: "2026.3.22",
      "User-Agent": "openclaw/2026.3.22",
    });

    expectPolicy({ provider: "xai" }, { endpointClass: "default", attributionProvider: "xai" });

    // Custom proxy baseUrl should withhold xAI attribution.
    expectPolicy(
      { provider: "xai", baseUrl: "https://proxy.example.com/v1" },
      {
        endpointClass: "custom",
        attributionProvider: undefined,
        allowsHiddenAttribution: false,
      },
    );
  });

  it("classifies native Mistral hosts centrally", () => {
    expect(resolveProviderEndpoint("https://api.mistral.ai/v1")).toMatchObject({
      endpointClass: "mistral-public",
      hostname: "api.mistral.ai",
    });

    expect(
      requestCapabilities({
        provider: "mistral",
        api: "openai-completions",
        baseUrl: "https://api.mistral.ai/v1",
      }),
    ).toMatchObject({
      endpointClass: "mistral-public",
      isKnownNativeEndpoint: true,
      knownProviderFamily: "mistral",
    });
  });

  it("classifies OpenRouter as an explicitly proxied attribution endpoint", () => {
    expectPolicy(
      { provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" },
      {
        endpointClass: "openrouter",
        usesExplicitProxyLikeEndpoint: true,
        attributionProvider: "openrouter",
        allowsHiddenAttribution: false,
      },
    );
  });

  it.each<{
    input: Parameters<typeof requestPolicy>[0];
    headers?: Record<string, string>;
  }>([
    {
      input: { provider: "or", api: "openai-completions", baseUrl: "https://openrouter.ai/api/v1" },
      headers: {
        "HTTP-Referer": "https://openclaw.ai",
        "X-OpenRouter-Title": "OpenClaw",
        "X-OpenRouter-Categories": "personal-agent,cli-agent",
      },
    },
    { input: { provider: "openrouter", baseUrl: "https://proxy.example.com/v1" } },
    {
      input: {
        provider: "my-gateway",
        api: "anthropic-messages",
        baseUrl: "https://ai-gateway.vercel.sh",
      },
      headers: { "HTTP-Referer": "https://openclaw.ai", "X-Title": "OpenClaw" },
    },
    {
      input: {
        provider: "vercel-ai-gateway",
        api: "anthropic-messages",
        baseUrl: "https://proxy.example.com",
      },
    },
    {
      input: { provider: "perplexity", transport: "http", capability: "other" },
      headers: { "X-Pplx-Integration": "openclaw/2026.3.22" },
    },
    {
      input: {
        provider: "perplexity",
        transport: "http",
        capability: "other",
        baseUrl: "https://proxy.example.com/v1",
      },
    },
  ])("gates documented attribution for $input.provider at $input.baseUrl", ({ input, headers }) => {
    expect(requestPolicy(input).attributionHeaders).toEqual(headers);
  });

  it("classifies Google Gemini and Vertex endpoints separately from custom hosts", () => {
    const cases = [
      ["generativelanguage.googleapis.com", "google-generative-ai"],
      [
        "europe-west4-aiplatform.googleapis.com",
        "google-vertex",
        "europe-west4",
        "/v1/projects/test",
      ],
      ["aiplatform.googleapis.com", "google-vertex", "global"],
      ["aiplatform.eu.rep.googleapis.com", "google-vertex", "eu"],
      ["aiplatform.us.rep.googleapis.com", "google-vertex", "us"],
      ["discoveryengine.eu.rep.googleapis.com", "custom"],
      ["proxy.example.com", "custom", undefined, "/google"],
    ];
    for (const [hostname, endpointClass, googleVertexRegion, path = ""] of cases) {
      expect(resolveProviderEndpoint("https://" + hostname + path)).toMatchObject({
        endpointClass,
        hostname,
        ...(googleVertexRegion ? { googleVertexRegion } : {}),
      });
    }
  });

  it("does not trust schemeless or embedded trusted-provider substrings", () => {
    for (const [url, hostname] of [
      ["api.anthropic.com.attacker.example", "api.anthropic.com.attacker.example"],
      ["api.openai.com.attacker.example", "api.openai.com.attacker.example"],
      ["https://attackerapi.openai.com", "attackerapi.openai.com"],
      ["attacker.example/?target=api.openai.com", "attacker.example"],
      ["openrouter.ai.attacker.example", "openrouter.ai.attacker.example"],
    ]) {
      expect(resolveProviderEndpoint(url)).toMatchObject({ endpointClass: "custom", hostname });
    }
  });

  it.each([
    ["anthropic", "anthropic-messages", undefined, "default", true],
    [" ANTHROPIC ", " ANTHROPIC-MESSAGES ", "https://api.anthropic.com", "anthropic-public", true],
    ["anthropic", "anthropic-messages", "https://proxy.example.test", "custom", false],
    ["anthropic", "openai-completions", undefined, "default", false],
    ["custom", "anthropic-messages", "https://api.anthropic.com", "anthropic-public", false],
  ] as const)(
    "resolves catalog service-tier facts for %s / %s / %s",
    (provider, api, baseUrl, endpointClass, allowsAnthropicServiceTier) => {
      const input = { provider, api, baseUrl };
      const expected = { endpointClass, allowsAnthropicServiceTier };
      expect(resolveProviderFastModeRequestCapabilities(input)).toEqual(expected);
      expect(resolveProviderRequestCapabilities(input)).toMatchObject(expected);
    },
  );

  it("respects compat.supportsPromptCacheKey override on prompt cache stripping", () => {
    expect(
      requestCapabilities({
        provider: "custom-proxy",
        api: "openai-responses",
        baseUrl: "https://proxy.example.com/v1",
        compat: { supportsPromptCacheKey: true },
      }),
    ).toMatchObject({
      endpointClass: "custom",
      shouldStripResponsesPromptCache: false,
    });

    expect(
      requestCapabilities({
        provider: "openai",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        compat: { supportsPromptCacheKey: false },
      }),
    ).toMatchObject({
      endpointClass: "openai-public",
      shouldStripResponsesPromptCache: true,
    });

    expect(
      requestCapabilities({
        provider: "custom-proxy",
        api: "openai-responses",
        baseUrl: "https://proxy.example.com/v1",
      }),
    ).toMatchObject({
      shouldStripResponsesPromptCache: true,
    });
  });

  it("resolves a provider capability matrix for representative native and proxied routes", () => {
    const route = (
      provider: string,
      api: string,
      baseUrl: string,
      expected: Record<string, unknown>,
    ) => ({
      input: { provider, api, baseUrl },
      expected: {
        allowsOpenAIServiceTier: false,
        supportsOpenAIReasoningCompatPayload: false,
        allowsResponsesStore: false,
        allowsAnthropicServiceTier: false,
        supportsNativeStreamingUsageCompat: false,
        isKnownNativeEndpoint: true,
        supportsResponsesStoreField: false,
        shouldStripResponsesPromptCache: false,
        ...expected,
      },
    });
    const cases = [
      route("openai", "openai-responses", "https://api.openai.com/v1", {
        allowsOpenAIServiceTier: true,
        supportsOpenAIReasoningCompatPayload: true,
        allowsResponsesStore: true,
        knownProviderFamily: "openai-family",
        endpointClass: "openai-public",
        supportsResponsesStoreField: true,
      }),
      route("openai", "openai-responses", "https://proxy.example.com/v1", {
        knownProviderFamily: "openai-family",
        endpointClass: "custom",
        isKnownNativeEndpoint: false,
        supportsResponsesStoreField: true,
        shouldStripResponsesPromptCache: true,
      }),
      route("anthropic", "anthropic-messages", "https://api.anthropic.com/v1", {
        allowsAnthropicServiceTier: true,
        knownProviderFamily: "anthropic",
        endpointClass: "anthropic-public",
      }),
      route("custom-anthropic", "anthropic-messages", "https://proxy.example.com/anthropic", {
        endpointClass: "custom",
        isKnownNativeEndpoint: false,
      }),
      route("openrouter", "openai-responses", "https://openrouter.ai/api/v1", {
        knownProviderFamily: "openrouter",
        endpointClass: "openrouter",
        supportsResponsesStoreField: true,
        shouldStripResponsesPromptCache: true,
      }),
      route("moonshot", "openai-completions", "https://api.moonshot.ai/v1", {
        supportsNativeStreamingUsageCompat: true,
        knownProviderFamily: "moonshot",
        endpointClass: "moonshot-native",
        compatibilityFamily: "moonshot",
      }),
      route(
        "qwen",
        "openai-completions",
        "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
        {
          supportsNativeStreamingUsageCompat: true,
          knownProviderFamily: "modelstudio",
          endpointClass: "modelstudio-native",
        },
      ),
      route("generic", "openai-completions", "https://coding-intl.dashscope.aliyuncs.com/v1", {
        supportsNativeStreamingUsageCompat: true,
        knownProviderFamily: "generic",
        endpointClass: "modelstudio-native",
      }),
      route("google", "google-generative-ai", "https://generativelanguage.googleapis.com", {
        knownProviderFamily: "google",
        endpointClass: "google-generative-ai",
      }),
      route("github-copilot", "openai-responses", "https://api.individual.githubcopilot.com", {
        knownProviderFamily: "github-copilot",
        endpointClass: "github-copilot-native",
        supportsResponsesStoreField: true,
        shouldStripResponsesPromptCache: true,
      }),
      route("openai", "openai-chatgpt-responses", "https://chatgpt.com/backend-api/codex", {
        allowsOpenAIServiceTier: true,
        supportsOpenAIReasoningCompatPayload: true,
        allowsResponsesStore: true,
        knownProviderFamily: "openai-family",
        endpointClass: "openai",
        supportsResponsesStoreField: true,
      }),
    ];

    for (const testCase of cases) {
      expect(requestCapabilities(testCase.input)).toMatchObject(testCase.expected);
    }
  });
});
