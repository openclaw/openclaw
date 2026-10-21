import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ensureAuthProfileStoreMock = vi.hoisted(() => vi.fn());
const listProfilesForProviderMock = vi.hoisted(() => vi.fn());
const coerceSecretRefMock = vi.hoisted(() => vi.fn());
const resolveConfiguredSecretInputWithFallbackMock = vi.hoisted(() => vi.fn());
const resolveRequiredConfiguredSecretRefInputStringMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/provider-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth")>();
  const { normalizeOptionalString } = await import("openclaw/plugin-sdk/string-coerce-runtime");
  return {
    ...actual,
    coerceSecretRef: coerceSecretRefMock,
    ensureAuthProfileStoreAsync: ensureAuthProfileStoreMock,
    listProfilesForProvider: listProfilesForProviderMock,
    normalizeOptionalSecretInput: normalizeOptionalString,
  };
});

vi.mock("openclaw/plugin-sdk/secret-input-runtime", () => ({
  resolveConfiguredSecretInputWithFallback: resolveConfiguredSecretInputWithFallbackMock,
  resolveRequiredConfiguredSecretRefInputString: resolveRequiredConfiguredSecretRefInputStringMock,
}));

import { resolveFirstGithubToken } from "./auth.js";

function resolveToken(options: Partial<Parameters<typeof resolveFirstGithubToken>[0]> = {}) {
  return resolveFirstGithubToken({ env: {}, ...options });
}

const tokenProfile = (token: string) => ({ type: "token", provider: "github-copilot", token });
const makeTokenRef = (source: "file" | "env", id: string) => ({ source, provider: "default", id });
const orderedConfig = (profileId: string) => ({
  auth: { order: { "github-copilot": [profileId] } },
});
function providerConfig(
  auth: "api-key" | "oauth",
  apiKey: NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]>[string]["apiKey"],
): OpenClawConfig {
  const provider = { auth, apiKey, baseUrl: "https://api.githubcopilot.com", models: [] };
  return { models: { providers: { "github-copilot": provider } } };
}
function setProfiles(profiles: Record<string, unknown>, order?: Record<string, string[]>) {
  ensureAuthProfileStoreMock.mockReturnValue({ version: 1, profiles, ...(order ? { order } : {}) });
  listProfilesForProviderMock.mockReturnValue(Object.keys(profiles));
}
const oauthProfile = (enterpriseUrl?: string, refresh = " durable-github-token ") => ({
  type: "oauth",
  provider: "github-copilot",
  access: "short-lived-copilot-token",
  refresh,
  expires: Date.now() + 60_000,
  ...(enterpriseUrl ? { enterpriseUrl } : {}),
});

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/provider-auth");
  vi.doUnmock("openclaw/plugin-sdk/secret-input-runtime");
  vi.resetModules();
});

describe("resolveFirstGithubToken", () => {
  beforeEach(() => {
    setProfiles({
      "github-copilot:github": {
        type: "token",
        tokenRef: makeTokenRef("file", "/providers/github-copilot/token"),
      },
    });
    coerceSecretRefMock.mockImplementation((value: unknown) =>
      typeof value === "object" && value !== null && "source" in value ? value : null,
    );
    resolveRequiredConfiguredSecretRefInputStringMock.mockImplementation(
      async ({ value }: { value: unknown }) => (value ? "resolved-profile-token" : undefined),
    );
    resolveConfiguredSecretInputWithFallbackMock.mockResolvedValue({
      value: "test-token-placeholder",
      source: "config",
      secretRefConfigured: false,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    ensureAuthProfileStoreMock.mockReset();
    listProfilesForProviderMock.mockReset();
    coerceSecretRefMock.mockReset();
    resolveConfiguredSecretInputWithFallbackMock.mockReset();
    resolveRequiredConfiguredSecretRefInputStringMock.mockReset();
  });

  it.each([
    {
      label: "provider keys are matched case-insensitively",
      providerKey: " GITHUB-COPILOT ",
      configuredOrder: ["github-copilot:first"],
      storedOrder: ["github-copilot:preferred"],
      expectedToken: "preferred-token",
    },
    {
      label: "an explicit empty order does not fall back to another account",
      configuredOrder: [],
      expectedToken: "",
    },
  ])("honors auth profile order when $label", async (testCase) => {
    const providerKey = testCase.providerKey ?? "github-copilot";
    setProfiles(
      {
        "github-copilot:first": tokenProfile("first-token"),
        "github-copilot:preferred": tokenProfile("preferred-token"),
      },
      testCase.storedOrder ? { [providerKey]: testCase.storedOrder } : undefined,
    );

    await expect(
      resolveToken({
        config: {
          auth: { order: { [providerKey]: testCase.configuredOrder } },
        },
      }),
    ).resolves.toEqual({
      githubToken: testCase.expectedToken,
      ...(testCase.expectedToken ? { profileId: "github-copilot:preferred" } : {}),
    });
  });

  it.each([
    {
      label: "a public GitHub OAuth account",
      enterpriseUrl: undefined,
      refresh: " durable-github-token ",
      expectedDomain: "github.com",
    },
    {
      label: "an enterprise GitHub OAuth account",
      enterpriseUrl: "acme.ghe.com",
      refresh: " durable-github-token ",
      expectedDomain: "acme.ghe.com",
    },
    {
      label: "an enterprise OAuth account with a whitespace-only durable credential",
      enterpriseUrl: "acme.ghe.com",
      refresh: "   ",
      expectedDomain: undefined,
    },
  ])("uses the durable credential when explicit order selects $label", async (testCase) => {
    setProfiles({
      "github-copilot:first": tokenProfile("first-token"),
      "github-copilot:preferred": oauthProfile(testCase.enterpriseUrl, testCase.refresh),
    });

    await expect(
      resolveToken({ config: orderedConfig("github-copilot:preferred") }),
    ).resolves.toEqual(
      testCase.expectedDomain
        ? {
            githubToken: "durable-github-token",
            githubDomain: testCase.expectedDomain,
            profileId: "github-copilot:preferred",
          }
        : { githubToken: "" },
    );
  });

  it("rejects an explicitly ordered OAuth account with an unsupported enterprise domain", async () => {
    setProfiles({
      "github-copilot:preferred": oauthProfile("attacker.example", "durable-github-token"),
    });

    await expect(
      resolveToken({ config: orderedConfig("github-copilot:preferred") }),
    ).rejects.toThrow(/attacker\.example/);
  });

  it("preserves explicitly requested profiles even when account order excludes them", async () => {
    setProfiles({
      "github-copilot:first": tokenProfile("first-token"),
      "github-copilot:preferred": tokenProfile("preferred-token"),
    });

    await expect(
      resolveToken({
        config: orderedConfig("github-copilot:first"),
        profileId: "github-copilot:preferred",
      }),
    ).resolves.toEqual({
      githubToken: "preferred-token",
      profileId: "github-copilot:preferred",
    });
  });

  it("does not use ambient tokens when a direct apiKey SecretRef is unavailable", async () => {
    setProfiles({});
    const config = providerConfig("api-key", makeTokenRef("env", "MISSING_COPILOT_DIRECT_TOKEN"));
    const env = {
      COPILOT_GITHUB_TOKEN: "ambient-copilot-token",
      GH_TOKEN: "ambient-gh-token",
      GITHUB_TOKEN: "ambient-github-token",
    };
    resolveConfiguredSecretInputWithFallbackMock.mockResolvedValue({
      secretRefConfigured: true,
      unresolvedRefReason: "models.providers.github-copilot.apiKey SecretRef is unresolved.",
    });

    for (const authProfileMode of [undefined, "api_key"] as const) {
      await expect(
        resolveToken({ config, env, ...(authProfileMode ? { authProfileMode } : {}) }),
      ).rejects.toThrow("models.providers.github-copilot.apiKey");
    }
  });

  it("lets explicit api-key config outrank environment direct auth", async () => {
    const config = providerConfig("api-key", "test-token-placeholder");
    const env = { COPILOT_GITHUB_TOKEN: "test-auth-token" } as NodeJS.ProcessEnv;

    const result = await resolveToken({ config, env, authProfileMode: "api_key" });

    expect(result).toEqual({ githubToken: "test-token-placeholder" });
    expect(resolveConfiguredSecretInputWithFallbackMock).toHaveBeenCalledWith({
      config,
      env,
      value: "test-token-placeholder",
      path: "models.providers.github-copilot.apiKey",
      readFallback: expect.any(Function),
    });
    expect(resolveRequiredConfiguredSecretRefInputStringMock).not.toHaveBeenCalled();
  });

  it("ignores inactive apiKey refs for OAuth profiles and profile-less direct auth", async () => {
    setProfiles({ "github-copilot:github": tokenProfile("profile-token") });
    resolveRequiredConfiguredSecretRefInputStringMock.mockResolvedValue(undefined);
    const config = providerConfig("oauth", makeTokenRef("env", "MISSING_COPILOT_DIRECT_TOKEN"));

    await expect(
      resolveToken({
        config,
        env: { COPILOT_GITHUB_TOKEN: "ambient-token" } as NodeJS.ProcessEnv,
      }),
    ).resolves.toEqual({ githubToken: "ambient-token" });
    expect(resolveConfiguredSecretInputWithFallbackMock).not.toHaveBeenCalled();

    setProfiles({});
    resolveConfiguredSecretInputWithFallbackMock.mockResolvedValue({ secretRefConfigured: false });
    await expect(resolveToken({ config })).resolves.toEqual({
      githubToken: "",
    });
    expect(resolveConfiguredSecretInputWithFallbackMock).toHaveBeenCalledWith(
      expect.objectContaining({ value: undefined }),
    );
  });

  it.each(["GITHUB_TOKEN"])("does not authenticate with generic %s", async (key) => {
    setProfiles({});
    await expect(resolveToken({ env: { [key]: "generic-token" } })).resolves.toEqual({
      githubToken: "",
    });
  });

  it("never replaces an explicitly requested missing profile with ambient auth or another profile", async () => {
    setProfiles({
      "github-copilot:github": { type: "token", token: "other-profile-token" },
    });

    await expect(
      resolveToken({
        env: { COPILOT_GITHUB_TOKEN: "ambient-token" },
        profileId: "github-copilot:missing",
      }),
    ).resolves.toEqual({ githubToken: "" });
    expect(resolveRequiredConfiguredSecretRefInputStringMock).not.toHaveBeenCalled();
  });

  it("does not read process.env or swallow an explicitly requested unavailable profile ref", async () => {
    const tokenRef = makeTokenRef("env", "COPILOT_PROCESS_ONLY_TOKEN");
    vi.stubEnv(tokenRef.id, "process-only-token");
    setProfiles({
      "github-copilot:github": { type: "token", tokenRef },
      "github-copilot:other": { type: "token", token: "other-profile-token" },
    });
    resolveRequiredConfiguredSecretRefInputStringMock.mockRejectedValue(
      new Error("github-copilot:github tokenRef unavailable"),
    );

    await expect(resolveToken({ profileId: "github-copilot:github" })).rejects.toThrow(
      "github-copilot:github tokenRef unavailable",
    );
    expect(resolveRequiredConfiguredSecretRefInputStringMock).toHaveBeenCalledWith(
      expect.objectContaining({ config: {}, env: {}, value: tokenRef }),
    );
  });

  it("resolves a profile SecretRef before stale plaintext through the central resolver", async () => {
    const config = { secrets: { defaults: { provider: "default" } } } as never;
    const env = {} as NodeJS.ProcessEnv;
    const tokenRef = makeTokenRef("file", "/providers/github-copilot/token");
    setProfiles({
      "github-copilot:github": { type: "token", token: "stale-profile-token", tokenRef },
    });
    const result = await resolveToken({ config, env });

    expect(result).toEqual({
      githubToken: "resolved-profile-token",
      profileId: "github-copilot:github",
    });
    expect(resolveRequiredConfiguredSecretRefInputStringMock).toHaveBeenCalledWith({
      config,
      env,
      value: tokenRef,
      path: "providers.github-copilot.authProfiles.github-copilot:github.tokenRef",
    });
  });
});
