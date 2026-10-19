import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveExecutablePath } from "../infra/executable-path.js";
import { createDeferredCore } from "../shared/deferred.js";
import { getOrCreatePromise } from "../shared/lazy-promise.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import { commandResult } from "./github-identity.test-support.js";
import { clearGitHubCredentialVerificationCache } from "./github-oauth-client.js";

const { run } = vi.hoisted(() => ({ run: vi.fn() }));
// mock-isolation: Capture credential subprocess requests without executing host Git or gh.
vi.mock("../process/exec.js", () => ({ runCommandBuffered: run }));

import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import {
  createGitHubReadIdentity,
  readCachedNativeGitHubToken,
  readNativeGitHubToken,
} from "./github-read-identity.js";
import {
  prepareGitHubPublicationIdentity,
  prepareGitHubReadIdentity as prepareRead,
  resolveManagedGitHubProfileDir,
} from "./github-tool-identity.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const native = (env: NodeJS.ProcessEnv) => readNativeGitHubToken(env, true);
const enterprise = (host: string) => ({ gateway: { github: { host } } });
const account = (id = 101, login = "native-user") => Response.json({ id, login, avatar_url: null });

beforeEach(() => {
  run.mockReset();
  vi.stubEnv("GH_TOKEN", undefined);
  vi.stubEnv("GITHUB_TOKEN", undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  clearRuntimeConfigSnapshot();
});

function pausedAuthority() {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  return {
    wait: async () => {
      entered.resolve();
      await release.promise;
    },
    async reject(pending: Promise<unknown>, reason: string, revoke: () => void) {
      const outcome = pending.then(
        () => "delivered",
        () => "refused",
      );
      try {
        expect(await Promise.race([entered.promise.then(() => "checking"), outcome])).toBe(
          "checking",
        );
        revoke();
        release.resolve();
        await expect(pending).rejects.toThrow(reason);
      } finally {
        release.resolve();
        await outcome;
      }
    },
  };
}

function startAdmitted(state: { admitted: boolean }, assertCurrent = () => {}) {
  return async <T>(start: () => T): Promise<Awaited<T>> => {
    await Promise.resolve();
    assertCurrent();
    state.admitted = true;
    let result: T;
    try {
      result = start();
    } finally {
      state.admitted = false;
    }
    return await result;
  };
}

const assertActive =
  (state: { active: boolean }, reason = "caller closed") =>
  () => {
    if (!state.active) {
      throw new Error(reason);
    }
  };

describe("native GitHub identity absence", () => {
  const launchFailure = (code = "ENOENT") => ({
    ...commandResult("", 1, "synthetic-launch-diagnostic"),
    code: null,
    termination: "error" as const,
    error: Object.assign(new Error("Synthetic launch failure"), { code }),
  });
  const absentEnvironment = () => {
    run.mockResolvedValue(launchFailure());
    const root = tempDirs.make("github-native-absence-");
    return { PATH: root, GH_CONFIG_DIR: root, GH_TOKEN: undefined, GITHUB_TOKEN: undefined };
  };

  it("refuses present native hosts.yml rather than treating it as anonymous", async () => {
    const env = absentEnvironment();
    await fs.writeFile(path.join(env.GH_CONFIG_DIR, "hosts.yml"), "{}\n");
    await expect(native(env)).rejects.toMatchObject({ reason: "unavailable" });
    expect(run).toHaveBeenCalledOnce();
  });

  it("rejects a symbolic native configuration directory", async () => {
    const env = absentEnvironment();
    const link = path.join(env.GH_CONFIG_DIR, "native-link");
    await fs.symlink(env.GH_CONFIG_DIR, link, "junction");
    await expect(native({ ...env, GH_CONFIG_DIR: link })).rejects.toMatchObject({
      reason: "unavailable",
    });
  });

  it("does not interpret unreadable configuration metadata as absence", async () => {
    const env = absentEnvironment();
    vi.spyOn(fs, "lstat").mockRejectedValue(
      Object.assign(new Error("Synthetic permission failure"), { code: "EACCES" }),
    );
    await expect(native(env)).rejects.toMatchObject({ reason: "unverified" });
  });

  it("detects a broken interpreter installed after a cached executable miss", async () => {
    const env = absentEnvironment();
    const cwd = process.cwd();
    expect(resolveExecutablePath("gh", { env, cwd })).toBeUndefined();
    await fs.writeFile(
      path.join(env.PATH, process.platform === "win32" ? "gh.cmd" : "gh"),
      "#!/missing/interpreter\n",
      { mode: 0o755 },
    );
    expect(resolveExecutablePath("gh", { env, cwd })).toBeUndefined();
    await expect(native(env)).rejects.toMatchObject({ reason: "unverified" });
  });

  it("rejects an ENOENT caused by an unavailable working directory", async () => {
    const env = absentEnvironment();
    vi.spyOn(process, "cwd").mockImplementation(() => {
      throw Object.assign(new Error("Missing cwd"), { code: "ENOENT" });
    });
    await expect(native(env)).rejects.toMatchObject({ reason: "unverified" });
  });

  it("uses native environment precedence without needing the optional CLI", async () => {
    await expect(
      native({ GH_TOKEN: "synthetic-primary", GITHUB_TOKEN: "synthetic-secondary" }),
    ).resolves.toBe("synthetic-primary");
    await expect(native({ GH_TOKEN: "", GITHUB_TOKEN: "synthetic-secondary" })).resolves.toBe(
      "synthetic-secondary",
    );
    await expect(native({ GH_TOKEN: " \n", GITHUB_TOKEN: "synthetic-secondary" })).rejects.toThrow(
      "one non-empty line",
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("scrubs public ambient credentials for a ghe.com lookup", async () => {
    setRuntimeConfigSnapshot(enterprise("tenant.ghe.com"));
    run.mockImplementation(async (_argv, options) =>
      commandResult(options.env.GH_TOKEN || options.env.GITHUB_TOKEN || "stored-tenant-token"),
    );
    await expect(
      readNativeGitHubToken({
        GH_TOKEN: "synthetic-public-token",
        GITHUB_TOKEN: "synthetic-public-secondary",
      }),
    ).resolves.toBe("stored-tenant-token");
  });

  it("separates cached native tokens by Enterprise host", async () => {
    const env = {
      GH_CONFIG_DIR: tempDirs.make("github-native-host-cache-"),
      GH_TOKEN: undefined,
      GITHUB_TOKEN: undefined,
      GH_ENTERPRISE_TOKEN: undefined,
      GITHUB_ENTERPRISE_TOKEN: undefined,
    };
    run
      .mockResolvedValueOnce(commandResult("host-a-token"))
      .mockResolvedValueOnce(commandResult("host-b-token"));
    setRuntimeConfigSnapshot(enterprise("a.ghe.example.test"));
    await expect(readCachedNativeGitHubToken(env)).resolves.toBe("host-a-token");
    setRuntimeConfigSnapshot(enterprise("b.ghe.example.test"));
    await expect(readCachedNativeGitHubToken(env)).resolves.toBe("host-b-token");
    expect(run.mock.calls.map(([argv]) => argv)).toEqual([
      ["gh", "auth", "token", "--hostname", "a.ghe.example.test"],
      ["gh", "auth", "token", "--hostname", "b.ghe.example.test"],
    ]);
  });

  it("rejects an ambient Enterprise token bound to another host", async () => {
    setRuntimeConfigSnapshot(enterprise("ghe.example.test"));
    const env = {
      GH_ENTERPRISE_TOKEN: "synthetic-host-a-token",
      GH_HOST: "other.ghe.example.test",
    };
    await expect(readCachedNativeGitHubToken(env)).rejects.toMatchObject({
      reason: "unverified",
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("preserves explicit undefined scrubs over inherited native environment tokens", async () => {
    vi.stubEnv("GH_TOKEN", "synthetic-preview-token");
    await expect(
      native({ GH_TOKEN: undefined, GITHUB_TOKEN: "synthetic-source-token" }),
    ).resolves.toBe("synthetic-source-token");
    await expect(native(absentEnvironment())).resolves.toBeUndefined();
  });

  it.each([
    ["C:\\xdg", "C:\\roaming", "C:\\xdg\\gh"],
    ["", "C:\\roaming", "C:\\roaming\\GitHub CLI"],
    ["", "", "C:\\user\\.config\\gh"],
  ])("checks Windows config precedence (%s, %s)", async (xdg, appData, expected) => {
    run.mockResolvedValue(launchFailure());
    const metadata = vi
      .spyOn(fs, "lstat")
      .mockRejectedValue(Object.assign(new Error("Absent fixture"), { code: "ENOENT" }));
    await withMockedPlatform("win32", async () => {
      await expect(
        native({
          GH_CONFIG_DIR: "",
          XDG_CONFIG_HOME: xdg,
          APPDATA: appData,
          USERPROFILE: "C:\\user",
          HOME: "C:\\wrong-home",
          PATH: "",
          GH_TOKEN: undefined,
          GITHUB_TOKEN: undefined,
        }),
      ).resolves.toBeUndefined();
    });
    expect(metadata.mock.calls.map(([file]) => file)).toEqual([
      expected,
      path.win32.join(expected, "config.yml"),
      path.win32.join(expected, "hosts.yml"),
    ]);
  });

  it.each([
    { label: "failed status", stdout: '{"hosts":{}}', code: 1 },
    { label: "malformed status", stdout: "not JSON", code: 0 },
    { label: "missing host map", stdout: "{}", code: 0 },
  ])("does not treat $label as anonymous native identity", async ({ stdout, code }) => {
    const outputs: ReturnType<typeof commandResult>[] = [];
    run.mockImplementation(async (argv: string[]) => {
      const result =
        argv[2] === "status"
          ? commandResult(stdout, code, "synthetic-native-diagnostic")
          : commandResult("", 1, "synthetic-token-diagnostic");
      outputs.push(result);
      return result;
    });
    await expect(native({})).rejects.toThrow(/could not be verified|credential is unavailable/u);
    expect(run.mock.calls.map(([argv]) => argv)).toEqual([
      ["gh", "auth", "token", "--hostname", "github.com"],
      ["gh", "auth", "status", "--active", "--hostname", "github.com", "--json", "hosts"],
    ]);
    expect(
      outputs.every(
        ({ stdout: out, stderr }) =>
          out.every((byte) => byte === 0) && stderr.every((byte) => byte === 0),
      ),
    ).toBe(true);
    const statusOptions = run.mock.calls[1]?.[1];
    expect(statusOptions.timeoutMs).toBeGreaterThan(0);
    expect(statusOptions.timeoutMs).toBeLessThanOrEqual(15_000);
    expect(statusOptions.maxOutputBytes).toBe(32 * 1024);
  });
});

describe("prepared GitHub read authority", () => {
  beforeEach(() => {
    clearGitHubCredentialVerificationCache();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const isNative = new Headers(init?.headers).get("Authorization")?.includes("native");
      return account(isNative ? 101 : 202, isNative ? "native-user" : "managed-user");
    });
  });

  type ReadOptions = Parameters<typeof prepareRead>[0];
  const readOptions = ({ config = {}, ...options }: Partial<ReadOptions> = {}): ReadOptions => ({
    config,
    agentId: "main",
    env: {},
    getCurrentConfig: () => config,
    assertActive: () => {},
    refresh: async () => {},
    ...options,
  });
  const read = (options: Partial<ReadOptions> = {}) => prepareRead(readOptions(options));

  it("keeps default read preparation bound to the configured Enterprise issuer", async () => {
    const config = {
      gateway: {
        github: { host: "ghe.example.test", apiBaseUrl: "https://ghe.example.test/api/v3" },
      },
    };
    const env = {
      GH_HOST: "ghe.example.test",
      GH_TOKEN: "synthetic-public-only",
      GH_ENTERPRISE_TOKEN: "native-enterprise-only",
    };
    setRuntimeConfigSnapshot(config);
    const identity = await read({ env, config });
    expect(identity.token).toBe(env.GH_ENTERPRISE_TOKEN);
    expect(fetch).toHaveBeenCalledWith(
      "https://ghe.example.test/api/v3/user",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: `Bearer ${env.GH_ENTERPRISE_TOKEN}` }),
      }),
    );
    await expect(identity.revalidate()).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledOnce();
    expect(run).not.toHaveBeenCalled();
  });

  it("caches native reads for 60 seconds but reads publication tokens live", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let token = "native-before-ttl";
    run.mockImplementation(async () => commandResult(token));
    const options = readOptions();
    const identity = await prepareRead(options);
    token = "native-after-ttl";
    now += 59_999;
    await expect(identity.revalidate()).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledOnce();
    const publication = await prepareGitHubPublicationIdentity(options);
    expect(publication.env).toMatchObject({ GH_TOKEN: token, GH_ENTERPRISE_TOKEN: token });
    expect(run).toHaveBeenCalledTimes(2);
    now += 1;
    await expect(identity.revalidate()).rejects.toMatchObject({ reason: "changed" });
    expect(run).toHaveBeenCalledTimes(3);
    expect((await prepareRead(options)).token).toBe(token);
  });

  it("shares concurrent native reads without caching an invalidated generation", async () => {
    const pending = createDeferredCore<ReturnType<typeof commandResult>>();
    const entered = createDeferredCore();
    run
      .mockImplementationOnce(() => {
        entered.resolve();
        return pending.promise;
      })
      .mockImplementation(async () => commandResult("native-new-generation"));
    const options = readOptions();
    const readers = Array.from({ length: 15 }, () => prepareRead(options));
    await entered.promise;
    // Let all admitted callers reach the shared pending native read.
    await Promise.resolve();
    expect(run).toHaveBeenCalledOnce();
    clearGitHubCredentialVerificationCache();
    expect((await prepareRead(options)).token).toBe("native-new-generation");
    pending.resolve(commandResult("native-old-generation"));
    await Promise.all(readers);
    expect((await prepareRead(options)).token).toBe("native-new-generation");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("separates native environments and observes ambient token changes immediately", async () => {
    run.mockImplementation(async (_argv, { env }) => commandResult(`native-${env.GH_CONFIG_DIR}`));
    const env: NodeJS.ProcessEnv = { GH_CONFIG_DIR: "first-profile", GH_TOKEN: undefined };
    const first = await read({ env });
    const other = await read({ env: { GH_CONFIG_DIR: "second-profile" } });
    expect(other.token).not.toBe(first.token);
    expect(run).toHaveBeenCalledTimes(2);
    env.GH_TOKEN = "native-from-environment";
    await expect(first.revalidate()).rejects.toMatchObject({ reason: "changed" });
    expect((await read({ env })).token).toBe(env.GH_TOKEN);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it.each(["refresh", "credential", "probe", "delivery"] as const)(
    "awaits caller authority before %s during identity preparation",
    async (stage) => {
      const pause = pausedAuthority();
      let phase = "refresh";
      let allowed = true;
      const refresh = vi.fn(async () => {
        phase = "credential";
      });
      run.mockImplementation(async () => {
        phase = "probe";
        return commandResult(`native-authority-${stage}`);
      });
      vi.mocked(fetch).mockImplementation(async () => {
        phase = "delivery";
        return account();
      });
      const preparing = read({
        startActive: async <T>(start: () => T): Promise<Awaited<T>> => {
          if (phase === stage) {
            await pause.wait();
          }
          if (!allowed) {
            throw new Error("grant revoked");
          }
          return await start();
        },
        refresh,
      });
      await pause.reject(preparing, "grant revoked", () => {
        expect(refresh).toHaveBeenCalledTimes(stage === "refresh" ? 0 : 1);
        expect(run).toHaveBeenCalledTimes(stage === "refresh" || stage === "credential" ? 0 : 1);
        expect(fetch).toHaveBeenCalledTimes(stage === "delivery" ? 1 : 0);
        allowed = false;
      });
    },
  );

  it.each(["before", "after"] as const)(
    "rechecks selection after delayed authority %s a retained read",
    async (stage) => {
      const pause = pausedAuthority();
      let phase = "preparing";
      const caller = { active: true };
      run.mockImplementation(async () => {
        if (phase === "before") {
          phase = "after";
        }
        return commandResult(`native-retained-${stage}`);
      });
      const identity = await read({
        assertActive: assertActive(caller),
        startActive: async <T>(start: () => T): Promise<Awaited<T>> => {
          if (phase === stage) {
            await pause.wait();
          }
          return await start();
        },
      });
      clearGitHubCredentialVerificationCache();
      run.mockClear();
      phase = "before";
      await pause.reject(identity.revalidate(), "caller closed", () => {
        expect(run).toHaveBeenCalledTimes(stage === "before" ? 0 : 1);
        caller.active = false;
      });
    },
  );

  it("starts credential and network operations inside current caller admission", async () => {
    const state = { admitted: false };
    let token = "native-before-refresh";
    const assertAdmitted = () => expect(state.admitted).toBe(true);
    run.mockImplementation(async () => {
      assertAdmitted();
      return commandResult(token);
    });
    vi.mocked(fetch).mockImplementation(async () => {
      assertAdmitted();
      return account();
    });
    const identity = await read({
      startActive: startAdmitted(state),
      refresh: async () => {
        assertAdmitted();
        token = "native-admitted-start";
      },
    });
    expect(identity.token).toBe("native-admitted-start");
    await identity.start(() => {
      assertAdmitted();
      return "read result";
    });
    expect(state.admitted).toBe(false);
  });

  it("releases shared transport admission and authorizes each caller's delivery", async () => {
    const transport = createDeferredCore<string>();
    const pending = new Map<string, Promise<string>>();
    const fetchShared = vi.fn(() => transport.promise);
    const caller = () => {
      const state = { active: true, admitted: false };
      const identity = createGitHubReadIdentity({
        token: "synthetic-shared-token",
        selection: { source: "system-detected", accountId: 101 },
        assertSelected: () => {},
        readToken: async () => "synthetic-shared-token",
        startActive: startAdmitted(state, assertActive(state, "grant revoked")),
      });
      const started = createDeferredCore();
      const result = identity.start(() => {
        expect(state.admitted).toBe(true);
        started.resolve();
        return getOrCreatePromise(pending, identity.cacheScope, fetchShared);
      });
      return { state, identity, started, result };
    };
    const leader = caller();
    const follower = caller();
    await Promise.all([leader.started.promise, follower.started.promise]);
    expect(leader.state.admitted || follower.state.admitted).toBe(false);
    expect(fetchShared).toHaveBeenCalledOnce();
    leader.state.active = false;
    transport.resolve("shared result");
    const [leaderResult, followerResult] = await Promise.all([leader.result, follower.result]);
    const publish = vi.fn((value: string) => value);
    const rejected = leader.identity.start(() => publish(leaderResult));
    await expect(rejected).rejects.toThrow("grant revoked");
    expect(publish).not.toHaveBeenCalled();
    await expect(follower.identity.start(() => publish(followerResult))).resolves.toBe(
      "shared result",
    );
    expect(publish).toHaveBeenCalledOnce();
  });

  it("does not verify credentials after read authority closes during refresh", async () => {
    const caller = { active: true };
    await expect(
      read({
        assertActive: assertActive(caller, "closed"),
        refresh: async () => {
          caller.active = false;
        },
      }),
    ).rejects.toThrow("closed");
    expect(fetch).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("binds system read authority to its selected profile and verified account", async () => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-github-read-selection-") };
    const profileId = `ghp_${"3".repeat(32)}`;
    const replacementProfileId = `ghp_${"4".repeat(32)}`;
    const configured = (selectedId: string): OpenClawConfig => ({
      tools: { github: { profileId: selectedId } },
    });
    let config = configured(profileId);
    const profileDir = resolveManagedGitHubProfileDir({
      agentId: "main",
      scope: "system",
      profileId,
      env,
    });
    await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });
    const hosts = path.join(profileDir, "hosts.yml");
    await fs.writeFile(hosts, "github.com:\n  oauth_token: read-system-before\n", {
      mode: 0o600,
    });
    const prepare = () => read({ env, config, getCurrentConfig: () => config });
    const identity = await prepare();
    expect(identity.selection).toEqual({ source: "system-configured", profileId, accountId: 202 });
    await fs.writeFile(hosts, "github.com:\n  oauth_token: read-system-rotated\n");
    await expect(identity.revalidate()).rejects.toThrow("identity changed");
    const rotated = await prepare();
    expect(rotated.selection).toEqual(identity.selection);
    expect(rotated.cacheScope).not.toBe(identity.cacheScope);
    config = configured(replacementProfileId);
    expect(() => rotated.assertSelected()).toThrow("identity changed");
    expect(run).not.toHaveBeenCalled();
  });

  it("admits explicit anonymous reads only while native credentials remain absent", async () => {
    run.mockImplementation(async (argv: string[]) =>
      argv[2] === "status" ? commandResult('{"hosts":{}}') : commandResult("", 1),
    );
    const options = readOptions();
    await expect(prepareRead(options)).rejects.toThrow("credential is unavailable");
    const identity = await prepareRead({ ...options, allowAnonymous: true });
    expect(identity.selection).toEqual({ source: "anonymous" });
    expect(identity.token).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
    await expect(identity.revalidate()).resolves.toBeUndefined();
    run.mockResolvedValue(commandResult("native-after-sign-in"));
    await expect(identity.revalidate()).rejects.toThrow("identity changed");
  });

  it("closes anonymous authority when native account configuration becomes unreadable", async () => {
    let hosts = {};
    run.mockImplementation(async (argv: string[]) =>
      argv[2] === "status" ? commandResult(JSON.stringify({ hosts })) : commandResult("", 1),
    );
    const identity = await prepareRead({ ...readOptions(), allowAnonymous: true });
    hosts = { "github.com": [{ state: "error" }] };
    await expect(identity.revalidate()).rejects.toThrow("credential is unavailable");
  });

  it("refuses anonymous fallback from a configured or rejected credential", async () => {
    const options = {
      ...readOptions({ env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-github-source-") } }),
      allowAnonymous: true as const,
    };
    const configured = { tools: { github: { profileId: `ghp_${"1".repeat(32)}` } } };
    await expect(
      prepareRead({
        ...options,
        config: configured,
        getCurrentConfig: () => configured,
      }),
    ).rejects.toThrow("credential is unavailable");
    expect(run).not.toHaveBeenCalled();
    run.mockResolvedValue(commandResult("native-rejected-source-token"));
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 401 }));
    await expect(prepareRead(options)).rejects.toThrow("credential is unavailable");
    expect(fetch).toHaveBeenCalledOnce();
  });
});
