import { describe, expect, it } from "vitest";
import type { ConfiguredProviderRequest } from "../config/types.provider-request.js";
import type { SecretRef } from "../config/types.secrets.js";
import type { PluginMetadataSnapshotOwnerMaps } from "../plugins/plugin-metadata-snapshot.types.js";
import {
  attachProviderAuthAuthority,
  assertProviderAuthAuthority,
} from "../plugins/provider-auth-authority.js";
import { resolveProviderTransportSsrFPolicy } from "./provider-network-policy.js";
import {
  applyPreparedRuntimeAuthToModel,
  attachModelProviderRequestRouteFacts,
  attachModelProviderRequestTransport,
  getModelProviderRequestTransport,
  buildProviderRequestDispatcherPolicy,
  getModelProviderRequestRouteFacts,
  inheritModelProviderRequestRouteFacts,
  mergeModelProviderRequestOverrides,
  resolveProviderRequestPolicyConfig,
  resolveProviderRequestConfig,
  resolveProviderRequestHeaders,
  sanitizeConfiguredModelProviderRequest,
  sanitizeConfiguredProviderRequest,
} from "./provider-request-config.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";

function buildProviderMetadataOwners(
  endpoints: NonNullable<PluginMetadataSnapshotOwnerMaps["providerEndpoints"]> = [],
  requests: NonNullable<PluginMetadataSnapshotOwnerMaps["providerRequests"]> = new Map(),
): PluginMetadataSnapshotOwnerMaps {
  const empty = new Map<string, readonly string[]>();
  return {
    channels: empty,
    channelConfigs: empty,
    providers: empty,
    modelCatalogProviders: empty,
    cliBackends: empty,
    setupProviders: empty,
    commandAliases: empty,
    contracts: empty,
    providerAuthContributions: [],
    modelIdNormalizationPolicies: new Map(),
    providerEndpoints: endpoints,
    providerRequests: requests,
  };
}

const requestConfig = (overrides: Partial<Parameters<typeof resolveProviderRequestConfig>[0]>) =>
  resolveProviderRequestConfig({
    provider: "custom-openai",
    baseUrl: "https://proxy.example.com/v1",
    ...overrides,
  });
const streaming = { capability: "llm", transport: "stream" } as const;
const clientTls = { cert: "client-cert", key: "client-key", serverName: "gateway.internal" };
const proxy = {
  mode: "explicit-proxy",
  url: "http://proxy.internal:8443",
  tls: { ca: "proxy-ca" },
} as const;

describe("provider request config", () => {
  it("carries lifecycle plugin metadata ownership through model projections", () => {
    const owners = buildProviderMetadataOwners(
      [],
      new Map([["prepared", { family: "prepared-family" }]]),
    );
    const prepared = attachModelProviderRequestRouteFacts(
      makeProviderModelFixture<"openai-completions">({
        provider: "prepared",
        api: "openai-completions",
        baseUrl: "https://prepared.example/v1",
        id: "prepared-model",
      }),
      owners,
    );
    const projected = inheritModelProviderRequestRouteFacts(prepared, {
      ...prepared,
      id: "projected-model",
    });

    expect(getModelProviderRequestRouteFacts(prepared)?.providerMetadataOwners).toBe(owners);
    expect(getModelProviderRequestRouteFacts(projected)?.providerMetadataOwners).toBe(owners);
    expect(getModelProviderRequestRouteFacts(projected)?.capabilities.knownProviderFamily).toBe(
      "prepared-family",
    );
  });

  it("applies prepared runtime auth without retaining stale credential headers", () => {
    const model = {
      provider: "microsoft-foundry",
      api: "anthropic-messages" as const,
      baseUrl: "https://example.services.ai.azure.com/anthropic",
      headers: { "X-Tenant": "tenant-a", "x-api-key": "old-key" },
    };

    const bearerModel = applyPreparedRuntimeAuthToModel(model, {
      request: { auth: { mode: "authorization-bearer", token: "entra-token" } },
    });
    expect(bearerModel.headers).toEqual({
      "X-Tenant": "tenant-a",
      Authorization: "Bearer entra-token",
    });

    const apiKeyModel = applyPreparedRuntimeAuthToModel(bearerModel, {
      request: {
        auth: { mode: "header", headerName: "x-api-key", value: "profile-key" },
      },
    });
    expect(apiKeyModel.headers).toEqual({ "X-Tenant": "tenant-a", "x-api-key": "profile-key" });
  });

  it("keeps exchanged request auth aligned with visible headers and authored network policy", () => {
    const model = attachModelProviderRequestTransport(
      {
        provider: "fixture",
        api: "openai-responses" as const,
        baseUrl: "https://fixture.invalid/v1",
        headers: { "x-api-key": "old-key", "x-tenant": "tenant" },
      },
      {
        headers: { "x-api-key": "old-key" },
        auth: { mode: "authorization-bearer", token: "old-token" },
        proxy: { mode: "env-proxy" },
        tls: { ca: "fixture-ca" },
        allowPrivateNetwork: false,
      },
    );
    let credentialCurrent = true;
    const retired = new Error("synthetic credential owner retired");
    const prepared = applyPreparedRuntimeAuthToModel(
      model,
      attachProviderAuthAuthority(
        {
          request: {
            headers: { "x-entitlement": "entitled" },
            auth: { mode: "header" as const, headerName: "x-session", value: "new-token" },
          },
        },
        () => {
          if (!credentialCurrent) {
            throw retired;
          }
        },
      ),
    );
    const request = getModelProviderRequestTransport(prepared);
    expect(request).toMatchObject({
      auth: { mode: "header", headerName: "x-session", value: "new-token" },
      proxy: { mode: "env-proxy" },
      tls: { ca: "fixture-ca" },
      allowPrivateNetwork: false,
    });
    expect(request?.headers).toEqual(prepared.headers);
    expect(request?.headers).toEqual({
      "x-tenant": "tenant",
      "x-entitlement": "entitled",
      "x-session": "new-token",
    });
    assertProviderAuthAuthority(prepared);
    credentialCurrent = false;
    expect(() => assertProviderAuthAuthority(prepared)).toThrow(retired);
  });

  it("merges discovered, provider, and model headers in precedence order", () => {
    const resolved = requestConfig({
      api: "openai-responses",
      discoveredHeaders: { "X-Discovered": "1", "X-Shared": "discovered" },
      providerHeaders: { "X-Provider": "2", "X-Shared": "provider" },
      modelHeaders: { "X-Model": "3", "X-Shared": "model" },
      ...streaming,
    });

    expect(resolved.headers).toEqual({
      "X-Discovered": "1",
      "X-Provider": "2",
      "X-Model": "3",
      "X-Shared": "model",
    });
  });

  it("surfaces authHeader intent without mutating headers yet", () => {
    const resolved = resolveProviderRequestConfig({
      provider: "google",
      api: "google-generative-ai",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      authHeader: true,
      ...streaming,
    });

    expect(resolved.auth).toEqual({
      configured: false,
      mode: "authorization-bearer",
    });
    expect(resolved.headers).toBeUndefined();
  });

  it("drops legacy Authorization when a custom auth header override is configured", () => {
    const resolved = requestConfig({
      api: "openai-responses",
      providerHeaders: { Authorization: "Bearer stale-token", "X-Tenant": "acme" },
      request: { auth: { mode: "header", headerName: "api-key", value: "secret" } },
      ...streaming,
    });

    expect(resolved.headers).toEqual({ "X-Tenant": "acme", "api-key": "secret" });
  });

  it("builds explicit proxy dispatcher policy from normalized transport config", () => {
    const resolved = requestConfig({
      request: {
        proxy,
        tls: { cert: "client-cert", key: "client-key" },
      },
    });

    expect(buildProviderRequestDispatcherPolicy(resolved)).toEqual({
      mode: "explicit-proxy",
      proxyUrl: "http://proxy.internal:8443",
      proxyTls: { ca: "proxy-ca" },
    });
  });

  it("does not copy target TLS into env proxy TLS", () => {
    const resolved = requestConfig({
      request: {
        proxy: { mode: "env-proxy" },
        tls: clientTls,
      },
    });

    expect(buildProviderRequestDispatcherPolicy(resolved)).toEqual({
      mode: "env-proxy",
      connect: { cert: "client-cert", key: "client-key", servername: "gateway.internal" },
    });
  });

  it("rejects insecure TLS transport overrides", () => {
    expect(() => requestConfig({ request: { tls: { insecureSkipVerify: true } } })).toThrow(
      /insecureskipverify/i,
    );
  });

  it("rejects proxy and tls runtime auth overrides", () => {
    expect(() =>
      applyPreparedRuntimeAuthToModel(
        { provider: "custom-openai" },
        {
          request: { proxy: { mode: "explicit-proxy", url: "http://proxy.internal:8443" } },
        },
      ),
    ).toThrow(/runtime auth request overrides do not allow proxy or tls/i);
  });

  it.each<NonNullable<ConfiguredProviderRequest["auth"]>>([
    { mode: "authorization-bearer", token: "" },
    { mode: "authorization-bearer", token: "   " },
    { mode: "header", headerName: "X-Server-Key", value: "" },
  ])("rejects empty explicitly selected auth instead of silently dropping it: %j", (auth) => {
    expect(() => sanitizeConfiguredModelProviderRequest({ auth })).toThrow(/request.auth/);
  });

  it("sanitizes configured request overrides into runtime transport overrides", () => {
    const configured: ConfiguredProviderRequest = {
      headers: { "X-Tenant": "acme" },
      auth: { mode: "authorization-bearer", token: "secret" },
      proxy: { ...proxy, tls: { ...proxy.tls } },
      tls: { ...clientTls },
    };
    expect(sanitizeConfiguredProviderRequest(configured)).toEqual({
      headers: { "X-Tenant": "acme" },
      auth: { mode: "authorization-bearer", token: "secret" },
      proxy: {
        mode: "explicit-proxy",
        url: "http://proxy.internal:8443",
        tls: { ca: "proxy-ca" },
      },
      tls: { cert: "client-cert", key: "client-key", serverName: "gateway.internal" },
    });
  });

  it("fails fast when configured request overrides still contain unresolved SecretRefs", () => {
    const ref = (id: string): SecretRef => ({ source: "env", provider: "default", id });
    expect(() =>
      sanitizeConfiguredProviderRequest({
        headers: { "X-Tenant": ref("MEDIA_AUDIO_TENANT") },
        auth: { mode: "authorization-bearer", token: ref("MEDIA_AUDIO_TOKEN") },
        tls: { cert: ref("MEDIA_AUDIO_CERT") },
      }),
    ).toThrow(/request\.(headers\.X-Tenant|auth\.token|tls\.cert): unresolved SecretRef/i);
  });

  it("keeps model-provider transport overrides once the llm path can carry them", () => {
    expect(
      sanitizeConfiguredModelProviderRequest({
        headers: { "X-Tenant": "acme" },
        proxy: { mode: "explicit-proxy", url: "http://proxy.internal:8443" },
      }),
    ).toEqual({
      headers: { "X-Tenant": "acme" },
      proxy: { mode: "explicit-proxy", url: "http://proxy.internal:8443" },
    });
  });

  it("preserves request.allowPrivateNetwork for operator-trusted LAN/overlay model bases", () => {
    expect(sanitizeConfiguredModelProviderRequest({ allowPrivateNetwork: true })).toEqual({
      allowPrivateNetwork: true,
    });
    expect(sanitizeConfiguredModelProviderRequest({ allowPrivateNetwork: false })).toEqual({
      allowPrivateNetwork: false,
    });
    expect(
      sanitizeConfiguredProviderRequest({ allowPrivateNetwork: true } as ConfiguredProviderRequest),
    ).toBeUndefined();
  });

  it("merges allowPrivateNetwork with later override winning", () => {
    expect(
      mergeModelProviderRequestOverrides(
        { allowPrivateNetwork: true },
        { allowPrivateNetwork: false },
      ),
    ).toEqual({ allowPrivateNetwork: false });
    expect(
      mergeModelProviderRequestOverrides(
        { allowPrivateNetwork: false },
        { allowPrivateNetwork: true },
      ),
    ).toEqual({ allowPrivateNetwork: true });
  });

  it("merges configured request overrides with later entries winning", () => {
    expect(
      mergeModelProviderRequestOverrides(
        {
          headers: { "X-Provider": "1", "X-Shared": "provider" },
          auth: { mode: "authorization-bearer", token: "provider-token" },
        },
        {
          headers: { "X-Entry": "2", "X-Shared": "entry" },
          auth: { mode: "header", headerName: "api-key", value: "entry-key" },
        },
      ),
    ).toEqual({
      headers: { "X-Provider": "1", "X-Shared": "entry", "X-Entry": "2" },
      auth: { mode: "header", headerName: "api-key", value: "entry-key" },
    });
  });

  it("lets caller headers override defaults when requested", () => {
    const resolved = resolveProviderRequestHeaders({
      provider: "openrouter",
      api: "openai-completions",
      ...streaming,
      callerHeaders: { "HTTP-Referer": "https://example.com", "X-Custom": "1" },
      precedence: "caller-wins",
    });

    expect(resolved).toEqual({
      "HTTP-Referer": "https://openclaw.ai",
      "X-OpenRouter-Title": "OpenClaw",
      "X-OpenRouter-Categories": "personal-agent,cli-agent",
      "X-Custom": "1",
    });
  });

  it("merges native OpenCode Go User-Agent headers case-insensitively", () => {
    const resolved = resolveProviderRequestHeaders({
      provider: "opencode-go",
      api: "openai-completions",
      baseUrl: "https://opencode.ai/zen/go/v1",
      ...streaming,
      callerHeaders: { "user-agent": "custom-agent/1.0" },
      precedence: "caller-wins",
    });

    expect(
      Object.keys(resolved ?? {}).filter((key) => key.toLowerCase() === "user-agent"),
    ).toHaveLength(1);
    expect(new Headers(resolved).get("user-agent")).toMatch(/^openclaw\//);
  });

  it("drops forbidden header keys while merging", () => {
    const resolved = resolveProviderRequestHeaders({
      provider: "custom-openai",
      callerHeaders: {
        __proto__: "polluted",
        constructor: "polluted",
        "X-Custom": "1",
      } as Record<string, string>,
      defaultHeaders: { prototype: "polluted" } as Record<string, string>,
    });

    expect(resolved).toEqual({ "X-Custom": "1" });
    expect(Object.getPrototypeOf(resolved ?? {})).toBeNull();
  });

  it("unifies policy, capabilities, headers, base URL, and private-network posture", () => {
    const resolved = resolveProviderRequestPolicyConfig({
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1/",
      defaultBaseUrl: "https://fallback.example/v1/",
      callerHeaders: { "User-Agent": "custom-agent/1.0", "X-Custom": "1" },
      providerHeaders: { authorization: "Bearer test-key" },
      compat: { supportsStore: true },
      ...streaming,
      precedence: "defaults-win",
    });

    expect(resolved).toMatchObject({
      baseUrl: "https://api.openai.com/v1",
      allowPrivateNetwork: false,
      trustConfiguredBaseUrlOrigin: false,
      capabilities: { endpointClass: "openai-public", allowsResponsesStore: true },
      headers: {
        authorization: "Bearer test-key",
        originator: "openclaw",
        "User-Agent": expect.stringMatching(/^openclaw\//),
        "X-Custom": "1",
      },
    });
    expect(typeof resolved.headers?.version).toBe("string");
  });

  it.each([
    ["openai", "openai-responses", "openai-public", "prepared-openai.example", undefined],
    [
      "anthropic",
      "anthropic-messages",
      "anthropic-public",
      "prepared-anthropic.example",
      undefined,
    ],
    ["acme-plugin", "openai-completions", "nvidia-native", "inference.acme.example", "acme-family"],
  ] as const)(
    "keeps %s outbound headers and SSRF policy byte-identical",
    (provider, api, endpointClass, host, family) => {
      const owners = buildProviderMetadataOwners(
        [{ endpointClass, hosts: [host] }],
        family ? new Map([[provider, { family }]]) : undefined,
      );
      const route = { provider, api, baseUrl: `https://${host}/v1` };
      const model = makeProviderModelFixture({ ...route, id: `${provider}-model` });
      const preparedModel = attachModelProviderRequestRouteFacts(model, owners);
      const common = {
        ...route,
        ...streaming,
        callerHeaders: { "X-Caller": "same" },
        providerHeaders: { Authorization: "Bearer redacted" },
      };
      const before = resolveProviderRequestPolicyConfig({
        ...common,
        providerMetadataOwners: owners,
      });
      const after = resolveProviderRequestPolicyConfig({
        ...common,
        routeFacts: getModelProviderRequestRouteFacts(preparedModel),
      });
      const ssrfPolicy = (resolved: typeof before) =>
        resolveProviderTransportSsrFPolicy({
          baseUrl: route.baseUrl,
          url: `${route.baseUrl}/responses`,
          allowPrivateNetwork: resolved.allowPrivateNetwork,
          trustConfiguredBaseUrlOrigin: resolved.trustConfiguredBaseUrlOrigin,
        });

      expect(JSON.stringify(after.headers)).toBe(JSON.stringify(before.headers));
      expect(JSON.stringify(ssrfPolicy(after))).toBe(JSON.stringify(ssrfPolicy(before)));
    },
  );

  it("keeps explicit private-network denial for loopback model requests", () => {
    const resolved = resolveProviderRequestPolicyConfig({
      provider: "local-agent-proxy",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:3000/v1",
      ...streaming,
      request: { allowPrivateNetwork: false },
    });

    expect(resolved).toMatchObject({
      allowPrivateNetwork: false,
      trustConfiguredBaseUrlOrigin: false,
    });
  });

  it("classifies vllm configured baseUrl as exact-origin trusted endpoint class", () => {
    const resolved = resolveProviderRequestPolicyConfig({
      provider: "vllm",
      api: "openai-completions",
      baseUrl: "http://192.168.1.20:8000/v1",
      ...streaming,
    });

    expect(resolved).toMatchObject({
      capabilities: { endpointClass: "custom" },
      allowPrivateNetwork: false,
      trustConfiguredBaseUrlOrigin: true,
    });
  });
});
