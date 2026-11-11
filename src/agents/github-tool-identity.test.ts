import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SecretInput } from "../config/types.secrets.js";
import type { GitHubToolIdentityConfig } from "../config/types.tools.js";
import { resolveCommandEnv } from "../process/exec-spawn.js";
import { commandResult } from "./github-identity.test-support.js";
import { clearGitHubCredentialVerificationCache } from "./github-oauth-client.js";

const { run } = vi.hoisted(() => ({ run: vi.fn() }));
const oauthMocks = vi.hoisted(() => ({ inspect: vi.fn() }));

// mock-isolation: Capture credential subprocess requests without executing host Git or gh.
vi.mock("../process/exec.js", () => ({ runCommandBuffered: run }));
vi.mock("./github-oauth-records.js", () => ({ inspectGitHubOAuthRecord: oauthMocks.inspect }));

import {
  installManagedGitHubProfile,
  matchesPreparedGitHubPublicationIdentity,
  prepareGitHubPublicationIdentity,
  prepareGitHubPublicationOptionsIdentity,
  prepareGitHubToolEnvironment,
  refreshManagedGitHubProfile,
  resolveGitHubToolIdentityStatus,
  resolveManagedGitHubAgentKey,
  resolveManagedGitHubProfileDir,
  resolveSystemGitHubIdentityStatus,
} from "./github-tool-identity.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const previewConfig = (token: SecretInput) => ({ gateway: { controlUi: { github: { token } } } });
const expectVerifiedToken = (token: string) =>
  expect(fetch).toHaveBeenCalledWith(
    "https://api.github.com/user",
    expect.objectContaining({
      headers: expect.objectContaining({ Authorization: `Bearer ${token}` }),
    }),
  );

async function writeProfile(profileDir: string, token: string) {
  await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(profileDir, "hosts.yml"), `github.com:\n  oauth_token: ${token}\n`, {
    mode: 0o600,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("GitHub tool identity", () => {
  let root: string;
  let env: NodeJS.ProcessEnv;
  const profileId = "ghp_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const profilePath = (id = profileId, scope: "system" | "agent" = "system") =>
    resolveManagedGitHubProfileDir({ agentId: "main", scope, profileId: id, env });
  const agentConfig = (github: GitHubToolIdentityConfig, agentDir = root): OpenClawConfig => ({
    agents: { entries: { main: { agentDir, tools: { github } } } },
  });
  const statusFor = (config: OpenClawConfig, selectedScope: "system" | "agent" = "system") =>
    resolveGitHubToolIdentityStatus({ config, agentId: "main", selectedScope, env });
  beforeEach(() => {
    root = tempDirs.make("openclaw-github-identity-");
    env = { OPENCLAW_STATE_DIR: root };
    clearGitHubCredentialVerificationCache();
    vi.stubEnv("GH_TOKEN", undefined);
    vi.stubEnv("GITHUB_TOKEN", undefined);
    run.mockReset();
    run.mockImplementation(async (argv: string[], options: { env?: NodeJS.ProcessEnv }) => {
      if (argv[0] === "git") {
        return commandResult();
      }
      if (argv.join(" ") === "gh auth token --hostname github.com") {
        return commandResult(options.env?.GH_TOKEN || options.env?.GITHUB_TOKEN || "native-token");
      }
      throw new Error("Unexpected credential subprocess");
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const token = new Headers(init?.headers).get("Authorization");
      const native = token?.includes("native") || token?.includes("test-token");
      return Response.json({
        id: native ? 101 : 202,
        login: native ? "native-user" : "managed-user",
        avatar_url: null,
      });
    });
    oauthMocks.inspect.mockReset().mockReturnValue({ state: "missing" });
  });

  it("gives a managed agent override complete precedence", async () => {
    const override = {
      profileId: "ghp_22222222222222222222222222222222",
      gitAuthor: { email: "agent@example.test" },
    };
    const config = {
      tools: {
        github: {
          profileId: "ghp_11111111111111111111111111111111",
          gitAuthor: { name: "System" },
        },
      },
      ...agentConfig(override),
    };

    expect(prepareGitHubToolEnvironment({ config: {}, agentId: "main" })).toMatchObject({
      localIdentityEnv: {},
      managedLocalIdentity: false,
    });

    const expectedProfileDir = profilePath("ghp_22222222222222222222222222222222", "agent");
    expect(prepareGitHubToolEnvironment({ config, agentId: "main", env })).toMatchObject({
      localIdentityEnv: {
        GH_CONFIG_DIR: expectedProfileDir,
        GIT_AUTHOR_EMAIL: "agent@example.test",
        GIT_COMMITTER_EMAIL: "agent@example.test",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "user.email",
        GIT_CONFIG_VALUE_0: "agent@example.test",
      },
      managedLocalIdentity: true,
    });
    const relocatedConfig = { ...config, ...agentConfig(override, path.join(root, "relocated")) };
    expect(
      prepareGitHubToolEnvironment({ config: relocatedConfig, agentId: "main", env }),
    ).toMatchObject({
      localIdentityEnv: { GH_CONFIG_DIR: expectedProfileDir },
    });
  });

  it("uses distinct bounded keys for distinct normalized agent ids", () => {
    const first = resolveManagedGitHubAgentKey("Reviewer-One");
    const second = resolveManagedGitHubAgentKey("reviewer-two");

    expect(first).toMatch(/^[a-f0-9]{64}$/u);
    expect(second).toMatch(/^[a-f0-9]{64}$/u);
    expect(first).not.toBe(second);
    expect(resolveManagedGitHubAgentKey(" reviewer-one ")).toBe(first);
  });

  it("keeps the selected scope distinct from the effective agent override", async () => {
    const systemProfileId = "ghp_12121212121212121212121212121212";
    const agentProfileId = "ghp_34343434343434343434343434343434";
    const systemProfileDir = profilePath(systemProfileId);
    const agentProfileDir = profilePath(agentProfileId, "agent");
    for (const profileDir of [systemProfileDir, agentProfileDir]) {
      await writeProfile(
        profileDir,
        profileDir === agentProfileDir ? "agent-token" : "system-token",
      );
    }
    const expiresAt = Date.now() + 8 * 60 * 60_000;
    oauthMocks.inspect.mockImplementation((id: string) => ({
      state: "valid",
      record: {
        profileId: id,
        accessExpiresAtMs: expiresAt,
        refreshExpiresAtMs: expiresAt + 180 * 24 * 60 * 60_000,
        scopes: id === systemProfileId ? ["repo"] : ["offline_access", "workflow"],
      },
    }));
    vi.mocked(fetch).mockImplementation(async (_url, init) => {
      const isAgent = new Headers(init?.headers).get("Authorization") === "Bearer agent-token";
      return Response.json({
        id: isAgent ? 202 : 101,
        login: isAgent ? "agent-user" : "system-user",
      });
    });
    run.mockImplementation(async (argv: string[]) => {
      if (argv[0] !== "git") {
        throw new Error("Managed status must not consult gh");
      }
      return commandResult();
    });
    const config = {
      tools: { github: { profileId: systemProfileId, kind: "oauth" as const } },
      ...agentConfig({ profileId: agentProfileId, kind: "oauth" }),
    };
    const oauthFacts = (source: string, login: string, oauthScopes: string[]) => ({
      source,
      credentialKind: "managed-oauth",
      account: { login },
      accessExpiresAtMs: expiresAt,
      refreshState: "available",
      oauthScopes,
      repositoryGrants: "unknown",
    });

    const systemSelected = await statusFor(config);
    expect(systemSelected).toMatchObject({
      selectedScope: "system",
      selected: {
        scope: "system",
        configured: true,
        identity: oauthFacts("system-configured", "system-user", ["repo"]),
      },
      effective: oauthFacts("agent-override", "agent-user", ["offline_access", "workflow"]),
    });

    const agentSelected = await statusFor(config, "agent");
    expect(agentSelected.selected).toEqual({
      scope: "agent",
      configured: true,
      identity: agentSelected.effective,
    });
  });

  it.each([
    [true, Date.now() + 60_000, "refreshing"],
    [undefined, 1, "expired"],
  ] as const)(
    "reports OAuth refresh state (pending=%s, expiry=%s): %s",
    async (pendingRefresh, refreshExpiresAtMs, expected) => {
      await writeProfile(profilePath(), "managed-token");
      run.mockImplementation(async () => commandResult());
      oauthMocks.inspect.mockReturnValue({
        state: "valid",
        record: {
          profileId,
          accessExpiresAtMs: Date.now() + 60_000,
          refreshExpiresAtMs,
          scopes: ["offline_access", "repo"],
          ...(pendingRefresh ? { pendingRefresh: true } : {}),
        },
      });

      const status = await statusFor({ tools: { github: { profileId, kind: "oauth" } } });

      expect(status.effective.refreshState).toBe(expected);
    },
  );

  it("reports a GitHub rate limit without exposing command diagnostics", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response("private diagnostics", {
        status: 403,
        headers: { "x-ratelimit-remaining": "0" },
      }),
    );
    const status = await statusFor({});
    expect(status.effective).toMatchObject({
      credentialKind: "native",
      credentialState: "rate_limited",
      evidence: "rate-limited",
      account: null,
    });
    expect(run.mock.calls.filter(([argv]) => argv[0] === "git")).toHaveLength(1);
    expect(JSON.stringify(status)).not.toContain("private");
    expect(JSON.stringify(status)).not.toContain("stderr");
  });

  it("resolves native environment precedence and reads Git author in the workspace", async () => {
    const workspace = tempDirs.make("openclaw-github-workspace-");
    await resolveGitHubToolIdentityStatus({
      config: { agents: { defaults: { workspace } } },
      agentId: "main",
      selectedScope: "system",
      env: { GH_TOKEN: "native-primary", GITHUB_TOKEN: "native-fallback" },
    });

    const ghCall = run.mock.calls.find(([argv]) => argv[0] === "gh");
    const gitCall = run.mock.calls.find(([argv]) => argv[0] === "git");
    expect(ghCall).toBeUndefined();
    expectVerifiedToken("native-primary");
    expect(gitCall?.[1]).toMatchObject({ cwd: workspace });
  });

  it.each([
    { surface: "agent", source: "env" },
    { surface: "system", source: "store" },
  ] as const)(
    "reports the native execution account in $surface status when $source owns the preview token",
    async ({ surface, source }) => {
      const params = {
        config: previewConfig("resolved-preview-status"),
        sourceConfig: previewConfig({ source, provider: "default", id: "GH_TOKEN" }),
        env: {
          GH_TOKEN: "preview-status-only",
          GITHUB_TOKEN: `native-status-${surface}-${source}`,
        },
      };
      const identity =
        surface === "system"
          ? await resolveSystemGitHubIdentityStatus(params)
          : (
              await resolveGitHubToolIdentityStatus({
                ...params,
                agentId: "main",
                selectedScope: "agent",
              })
            ).effective;

      expect(identity).toMatchObject({
        source: "system-detected",
        credentialState: "available",
        account: { login: "native-user" },
      });
    },
  );

  it("captures a frozen managed publication child environment without ambient tokens", async () => {
    Object.assign(env, {
      GH_TOKEN: "ambient-primary",
      GITHUB_TOKEN: "ambient-fallback",
      PREVIEW_SERVICE_TOKEN: "preview-only",
      GIT_EDITOR: "synthetic-before-preparation",
    });
    const profileDir = profilePath();
    await writeProfile(profileDir, "managed-publication-token");
    const accessExpiresAtMs = 1_900_000_000_000;
    oauthMocks.inspect.mockReturnValue({
      state: "valid",
      record: {
        accountId: 202,
        refreshToken: "synthetic-publication-refresh",
        accessExpiresAtMs,
      },
    });
    const params = {
      config: {
        tools: { github: { profileId, kind: "oauth" as const } },
        ...previewConfig("resolved-preview-token"),
      },
      sourceConfig: {
        tools: { github: { profileId } },
        ...previewConfig({ source: "env", provider: "default", id: "PREVIEW_SERVICE_TOKEN" }),
      },
      agentId: "main",
      env,
    };
    const preparing = prepareGitHubPublicationIdentity(params);
    env.GIT_EDITOR = "synthetic-after-preparation";
    const identity = await preparing;
    const childEnv = resolveCommandEnv({
      argv: ["gh", "api", "user"],
      baseEnv: env,
      env: identity.env,
    });

    const expectedEnv = {
      GIT_EDITOR: "synthetic-before-preparation",
      GH_CONFIG_DIR: profileDir,
      GH_TOKEN: "managed-publication-token",
      GH_ENTERPRISE_TOKEN: "managed-publication-token",
      GITHUB_TOKEN: undefined,
      GITHUB_ENTERPRISE_TOKEN: undefined,
      PREVIEW_SERVICE_TOKEN: undefined,
    };
    expect(identity).toMatchObject({ env: expectedEnv, accessExpiresAtMs });
    expect(oauthMocks.inspect).toHaveBeenCalledTimes(2);
    expect(Object.isFrozen(identity)).toBe(true);
    expect(Object.isFrozen(identity.env)).toBe(true);
    expect(
      Object.fromEntries(Object.keys(expectedEnv).map((name) => [name, childEnv[name]])),
    ).toEqual(expectedEnv);
    const matches = (id: string) =>
      matchesPreparedGitHubPublicationIdentity({
        config: { tools: { github: { profileId: id } } },
        agentId: "main",
        identity,
      });
    expect(matches(profileId)).toBe(true);
    expect(matches("ghp_cccccccccccccccccccccccccccccccc")).toBe(false);
    expect(run).not.toHaveBeenCalled();
    expectVerifiedToken("managed-publication-token");
    oauthMocks.inspect.mockClear();
    expect(await prepareGitHubPublicationOptionsIdentity(params)).toEqual({
      source: "system-configured",
      host: "github.com",
      account: { accountId: 202, login: "managed-user", avatarUrl: null },
    });
    expect(oauthMocks.inspect).not.toHaveBeenCalled();
  });

  it("reports a managed unverified transport failure honestly", async () => {
    await writeProfile(profilePath(profileId, "agent"), "managed-status-500");
    vi.mocked(fetch).mockResolvedValue(new Response("private diagnostics", { status: 500 }));
    const status = await statusFor(agentConfig({ profileId }), "agent");

    expect(status.effective.credentialState).toBe("unverified");
    expect(run.mock.calls.every(([argv]) => argv[0] === "git")).toBe(true);
    expect(JSON.stringify(status)).not.toContain("private diagnostics");
  });

  it.each(["verification", "preparation", "staging"] as const)(
    "preserves the stable credential when refresh authority closes during %s",
    async (phase) => {
      vi.stubEnv("FS_SAFE_NATIVE_MODE", "off");
      const profileDir = path.join(root, "profile");
      await fs.mkdir(profileDir, { mode: 0o700 });
      const hosts = path.join(profileDir, "hosts.yml");
      const config = path.join(profileDir, "config.yml");
      await fs.writeFile(hosts, "previous credential\n", { mode: 0o600 });
      await fs.writeFile(config, "version: 1\neditor: vim\n", { mode: 0o600 });
      const revoked = new Error("GitHub refresh authority closed");
      let authorized = true;
      let revokedAtBoundary = false;
      const revoke = () => {
        authorized = false;
        revokedAtBoundary = true;
      };
      vi.mocked(fetch).mockImplementation(async () => {
        if (phase === "verification") {
          revoke();
        }
        return Response.json({ id: 202, login: "managed-user" });
      });
      const open = fs.open.bind(fs);
      vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        const handle = await open(...args);
        if (
          phase === "staging" &&
          path.dirname(String(args[0])) === profileDir &&
          typeof args[1] === "number" &&
          (args[1] & fsConstants.O_EXCL) !== 0
        ) {
          revoke();
        }
        return handle;
      });

      await expect(
        refreshManagedGitHubProfile({
          profileDir,
          token: "replacement-credential",
          expectedAccountId: 202,
          prepareEffect: async () => {
            if (phase === "preparation") {
              await Promise.resolve();
              revoke();
            }
          },
          assertCurrent: () => {
            if (!authorized) {
              throw revoked;
            }
          },
        }),
      ).rejects.toBe(revoked);
      expect(revokedAtBoundary).toBe(true);
      expect(await fs.readFile(hosts, "utf8")).toBe("previous credential\n");
      expect(await fs.readFile(config, "utf8")).toBe("version: 1\neditor: vim\n");
      expect((await fs.readdir(profileDir)).toSorted()).toEqual(["config.yml", "hosts.yml"]);
    },
  );

  it.each([false, true])(
    "preserves the prior generation when config commit fails=%s",
    async (fails) => {
      const previousProfileDir = path.join(root, "profile-old");
      const profileDir = path.join(root, "profile-new");
      await fs.mkdir(previousProfileDir, { mode: 0o700 });
      await fs.writeFile(path.join(previousProfileDir, "hosts.yml"), "old-profile\n", {
        mode: 0o600,
      });

      const oldHosts = () => fs.readFile(path.join(previousProfileDir, "hosts.yml"), "utf8");
      const newHosts = () => fs.readFile(path.join(profileDir, "hosts.yml"), "utf8");
      const commitConfig = vi.fn(async () => {
        await expect(oldHosts()).resolves.toBe("old-profile\n");
        await expect(newHosts()).resolves.toContain("oauth_token: replacement-token");
        if (fails) {
          throw new Error("config changed concurrently");
        }
      });
      const installing = installManagedGitHubProfile({
        profileDir,
        token: "replacement-token",
        commitConfig,
      });
      if (fails) {
        await expect(installing).rejects.toThrow("config changed concurrently");
        await expect(fs.stat(profileDir)).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        await installing;
        await expect(newHosts()).resolves.toContain("oauth_token: replacement-token");
      }
      expect(commitConfig).toHaveBeenCalledOnce();
      await expect(oldHosts()).resolves.toBe("old-profile\n");
    },
  );
});
