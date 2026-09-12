import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveExecutablePath } from "../infra/executable-path.js";
import { createDeferredCore } from "../shared/deferred.js";
import { getOrCreatePromise } from "../shared/lazy-promise.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";

const mocks = vi.hoisted(() => ({ runCommandBuffered: vi.fn() }));
vi.mock("../process/exec.js", () => ({ runCommandBuffered: mocks.runCommandBuffered }));

import { createGitHubReadIdentity, readNativeGitHubToken } from "./github-read-identity.js";
import {
  prepareGitHubPublicationIdentity,
  prepareGitHubReadIdentity,
  resolveManagedGitHubProfileDir,
} from "./github-tool-identity.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function commandResult(stdout = "", code = 0, stderr = "") {
  return {
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
    code,
    signal: null,
    killed: false,
    termination: "exit" as const,
  };
}

describe("native GitHub identity absence", () => {
  beforeEach(() => {
    mocks.runCommandBuffered.mockReset();
    vi.stubEnv("GH_TOKEN", undefined);
    vi.stubEnv("GITHUB_TOKEN", undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  const launchFailure = (code = "ENOENT") => ({
    ...commandResult("", 1, "synthetic-launch-diagnostic"),
    code: null,
    termination: "error" as const,
    error: Object.assign(new Error("Synthetic launch failure"), { code }),
  });
  const absentEnvironment = () => {
    const root = tempDirs.make("github-native-absence-");
    return { PATH: root, GH_CONFIG_DIR: root, GH_TOKEN: undefined, GITHUB_TOKEN: undefined };
  };

  it("admits public source identity on a clean host without the optional GitHub CLI", async () => {
    mocks.runCommandBuffered.mockResolvedValue(launchFailure());
    await expect(readNativeGitHubToken(absentEnvironment(), true)).resolves.toBeUndefined();
    expect(mocks.runCommandBuffered).toHaveBeenCalledOnce();
  });

  it.each(["config.yml", "hosts.yml"])(
    "refuses a present native %s rather than treating it as anonymous",
    async (name) => {
      const env = absentEnvironment();
      await fs.writeFile(path.join(env.GH_CONFIG_DIR, name), "{}\n");
      mocks.runCommandBuffered.mockResolvedValue(launchFailure());
      await expect(readNativeGitHubToken(env, true)).rejects.toMatchObject({
        reason: "unavailable",
      });
      expect(mocks.runCommandBuffered).toHaveBeenCalledOnce();
    },
  );

  it("rejects a symbolic native configuration directory", async () => {
    const env = absentEnvironment();
    const link = path.join(env.GH_CONFIG_DIR, "native-link");
    await fs.symlink(env.GH_CONFIG_DIR, link, "junction");
    mocks.runCommandBuffered.mockResolvedValue(launchFailure());
    await expect(
      readNativeGitHubToken({ ...env, GH_CONFIG_DIR: link }, true),
    ).rejects.toMatchObject({ reason: "unavailable" });
  });

  it("does not interpret unreadable configuration metadata as absence", async () => {
    const env = absentEnvironment();
    mocks.runCommandBuffered.mockResolvedValue(launchFailure());
    vi.spyOn(fs, "lstat").mockRejectedValue(
      Object.assign(new Error("Synthetic permission failure"), { code: "EACCES" }),
    );
    await expect(readNativeGitHubToken(env, true)).rejects.toMatchObject({ reason: "unverified" });
  });

  it.each(["EACCES", "ENOEXEC"])(
    "rejects a native launch %s without an anonymous fallback",
    async (code) => {
      mocks.runCommandBuffered.mockResolvedValue(launchFailure(code));
      await expect(readNativeGitHubToken(absentEnvironment(), true)).rejects.toMatchObject({
        reason: "unverified",
      });
      expect(mocks.runCommandBuffered).toHaveBeenCalledOnce();
    },
  );

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
    mocks.runCommandBuffered.mockResolvedValue(launchFailure());
    await expect(readNativeGitHubToken(env, true)).rejects.toMatchObject({ reason: "unverified" });
  });

  it("rejects an ENOENT caused by an unavailable working directory", async () => {
    const env = absentEnvironment();
    mocks.runCommandBuffered.mockResolvedValue(launchFailure());
    vi.spyOn(process, "cwd").mockImplementation(() => {
      throw Object.assign(new Error("Missing cwd"), { code: "ENOENT" });
    });
    await expect(readNativeGitHubToken(env, true)).rejects.toMatchObject({ reason: "unverified" });
  });

  it("uses native environment precedence without needing the optional CLI", async () => {
    await expect(
      readNativeGitHubToken(
        { GH_TOKEN: "synthetic-primary", GITHUB_TOKEN: "synthetic-secondary" },
        true,
      ),
    ).resolves.toBe("synthetic-primary");
    await expect(
      readNativeGitHubToken({ GH_TOKEN: "", GITHUB_TOKEN: "synthetic-secondary" }, true),
    ).resolves.toBe("synthetic-secondary");
    await expect(
      readNativeGitHubToken({ GH_TOKEN: " \n", GITHUB_TOKEN: "synthetic-secondary" }, true),
    ).rejects.toThrow("one non-empty line");
    expect(mocks.runCommandBuffered).not.toHaveBeenCalled();
  });

  it("preserves explicit undefined scrubs over inherited native environment tokens", async () => {
    vi.stubEnv("GH_TOKEN", "synthetic-preview-token");
    await expect(
      readNativeGitHubToken({ GH_TOKEN: undefined, GITHUB_TOKEN: "synthetic-source-token" }, true),
    ).resolves.toBe("synthetic-source-token");
    mocks.runCommandBuffered.mockResolvedValue(launchFailure());
    await expect(readNativeGitHubToken(absentEnvironment(), true)).resolves.toBeUndefined();
  });

  it("fences native environment rotation and newly installed native credentials", async () => {
    const env: NodeJS.ProcessEnv = { GH_TOKEN: "synthetic-first" };
    const authenticated = createGitHubReadIdentity({
      token: "synthetic-first",
      selection: { source: "system-detected", accountId: 1 },
      assertSelected: () => {},
      readToken: () => readNativeGitHubToken(env, true),
    });
    env.GH_TOKEN = "synthetic-rotated";
    await expect(authenticated.revalidate()).rejects.toMatchObject({ reason: "changed" });
    const absent = absentEnvironment();
    mocks.runCommandBuffered.mockResolvedValue(launchFailure());
    expect(await readNativeGitHubToken(absent, true)).toBeUndefined();
    const anonymous = createGitHubReadIdentity({
      token: undefined,
      selection: { source: "anonymous" },
      assertSelected: () => {},
      readToken: () => readNativeGitHubToken(absent, true),
    });
    mocks.runCommandBuffered.mockImplementation(async () =>
      commandResult("synthetic-installed", 0, ""),
    );
    await expect(anonymous.revalidate()).rejects.toMatchObject({ reason: "changed" });
  });

  it.each([
    {
      env: {
        GH_CONFIG_DIR: "C:\\explicit",
        XDG_CONFIG_HOME: "C:\\xdg",
        APPDATA: "C:\\roaming",
        USERPROFILE: "C:\\user",
      },
      expected: "C:\\explicit",
    },
    {
      env: {
        GH_CONFIG_DIR: "",
        XDG_CONFIG_HOME: "C:\\xdg",
        APPDATA: "C:\\roaming",
        USERPROFILE: "C:\\user",
      },
      expected: "C:\\xdg\\gh",
    },
    {
      env: {
        GH_CONFIG_DIR: "",
        XDG_CONFIG_HOME: "",
        APPDATA: "C:\\roaming",
        USERPROFILE: "C:\\user",
      },
      expected: "C:\\roaming\\GitHub CLI",
    },
    {
      env: { GH_CONFIG_DIR: "", XDG_CONFIG_HOME: "", APPDATA: "", USERPROFILE: "C:\\user" },
      expected: "C:\\user\\.config\\gh",
    },
  ])("checks the canonical Windows native config location $expected", async ({ env, expected }) => {
    mocks.runCommandBuffered.mockResolvedValue(launchFailure());
    const metadata = vi
      .spyOn(fs, "lstat")
      .mockRejectedValue(Object.assign(new Error("Absent fixture"), { code: "ENOENT" }));
    await withMockedPlatform("win32", async () => {
      await expect(
        readNativeGitHubToken(
          {
            ...env,
            HOME: "C:\\wrong-home",
            PATH: "",
            GH_TOKEN: undefined,
            GITHUB_TOKEN: undefined,
          },
          true,
        ),
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
    {
      label: "unreadable account",
      stdout: '{"hosts":{"github.com":[{"state":"error"}]}}',
      code: 0,
    },
    {
      label: "timed-out account",
      stdout: '{"hosts":{"github.com":[{"state":"timeout"}]}}',
      code: 0,
    },
  ])("does not treat $label as anonymous native identity", async ({ stdout, code }) => {
    const outputs: ReturnType<typeof commandResult>[] = [];
    mocks.runCommandBuffered.mockImplementation(async (argv: string[]) => {
      const result =
        argv[2] === "status"
          ? commandResult(stdout, code, "synthetic-native-diagnostic")
          : commandResult("", 1, "synthetic-token-diagnostic");
      outputs.push(result);
      return result;
    });
    await expect(readNativeGitHubToken({}, true)).rejects.toThrow(
      /could not be verified|credential is unavailable/u,
    );
    expect(mocks.runCommandBuffered.mock.calls.map(([argv]) => argv)).toEqual([
      ["gh", "auth", "token", "--hostname", "github.com"],
      ["gh", "auth", "status", "--active", "--hostname", "github.com", "--json", "hosts"],
    ]);
    expect(
      outputs.every(
        ({ stdout: out, stderr }) =>
          out.every((byte) => byte === 0) && stderr.every((byte) => byte === 0),
      ),
    ).toBe(true);
    const statusOptions = mocks.runCommandBuffered.mock.calls[1]?.[1];
    expect(statusOptions.timeoutMs).toBeGreaterThan(0);
    expect(statusOptions.timeoutMs).toBeLessThanOrEqual(15_000);
    expect(statusOptions.maxOutputBytes).toBe(32 * 1024);
  });
});

describe("prepared GitHub read authority", () => {
  beforeEach(() => {
    mocks.runCommandBuffered.mockReset();
    vi.stubEnv("GH_TOKEN", undefined);
    vi.stubEnv("GITHUB_TOKEN", undefined);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const native = new Headers(init?.headers).get("Authorization")?.includes("native");
      return new Response(
        JSON.stringify({
          id: native ? 101 : 202,
          login: native ? "native-user" : "managed-user",
          avatar_url: null,
        }),
      );
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it.each(["refresh", "credential", "probe", "delivery"] as const)(
    "awaits caller authority before %s during identity preparation",
    async (stage) => {
      const entered = createDeferredCore();
      const release = createDeferredCore();
      let phase = "refresh";
      let allowed = true;
      const refresh = vi.fn(async () => {
        phase = "credential";
      });
      mocks.runCommandBuffered.mockImplementation(async () => {
        phase = "probe";
        return commandResult(`native-authority-${stage}`);
      });
      vi.mocked(fetch).mockImplementation(async () => {
        phase = "delivery";
        return new Response(JSON.stringify({ id: 101, login: "native-user", avatar_url: null }));
      });
      const options = {
        config: {},
        agentId: "main",
        env: {},
        getCurrentConfig: () => ({}),
        assertActive: () => {},
        startActive: async <T>(start: () => T): Promise<Awaited<T>> => {
          if (phase === stage) {
            entered.resolve();
            await release.promise;
          }
          if (!allowed) {
            throw new Error("grant revoked");
          }
          return await start();
        },
        refresh,
      };
      const preparing = prepareGitHubReadIdentity(options);
      const outcome = preparing.then(
        () => "delivered",
        () => "refused",
      );
      try {
        expect(await Promise.race([entered.promise.then(() => "checking"), outcome])).toBe(
          "checking",
        );
        expect(refresh).toHaveBeenCalledTimes(stage === "refresh" ? 0 : 1);
        expect(mocks.runCommandBuffered).toHaveBeenCalledTimes(
          stage === "refresh" || stage === "credential" ? 0 : 1,
        );
        expect(fetch).toHaveBeenCalledTimes(stage === "delivery" ? 1 : 0);
        allowed = false;
        release.resolve();
        await expect(preparing).rejects.toThrow("grant revoked");
      } finally {
        release.resolve();
        await outcome;
      }
    },
  );

  it.each(["before", "after"] as const)(
    "rechecks live selection after delayed caller authority %s a retained credential read",
    async (stage) => {
      const entered = createDeferredCore();
      const release = createDeferredCore();
      let phase = "preparing";
      let active = true;
      const config = {};
      mocks.runCommandBuffered.mockImplementation(async () => {
        if (phase === "before") {
          phase = "after";
        }
        return commandResult(`native-retained-${stage}`);
      });
      const identity = await prepareGitHubReadIdentity({
        config,
        agentId: "main",
        env: {},
        getCurrentConfig: () => config,
        assertActive: () => {
          if (!active) {
            throw new Error("caller closed");
          }
        },
        startActive: async <T>(start: () => T): Promise<Awaited<T>> => {
          if (phase === stage) {
            entered.resolve();
            await release.promise;
          }
          return await start();
        },
        refresh: async () => {},
      });
      mocks.runCommandBuffered.mockClear();
      phase = "before";
      const checking = identity.revalidate();
      const outcome = checking.then(
        () => "delivered",
        () => "refused",
      );
      try {
        expect(await Promise.race([entered.promise.then(() => "checking"), outcome])).toBe(
          "checking",
        );
        expect(mocks.runCommandBuffered).toHaveBeenCalledTimes(stage === "before" ? 0 : 1);
        active = false;
        release.resolve();
        await expect(checking).rejects.toThrow("caller closed");
      } finally {
        release.resolve();
        await outcome;
      }
    },
  );

  it("starts credential and network operations inside current caller admission", async () => {
    let admitted = false;
    const assertAdmitted = () => expect(admitted).toBe(true);
    mocks.runCommandBuffered.mockImplementation(async () => {
      assertAdmitted();
      return commandResult("native-admitted-start");
    });
    vi.mocked(fetch).mockImplementation(async () => {
      assertAdmitted();
      return new Response(JSON.stringify({ id: 101, login: "native-user", avatar_url: null }));
    });
    const identity = await prepareGitHubReadIdentity({
      config: {},
      agentId: "main",
      env: {},
      getCurrentConfig: () => ({}),
      assertActive: () => {},
      startActive: async <T>(start: () => T): Promise<Awaited<T>> => {
        await Promise.resolve();
        admitted = true;
        let result: T;
        try {
          result = start();
        } finally {
          admitted = false;
        }
        return await result;
      },
      refresh: async () => assertAdmitted(),
    });
    await identity.start(() => {
      assertAdmitted();
      return "read result";
    });
    expect(admitted).toBe(false);
  });

  it("releases admission during shared transport and authorizes each caller's final delivery", async () => {
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
        startActive: async <T>(start: () => T): Promise<Awaited<T>> => {
          await Promise.resolve();
          if (!state.active) {
            throw new Error("grant revoked");
          }
          state.admitted = true;
          let result: T;
          try {
            result = start();
          } finally {
            state.admitted = false;
          }
          return await result;
        },
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
    await expect(leader.identity.start(() => publish(leaderResult))).rejects.toThrow(
      "grant revoked",
    );
    expect(publish).not.toHaveBeenCalled();
    await expect(follower.identity.start(() => publish(followerResult))).resolves.toBe(
      "shared result",
    );
    expect(publish).toHaveBeenCalledOnce();
  });

  it("refreshes before read credential verification and fences native rotation without changing publication snapshots", async () => {
    const config = { gateway: { controlUi: { github: { token: "resolved-preview-token" } } } };
    const sourceConfig = {
      gateway: {
        controlUi: {
          github: { token: { source: "env" as const, provider: "default", id: "GH_TOKEN" } },
        },
      },
    };
    const env = { GH_TOKEN: "preview-only", GITHUB_TOKEN: "native-before" };
    const refresh = vi.fn(async () => {
      env.GITHUB_TOKEN = "native-refreshed";
    });
    const identity = await prepareGitHubReadIdentity({
      config,
      sourceConfig,
      agentId: "main",
      env,
      refresh,
      getCurrentConfig: () => config,
      assertActive: () => {},
    });
    expect(refresh).toHaveBeenCalledOnce();
    expect(identity.token).toBe("native-refreshed");
    expect(identity.selection).toEqual({ source: "system-detected", accountId: 101 });
    expect(identity).not.toHaveProperty("env");
    expect(identity.cacheScope).not.toContain("native-refreshed");
    await expect(identity.revalidate()).resolves.toBeUndefined();
    const publication = await prepareGitHubPublicationIdentity({
      config,
      sourceConfig,
      agentId: "main",
      env,
    });
    env.GITHUB_TOKEN = "native-rotated";
    await expect(identity.revalidate()).rejects.toThrow("identity changed");
    expect(publication.env.GH_TOKEN).toBe("native-refreshed");
    expect(JSON.stringify(mocks.runCommandBuffered.mock.calls)).not.toContain("preview-only");
  });

  it("does not verify credentials after read authority closes during refresh", async () => {
    let active = true;
    await expect(
      prepareGitHubReadIdentity({
        config: {},
        agentId: "main",
        env: {},
        getCurrentConfig: () => ({}),
        assertActive: () => {
          if (!active) {
            throw new Error("closed");
          }
        },
        refresh: async () => {
          active = false;
        },
      }),
    ).rejects.toThrow("closed");
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.runCommandBuffered).not.toHaveBeenCalled();
  });

  it.each(["system", "agent"] as const)(
    "binds %s read authority to its selected profile and verified account",
    async (scope) => {
      const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-github-read-selection-") };
      const profileId = `ghp_${"3".repeat(32)}`;
      const replacementProfileId = `ghp_${"4".repeat(32)}`;
      const configured = (selectedProfileId: string): OpenClawConfig => {
        const github = { profileId: selectedProfileId };
        return scope === "system"
          ? { tools: { github } }
          : { agents: { entries: { main: { tools: { github } } } } };
      };
      let config = configured(profileId);
      const profileDir = resolveManagedGitHubProfileDir({ agentId: "main", scope, profileId, env });
      await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });
      const hosts = path.join(profileDir, "hosts.yml");
      await fs.writeFile(hosts, `github.com:\n  oauth_token: read-${scope}-before\n`, {
        mode: 0o600,
      });
      const prepare = () =>
        prepareGitHubReadIdentity({
          config,
          agentId: "main",
          env,
          getCurrentConfig: () => config,
          assertActive: () => {},
          refresh: async () => {},
        });
      const identity = await prepare();
      expect(identity.selection).toEqual({
        source: scope === "system" ? "system-configured" : "agent-override",
        profileId,
        accountId: 202,
      });
      await fs.writeFile(hosts, `github.com:\n  oauth_token: read-${scope}-rotated\n`);
      await expect(identity.revalidate()).rejects.toThrow("identity changed");
      const rotated = await prepare();
      expect(rotated.selection).toEqual(identity.selection);
      expect(rotated.cacheScope).not.toBe(identity.cacheScope);
      config = configured(replacementProfileId);
      expect(() => rotated.assertSelected()).toThrow("identity changed");
      expect(mocks.runCommandBuffered).not.toHaveBeenCalled();
    },
  );

  it("admits explicit anonymous source reads only while native credentials remain absent", async () => {
    mocks.runCommandBuffered.mockImplementation(async (argv: string[]) =>
      argv[2] === "status" ? commandResult('{"hosts":{}}') : commandResult("", 1),
    );
    const options = {
      config: {},
      agentId: "main",
      env: {},
      getCurrentConfig: () => ({}),
      assertActive: () => {},
      refresh: async () => {},
    };
    await expect(prepareGitHubReadIdentity(options)).rejects.toThrow("credential is unavailable");
    const identity = await prepareGitHubReadIdentity({ ...options, allowAnonymous: true });
    expect(identity.selection).toEqual({ source: "anonymous" });
    expect(identity.token).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
    await expect(identity.revalidate()).resolves.toBeUndefined();
    mocks.runCommandBuffered.mockResolvedValue(commandResult("native-after-sign-in"));
    await expect(identity.revalidate()).rejects.toThrow("identity changed");
  });

  it("closes anonymous read authority when native account configuration becomes unreadable", async () => {
    let hosts = {};
    mocks.runCommandBuffered.mockImplementation(async (argv: string[]) =>
      argv[2] === "status" ? commandResult(JSON.stringify({ hosts })) : commandResult("", 1),
    );
    const identity = await prepareGitHubReadIdentity({
      config: {},
      agentId: "main",
      env: {},
      getCurrentConfig: () => ({}),
      assertActive: () => {},
      refresh: async () => {},
      allowAnonymous: true,
    });
    hosts = { "github.com": [{ state: "error" }] };
    await expect(identity.revalidate()).rejects.toThrow("credential is unavailable");
  });

  it("never substitutes anonymous access for a configured or rejected source credential", async () => {
    const options = {
      config: {},
      agentId: "main",
      env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-github-source-") },
      getCurrentConfig: () => ({}),
      assertActive: () => {},
      refresh: async () => {},
      allowAnonymous: true as const,
    };
    const configured = { tools: { github: { profileId: `ghp_${"1".repeat(32)}` } } };
    await expect(
      prepareGitHubReadIdentity({
        ...options,
        config: configured,
        getCurrentConfig: () => configured,
      }),
    ).rejects.toThrow("credential is unavailable");
    expect(mocks.runCommandBuffered).not.toHaveBeenCalled();
    mocks.runCommandBuffered.mockResolvedValue(commandResult("native-rejected-source-token"));
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 401 }));
    await expect(prepareGitHubReadIdentity(options)).rejects.toThrow("credential is unavailable");
    expect(fetch).toHaveBeenCalledOnce();
  });
});
