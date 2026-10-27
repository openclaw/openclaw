import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveRequestUrl } from "../../plugin-sdk/request-url.js";
import { clearPluginRegistryLoadCache, loadOpenClawPlugins } from "../../plugins/loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  loadOpenClawPlugins as loadFixturePlugins,
  resetPluginLoaderTestStateForTest,
  writePlugin,
} from "../../plugins/loader.test-fixtures.js";
import { resetPluginRuntimeStateForTest } from "../../plugins/runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { isOAuthRefreshFence } from "../auth-profiles/oauth-refresh-marker.js";
import { resolveApiKeyForProfile } from "../auth-profiles/oauth.js";
import { loadPersistedAuthProfileStore } from "../auth-profiles/persisted.js";
import { writePersistedAuthProfileStoreRaw } from "../auth-profiles/sqlite.js";
import type { OAuthCredential } from "../auth-profiles/types.js";
import * as sdkRefresh from "./auth-storage-oauth-refresh.js";
import { getAuthStorageOAuthProviderRegistry } from "./auth-storage-oauth-registry.js";
import { AuthStorage } from "./auth-storage.js";

// One test root for the SQLite OAuth refresh owner boundary keeps the agents-sessions
// type shard within budget; each suite keeps its own fixtures and cleanup hooks.
// Shared unit setup stubs this facade; these integrations exercise the real builtin adapters.
vi.unmock("../../llm/oauth.js");

describe("bundled xAI adapter through the SQLite owner", () => {
  const original: OAuthCredential = {
    type: "oauth",
    provider: "xai",
    accountId: "synthetic-account",
    access: "synthetic-old-access",
    refresh: "synthetic-old-refresh",
    expires: 1,
  };
  const endpoint = "https://auth.x.ai/oauth2/token";
  const rotated = {
    access_token: "synthetic-new-access",
    refresh_token: "synthetic-new-refresh",
    expires_in: 3600,
  };

  async function storage(agentDir: string, pluginId = "xai") {
    const registry = loadOpenClawPlugins({
      config: { plugins: { allow: [pluginId], entries: { [pluginId]: { enabled: true } } } },
      cache: false,
      onlyPluginIds: [pluginId],
    });
    expect(
      registry.plugins.find((plugin) => plugin.id === pluginId)?.status,
      JSON.stringify(registry.diagnostics),
    ).toBe("loaded");
    return await AuthStorage.forAgentAsync(agentDir);
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    clearPluginRegistryLoadCache();
    resetPluginRuntimeStateForTest();
  });

  describe("bundled OAuth adapter through SQLite SDK owner", () => {
    it("restores a discovery-only failure and permits a later intentional refresh", async () => {
      await withOpenClawTestState(
        { layout: "state-only", prefix: "oauth-boundary-discovery-" },
        async (state) => {
          await state.writeConfig({
            plugins: { allow: ["xai"], entries: { xai: { enabled: true } } },
          });
          const dir = state.agentDir();
          writePersistedAuthProfileStoreRaw(
            { version: 1, profiles: { "xai:default": original } },
            dir,
          );
          const requests: Array<{ url: string; body: string }> = [];
          vi.stubGlobal(
            "fetch",
            vi.fn<typeof fetch>(async (url, init) => {
              requests.push({
                url: resolveRequestUrl(url),
                body: await new Response(init?.body).text(),
              });
              if (requests.length === 1) {
                return Response.json({ error: "temporarily_unavailable" }, { status: 503 });
              }
              if (resolveRequestUrl(url).includes("openid-configuration")) {
                return Response.json({ token_endpoint: endpoint });
              }
              return Response.json(rotated);
            }),
          );
          await expect(
            (await storage(dir)).getApiKey("xai", { includeFallback: false }),
          ).resolves.toBeUndefined();
          expect(loadPersistedAuthProfileStore(dir)?.profiles["xai:default"]).toEqual(original);
          expect(requests).toHaveLength(1);
          await expect(
            (await storage(dir)).getApiKey("xai", { includeFallback: false }),
          ).resolves.toBe(rotated.access_token);
          expect(requests.filter((request) => request.url === endpoint)).toEqual([
            {
              url: endpoint,
              body: "grant_type=refresh_token&client_id=b1a00492-073a-47ea-816f-4c329264a828&refresh_token=synthetic-old-refresh",
            },
          ]);
          expect(loadPersistedAuthProfileStore(dir)?.profiles["xai:default"]).toMatchObject({
            access: rotated.access_token,
            refresh: rotated.refresh_token,
          });
        },
      );
    });

    it("keeps the sign-in after an xAI HTML 503 and lets a later refresh succeed", async () => {
      await withOpenClawTestState(
        { layout: "state-only", prefix: "oauth-boundary-retained-" },
        async (state) => {
          await state.writeConfig({
            plugins: { allow: ["xai"], entries: { xai: { enabled: true } } },
          });
          const dir = state.agentDir();
          const initial = { ...original, tokenEndpoint: endpoint };
          writePersistedAuthProfileStoreRaw(
            { version: 1, profiles: { "xai:default": initial } },
            dir,
          );
          let consumed = 0;
          vi.stubGlobal(
            "fetch",
            vi.fn<typeof fetch>(async (url, init) => {
              expect(resolveRequestUrl(url)).toBe(endpoint);
              expect(
                new URLSearchParams(await new Response(init?.body).text()).get("refresh_token"),
              ).toBe(original.refresh);
              consumed += 1;
              return consumed === 1
                ? new Response("<html>temporary upstream error</html>", {
                    status: 503,
                    headers: { "content-type": "text/html" },
                  })
                : Response.json(rotated);
            }),
          );
          await expect(
            (await storage(dir)).getApiKey("xai", { includeFallback: false }),
          ).resolves.toBeUndefined();
          expect(loadPersistedAuthProfileStore(dir)?.profiles["xai:default"]).toEqual(initial);
          await expect(
            (await storage(dir)).getApiKey("xai", { includeFallback: false }),
          ).resolves.toBe(rotated.access_token);
          expect(consumed).toBe(2);
          expect(loadPersistedAuthProfileStore(dir)?.profiles["xai:default"]).toMatchObject({
            access: rotated.access_token,
            refresh: rotated.refresh_token,
          });
        },
      );
    });

    it.each(["socket-close", "malformed-success"] as const)(
      "does not replay a possibly consumed token after %s",
      async (outcome) => {
        await withOpenClawTestState(
          { layout: "state-only", prefix: "oauth-boundary-consumed-" },
          async (state) => {
            await state.writeConfig({
              plugins: { allow: ["xai"], entries: { xai: { enabled: true } } },
            });
            const dir = state.agentDir();
            writePersistedAuthProfileStoreRaw(
              { version: 1, profiles: { "xai:default": { ...original, tokenEndpoint: endpoint } } },
              dir,
            );
            let consumed = 0;
            vi.stubGlobal(
              "fetch",
              vi.fn<typeof fetch>(async (_url, init) => {
                expect(
                  new URLSearchParams(await new Response(init?.body).text()).get("refresh_token"),
                ).toBe(original.refresh);
                consumed += 1;
                if (outcome === "socket-close") {
                  throw Object.assign(new Error("socket closed after consuming grant"), {
                    code: "ECONNRESET",
                  });
                }
                return new Response('{"access_token":', { status: 200 });
              }),
            );
            await expect(
              (await storage(dir)).getApiKey("xai", { includeFallback: false }),
            ).resolves.toBeUndefined();
            const persisted = loadPersistedAuthProfileStore(dir)?.profiles["xai:default"];
            expect(isOAuthRefreshFence(persisted?.type === "oauth" ? persisted : undefined)).toBe(
              true,
            );
            await expect(
              (await storage(dir)).getApiKey("xai", { includeFallback: false }),
            ).resolves.toBeUndefined();
            expect(consumed).toBe(1);
          },
        );
      },
    );
  });

  for (const owner of ["native manager", "SDK AuthStorage"] as const) {
    it.each(["coalesced waiters", "newer login"] as const)(
      owner + " preserves the real HTTP claim with %s",
      async (mode) =>
        withOpenClawTestState(
          { layout: "state-only", prefix: "oauth-real-owner-" },
          async (state) => {
            const cfg = { plugins: { allow: ["xai"], entries: { xai: { enabled: true } } } };
            await state.writeConfig(cfg);
            const dir = state.agentDir();
            const initial = { ...original, tokenEndpoint: endpoint };
            writePersistedAuthProfileStoreRaw(
              { version: 1, profiles: { "xai:default": initial } },
              dir,
            );
            const sdk = await storage(dir);
            const secondSdk = await storage(dir);
            const entered = createDeferredCore();
            const release = createDeferredCore();
            let requests = 0;
            vi.stubGlobal(
              "fetch",
              vi.fn<typeof fetch>(async (url, init) => {
                expect(resolveRequestUrl(url)).toBe(endpoint);
                expect(
                  new URLSearchParams(await new Response(init?.body).text()).get("refresh_token"),
                ).toBe(original.refresh);
                requests++;
                entered.resolve();
                await release.promise;
                return Response.json(rotated);
              }),
            );
            const resolve = async (target = sdk) =>
              owner === "SDK AuthStorage"
                ? target.getApiKey("xai", { includeFallback: false })
                : (
                    await resolveApiKeyForProfile({
                      cfg,
                      store: loadPersistedAuthProfileStore(dir)!,
                      profileId: "xai:default",
                      agentDir: dir,
                      allowProfileFallback: false,
                    })
                  )?.apiKey;
            const first = resolve();
            await entered.promise;
            const newer = {
              ...initial,
              access: "synthetic-new-login",
              refresh: "synthetic-new-login-refresh",
              expires: Date.now() + 600000,
            };
            let second: Promise<string | undefined> | undefined;
            try {
              if (mode === "newer login") {
                writePersistedAuthProfileStoreRaw(
                  { version: 1, profiles: { "xai:default": newer } },
                  dir,
                );
              } else {
                const admitted = createDeferredCore();
                if (owner === "SDK AuthStorage") {
                  // Observe the real serialized entry, without replacing its backend or refresh.
                  const refresh = sdkRefresh.refreshAuthStorageOAuthCredential;
                  vi.spyOn(sdkRefresh, "refreshAuthStorageOAuthCredential").mockImplementation(
                    (params) => {
                      const work = refresh(params);
                      admitted.resolve();
                      return work;
                    },
                  );
                } else {
                  const { KeyedAsyncQueue } = await import("../../plugin-sdk/keyed-async-queue.js");
                  // oxlint-disable-next-line typescript/unbound-method -- Preserve the native queue receiver.
                  const enqueue = KeyedAsyncQueue.prototype.enqueue;
                  vi.spyOn(KeyedAsyncQueue.prototype, "enqueue").mockImplementation(function (
                    this: InstanceType<typeof KeyedAsyncQueue>,
                    key,
                    task,
                    hooks,
                  ) {
                    return enqueue.call(this, key, task, {
                      ...hooks,
                      onEnqueue() {
                        hooks?.onEnqueue?.();
                        admitted.resolve();
                      },
                    });
                  });
                }
                second = resolve(secondSdk);
                await admitted.promise;
                expect(requests).toBe(1);
              }
            } finally {
              release.resolve();
            }
            const expected = mode === "newer login" ? newer.access : rotated.access_token;
            await expect(first).resolves.toBe(expected);
            if (second) {
              await expect(second).resolves.toBe(expected);
            }
            expect(loadPersistedAuthProfileStore(dir)?.profiles["xai:default"]).toMatchObject(
              mode === "newer login"
                ? newer
                : { access: rotated.access_token, refresh: rotated.refresh_token },
            );
            await expect(resolve()).resolves.toBe(expected);
            expect(requests).toBe(1);
          },
        ),
    );
  }

  it("a native caller detaches without cancelling real HTTP rotation or durable settlement", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "oauth-real-detach-" },
      async (state) => {
        const cfg = { plugins: { allow: ["xai"], entries: { xai: { enabled: true } } } };
        await state.writeConfig(cfg);
        const dir = state.agentDir();
        writePersistedAuthProfileStoreRaw(
          { version: 1, profiles: { "xai:default": { ...original, tokenEndpoint: endpoint } } },
          dir,
        );
        await storage(dir);
        const entered = createDeferredCore();
        const release = createDeferredCore();
        let requests = 0;
        vi.stubGlobal(
          "fetch",
          vi.fn<typeof fetch>(async (_url, init) => {
            expect(
              new URLSearchParams(await new Response(init?.body).text()).get("refresh_token"),
            ).toBe(original.refresh);
            requests++;
            entered.resolve();
            await release.promise;
            expect(init?.signal?.aborted).not.toBe(true);
            return Response.json(rotated);
          }),
        );
        const abort = new AbortController();
        const resolve = async (signal?: AbortSignal) =>
          (
            await resolveApiKeyForProfile({
              cfg,
              store: loadPersistedAuthProfileStore(dir)!,
              profileId: "xai:default",
              agentDir: dir,
              allowProfileFallback: false,
              signal,
            })
          )?.apiKey;
        const first = resolve(abort.signal).then(
          () => "published",
          () => "detached",
        );
        await entered.promise;
        abort.abort();
        try {
          expect(await first).toBe("detached");
        } finally {
          release.resolve();
        }
        await expect(resolve()).resolves.toBe(rotated.access_token);
        expect(loadPersistedAuthProfileStore(dir)?.profiles["xai:default"]).toMatchObject({
          access: rotated.access_token,
          refresh: rotated.refresh_token,
        });
        expect(requests).toBe(1);
      },
    );
  });

  for (const owner of ["native manager", "SDK AuthStorage"] as const) {
    it(owner + " persists the real Copilot projection without a refresh-token POST", async () => {
      await withOpenClawTestState(
        { layout: "state-only", prefix: "oauth-copilot-owner-" },
        async (state) => {
          const cfg = {
            plugins: {
              allow: ["github-copilot"],
              entries: { "github-copilot": { enabled: true } },
            },
          };
          await state.writeConfig(cfg);
          const dir = state.agentDir();
          const credential = { ...original, provider: "github-copilot" };
          writePersistedAuthProfileStoreRaw(
            { version: 1, profiles: { "github-copilot:default": credential } },
            dir,
          );
          const sdk = await storage(dir, "github-copilot");
          const network = vi.fn<typeof fetch>(async () => {
            throw new Error("projection must not send a refresh grant");
          });
          vi.stubGlobal("fetch", network);
          const result =
            owner === "SDK AuthStorage"
              ? await sdk.getApiKey("github-copilot", { includeFallback: false })
              : (
                  await resolveApiKeyForProfile({
                    cfg,
                    store: loadPersistedAuthProfileStore(dir)!,
                    profileId: "github-copilot:default",
                    agentDir: dir,
                    allowProfileFallback: false,
                  })
                )?.apiKey;
          expect(result).toBe(credential.refresh);
          expect(loadPersistedAuthProfileStore(dir)?.profiles["github-copilot:default"]).toEqual({
            ...credential,
            access: credential.refresh,
            expires: 8_640_000_000_000_000,
          });
          expect(network).not.toHaveBeenCalled();
        },
      );
    });

    it.each([
      {
        plugin: "minimax",
        provider: "minimax-portal",
        profileId: "minimax-portal:minimax-cli",
        authFlow: "external-cli",
      },
      {
        plugin: "google",
        provider: "google-gemini-cli",
        profileId: "google-gemini-cli:default",
        authFlow: undefined,
      },
    ])(
      owner + " does not invent a native refresh for $provider",
      async ({ plugin, provider, profileId, authFlow }) => {
        await withOpenClawTestState(
          { layout: "state-only", prefix: "oauth-unsupported-owner-" },
          async (state) => {
            const cfg = { plugins: { allow: [plugin], entries: { [plugin]: { enabled: true } } } };
            await state.writeConfig(cfg);
            const dir = state.agentDir();
            const credential = { ...original, provider, ...(authFlow ? { authFlow } : {}) };
            writePersistedAuthProfileStoreRaw(
              { version: 1, profiles: { [profileId]: credential } },
              dir,
            );
            const sdk = await storage(dir, plugin);
            const network = vi.fn<typeof fetch>(async () => {
              throw new Error("unsupported owner must not send a refresh grant");
            });
            vi.stubGlobal("fetch", network);
            const result =
              owner === "SDK AuthStorage"
                ? await sdk.getApiKey(provider, { includeFallback: false })
                : (
                    await resolveApiKeyForProfile({
                      cfg,
                      store: loadPersistedAuthProfileStore(dir)!,
                      profileId,
                      agentDir: dir,
                      allowProfileFallback: false,
                    })
                  )?.apiKey;
            expect(result).toBeUndefined();
            expect(loadPersistedAuthProfileStore(dir)?.profiles[profileId]).toEqual(credential);
            expect(network).not.toHaveBeenCalled();
          },
        );
      },
    );
  }
});

describe("third-party plugin refresh outcomes", () => {
  const provider = "fixture-oauth";
  const profileId = provider + ":default";
  const original: OAuthCredential = {
    type: "oauth",
    provider,
    access: "synthetic-old-access",
    refresh: "synthetic-old-refresh",
    expires: 1,
  };
  const endpoint = "https://oauth.example.test/token";
  // The fixture is admitted as a third-party plugin and imports only the public SDK.
  // The real runtime, HTTP parser, and SQLite refresh owner remain in the path.
  const body = [
    'const { createOAuthRefreshError, createOAuthRefreshResponseError } = require("openclaw/plugin-sdk/provider-oauth-runtime");',
    'module.exports = { id: "fixture-oauth", register(api) {',
    'api.registerProvider({ id: "fixture-oauth", label: "Fixture OAuth", auth: [], async refreshOAuth(cred) {',
    'const discovery = await fetch("https://oauth.example.test/discovery");',
    'if (!discovery.ok) throw createOAuthRefreshError("discovery unavailable", { version: 1, phase: "before-dispatch", outcome: "not-attempted", recovery: { kind: "later", evidence: "dispatch-not-started" } });',
    'const response = await fetch((await discovery.json()).token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: cred.refresh }) });',
    "const data = await response.json();",
    'if (data.legacy) throw Object.assign(new Error("legacy retry hint"), { oauthRefreshFailure: { retryable: true } });',
    'if (data.unknownVersion) throw Object.assign(new Error("future outcome"), { oauthRefreshOutcome: { version: 999, phase: "before-dispatch", outcome: "not-attempted", recovery: { kind: "later", evidence: "dispatch-not-started" } }});',
    'if (!response.ok || data.error) throw new Error("adapter wrapper", { cause: createOAuthRefreshResponseError("fixture rejected", response.status, data) });',
    'if (typeof data.access_token !== "string" || typeof data.refresh_token !== "string") throw new Error("invalid response");',
    "return { ...cred, access: data.access_token, refresh: data.refresh_token, expires: Date.now() + 600000 };",
    "}}); }};",
  ].join("\n");

  afterEach(() => {
    vi.unstubAllGlobals();
    resetPluginLoaderTestStateForTest();
  });
  afterAll(cleanupPluginLoaderFixturesForTest);

  for (const owner of ["native plugin", "registered SDK provider"] as const) {
    describe(owner + " public outcome compatibility", () => {
      it.each([
        "success",
        "discovery",
        "rejected",
        "unknown",
        "legacy",
        "unknown-version",
      ] as const)("%s preserves real HTTP and durable settlement", async (mode) =>
        withOpenClawTestState({ layout: "state-only", prefix: "custom-oauth-" }, async (state) => {
          const plugin = writePlugin({ id: provider, body });
          const cfg: OpenClawConfig = {
            plugins: {
              allow: [provider],
              load: { paths: [plugin.file] },
              slots: { memory: "none" },
              entries: { [provider]: { enabled: true } },
            },
          };
          await state.writeConfig(cfg);
          const registry = loadFixturePlugins({
            config: cfg,
            cache: false,
            onlyPluginIds: [provider],
          });
          expect(
            registry.plugins.find((p) => p.id === provider)?.status,
            JSON.stringify(registry.diagnostics),
          ).toBe("loaded");
          const adapter = registry.providers.find((p) => p.provider.id === provider)?.provider
            .refreshOAuth;
          if (!adapter) {
            throw new Error("Fixture adapter was not registered");
          }
          const dir = state.agentDir();
          writePersistedAuthProfileStoreRaw(
            { version: 1, profiles: { [profileId]: original } },
            dir,
          );
          let discoveries = 0;
          let exchanges = 0;
          vi.stubGlobal(
            "fetch",
            vi.fn<typeof fetch>(async (url, init) => {
              if (resolveRequestUrl(url).endsWith("/discovery")) {
                discoveries++;
                return mode === "discovery" && discoveries === 1
                  ? new Response(null, { status: 503 })
                  : Response.json({ token_endpoint: endpoint });
              }
              expect(resolveRequestUrl(url)).toBe(endpoint);
              expect(init?.method).toBe("POST");
              expect(
                Object.fromEntries(new URLSearchParams(await new Response(init?.body).text())),
              ).toEqual({
                grant_type: "refresh_token",
                refresh_token: original.refresh,
              });
              exchanges++;
              if (mode === "unknown") {
                throw new Error("socket closed after consuming grant");
              }
              if (mode === "rejected") {
                return Response.json({ error: { code: "invalid_grant" } });
              }
              if (mode === "legacy") {
                return Response.json({ legacy: true });
              }
              if (mode === "unknown-version") {
                return Response.json({ unknownVersion: true });
              }
              return Response.json({
                access_token: "synthetic-new-access",
                refresh_token: "synthetic-new-refresh",
              });
            }),
          );
          const sdk = await AuthStorage.forAgentAsync(dir, cfg);
          getAuthStorageOAuthProviderRegistry(sdk).register({
            id: provider,
            name: "Fixture OAuth",
            login: async () => {
              throw new Error("unused login");
            },
            refreshToken: (cred) => adapter({ ...cred, type: "oauth", provider }, cfg),
            getApiKey: (cred) => cred.access,
          });
          const resolve = async () =>
            owner === "registered SDK provider"
              ? sdk.getApiKey(provider, { includeFallback: false })
              : (
                  await resolveApiKeyForProfile({
                    cfg,
                    store: loadPersistedAuthProfileStore(dir)!,
                    profileId,
                    agentDir: dir,
                    allowProfileFallback: false,
                  })
                )?.apiKey;
          if (mode === "success") {
            await expect(resolve()).resolves.toBe("synthetic-new-access");
          } else {
            if (owner === "native plugin") {
              await expect(resolve()).rejects.toThrow("OAuth token refresh failed");
            } else {
              await expect(resolve()).resolves.toBeUndefined();
            }
            if (mode === "discovery") {
              expect(loadPersistedAuthProfileStore(dir)?.profiles[profileId]).toEqual(original);
              expect(exchanges).toBe(0);
              await expect(resolve()).resolves.toBe("synthetic-new-access");
            } else {
              const value = loadPersistedAuthProfileStore(dir)?.profiles[profileId];
              expect(isOAuthRefreshFence(value?.type === "oauth" ? value : undefined)).toBe(true);
              await expect(resolve()).resolves.toBeUndefined();
            }
          }
          if (mode === "success" || mode === "discovery") {
            expect(loadPersistedAuthProfileStore(dir)?.profiles[profileId]).toMatchObject({
              access: "synthetic-new-access",
              refresh: "synthetic-new-refresh",
            });
            await expect(resolve()).resolves.toBe("synthetic-new-access");
          }
          expect(exchanges).toBe(1);
          expect(discoveries).toBe(mode === "discovery" ? 2 : 1);
        }),
      );
    });
  }
});

describe("bundled provider refresh composition", () => {
  const oldRefresh = "synthetic-old-refresh";
  const nextRefresh = "synthetic-next-refresh";
  const nextAccess = "synthetic-next-access";
  const issuer = "https://auth.openai.com";
  const clientId = "oaiapp_synthetic_registered";
  const jwt = (claims: object) =>
    [
      "eyJhbGciOiJub25lIn0",
      Buffer.from(JSON.stringify(claims)).toString("base64url"),
      "synthetic",
    ].join(".");
  const codexAccess = jwt({
    "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" },
  });
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = {
    ...keys.publicKey.export({ format: "jwk" }),
    kid: "synthetic-signing-key",
    alg: "RS256",
  };
  let idToken: string;
  beforeAll(() => {
    const now = Math.floor(Date.now() / 1000);
    const input = [
      Buffer.from(JSON.stringify({ alg: "RS256", kid: "synthetic-signing-key" })).toString(
        "base64url",
      ),
      Buffer.from(
        JSON.stringify({
          sub: "synthetic-subject",
          iss: issuer,
          aud: clientId,
          iat: now,
          exp: now + 3600,
        }),
      ).toString("base64url"),
    ].join(".");
    idToken =
      input + "." + sign("RSA-SHA256", Buffer.from(input), keys.privateKey).toString("base64url");
  });

  type Route = {
    name: string;
    provider: string;
    plugin?: string;
    endpoint: string;
    json?: boolean;
    fields: Record<string, string>;
    extra?: () => Partial<OAuthCredential>;
    response?: () => object;
    access?: string;
    env?: Record<string, string>;
  };
  const standard = { access_token: nextAccess, refresh_token: nextRefresh, expires_in: 3600 };
  const routes: Route[] = [
    {
      name: "Anthropic builtin",
      provider: "anthropic",
      endpoint: "https://platform.claude.com/v1/oauth/token",
      json: true,
      fields: { client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e" },
    },
    {
      name: "OpenAI standard plugin",
      provider: "openai",
      plugin: "openai",
      endpoint: issuer + "/oauth/token",
      access: codexAccess,
      fields: { client_id: "app_EMoamEEZ73f0CkXaXp7hrann" },
      extra: () => ({ accountId: "synthetic-account" }),
      response: () => ({ ...standard, access_token: codexAccess }),
    },
    {
      name: "OpenAI builtin facade",
      provider: "openai",
      endpoint: issuer + "/oauth/token",
      access: codexAccess,
      fields: { client_id: "app_EMoamEEZ73f0CkXaXp7hrann" },
      extra: () => ({ accountId: "synthetic-account" }),
      response: () => ({ ...standard, access_token: codexAccess }),
    },
    ...["chatgpt-token-sharing", "chatgpt-identity"].map((flow): Route => ({
      name: "OpenAI " + flow,
      provider: "openai",
      plugin: "openai",
      endpoint: issuer + "/api/accounts/oauth/token",
      fields: { client_id: clientId, resource: "https://api.openai.com/v1" },
      extra: () => ({
        authFlow: flow,
        issuer,
        clientId,
        tokenEndpoint: issuer + "/api/accounts/oauth/token",
        idToken,
        accountId: createHash("sha256")
          .update(issuer + "\0" + clientId + "\0synthetic-subject")
          .digest("hex"),
        grantedScope:
          flow === "chatgpt-token-sharing" ? "resource.invoke chatgpt.tokens.use.direct" : "openid",
      }),
      response: () => ({ ...standard, id_token: idToken, token_type: "Bearer" }),
    })),
    {
      name: "Chutes stored public client",
      provider: "chutes",
      plugin: "chutes",
      endpoint: "https://api.chutes.ai/idp/token",
      fields: { client_id: "synthetic-client" },
      extra: () => ({ clientId: "synthetic-client" }),
    },
    {
      name: "Chutes confidential client",
      provider: "chutes",
      plugin: "chutes",
      endpoint: "https://api.chutes.ai/idp/token",
      fields: { client_id: "synthetic-client", client_secret: "synthetic-client-secret" },
      extra: () => ({ clientId: "synthetic-client" }),
      env: { CHUTES_CLIENT_SECRET: "synthetic-client-secret" },
    },
    ...["global", "cn"].map((region): Route => ({
      name: "MiniMax " + region,
      provider: "minimax-portal",
      plugin: "minimax",
      endpoint:
        "https://account." + (region === "cn" ? "minimaxi.com" : "minimax.io") + "/oauth2/token",
      fields: { client_id: "78257093-7e40-4613-99e0-527b14b39113" },
      extra: () => ({
        tokenEndpoint:
          "https://account." + (region === "cn" ? "minimaxi.com" : "minimax.io") + "/oauth2/token",
      }),
      response: () => ({
        status: "success",
        access_token: nextAccess,
        refresh_token: nextRefresh,
        expired_in: 3600,
      }),
    })),
    {
      name: "Radius",
      provider: "radius",
      plugin: "radius",
      endpoint: "https://radius.pi.dev/v1/oauth/token",
      fields: { client_id: "pi-gateway" },
      response: () => ({ ...standard, scope: "gateway offline_access" }),
    },
    {
      name: "xAI cached endpoint",
      provider: "xai",
      plugin: "xai",
      endpoint: "https://auth.x.ai/oauth2/token",
      fields: { client_id: "b1a00492-073a-47ea-816f-4c329264a828" },
      extra: () => ({ tokenEndpoint: "https://auth.x.ai/oauth2/token" }),
    },
  ];

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    clearPluginRegistryLoadCache();
    resetPluginRuntimeStateForTest();
  });

  for (const owner of ["model manager", "SDK AuthStorage"] as const) {
    // Exercise each adapter failure through SDK storage; native keeps builtin, facade, and plugin paths.
    const failureRoutes =
      owner === "SDK AuthStorage"
        ? routes
        : routes.filter((route) => !route.plugin || route.provider === "xai");
    describe(owner + " real bundled refresh composition", () => {
      it.each(routes)("$name serializes, parses and durably publishes rotation", async (route) => {
        await run(route, "success");
      });
      it.each(routes.filter((route) => route.provider !== "anthropic"))(
        "$name preserves an explicitly omitted unchanged refresh token",
        async (route) => {
          await run(route, "omitted-refresh");
        },
      );
      it.each(failureRoutes)(
        "$name fences a malformed returned rotation rather than retaining the old token",
        async (route) => {
          await run(route, "invalid-refresh");
        },
      );
      it.each(routes.filter((route) => route.name.includes("chatgpt-")))(
        "$name never restores a consumed grant after identity verification fails",
        async (route) => {
          await run(route, "identity-failure");
        },
      );
      it.each(failureRoutes)(
        "$name quarantines a consumed grant despite a transient-looking lost response",
        async (route) => {
          await run(route, "socket");
        },
      );
      it.each(failureRoutes)(
        "$name preserves structured rejection on HTTP 200 without replay",
        async (route) => {
          await run(route, "rejected");
        },
      );
    });

    async function run(
      route: Route,
      mode:
        | "success"
        | "omitted-refresh"
        | "invalid-refresh"
        | "identity-failure"
        | "socket"
        | "rejected",
    ) {
      await withOpenClawTestState(
        { layout: "state-only", prefix: "oauth-real-adapter-" },
        async (state) => {
          vi.stubEnv("CHUTES_CLIENT_SECRET", "");
          for (const [name, value] of Object.entries(route.env ?? {})) {
            vi.stubEnv(name, value);
          }
          const cfg: OpenClawConfig = {
            plugins: {
              allow: route.plugin ? [route.plugin] : [],
              entries: route.plugin ? { [route.plugin]: { enabled: true } } : {},
            },
          };
          await state.writeConfig(cfg);
          if (route.plugin) {
            const registry = loadOpenClawPlugins({
              config: cfg,
              cache: false,
              onlyPluginIds: [route.plugin],
            });
            expect(
              registry.plugins.find((plugin) => plugin.id === route.plugin)?.status,
              JSON.stringify(registry.diagnostics),
            ).toBe("loaded");
          }
          const dir = state.agentDir();
          const profileId = route.provider + ":default";
          const credential: OAuthCredential = {
            type: "oauth",
            provider: route.provider,
            access: "synthetic-old-access",
            refresh: oldRefresh,
            expires: 1,
            ...route.extra?.(),
          };
          writePersistedAuthProfileStoreRaw(
            { version: 1, profiles: { [profileId]: credential } },
            dir,
          );
          let grantsConsumed = 0;
          vi.stubGlobal(
            "fetch",
            vi.fn<typeof fetch>(async (url, init) => {
              if (resolveRequestUrl(url) === issuer + "/.well-known/jwks.json") {
                if (mode === "identity-failure") {
                  return Response.json({ keys: [] });
                }
                return Response.json({ keys: [jwk] });
              }
              expect(resolveRequestUrl(url)).toBe(route.endpoint);
              expect(init?.method).toBe("POST");
              const headers = new Headers(init?.headers);
              expect(headers.get("content-type")).toContain(
                route.json ? "application/json" : "application/x-www-form-urlencoded",
              );
              const body: unknown = route.json
                ? JSON.parse(await new Response(init?.body).text())
                : Object.fromEntries(new URLSearchParams(await new Response(init?.body).text()));
              expect(body).toEqual({
                grant_type: "refresh_token",
                refresh_token: oldRefresh,
                ...route.fields,
              });
              grantsConsumed += 1;
              if (mode === "socket") {
                throw Object.assign(new Error("connection reset after consuming synthetic grant"), {
                  code: "ECONNRESET",
                });
              }
              if (mode === "rejected") {
                return Response.json({
                  error: { code: "invalid_grant" },
                  error_description: "synthetic rejection",
                });
              }
              const response: Record<string, unknown> = { ...(route.response?.() ?? standard) };
              if (mode === "omitted-refresh") {
                delete response.refresh_token;
              }
              if (mode === "invalid-refresh") {
                response.refresh_token = null;
              }
              return Response.json(response);
            }),
          );
          const resolve = async () => {
            if (owner === "SDK AuthStorage") {
              const storage = await AuthStorage.forAgentAsync(dir, cfg);
              const value = await storage.getApiKey(route.provider, { includeFallback: false });
              if (grantsConsumed === 0) {
                expect(
                  storage
                    .drainErrors()
                    .map((error) => error.stack)
                    .join("\n"),
                ).toBe("");
              }
              return value;
            }
            return (
              await resolveApiKeyForProfile({
                cfg,
                store: loadPersistedAuthProfileStore(dir)!,
                profileId,
                agentDir: dir,
                allowProfileFallback: false,
              })
            )?.apiKey;
          };
          if (mode === "success" || mode === "omitted-refresh") {
            await expect(resolve()).resolves.toBe(route.access ?? nextAccess);
            expect(loadPersistedAuthProfileStore(dir)?.profiles[profileId]).toMatchObject({
              type: "oauth",
              access: route.access ?? nextAccess,
              refresh: mode === "omitted-refresh" ? oldRefresh : nextRefresh,
            });
            await expect(resolve()).resolves.toBe(route.access ?? nextAccess);
          } else {
            if (owner === "SDK AuthStorage") {
              await expect(resolve()).resolves.toBeUndefined();
            } else {
              await expect(resolve()).rejects.toThrow("OAuth token refresh failed");
            }
            const persisted = loadPersistedAuthProfileStore(dir)?.profiles[profileId];
            expect(isOAuthRefreshFence(persisted?.type === "oauth" ? persisted : undefined)).toBe(
              true,
            );
            // A new call observes the terminal durable generation, not another provider attempt.
            await expect(resolve()).resolves.toBeUndefined();
          }
          expect(grantsConsumed).toBe(1);
        },
      );
    }
  }
});
