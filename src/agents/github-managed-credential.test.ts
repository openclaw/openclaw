import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveCommandEnv } from "../process/exec-spawn.js";
import { createDeferredCore } from "../shared/deferred.js";
import { commandResult as result } from "./github-identity.test-support.js";
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
const profileId = "ghp_66666666666666666666666666666666";
const install = (profileDir: string, token: string, commitConfig = async () => {}) =>
  installManagedGitHubProfile({ profileDir, token, commitConfig });
const rotate = (profileDir: string, token: string) =>
  refreshManagedGitHubProfile({ profileDir, token, expectedAccountId: account.id });
const enterprise = (host = "ghe.example.test", apiBaseUrl = `https://${host}/api/v3`) => ({
  gateway: { github: { host, apiBaseUrl } },
});
const personal = (accountId = account.id) =>
  preparePersonalGitHubPublicationIdentity({
    profileId,
    accountId,
    assertCurrent: () => {},
  });

describe("managed credential isolation", () => {
  let root: string;
  let env: { OPENCLAW_STATE_DIR: string; GH_TOKEN?: string };
  const profile = (scope: "system" | "agent" | "personal", agentId = "main") =>
    resolveManagedGitHubProfileDir({ agentId, scope, profileId, env });
  const publish = (config: OpenClawConfig) =>
    prepareGitHubPublicationIdentity({ config, agentId: "main", env });
  const statusFor = (config: OpenClawConfig, selectedScope: "system" | "agent") =>
    resolveGitHubToolIdentityStatus({ config, agentId: "main", selectedScope, env });
  beforeEach(() => {
    // Cases reuse token literals with different verification responses.
    clearGitHubCredentialVerificationCache();
    root = dirs.make("github-managed-");
    env = { OPENCLAW_STATE_DIR: root };
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    commands.run.mockReset().mockImplementation(async () => {
      throw new Error("Unexpected subprocess at the managed credential boundary");
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json(account));
  });
  afterEach(() => {
    clearRuntimeConfigSnapshot();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("keeps OAuth installation, rotation and personal publication at their public issuer", async () => {
    setRuntimeConfigSnapshot(enterprise());
    const profileDir = profile("personal", "");
    const initialToken = "synthetic-public-oauth-initial";
    const rotatedToken = "synthetic-public-oauth-rotated";
    const requests: Array<[url: string, publicCredential: boolean]> = [];
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      const requestUrl = url instanceof Request ? url.url : String(url);
      const authorization = new Headers(init?.headers).get("Authorization");
      requests.push([
        requestUrl,
        [initialToken, rotatedToken].some((token) => authorization === `Bearer ${token}`),
      ]);
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
    assert(authorization.status === "authorized");
    const commitConfig = vi.fn(async () => {});
    await install(profileDir, authorization.tokens.accessToken, commitConfig);
    const refreshed = await refreshGitHubOAuthToken({
      refreshToken: authorization.tokens.refreshToken,
    });
    assert(refreshed.status === "refreshed");
    await rotate(profileDir, refreshed.tokens.accessToken);
    clearGitHubCredentialVerificationCache();
    const identity = await personal();
    expect(requests).toEqual([
      ["https://github.com/login/oauth/access_token", false],
      ["https://api.github.com/user", true],
      ["https://github.com/login/oauth/access_token", false],
      ["https://api.github.com/user", true],
      ["https://api.github.com/user", true],
    ]);
    expect(commitConfig).toHaveBeenCalledOnce();
    expect(identity).toMatchObject({ host: "github.com", env: { GH_TOKEN: rotatedToken } });
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
      const config = enterprise("a.ghe.example.test");
      setRuntimeConfigSnapshot(config);
      await install(profile("personal", ""), "synthetic-personal-host-token");
      clearGitHubCredentialVerificationCache();
      const started = createDeferredCore();
      const release = createDeferredCore<Response>();
      vi.mocked(fetch).mockImplementation(async (url) => {
        const requestUrl = url instanceof Request ? url.url : url;
        expect(requestUrl).toBe("https://api.github.com/user");
        started.resolve();
        return await release.promise;
      });
      const prepared = personal();
      const outcome = expect(prepared).rejects.toThrow("GitHub identity changed");
      await started.promise;
      setRuntimeConfigSnapshot(
        enterprise(
          change === "host" ? "b.ghe.example.test" : config.gateway.github.host,
          "https://b.ghe.example.test/api/v3",
        ),
      );
      release.resolve(Response.json(account));
      await outcome;
    },
  );

  it("pins the verified system credential for broker children across profile retirement and host changes", async () => {
    const config = { tools: { github: { profileId, gitAuthor: { name: "Managed Author" } } } };
    const profileDir = profile("system");
    await install(profileDir, "synthetic-managed-before");
    const identity = await publish(config);
    setRuntimeConfigSnapshot(enterprise());
    const probes = vi.mocked(fetch).mock.calls.length;
    await expect(publish(config).then(() => undefined)).rejects.toMatchObject({
      reason: "unavailable",
    });
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
    expect(ordinary.localIdentityEnv).toMatchObject({
      GH_CONFIG_DIR: profileDir,
      GIT_AUTHOR_NAME: "Managed Author",
    });
    expect(Object.isFrozen(identity.env)).toBe(true);
  });

  it("rejects a refresh mismatch without replacing the selected credential", async () => {
    const profileDir = path.join(root, "profile");
    await install(profileDir, "synthetic-before");
    const original = await fs.readFile(path.join(profileDir, "hosts.yml"), "utf8");
    vi.mocked(fetch).mockResolvedValue(Response.json({ ...account, id: 303 }));
    await expect(rotate(profileDir, "synthetic-after")).rejects.toThrow("different account");
    expect(await fs.readFile(path.join(profileDir, "hosts.yml"), "utf8")).toBe(original);
    expect(await fs.readdir(root)).toEqual(["profile"]);
    expect(commands.run).not.toHaveBeenCalled();
  });

  it("rejects a classic token missing gh's minimum organization scope", async () => {
    const profileDir = path.join(root, "profile");
    vi.mocked(fetch).mockResolvedValue(
      Response.json(account, { headers: { "x-oauth-scopes": "repo" } }),
    );
    const commitConfig = vi.fn(async () => {});
    await expect(install(profileDir, "synthetic-scoped-token", commitConfig)).rejects.toThrow(
      "missing required",
    );
    expect(commitConfig).not.toHaveBeenCalled();
    expect(await fs.readdir(root)).toEqual([]);
    expect(commands.run).not.toHaveBeenCalled();
  });

  it("rejects a corrupt CLI config and keeps YAML credential diagnostics private", async () => {
    const profileDir = profile("system");
    await install(profileDir, "synthetic-token");
    commands.run.mockImplementation(async (argv: string[]) => {
      if (argv[0] !== "git") {
        throw new Error("Unexpected gh subprocess");
      }
      return result();
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await fs.writeFile(path.join(profileDir, "config.yml"), "editor: [invalid");
    const config = { tools: { github: { profileId } } };
    const status = await statusFor(config, "system");
    expect(status.effective.credentialState).toBe("configured_unavailable");
    await fs.writeFile(path.join(profileDir, "config.yml"), "version: 1");
    await fs.writeFile(
      path.join(profileDir, "hosts.yml"),
      "github.com:\n  oauth_token: !private synthetic-token",
    );
    await expect(publish(config)).rejects.toThrow("unavailable");
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(["agent", "personal"] as const)(
    "rejects a tokenless %s profile despite native authentication",
    async (scope) => {
      env.GH_TOKEN = "synthetic-ambient";
      const profileDir = profile(scope);
      await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });
      await fs.writeFile(path.join(profileDir, "hosts.yml"), "{}", { mode: 0o600 });
      commands.run.mockImplementation(async (argv: string[]) =>
        result(argv[0] === "gh" ? JSON.stringify({ id: 101, login: "native-user" }) : ""),
      );
      if (scope === "personal") {
        await expect(personal(101)).rejects.toThrow(/unavailable/);
      } else {
        const github = { profileId };
        const config = { agents: { entries: { main: { tools: { github } } } } };
        const status = await statusFor(config, scope);
        expect(status.effective).toMatchObject({
          credentialState: "configured_unavailable",
          account: null,
        });
        await expect(publish(config)).rejects.toThrow(/unavailable/);
      }
      expect(commands.run.mock.calls.every(([argv]) => argv[0] !== "gh")).toBe(true);
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});
