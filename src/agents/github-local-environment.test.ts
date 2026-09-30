import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AdmittedRunContext } from "./admitted-run-context.js";
import { prepareLocalGitHubEnvironment } from "./github-local-environment.js";

const mocks = vi.hoisted(() => ({
  operator: vi.fn(),
  profile: vi.fn(),
  issue: vi.fn(),
  fetch: vi.fn(),
  profileListeners: new Set<() => void>(),
}));
vi.mock("./admitted-run-context.js", () => ({ readAdmittedRunOperatorAuthority: mocks.operator }));
vi.mock("../state/user-profile-list.js", () => ({
  prepareUserProfileIdentity: mocks.profile,
  getUserProfileDisplay: () => ({ displayName: "Verified Person" }),
}));
vi.mock("../state/user-profile-events.js", () => ({
  onUserProfilesChanged: (listener: () => void) => {
    mocks.profileListeners.add(listener);
    return () => mocks.profileListeners.delete(listener);
  },
  onUserProfileEmailBindingChanged: () => () => {},
}));
vi.mock("../gateway/worker-environments/worker-github-installation-token.js", async (load) => {
  const actual =
    await load<
      typeof import("../gateway/worker-environments/worker-github-installation-token.js")
    >();
  return {
    hasWorkerGitHubAppConfiguration: actual.hasWorkerGitHubAppConfiguration,
    issueWorkerGitHubInstallationToken: mocks.issue,
  };
});

// SAFETY: the mocked admitted-run reader ignores this fixture's context fields.
const context = {} as AdmittedRunContext;
const disposers: (() => Promise<void>)[] = [];
const prepare = async (signal = new AbortController().signal, config: OpenClawConfig = {}) => {
  const result = await prepareLocalGitHubEnvironment({
    admittedRunContext: context,
    agentId: "main",
    config,
    assertCurrent: () => {},
    signal,
  });
  if (result) {
    disposers.push(result.dispose);
  }
  return result;
};

beforeEach(() => {
  vi.stubEnv("GITHUB_APP_ID", "13361");
  vi.stubEnv("GITHUB_INSTALLATION_ID", "119386");
  vi.stubEnv("GITHUB_APP_PRIVATE_KEY", "synthetic-key");
  vi.stubEnv("GITHUB_HOST", "fixture.ghe.com");
  vi.stubEnv("GITHUB_API_BASE_URL", "https://api.fixture.ghe.com");
  mocks.operator.mockReturnValue({ profileId: "person-1", assertCurrent: () => {} });
  mocks.profile.mockImplementation(async () => ({
    emailBindingIds: ["binding-1"],
    release: vi.fn(),
    readCurrentFacts: () => ({
      profile: { emails: ["github:fixture.ghe.com:123", "person@example.test"] },
    }),
  }));
  mocks.issue.mockImplementation(async () => ({
    token: "synthetic-installation-token",
    expiresAtMs: Date.now() + 60_000,
    revoke: vi.fn(),
  }));
  mocks.fetch.mockImplementation(async () => Response.json({ id: 123, login: "verified-person" }));
  vi.stubGlobal("fetch", mocks.fetch);
});
afterEach(async () => {
  await Promise.all(disposers.splice(0).map((dispose) => dispose().catch(() => {})));
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("local native GitHub environment", () => {
  it("binds isolated enterprise profiles to the requesting user and cleans only the owning run", async () => {
    const first = (await prepare())!;
    const second = (await prepare())!;
    expect(mocks.issue).toHaveBeenCalledWith({
      host: "fixture.ghe.com",
      signal: expect.any(AbortSignal),
    });
    expect(first.env.GH_CONFIG_DIR).not.toBe(second.env.GH_CONFIG_DIR);
    expect(first.env).toMatchObject({
      GH_HOST: "fixture.ghe.com",
      GH_TOKEN: "",
      GH_ENTERPRISE_TOKEN: "",
      OPENCLAW_GATEWAY_PASSWORD: "",
      GITHUB_APP_PRIVATE_KEY: "",
      GITHUB_USER_LOGIN: "verified-person",
      GIT_AUTHOR_NAME: "Verified Person",
      GIT_AUTHOR_EMAIL: "person@example.test",
    });
    expect(JSON.stringify(first.env)).not.toContain("synthetic-installation-token");
    expect(mocks.fetch).toHaveBeenCalledWith(
      "https://api.fixture.ghe.com/user/123",
      expect.objectContaining({ redirect: "error" }),
    );
    const hosts = parse(
      await fs.readFile(path.join(first.env.GH_CONFIG_DIR!, "hosts.yml"), "utf8"),
    );
    expect(hosts["fixture.ghe.com"]).toMatchObject({
      user: "x-access-token",
      oauth_token: "synthetic-installation-token",
    });
    expect((await fs.stat(first.env.GH_CONFIG_DIR!)).mode & 0o077).toBe(0);
    const [firstGrant, secondGrant] = await Promise.all(
      mocks.issue.mock.results.map((result) => result.value),
    );
    await first.dispose();
    expect(firstGrant.revoke).toHaveBeenCalledOnce();
    expect(secondGrant.revoke).not.toHaveBeenCalled();
    await expect(fs.access(first.env.GH_CONFIG_DIR!)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(second.env.GH_CONFIG_DIR!)).resolves.toBeUndefined();
    expect(() => first.assertCurrent()).toThrow();
  });

  it("does not issue for anonymous or disabled execution", async () => {
    mocks.operator.mockReturnValue(undefined);
    expect(await prepare()).toBeUndefined();
    expect(mocks.issue).not.toHaveBeenCalled();
    vi.stubEnv("GITHUB_APP_ID", "");
    vi.stubEnv("GITHUB_INSTALLATION_ID", "");
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY", "");
    expect(await prepare()).toBeUndefined();
    expect(mocks.issue).not.toHaveBeenCalled();
  });

  it.each(["agent", "system"] as const)(
    "retains the configured %s identity instead of issuing an App grant",
    async (scope) => {
      const config: OpenClawConfig = {
        agents: {
          entries: {
            main: { tools: { github: { profileId: "ghp_11111111111111111111111111111111" } } },
          },
        },
      };
      if (scope === "system") {
        config.tools = { github: config.agents!.entries!.main!.tools!.github };
        delete config.agents;
      }
      expect(await prepare(new AbortController().signal, config)).toBeUndefined();
      expect(mocks.issue).not.toHaveBeenCalled();
    },
  );

  it("rejects missing or mismatched requester identity without admin fallback", async () => {
    mocks.profile.mockResolvedValueOnce({
      emailBindingIds: [],
      release: vi.fn(),
      readCurrentFacts: () => ({ profile: { emails: ["person@example.test"] } }),
    });
    expect(await prepare()).toBeUndefined();
    expect(mocks.issue).not.toHaveBeenCalled();
    mocks.fetch.mockResolvedValueOnce(Response.json({ id: 999, login: "other-person" }));
    await expect(prepare()).rejects.toThrow("identity did not match");
    const grant = await mocks.issue.mock.results[0]!.value;
    expect(grant.revoke).toHaveBeenCalledOnce();
  });

  it("revokes on cancellation and fences authority lost during issuance", async () => {
    const abort = new AbortController();
    const prepared = (await prepare(abort.signal))!;
    abort.abort();
    await prepared.dispose();
    await expect(fs.access(prepared.env.GH_CONFIG_DIR!)).rejects.toMatchObject({ code: "ENOENT" });
    let current = true;
    mocks.operator.mockReturnValue({
      profileId: "person-1",
      assertCurrent: () => {
        if (!current) {
          throw new Error("authority ended");
        }
      },
    });
    const revoke = vi.fn();
    mocks.issue.mockImplementationOnce(async () => {
      current = false;
      return { token: "synthetic", expiresAtMs: Date.now() + 60_000, revoke };
    });
    await expect(prepare()).rejects.toThrow("authority ended");
    expect(revoke).toHaveBeenCalledOnce();
  });

  it("revokes on binding removal before another native command uses the profile", async () => {
    let current = true;
    mocks.profile.mockImplementationOnce(async () => ({
      emailBindingIds: ["binding-1"],
      release: vi.fn(),
      readCurrentFacts: () => {
        if (!current) {
          throw new Error("binding removed");
        }
        return { profile: { emails: ["github:fixture.ghe.com:123", "person@example.test"] } };
      },
    }));
    const prepared = (await prepare())!;
    const grant = await mocks.issue.mock.results[0]!.value;
    current = false;
    for (const listener of mocks.profileListeners) {
      listener();
    }
    expect(grant.revoke).toHaveBeenCalledOnce();
    await prepared.dispose();
    expect(grant.revoke).toHaveBeenCalledOnce();
    await expect(fs.access(prepared.env.GH_CONFIG_DIR!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("settles local cleanup after transient revoke failure and retries on finalization", async () => {
    const revoke = vi
      .fn()
      .mockRejectedValueOnce(new Error("synthetic network failure"))
      .mockResolvedValue(undefined);
    mocks.issue.mockResolvedValueOnce({
      token: "synthetic",
      expiresAtMs: Date.now() + 60_000,
      revoke,
    });
    const prepared = (await prepare())!;
    await expect(prepared.dispose()).resolves.toBeUndefined();
    await expect(fs.access(prepared.env.GH_CONFIG_DIR!)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(prepared.dispose()).resolves.toBeUndefined();
    expect(revoke).toHaveBeenCalledTimes(2);
  });

  it("renews the stable command profile before expiry and retires both grants", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let retired: () => void = () => {};
    const retirement = new Promise<void>((resolve) => {
      retired = resolve;
    });
    const firstRevoke = vi.fn(async () => {
      retired();
    });
    const nextRevoke = vi.fn();
    mocks.issue.mockResolvedValueOnce({
      token: "synthetic-first",
      expiresAtMs: Date.now() + 3_600_000,
      revoke: firstRevoke,
    });
    mocks.issue.mockImplementationOnce(async () => ({
      token: "synthetic-renewed",
      expiresAtMs: Date.now() + 3_600_000,
      revoke: nextRevoke,
    }));
    const prepared = (await prepare())!;
    await vi.advanceTimersByTimeAsync(3_300_000);
    await retirement;
    const hosts = parse(
      await fs.readFile(path.join(prepared.env.GH_CONFIG_DIR, "hosts.yml"), "utf8"),
    );
    expect(hosts["fixture.ghe.com"].oauth_token).toBe("synthetic-renewed");
    prepared.assertCurrent();
    await prepared.dispose();
    expect(mocks.issue).toHaveBeenCalledTimes(2);
    expect(firstRevoke).toHaveBeenCalledOnce();
    expect(nextRevoke).toHaveBeenCalledOnce();
  });

  it("expires when renewal is unavailable", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const prepared = (await prepare())!;
    mocks.issue.mockRejectedValue(new Error("synthetic issuer unavailable"));
    await vi.advanceTimersByTimeAsync(60_000);
    await prepared.dispose();
    expect(() => prepared.assertCurrent()).toThrow();
    await expect(fs.access(prepared.env.GH_CONFIG_DIR!)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
