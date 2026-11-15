import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loadStore = vi.hoisted(() => vi.fn());
const resolveDirectSecret = vi.hoisted(() => vi.fn());
const resolveProfileSecret = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/provider-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth")>()),
  ensureAuthProfileStoreAsync: loadStore,
}));

// mock-isolation: Credential resolution uses fixture secrets, never the operator's secret providers.
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
const PROFILE = "github-copilot:github";
const pair = () => ({
  [FIRST]: tokenProfile("first-token"),
  [PREFERRED]: tokenProfile("preferred-token"),
});
const expectToken = (
  options: Parameters<typeof resolveToken>[0],
  expected: Awaited<ReturnType<typeof resolveToken>>,
) => expect(resolveToken(options)).resolves.toEqual(expected);
const setProfile = (profile: Record<string, unknown>) =>
  setProfiles({ [PROFILE]: { provider: "github-copilot", ...profile } });
function providerConfig(
  auth: "api-key" | "oauth",
  apiKey: NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]>[string]["apiKey"],
): OpenClawConfig {
  const provider = { auth, apiKey, baseUrl: "https://api.githubcopilot.com", models: [] };
  return { models: { providers: { "github-copilot": provider } } };
}
function setProfiles(profiles: Record<string, unknown>, order?: Record<string, string[]>) {
  loadStore.mockReturnValue({ version: 1, profiles, ...(order ? { order } : {}) });
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
    setProfile({
      type: "token",
      tokenRef: makeTokenRef("file", "/providers/github-copilot/token"),
    });
    resolveProfileSecret.mockImplementation(async ({ value }: { value: unknown }) =>
      value ? "resolved-profile-token" : undefined,
    );
    resolveDirectSecret.mockResolvedValue({
      value: "test-token-placeholder",
      secretRefConfigured: false,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    loadStore.mockReset();
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
    setProfiles({ [PREFERRED]: oauthProfile("attacker.example", "durable-github-token") });
    await expect(resolveToken({ config: orderedConfig(PREFERRED) })).rejects.toThrow(
      /attacker\.example/,
    );
  });

  it.each([PREFERRED, "github-copilot:missing"])(
    "uses only the explicitly requested profile %s",
    async (profileId) => {
      setProfiles(pair());
      await expectToken(
        { config: orderedConfig(FIRST), profileId, env: { COPILOT_GITHUB_TOKEN: "ambient-token" } },
        profileId === PREFERRED
          ? { githubToken: "preferred-token", profileId }
          : { githubToken: "" },
      );
      if (profileId !== PREFERRED) {
        expect(resolveProfileSecret).not.toHaveBeenCalled();
      }
    },
  );

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

    await expectToken(
      { config, env, authProfileMode: "api_key" },
      { githubToken: "test-token-placeholder" },
    );
    expect(resolveProfileSecret).not.toHaveBeenCalled();
  });

  it("ignores inactive apiKey refs for OAuth profiles and profile-less direct auth", async () => {
    setProfile(tokenProfile("profile-token"));
    resolveProfileSecret.mockResolvedValue(undefined);
    const config = providerConfig("oauth", makeTokenRef("env", "MISSING_COPILOT_DIRECT_TOKEN"));

    await expectToken(
      { config, env: { COPILOT_GITHUB_TOKEN: "ambient-token" } },
      { githubToken: "ambient-token" },
    );
    expect(resolveDirectSecret).not.toHaveBeenCalled();

    setProfiles({});
    resolveDirectSecret.mockResolvedValue({ secretRefConfigured: false });
    await expectToken({ config }, { githubToken: "" });
    expect(resolveDirectSecret).toHaveBeenCalledWith(expect.objectContaining({ value: undefined }));
  });

  it("does not authenticate with generic GITHUB_TOKEN", async () => {
    setProfiles({});
    await expectToken({ env: { GITHUB_TOKEN: "generic-token" } }, { githubToken: "" });
  });

  it("does not read process.env or swallow an explicitly requested unavailable profile ref", async () => {
    const tokenRef = makeTokenRef("env", "COPILOT_PROCESS_ONLY_TOKEN");
    vi.stubEnv(tokenRef.id, "process-only-token");
    setProfiles({
      [PROFILE]: { ...tokenProfile(""), tokenRef },
      "github-copilot:other": tokenProfile("other-profile-token"),
    });
    resolveProfileSecret.mockRejectedValue(new Error("github-copilot:github tokenRef unavailable"));

    await expect(resolveToken({ profileId: PROFILE })).rejects.toThrow(
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
    setProfile({ ...tokenProfile("stale-profile-token"), tokenRef });
    await expectToken(
      { config, env },
      { githubToken: "resolved-profile-token", profileId: PROFILE },
    );
    expect(resolveProfileSecret).toHaveBeenCalledWith({
      config,
      env,
      value: tokenRef,
      path: "providers.github-copilot.authProfiles.github-copilot:github.tokenRef",
    });
  });
});
