import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveStateDir } from "../config/paths.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { maybeWrapCommandWithShellSnapshot } from "./shell-snapshot.js";
import { getBashShellConfig, getShellConfig } from "./shell-utils.js";

const isWin = process.platform === "win32";
const EXEC_SHELL_SNAPSHOT_ENV = "OPENCLAW_EXEC_SHELL_SNAPSHOT";

function resolveShellSnapshotDirForTest(
  env: Record<string, string | undefined> = process.env,
): string {
  return path.join(resolveStateDir(env as NodeJS.ProcessEnv), "cache", "shell-snapshots");
}

function resolveBashForTest(): string | null {
  return isWin ? null : getBashShellConfig().shell;
}

function resolveZshForTest(): string | null {
  if (isWin) {
    return null;
  }
  if (fs.existsSync("/bin/zsh")) {
    return "/bin/zsh";
  }
  for (const entry of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(entry, "zsh");
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Keep searching the test host PATH.
    }
  }
  return null;
}

function setSnapshotStateForTest(
  stateDir: string,
  options: { home?: string; zdotdir?: string } = {},
): void {
  // Snapshot tests mutate trusted process env, not per-command untrusted env.
  setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
  if (options.home) {
    setTestEnvValue("HOME", options.home);
  }
  if (options.zdotdir) {
    process.env.ZDOTDIR = options.zdotdir;
  } else {
    delete process.env.ZDOTDIR;
  }
}

describe("exec shell snapshots", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let envSnapshot: ReturnType<typeof captureEnv>;
  const makeDir = () => tempDirs.make("openclaw-snapshot-");
  const setup = () => {
    const home = makeDir(),
      stateDir = makeDir(),
      cwd = makeDir();
    setSnapshotStateForTest(stateDir, { home });
    return { home, stateDir, cwd };
  };
  const runtimeEnv = (home: string, stateDir: string, overrides: NodeJS.ProcessEnv = {}) => ({
    ...process.env,
    HOME: home,
    OPENCLAW_STATE_DIR: stateDir,
    ...overrides,
  });
  const writeRc = (home: string, source: string | string[]) =>
    fs.writeFileSync(
      path.join(home, ".bashrc"),
      typeof source === "string" ? source : source.join("\n"),
    );
  async function run(
    shell: string,
    cwd: string,
    env: NodeJS.ProcessEnv,
    command = 'printf "%s" "$PNPM_HOME"',
  ) {
    const shellArgs = getShellConfig(shell).args;
    const wrapped = await maybeWrapCommandWithShellSnapshot({
      command,
      shell,
      shellArgs,
      cwd,
      env,
    });
    const result = spawnSync(shell, [...shellArgs, wrapped], {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(result.status).toBe(0);
    return result.stdout;
  }
  function readSnapshot(env: NodeJS.ProcessEnv) {
    const dir = resolveShellSnapshotDirForTest(env);
    const files = fs.readdirSync(dir).filter((entry) => entry.endsWith(".sh"));
    expect(files).toHaveLength(1);
    return fs.readFileSync(path.join(dir, expectDefined(files[0], "snapshot file")), "utf8");
  }

  beforeEach(() => {
    envSnapshot = captureEnv([
      "HOME",
      "USERPROFILE",
      "OPENCLAW_STATE_DIR",
      "OPENCLAW_EXEC_SHELL_SNAPSHOT",
      "PNPM_HOME",
      "ZDOTDIR",
    ]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    envSnapshot.restore();
  });

  it("leaves commands unchanged for unsupported shells", async () => {
    const command = "echo unchanged";
    const wrapped = await maybeWrapCommandWithShellSnapshot({
      command,
      shell: "/bin/fish",
      shellArgs: ["-c"],
      cwd: os.tmpdir(),
      env: {},
    });

    expect(wrapped).toBe(command);
  });

  it("does not honor per-call env for selecting the snapshot state dir", async () => {
    // Per-call env may be model/tool-controlled, so snapshot roots come from process env.
    const trustedStateDir = makeDir(),
      untrustedStateDir = makeDir();
    const home = makeDir(),
      untrustedHome = makeDir();
    const sideEffectPath = path.join(untrustedHome, "side-effect");
    setSnapshotStateForTest(trustedStateDir, { home });
    writeRc(untrustedHome, `touch ${JSON.stringify(sideEffectPath)}\n`);
    const command = "echo unchanged";
    const wrapped = await maybeWrapCommandWithShellSnapshot({
      command,
      shell: "/bin/bash",
      shellArgs: ["-c"],
      cwd: os.tmpdir(),
      env: {
        ...process.env,
        HOME: untrustedHome,
        [EXEC_SHELL_SNAPSHOT_ENV]: "0",
        OPENCLAW_STATE_DIR: untrustedStateDir,
        SSH_CLIENT: "127.0.0.1 1000 22",
        SSH_CONNECTION: "127.0.0.1 1000 127.0.0.1 22",
      },
    });

    expect(wrapped).not.toBe(command);
    expect(
      fs.existsSync(resolveShellSnapshotDirForTest({ OPENCLAW_STATE_DIR: untrustedStateDir })),
    ).toBe(false);
    expect(
      fs.existsSync(resolveShellSnapshotDirForTest({ OPENCLAW_STATE_DIR: trustedStateDir })),
    ).toBe(true);
    expect(fs.existsSync(sideEffectPath)).toBe(false);
  });

  it("captures bash startup aliases, functions, and safe environment without secrets", async () => {
    const bash = resolveBashForTest();
    if (!bash) {
      return;
    }

    const { home, stateDir, cwd } = setup();
    writeRc(home, [
      "case $- in *i*) ;; *) return;; esac",
      "alias oc_snap_alias='printf alias-ok'",
      'alias oc_snap_secret="printf $OPENAI_API_KEY"',
      '[ "$OPENCLAW_SHELL" = exec ] && alias oc_snap_exec_alias="printf marker-ok"',
      "oc_snap_fn() { printf fn-ok; }",
      'export PATH="/snapshot/bin:$PATH"',
      'export OPENAI_API_KEY="snapshot-secret"',
      "",
    ]);

    const env = runtimeEnv(home, stateDir, {
      OPENCLAW_SHELL: "exec",
      OPENAI_API_KEY: "inherited-secret",
    });
    expect(
      await run(
        bash,
        cwd,
        env,
        "oc_snap_fn; printf ' '; oc_snap_alias; printf ' '; oc_snap_exec_alias; printf ' '; case \":$PATH:\" in *:/snapshot/bin:*) printf path-ok;; *) printf path-missing;; esac",
      ),
    ).toBe("fn-ok alias-ok marker-ok path-ok");
    const snapshot = readSnapshot(env);
    expect(snapshot).toContain("oc_snap_fn");
    expect(snapshot).toContain("oc_snap_alias");
    expect(snapshot).not.toMatch(/snapshot-secret|inherited-secret|OPENAI_API_KEY/);
  });

  it("preserves per-call safe env overrides after trusted capture", async () => {
    const bash = resolveBashForTest();
    if (!bash) {
      return;
    }

    const { home, stateDir, cwd } = setup();
    process.env.PNPM_HOME = "/trusted";
    writeRc(home, 'export PNPM_HOME="${PNPM_HOME}/from-rc"\n');

    const runWithPnpmHome = (PNPM_HOME: string) =>
      run(bash, cwd, runtimeEnv(home, stateDir, { PNPM_HOME }));

    await expect(runWithPnpmHome("/first")).resolves.toBe("/first");
    await expect(runWithPnpmHome("/second")).resolves.toBe("/second");
  });

  it.each(["USERPROFILE", "OS account"])(
    "uses %s when trusted HOME is blank without trimming a valid path",
    async (fallback) => {
      const bash = resolveBashForTest();
      if (!bash) {
        return;
      }

      const homeRoot = makeDir();
      const home = path.join(homeRoot, " trusted home ");
      const stateDir = makeDir(),
        cwd = makeDir();
      fs.mkdirSync(home);
      setSnapshotStateForTest(stateDir, { home });
      writeRc(home, 'export PNPM_HOME="/rc-home"\n');

      const runWithCapturedPnpmHome = () => run(bash, cwd, runtimeEnv(home, stateDir));

      if (fallback === "USERPROFILE") {
        await expect(runWithCapturedPnpmHome()).resolves.toBe("/rc-home");
        setTestEnvValue("USERPROFILE", home);
      } else {
        setTestEnvValue("USERPROFILE", "   ");
        vi.spyOn(os, "userInfo").mockReturnValue({ ...os.userInfo(), homedir: home });
      }
      setTestEnvValue("HOME", "");
      await expect(runWithCapturedPnpmHome()).resolves.toBe("/rc-home");
    },
  );

  it("does not let non-fingerprinted env change captured shell state", async () => {
    const bash = resolveBashForTest();
    if (!bash) {
      return;
    }

    const { home, stateDir, cwd } = setup();
    writeRc(home, [
      'if [ -n "$VIRTUAL_ENV" ]; then',
      "  alias oc_env_branch='printf virtual'",
      "else",
      "  alias oc_env_branch='printf plain'",
      "fi",
      "",
    ]);

    const env = runtimeEnv(home, stateDir, { VIRTUAL_ENV: "/tmp/venv" });
    expect(await run(bash, cwd, env, "oc_env_branch")).toBe("plain");
    const snapshot = readSnapshot(env);
    expect(snapshot).not.toMatch(/virtual|VIRTUAL_ENV/);
  });

  it("refuses to persist aliases or functions with literal secret-looking values", async () => {
    const bash = resolveBashForTest();
    if (!bash) {
      return;
    }

    const { home, stateDir, cwd } = setup();
    writeRc(home, [
      "alias oc_secret_alias='GITHUB_TOKEN=ghp_literal_secret gh'",
      "alias oc_aws_secret_alias='AWS_SECRET_ACCESS_KEY=literal-secret aws sts get-caller-identity'",
      "",
    ]);

    const env = runtimeEnv(home, stateDir);
    const command = "echo fallback";
    const wrapped = await maybeWrapCommandWithShellSnapshot({
      command,
      shell: bash,
      shellArgs: getShellConfig(bash).args,
      cwd,
      env,
    });

    expect(wrapped).toBe(command);
    const snapshotDir = resolveShellSnapshotDirForTest(env);
    const files = fs.existsSync(snapshotDir)
      ? fs.readdirSync(snapshotDir).filter((entry) => entry.endsWith(".sh"))
      : [];
    expect(files).toHaveLength(0);
  });

  it("captures zsh aliases in sourceable form", async () => {
    const zsh = resolveZshForTest();
    if (!zsh) {
      return;
    }

    const { home, stateDir, cwd } = setup();
    setSnapshotStateForTest(stateDir, { home });
    fs.writeFileSync(
      path.join(home, ".zshrc"),
      [
        "alias oc_snap_zsh_alias='printf zsh-alias-ok'",
        "oc_snap_zsh_fn() { printf zsh-fn-ok; }",
        "",
      ].join("\n"),
    );

    const env = {
      ...process.env,
      HOME: home,
      OPENCLAW_STATE_DIR: stateDir,
    };
    const shellArgs = getShellConfig(zsh).args;
    const wrapped = await maybeWrapCommandWithShellSnapshot({
      command: "oc_snap_zsh_fn; printf ' '; oc_snap_zsh_alias",
      shell: zsh,
      shellArgs,
      cwd,
      env,
    });

    const result = spawnSync(zsh, [...shellArgs, wrapped], {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("zsh-fn-ok zsh-alias-ok");
  });

  it("captures zsh startup state from ZDOTDIR", async () => {
    const zsh = resolveZshForTest();
    if (!zsh) {
      return;
    }

    const { home, stateDir, cwd } = setup();
    const zdotdir = makeDir();
    setSnapshotStateForTest(stateDir, { home, zdotdir });
    fs.writeFileSync(path.join(home, ".zshrc"), "alias oc_snap_zdot_alias='printf wrong-home'\n");
    fs.writeFileSync(
      path.join(zdotdir, ".zshrc"),
      ["[[ -o interactive ]] || return", "alias oc_snap_zdot_alias='printf zdotdir-ok'", ""].join(
        "\n",
      ),
    );

    const env = {
      ...process.env,
      HOME: home,
      OPENCLAW_STATE_DIR: stateDir,
      ZDOTDIR: zdotdir,
    };
    const shellArgs = getShellConfig(zsh).args;
    const wrapped = await maybeWrapCommandWithShellSnapshot({
      command: "oc_snap_zdot_alias",
      shell: zsh,
      shellArgs,
      cwd,
      env,
    });

    const result = spawnSync(zsh, [...shellArgs, wrapped], {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("zdotdir-ok");
  });
});
