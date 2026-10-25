import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createApiKeyCredential,
  createAuthProfileStoreFixture,
  createOAuthRefreshCredential,
} from "./auth-profiles/credential-fixtures.test-support.js";
import { parseLegacyCredentialEntry } from "./auth-profiles/legacy-flat-credential.js";
import type { AuthProfileCredential, OAuthCredential } from "./auth-profiles/types.js";
import type { ProviderAuthAliasLookupParams } from "./provider-auth-aliases.js";

const { readCodexCliCredentialsCachedMock, resolveProviderIdForAuthMock } = vi.hoisted(() => ({
  readCodexCliCredentialsCachedMock: vi.fn<
    (options?: { allowKeychainPrompt?: boolean }) => OAuthCredential | null
  >(() => null),
  resolveProviderIdForAuthMock: vi.fn<(provider: string, params?: unknown) => string>(
    (provider: string) => (provider === "codex-cli" ? "openai" : provider),
  ),
}));

vi.mock("./cli-credentials.js", () => ({
  readCodexCliCredentialsCached: readCodexCliCredentialsCachedMock,
  readMiniMaxCliCredentialsCached: () => null,
}));
vi.mock("./provider-auth-aliases.js", () => ({
  resolveProviderIdForAuth: resolveProviderIdForAuthMock,
}));

import {
  buildAuthHealthSummary,
  DEFAULT_OAUTH_WARN_MS,
  formatRemainingShort,
} from "./auth-health.js";

describe("buildAuthHealthSummary", () => {
  const now = 1_700_000_000_000;
  const profileStatuses = (summary: ReturnType<typeof buildAuthHealthSummary>) =>
    Object.fromEntries(summary.profiles.map((profile) => [profile.profileId, profile.status]));

  const oauth = (expires: number, provider = "openai", refresh = "refresh") =>
    createOAuthRefreshCredential({ expires, provider, refresh });
  function mockFreshCodexCliCredentials(expires = now + DEFAULT_OAUTH_WARN_MS + 60_000) {
    readCodexCliCredentialsCachedMock.mockReturnValue(
      createOAuthRefreshCredential({
        expires,
        access: "fresh-cli-access",
        refresh: "fresh-cli-refresh",
        accountId: "acct-cli",
      }),
    );
  }
  const buildOpenAiCodexOAuthStore = (expires: number) =>
    createAuthProfileStoreFixture({
      "openai:default": createOAuthRefreshCredential({
        expires,
        access: "canonical-access",
        refresh: "canonical-refresh",
        accountId: "acct-cli",
      }),
    });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    readCodexCliCredentialsCachedMock.mockReset();
    resolveProviderIdForAuthMock.mockReset();
  });

  it.each([
    { name: "default warning window", warnAfterMs: undefined, shortLivedStatus: "ok" },
    {
      name: "explicit warning window",
      warnAfterMs: DEFAULT_OAUTH_WARN_MS,
      shortLivedStatus: "expiring",
    },
  ])("classifies OAuth and API key profiles with $name", ({ warnAfterMs, shortLivedStatus }) => {
    const store = createAuthProfileStoreFixture({
      "anthropic:ok": oauth(now + DEFAULT_OAUTH_WARN_MS + 60_000, "anthropic"),
      "anthropic:expiring": oauth(now + 10_000, "anthropic"),
      "anthropic:short-lived": oauth(now + 60 * 60_000, "anthropic"),
      "anthropic:manual-renewal": parseLegacyCredentialEntry({
        type: "oauth",
        provider: "anthropic",
        access: "access",
        refresh: "",
        expires: now + 60 * 60_000,
      })!,
      "anthropic:expired": oauth(now - 10_000, "anthropic"),
      "anthropic:api": createApiKeyCredential("anthropic", "sk-ant-api"),
    });

    const summary = buildAuthHealthSummary({
      store,
      warnAfterMs,
    });

    expect(profileStatuses(summary)).toEqual({
      "anthropic:ok": "ok",
      "anthropic:expiring": "expiring",
      "anthropic:short-lived": shortLivedStatus,
      "anthropic:manual-renewal": "expiring",
      "anthropic:expired": "expired",
      "anthropic:api": "static",
    });

    const provider = summary.providers.find((entry) => entry.provider === "anthropic");
    expect(provider?.status).toBe("expired");
    expect(
      provider?.profiles.find((profile) => profile.profileId === "anthropic:expired")?.status,
    ).toBe("expired");
  });

  it.each<[string, AuthProfileCredential, string, string?]>([
    [
      "unresolved sidecar",
      {
        ...oauth(now + DEFAULT_OAUTH_WARN_MS),
        provider: "openai-codex",
        access: "",
        refresh: "",
        oauthRef: {
          source: "openclaw-credentials",
          provider: "openai-codex",
          id: "0123456789abcdef0123456789abcdef",
        },
      },
      "missing",
      "unresolved_ref",
    ],
    [
      "missing OAuth",
      { type: "oauth", provider: "openai" } as unknown as OAuthCredential,
      "missing",
      "missing_credential",
    ],
    [
      "command-shaped key",
      createApiKeyCredential("zai", "openclaw onboard --auth-choice zai-coding-global"),
      "missing",
      "malformed_api_key",
    ],
    [
      "invalid token expiry",
      { type: "token", provider: "github-copilot", token: "gh-token", expires: 0 },
      "missing",
      "invalid_expires",
    ],
    ["out-of-range OAuth expiry", oauth(MAX_DATE_TIMESTAMP_MS + 1), "missing"],
    ["expired OAuth without refresh", oauth(now - 10_000, "google-antigravity", ""), "expired"],
  ])(
    "classifies %s without consulting native Codex credentials",
    (_name, credential, status, reasonCode) => {
      mockFreshCodexCliCredentials();
      const summary = buildAuthHealthSummary({
        store: createAuthProfileStoreFixture({ [`${credential.provider}:default`]: credential }),
      });
      expect(summary.profiles[0]?.status).toBe(status);
      expect(summary.providers[0]?.status).toBe(status);
      if (reasonCode) {
        expect(summary.profiles[0]?.reasonCode).toBe(reasonCode);
      }
      if (status === "missing") {
        expect(summary.profiles[0]?.expiresAt).toBeUndefined();
        expect(summary.providers[0]?.expiresAt).toBeUndefined();
      }
      expect(readCodexCliCredentialsCachedMock).not.toHaveBeenCalled();
    },
  );

  it("uses ordered usable profiles for provider health while keeping stale inventory visible", () => {
    const store = {
      version: 1,
      profiles: {
        "openai:default": oauth(now - 10_000),
        "openai:named": oauth(now + DEFAULT_OAUTH_WARN_MS + 60_000),
      },
      order: {
        openai: ["openai:named"],
      },
    };

    const summary = buildAuthHealthSummary({ store });

    expect(profileStatuses(summary)).toEqual({
      "openai:default": "expired",
      "openai:named": "ok",
    });
    const provider = summary.providers.find((entry) => entry.provider === "openai");
    expect(provider?.status).toBe("ok");
    expect(provider?.expiresAt).toBe(now + DEFAULT_OAUTH_WARN_MS + 60_000);
    expect(provider?.effectiveProfiles?.map((profile) => profile.profileId)).toEqual([
      "openai:named",
    ]);
    expect(provider?.profiles.map((profile) => profile.profileId)).toEqual([
      "openai:default",
      "openai:named",
    ]);
  });

  it("honors canonical empty auth order for aliased stored profile providers", () => {
    const store = {
      version: 1,
      profiles: {
        "codex-cli:legacy": oauth(now + DEFAULT_OAUTH_WARN_MS + 60_000, "codex-cli"),
      },
      order: {
        openai: [],
      },
    };

    const summary = buildAuthHealthSummary({ store });

    const provider = summary.providers.find((entry) => entry.provider === "codex-cli");
    expect(provider?.status).toBe("missing");
    expect(provider?.effectiveProfiles).toEqual([]);
    expect(provider?.profiles.map((profile) => profile.profileId)).toEqual(["codex-cli:legacy"]);
  });

  it("uses runtime provider credentials for profile health", () => {
    const store = createAuthProfileStoreFixture({
      "anthropic:claude-cli": oauth(now - 10_000, "claude-cli"),
    });

    const summary = buildAuthHealthSummary({
      store,
      warnAfterMs: DEFAULT_OAUTH_WARN_MS,
      runtimeCredentialsByProvider: new Map([
        [
          "claude-cli",
          {
            type: "token",
            provider: "claude-cli",
            token: "fresh-cli-access",
            expires: now + DEFAULT_OAUTH_WARN_MS + 60_000,
          },
        ],
      ]),
    });

    const profile = summary.profiles.find((entry) => entry.profileId === "anthropic:claude-cli");
    expect(profile?.status).toBe("ok");
    expect(profile?.expiresAt).toBe(now + DEFAULT_OAUTH_WARN_MS + 60_000);
  });

  it.each([
    ["expired", -10_000, undefined],
    ["ok", DEFAULT_OAUTH_WARN_MS + 10_000, undefined],
    ["expiring", 2 * 60_000, 60_000],
  ] as const)(
    "keeps canonical %s health over fresh Codex CLI state",
    (status, delta, warnAfterMs) => {
      mockFreshCodexCliCredentials(now + 7 * DEFAULT_OAUTH_WARN_MS);
      const summary = buildAuthHealthSummary({
        store: buildOpenAiCodexOAuthStore(now + delta),
        warnAfterMs,
      });
      const profile = summary.profiles.find((entry) => entry.profileId === "openai:default");
      expect(profile?.status).toBe(status);
      if (status !== "expired") {
        expect(profile?.expiresAt).toBe(now + delta);
      }
    },
  );

  it("keeps unavailable profiles in explicit auth order authoritative", () => {
    const store = createAuthProfileStoreFixture({
      "claude-cli:token": {
        type: "token" as const,
        provider: "claude-cli",
        token: "fake-token",
      },
    });
    const cfg = {
      auth: {
        order: {
          "claude-cli": ["claude-cli:old-oauth"],
        },
      },
    };

    const summary = buildAuthHealthSummary({ cfg, store });

    const provider = summary.providers.find((entry) => entry.provider === "claude-cli");
    expect(provider?.status).toBe("missing");
    expect(provider?.effectiveProfiles).toEqual([]);
    expect(provider?.profiles.map((profile) => profile.profileId)).toEqual(["claude-cli:token"]);
  });

  it("does not normalize provider aliases when filtering and grouping profile health", () => {
    const store = createAuthProfileStoreFixture({
      "zai:dot": createApiKeyCredential("z.ai", "sk-dot"),
      "zai:dash": createApiKeyCredential("z-ai", "sk-dash"),
    });

    const summary = buildAuthHealthSummary({
      store,
      providers: ["zai"],
    });

    expect(summary.profiles).toEqual([]);
    expect(summary.providers).toEqual([
      {
        provider: "zai",
        status: "missing",
        effectiveProfiles: [],
        profiles: [],
      },
    ]);
  });

  it("uses caller-owned plugin metadata when resolving explicit auth order", () => {
    resolveProviderIdForAuthMock.mockImplementation((provider: string, params?: unknown) => {
      const metadata = (params as { metadataSnapshot?: { plugins?: unknown[] } } | undefined)
        ?.metadataSnapshot;
      return provider === "fixture-alias" && metadata?.plugins?.length
        ? "fixture-provider"
        : provider;
    });
    const metadataSnapshot = {
      plugins: [
        {
          id: "fixture-auth-alias",
          origin: "bundled" as const,
          providerAuthAliases: { "fixture-alias": "fixture-provider" },
        },
      ],
    } as unknown as NonNullable<ProviderAuthAliasLookupParams["metadataSnapshot"]>;
    const summary = buildAuthHealthSummary({
      cfg: { auth: { order: { "fixture-provider": [] } } },
      store: createAuthProfileStoreFixture({
        "fixture-alias:token": {
          type: "token" as const,
          provider: "fixture-alias",
          token: "fake-token",
        },
      }),
      authAliasLookupParams: {
        metadataSnapshot,
      },
    });

    expect(summary.providers).toMatchObject([
      { provider: "fixture-alias", status: "missing", effectiveProfiles: [] },
    ]);
    expect(resolveProviderIdForAuthMock).toHaveBeenCalledWith(
      "fixture-alias",
      expect.objectContaining({ metadataSnapshot }),
    );
  });
});

describe("formatRemainingShort", () => {
  it("supports an explicit under-minute label override", () => {
    expect(formatRemainingShort(20_000)).toBe("1m");
    expect(formatRemainingShort(20_000, { underMinuteLabel: "soon" })).toBe("soon");
  });
});
