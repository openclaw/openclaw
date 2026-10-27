import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import {
  createApiKeyCredential,
  createAuthProfileStoreFixture,
  createOAuthRefreshCredential,
} from "./auth-profiles/credential-fixtures.test-support.js";
import { parseLegacyCredentialEntry } from "./auth-profiles/legacy-flat-credential.js";
import type { AuthProfileCredential, OAuthCredential } from "./auth-profiles/types.js";
import type { ProviderAuthAliasLookupParams } from "./provider-auth-aliases.js";

const { resolveProviderIdForAuthMock } = vi.hoisted(() => ({
  resolveProviderIdForAuthMock: vi.fn<
    (provider: string, params?: ProviderAuthAliasLookupParams) => string
  >((provider: string) => (provider === "codex-cli" ? "openai" : provider)),
}));

// mock-isolation: health fixtures must not read credentials from native CLI stores.
vi.mock("./cli-credentials.js", () => ({
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
  const health = (
    profiles: Record<string, AuthProfileCredential>,
    options: Omit<Parameters<typeof buildAuthHealthSummary>[0], "store"> = {},
    order?: Record<string, string[]>,
  ) =>
    buildAuthHealthSummary({
      store: { ...createAuthProfileStoreFixture(profiles), order },
      ...options,
    });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(now);
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
    const summary = health(
      {
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
      },
      { warnAfterMs },
    );

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
    expect(summary.profiles.find(({ profileId }) => profileId === "anthropic:ok")?.expiresAt).toBe(
      now + DEFAULT_OAUTH_WARN_MS + 60_000,
    );
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
  ])("classifies %s", (_name, credential, status, reasonCode) => {
    const summary = health({ [`${credential.provider}:default`]: credential });
    expect(summary.profiles[0]?.status).toBe(status);
    expect(summary.providers[0]?.status).toBe(status);
    if (reasonCode) {
      expect(summary.profiles[0]?.reasonCode).toBe(reasonCode);
    }
    if (status === "missing") {
      expect(summary.profiles[0]?.expiresAt).toBeUndefined();
      expect(summary.providers[0]?.expiresAt).toBeUndefined();
    }
  });

  it("uses ordered usable profiles for provider health while keeping stale inventory visible", () => {
    const summary = health(
      {
        "openai:default": oauth(now - 10_000),
        "openai:named": oauth(now + DEFAULT_OAUTH_WARN_MS + 60_000),
      },
      {},
      { openai: ["openai:named"] },
    );

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

  it.each(["canonical empty", "configured unavailable"])(
    "keeps %s auth order authoritative without hiding inventory",
    (mode) => {
      const empty = mode === "canonical empty";
      const providerId = empty ? "codex-cli" : "claude-cli";
      const profileId = `${providerId}:stored`;
      const credential: AuthProfileCredential = empty
        ? oauth(now + DEFAULT_OAUTH_WARN_MS + 60_000, providerId)
        : { type: "token", provider: providerId, token: "fake-token" };
      const summary = health(
        { [profileId]: credential },
        empty ? {} : { cfg: { auth: { order: { [providerId]: ["claude-cli:old-oauth"] } } } },
        empty ? { openai: [] } : undefined,
      );
      expect(summary.providers[0]).toMatchObject({ status: "missing", effectiveProfiles: [] });
      expect(summary.providers[0]?.profiles.map((profile) => profile.profileId)).toEqual([
        profileId,
      ]);
    },
  );

  it("uses runtime provider credentials for profile health", () => {
    const summary = health(
      {
        "anthropic:claude-cli": oauth(now - 10_000, "claude-cli"),
      },
      {
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
      },
    );

    const profile = summary.profiles.find((entry) => entry.profileId === "anthropic:claude-cli");
    expect(profile?.status).toBe("ok");
    expect(profile?.expiresAt).toBe(now + DEFAULT_OAUTH_WARN_MS + 60_000);
  });

  it("keeps the OAuth refresh margin above a shorter explicit warning window", () => {
    const summary = health({ "openai:default": oauth(now + 2 * 60_000) }, { warnAfterMs: 60_000 });
    expect(summary.profiles[0]).toMatchObject({ status: "expiring", expiresAt: now + 2 * 60_000 });
  });

  it("does not normalize provider aliases when filtering and grouping profile health", () => {
    const summary = health(
      {
        "zai:dot": createApiKeyCredential("z.ai", "sk-dot"),
        "zai:dash": createApiKeyCredential("z-ai", "sk-dash"),
      },
      { providers: ["zai"] },
    );

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
    resolveProviderIdForAuthMock.mockImplementation((provider, params) => {
      return provider === "fixture-alias" && params?.metadataSnapshot?.plugins.length
        ? "fixture-provider"
        : provider;
    });
    const metadataSnapshot = createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: "fixture-auth-alias",
          providerAuthAliases: { "fixture-alias": "fixture-provider" },
        },
      ],
    });
    const summary = health(
      {
        "fixture-alias:token": {
          type: "token" as const,
          provider: "fixture-alias",
          token: "fake-token",
        },
      },
      {
        cfg: { auth: { order: { "fixture-provider": [] } } },
        authAliasLookupParams: { metadataSnapshot },
      },
    );

    expect(summary.providers).toMatchObject([
      { provider: "fixture-alias", status: "missing", effectiveProfiles: [] },
    ]);
  });
});

describe("formatRemainingShort", () => {
  it("supports an explicit under-minute label override", () => {
    expect(formatRemainingShort(20_000)).toBe("1m");
    expect(formatRemainingShort(20_000, { underMinuteLabel: "soon" })).toBe("soon");
  });
});
