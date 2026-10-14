import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { resolveCommandEnv } from "../process/exec-spawn.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  clearGitHubCredentialVerificationCache,
  pollGitHubOAuthDeviceToken,
  refreshGitHubOAuthToken,
} from "./github-oauth-client.js";

const commands = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("../process/exec.js", () => ({ runCommandBuffered: commands.run }));
vi.mock("./github-oauth-records.js", () => ({
  inspectGitHubOAuthRecord: () => ({ state: "missing" }),
}));

import {
  installManagedGitHubProfile,
  prepareGitHubPublicationIdentity,
  preparePersonalGitHubPublicationIdentity,
  prepareGitHubToolEnvironment,
  refreshManagedGitHubProfile,
  resolveGitHubToolIdentityStatus,
  resolveManagedGitHubProfileDir,
} from "./github-tool-identity.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const account = { id: 202, login: "managed-user", avatar_url: null };
const result = (stdout = "") => ({
  stdout: Buffer.from(stdout),
  stderr: Buffer.alloc(0),
  code: 0,
  signal: null,
  killed: false,
  termination: "exit" as const,
});

describe("managed credential isolation", () => {
  beforeEach(() => {
    // Cases reuse token literals with different verification responses.
    clearGitHubCredentialVerificationCache();
    commands.run.mockReset().mockImplementation(async () => {
      throw new Error("Unexpected subprocess at the managed credential boundary");
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response(JSON.stringify(account)),
    );
  });
  afterEach(() => {
    clearRuntimeConfigSnapshot();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("keeps OAuth installation, rotation and personal publication at their public issuer", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", dirs.make("github-oauth-issuer-"));
    setRuntimeConfigSnapshot({
      gateway: {
        github: { host: "ghe.example.test", apiBaseUrl: "https://ghe.example.test/api/v3" },
      },
    });
    const profileId = "ghp_66666666666666666666666666666666";
    const profileDir = resolveManagedGitHubProfileDir({
      agentId: "",
      scope: "personal",
      profileId,
    });
    const initialToken = "synthetic-public-oauth-initial";
    const rotatedToken = "synthetic-public-oauth-rotated";
    const requests: Array<{ url: string; publicCredential: boolean }> = [];
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      const requestUrl = url instanceof Request ? url.url : String(url);
      const authorization = new Headers(init?.headers).get("Authorization");
      requests.push({
        url: requestUrl,
        publicCredential: [initialToken, rotatedToken].some(
          (token) => authorization === `Bearer ${token}`,
        ),
      });
      if (init?.method === "POST") {
        const refresh =
          init.body instanceof URLSearchParams && init.body.get("grant_type") === "refresh_token";
        return Response.json({
          access_token: refresh ? rotatedToken : initialToken,
          token_type: "bearer",
          scope: "repo workflow read:org gist",
          expires_in: 28_800,
          refresh_token: "synthetic-public-refresh",
          refresh_token_expires_in: 86400,
        });
      }
      return Response.json(account);
    });
    const authorization = await pollGitHubOAuthDeviceToken({ deviceCode: "a".repeat(40) });
    if (authorization.status !== "authorized") {
      throw new Error("The OAuth fixture did not authorize its public token");
    }
    const commitConfig = vi.fn(async () => {});
    await installManagedGitHubProfile({
      profileDir,
      token: authorization.tokens.accessToken,
      commitConfig,
    });
    const refreshed = await refreshGitHubOAuthToken({
      refreshToken: authorization.tokens.refreshToken,
    });
    if (refreshed.status !== "refreshed") {
      throw new Error("The OAuth fixture did not rotate its public token");
    }
    await refreshManagedGitHubProfile({
      profileDir,
      token: refreshed.tokens.accessToken,
      expectedAccountId: account.id,
    });
    clearGitHubCredentialVerificationCache();
    const identity = await preparePersonalGitHubPublicationIdentity({
      profileId,
      accountId: account.id,
      assertCurrent: () => {},
    });
    expect(requests).toEqual([
      { url: "https://github.com/login/oauth/access_token", publicCredential: false },
      { url: "https://api.github.com/user", publicCredential: true },
      { url: "https://github.com/login/oauth/access_token", publicCredential: false },
      { url: "https://api.github.com/user", publicCredential: true },
      { url: "https://api.github.com/user", publicCredential: true },
    ]);
    expect(commitConfig).toHaveBeenCalledOnce();
    expect(identity.host).toBe("github.com");
    expect(identity.env.GH_TOKEN).toBe(rotatedToken);
    const hosts = parseYaml(await fs.readFile(path.join(profileDir, "hosts.yml"), "utf8"));
    expect(hosts["github.com"].oauth_token).toBe(rotatedToken);
    expect((await fs.stat(profileDir)).mode & 0o777).toBe(0o700);
    for (const name of ["hosts.yml", "config.yml"]) {
      expect((await fs.stat(path.join(profileDir, name))).mode & 0o777).toBe(0o600);
    }
    expect(commands.run).not.toHaveBeenCalled();
  });

  it.each(["host", "API"])(
    "pins personal publication endpoints during verification (%s)",
    async (change) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", dirs.make("personal-host-admission-"));
      const profileId = "ghp_55555555555555555555555555555555";
      const config = {
        gateway: {
          github: { host: "a.ghe.example.test", apiBaseUrl: "https://a.ghe.example.test/api/v3" },
        },
      };
      setRuntimeConfigSnapshot(config);
      await installManagedGitHubProfile({
        profileDir: resolveManagedGitHubProfileDir({ agentId: "", scope: "personal", profileId }),
        token: "synthetic-personal-host-token",
        commitConfig: async () => {},
      });
      clearGitHubCredentialVerificationCache();
      const started = createDeferredCore();
      const release = createDeferredCore<Response>();
      vi.mocked(fetch).mockImplementation(async (url) => {
        const requestUrl = url instanceof Request ? url.url : url;
        expect(requestUrl).toBe("https://api.github.com/user");
        started.resolve();
        return await release.promise;
      });
      const prepared = preparePersonalGitHubPublicationIdentity({
        profileId,
        accountId: 202,
        assertCurrent: () => {},
      }).then((identity) => ({ host: identity.host, accountId: identity.account.accountId }));
      const outcome = expect(prepared).rejects.toThrow("GitHub identity changed");
      await started.promise;
      setRuntimeConfigSnapshot({
        gateway: {
          github: {
            host: change === "host" ? "b.ghe.example.test" : config.gateway.github.host,
            apiBaseUrl: "https://b.ghe.example.test/api/v3",
          },
        },
      });
      release.resolve(new Response(JSON.stringify(account)));
      await outcome;
    },
  );

  it("pins the verified system credential for broker children across profile retirement and host changes", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", dirs.make("github-broker-snapshot-"));
    const profileId = "ghp_33333333333333333333333333333333";
    const config = { tools: { github: { profileId, gitAuthor: { name: "Managed Author" } } } };
    const profileDir = resolveManagedGitHubProfileDir({
      agentId: "main",
      scope: "system",
      profileId,
    });
    await installManagedGitHubProfile({
      profileDir,
      token: "synthetic-managed-before",
      commitConfig: async () => {},
    });
    const identity = await prepareGitHubPublicationIdentity({ config, agentId: "main" });
    setRuntimeConfigSnapshot({
      gateway: {
        github: { host: "ghe.example.test", apiBaseUrl: "https://ghe.example.test/api/v3" },
      },
    });
    const probes = vi.mocked(fetch).mock.calls.length;
    await expect(
      prepareGitHubPublicationIdentity({ config, agentId: "main" }).then(() => undefined),
    ).rejects.toMatchObject({ reason: "unavailable" });
    expect(fetch).toHaveBeenCalledTimes(probes);
    await fs.rm(profileDir, { recursive: true });
    const child = resolveCommandEnv({
      argv: ["gh", "api", "user"],
      baseEnv: { GH_TOKEN: "synthetic-native-after" },
      env: identity.env,
    });
    expect(child.GH_TOKEN).toBe("synthetic-managed-before");
    expect(child.GH_ENTERPRISE_TOKEN).toBe("synthetic-managed-before");
    expect(child.GITHUB_TOKEN).toBeUndefined();
    expect(child.GITHUB_ENTERPRISE_TOKEN).toBeUndefined();
    const ordinary = prepareGitHubToolEnvironment({ config, agentId: "main" });
    expect(JSON.stringify(ordinary)).not.toContain("synthetic-");
    expect(ordinary.localIdentityEnv.GH_CONFIG_DIR).toBe(profileDir);
    expect(ordinary.localIdentityEnv.GIT_AUTHOR_NAME).toBe("Managed Author");
    expect(Object.isFrozen(identity.env)).toBe(true);
  });

  it("rejects a refresh mismatch without replacing the selected credential", async () => {
    const root = dirs.make("github-refresh-isolation-");
    const profileDir = path.join(root, "profile");
    await installManagedGitHubProfile({
      profileDir,
      token: "synthetic-before",
      commitConfig: async () => {},
    });
    const original = await fs.readFile(path.join(profileDir, "hosts.yml"), "utf8");
    vi.mocked(fetch).mockResolvedValue(Response.json({ ...account, id: 303 }));
    await expect(
      refreshManagedGitHubProfile({
        profileDir,
        token: "synthetic-after",
        expectedAccountId: 202,
      }),
    ).rejects.toThrow("different account");
    expect(await fs.readFile(path.join(profileDir, "hosts.yml"), "utf8")).toBe(original);
    expect(await fs.readdir(root)).toEqual(["profile"]);
    expect(commands.run).not.toHaveBeenCalled();
  });

  it("rejects a classic token missing gh's minimum organization scope", async () => {
    const root = dirs.make("github-managed-scopes-");
    const profileDir = path.join(root, "profile");
    vi.mocked(fetch).mockResolvedValue(
      Response.json(account, { headers: { "x-oauth-scopes": "repo" } }),
    );
    const commitConfig = vi.fn(async () => {});
    await expect(
      installManagedGitHubProfile({ profileDir, token: "synthetic-scoped-token", commitConfig }),
    ).rejects.toThrow("missing required");
    expect(commitConfig).not.toHaveBeenCalled();
    expect(await fs.readdir(root)).toEqual([]);
    expect(commands.run).not.toHaveBeenCalled();
  });

  it("rejects a corrupt CLI config and keeps YAML credential diagnostics private", async () => {
    const env = { OPENCLAW_STATE_DIR: dirs.make("github-corrupt-config-") };
    const profileId = "ghp_44444444444444444444444444444444";
    const profileDir = resolveManagedGitHubProfileDir({
      agentId: "main",
      scope: "system",
      profileId,
      env,
    });
    await installManagedGitHubProfile({
      profileDir,
      token: "synthetic-token",
      commitConfig: async () => {},
    });
    commands.run.mockImplementation(async (argv: string[]) => {
      if (argv[0] !== "git") {
        throw new Error("Unexpected gh subprocess");
      }
      return result();
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await fs.writeFile(path.join(profileDir, "config.yml"), "editor: [invalid");
    const config = { tools: { github: { profileId } } };
    expect(
      (
        await resolveGitHubToolIdentityStatus({
          config,
          agentId: "main",
          selectedScope: "system",
          env,
        })
      ).effective.credentialState,
    ).toBe("configured_unavailable");
    await fs.writeFile(path.join(profileDir, "config.yml"), "version: 1");
    await fs.writeFile(
      path.join(profileDir, "hosts.yml"),
      "github.com:\n  oauth_token: !private synthetic-token",
    );
    await expect(
      prepareGitHubPublicationIdentity({ config, agentId: "main", env }),
    ).rejects.toThrow("unavailable");
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    { scope: "agent", hosts: "{}" },
    { scope: "personal", hosts: "{}" },
  ] as const)(
    "rejects tokenless or corrupt $scope profile $hosts despite native authentication",
    async ({ scope, hosts }) => {
      const env = {
        OPENCLAW_STATE_DIR: dirs.make("github-tokenless-isolation-"),
        GH_TOKEN: "synthetic-ambient",
      };
      vi.stubEnv("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
      const profileId = "ghp_22222222222222222222222222222222";
      const profileDir = resolveManagedGitHubProfileDir({
        agentId: "main",
        scope,
        profileId,
        env,
      });
      await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });
      await fs.writeFile(path.join(profileDir, "hosts.yml"), hosts, { mode: 0o600 });
      commands.run.mockImplementation(async (argv: string[]) =>
        result(argv[0] === "gh" ? JSON.stringify({ id: 101, login: "native-user" }) : ""),
      );
      if (scope === "personal") {
        await expect(
          preparePersonalGitHubPublicationIdentity({
            profileId,
            accountId: 101,
            assertCurrent: () => {},
          }),
        ).rejects.toThrow(/unavailable/);
      } else {
        const github = { profileId };
        const config = { agents: { entries: { main: { tools: { github } } } } };
        const status = await resolveGitHubToolIdentityStatus({
          config,
          agentId: "main",
          selectedScope: scope,
          env,
        });
        expect(status.effective).toMatchObject({
          credentialState: "configured_unavailable",
          account: null,
        });
        await expect(
          prepareGitHubPublicationIdentity({ config, agentId: "main", env }),
        ).rejects.toThrow(/unavailable/);
      }
      expect(commands.run.mock.calls.every(([argv]) => argv[0] !== "gh")).toBe(true);
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});
