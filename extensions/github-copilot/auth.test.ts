import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loadStore = vi.hoisted(() => vi.fn());
const listProfiles = vi.hoisted(() => vi.fn());
const coerceRef = vi.hoisted(() => vi.fn());
const resolveDirectSecret = vi.hoisted(() => vi.fn());
const resolveProfileSecret = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/provider-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth")>();
  const { normalizeOptionalString } = await import("openclaw/plugin-sdk/string-coerce-runtime");
  return {
    ...actual,
    coerceSecretRef: coerceRef,
    ensureAuthProfileStoreAsync: loadStore,
    listProfilesForProvider: listProfiles,
    normalizeOptionalSecretInput: normalizeOptionalString,
  };
});

vi.mock("openclaw/plugin-sdk/secret-input-runtime", () => ({
  resolveConfiguredSecretInputWithFallback: resolveDirectSecret,
  resolveRequiredConfiguredSecretRefInputString: resolveProfileSecret,
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
const FIRST = "github-copilot:first";
const PREFERRED = "github-copilot:preferred";
const pair = () => ({
  [FIRST]: tokenProfile("first-token"),
  [PREFERRED]: tokenProfile("preferred-token"),
});
const expectToken = (
  options: Parameters<typeof resolveToken>[0],
  expected: Awaited<ReturnType<typeof resolveToken>>,
) => expect(resolveToken(options)).resolves.toEqual(expected);
function providerConfig(
  auth: "api-key" | "oauth",
  apiKey: NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]>[string]["apiKey"],
): OpenClawConfig {
  const provider = { auth, apiKey, baseUrl: "https://api.githubcopilot.com", models: [] };
  return { models: { providers: { "github-copilot": provider } } };
}
function setProfiles(profiles: Record<string, unknown>, order?: Record<string, string[]>) {
  loadStore.mockReturnValue({ version: 1, profiles, ...(order ? { order } : {}) });
  listProfiles.mockReturnValue(Object.keys(profiles));
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
    coerceRef.mockImplementation((value: unknown) =>
      typeof value === "object" && value !== null && "source" in value ? value : null,
    );
    resolveProfileSecret.mockImplementation(async ({ value }: { value: unknown }) =>
      value ? "resolved-profile-token" : undefined,
    );
    resolveDirectSecret.mockResolvedValue({
      value: "test-token-placeholder",
      source: "config",
      secretRefConfigured: false,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    loadStore.mockReset();
    listProfiles.mockReset();
    coerceRef.mockReset();
    resolveDirectSecret.mockReset();
    resolveProfileSecret.mockReset();
  });

  it.each([
    [
      " GITHUB-COPILOT ",
      [FIRST],
      [PREFERRED],
      { githubToken: "preferred-token", profileId: PREFERRED },
    ],
    ["github-copilot", [], undefined, { githubToken: "" }],
  ] as const)(
    "honors explicit/stored auth order for %s: %j",
    async (key, configured, stored, expected) => {
      setProfiles(pair(), stored ? { [key]: [...stored] } : undefined);
      await expectToken({ config: { auth: { order: { [key]: [...configured] } } } }, expected);
    },
  );

  it.each([
    [undefined, " durable-github-token ", "github.com"],
    ["acme.ghe.com", " durable-github-token ", "acme.ghe.com"],
    ["acme.ghe.com", "   ", undefined],
  ] as const)(
    "uses the durable credential for %s with refresh %j",
    async (domain, refresh, expectedDomain) => {
      setProfiles({ ...pair(), [PREFERRED]: oauthProfile(domain, refresh) });
      await expectToken(
        { config: orderedConfig(PREFERRED) },
        expectedDomain
          ? {
              githubToken: "durable-github-token",
              githubDomain: expectedDomain,
              profileId: PREFERRED,
            }
          : { githubToken: "" },
      );
    },
  );

  it("rejects an explicitly ordered OAuth account with an unsupported enterprise domain", async () => {
    setProfiles({
      "github-copilot:preferred": oauthProfile("attacker.example", "durable-github-token"),
    });

    await expect(
      resolveToken({ config: orderedConfig("github-copilot:preferred") }),
    ).rejects.toThrow(/attacker\.example/);
  });

  it("preserves explicitly requested profiles even when account order excludes them", async () => {
    setProfiles(pair());
    await expectToken(
      { config: orderedConfig(FIRST), profileId: PREFERRED },
      {
        githubToken: "preferred-token",
        profileId: PREFERRED,
      },
    );
  });

  it("does not use ambient tokens when a direct apiKey SecretRef is unavailable", async () => {
    setProfiles({});
    const config = providerConfig("api-key", makeTokenRef("env", "MISSING_COPILOT_DIRECT_TOKEN"));
    const env = {
      COPILOT_GITHUB_TOKEN: "ambient-copilot-token",
      GH_TOKEN: "ambient-gh-token",
      GITHUB_TOKEN: "ambient-github-token",
    };
    resolveDirectSecret.mockResolvedValue({
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
    expect(resolveDirectSecret).toHaveBeenCalledWith({
      config,
      env,
      value: "test-token-placeholder",
      path: "models.providers.github-copilot.apiKey",
      readFallback: expect.any(Function),
    });
    expect(resolveProfileSecret).not.toHaveBeenCalled();
  });

  it("ignores inactive apiKey refs for OAuth profiles and profile-less direct auth", async () => {
    setProfiles({ "github-copilot:github": tokenProfile("profile-token") });
    resolveProfileSecret.mockResolvedValue(undefined);
    const config = providerConfig("oauth", makeTokenRef("env", "MISSING_COPILOT_DIRECT_TOKEN"));

    await expect(
      resolveToken({
        config,
        env: { COPILOT_GITHUB_TOKEN: "ambient-token" } as NodeJS.ProcessEnv,
      }),
    ).resolves.toEqual({ githubToken: "ambient-token" });
    expect(resolveDirectSecret).not.toHaveBeenCalled();

    setProfiles({});
    resolveDirectSecret.mockResolvedValue({ secretRefConfigured: false });
    await expect(resolveToken({ config })).resolves.toEqual({
      githubToken: "",
    });
    expect(resolveDirectSecret).toHaveBeenCalledWith(expect.objectContaining({ value: undefined }));
  });

  it("does not authenticate with generic GITHUB_TOKEN", async () => {
    setProfiles({});
    await expectToken(
      { env: { GITHUB_TOKEN: "generic-token" } },
      {
        githubToken: "",
      },
    );
  });

  it("never replaces an explicitly requested missing profile with ambient auth or another profile", async () => {
    setProfiles({
      "github-copilot:github": { type: "token", token: "other-profile-token" },
    });

    await expectToken(
      {
        env: { COPILOT_GITHUB_TOKEN: "ambient-token" },
        profileId: "github-copilot:missing",
      },
      { githubToken: "" },
    );
    expect(resolveProfileSecret).not.toHaveBeenCalled();
  });

  it("does not read process.env or swallow an explicitly requested unavailable profile ref", async () => {
    const tokenRef = makeTokenRef("env", "COPILOT_PROCESS_ONLY_TOKEN");
    vi.stubEnv(tokenRef.id, "process-only-token");
    setProfiles({
      "github-copilot:github": { type: "token", tokenRef },
      "github-copilot:other": { type: "token", token: "other-profile-token" },
    });
    resolveProfileSecret.mockRejectedValue(new Error("github-copilot:github tokenRef unavailable"));

    await expect(resolveToken({ profileId: "github-copilot:github" })).rejects.toThrow(
      "github-copilot:github tokenRef unavailable",
    );
    expect(resolveProfileSecret).toHaveBeenCalledWith(
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
    expect(resolveProfileSecret).toHaveBeenCalledWith({
      config,
      env,
      value: tokenRef,
      path: "providers.github-copilot.authProfiles.github-copilot:github.tokenRef",
    });
  });
});
