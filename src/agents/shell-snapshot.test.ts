import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveStateDir } from "../config/paths.js";
import { resolveExecutablePath } from "../infra/executable-path.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { maybeWrapCommandWithShellSnapshot } from "./shell-snapshot.js";
import { getBashShellConfig, getShellConfig } from "./shell-utils.js";

const isWin = process.platform === "win32";
function resolveShellSnapshotDirForTest(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env as NodeJS.ProcessEnv), "cache", "shell-snapshots");
}

function resolveBashForTest(): string | null {
  return isWin ? null : getBashShellConfig().shell;
}

function resolveZshForTest(): string | null {
  return isWin
    ? null
    : fs.existsSync("/bin/zsh")
      ? "/bin/zsh"
      : (resolveExecutablePath("zsh", { useCache: false }) ?? null);
}

function setSnapshotStateForTest(stateDir: string, home: string): void {
  // Snapshot tests mutate trusted process env, not per-command untrusted env.
  setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
  setTestEnvValue("HOME", home);
  delete process.env.ZDOTDIR;
}

describe("exec shell snapshots", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let envSnapshot: ReturnType<typeof captureEnv>;
  const makeDir = () => tempDirs.make("openclaw-snapshot-");
  const setup = (shell: string) => {
    const home = makeDir(),
      stateDir = makeDir(),
      cwd = makeDir();
    setSnapshotStateForTest(stateDir, home);
    const env = (overrides: NodeJS.ProcessEnv = {}) => ({ ...process.env, ...overrides });
    return {
      home,
      run: (command?: string, overrides?: NodeJS.ProcessEnv) =>
        runShell(shell, cwd, env(overrides), command),
      wrap: (command: string) => wrapShell(shell, cwd, env(), command),
    };
  };
  const writeRc = (home: string, source: string | string[], name = ".bashrc") =>
    fs.writeFileSync(
      path.join(home, name),
      typeof source === "string" ? source : source.join("\n"),
    );
  async function wrapShell(shell: string, cwd: string, env: NodeJS.ProcessEnv, command: string) {
    setTestEnvValue("SHELL", shell);
    const shellArgs = getShellConfig().args;
    const wrapped = await maybeWrapCommandWithShellSnapshot({
      command,
      shell,
      shellArgs,
      cwd,
      env,
    });
    return { shellArgs, wrapped };
  }
  async function runShell(
    shell: string,
    cwd: string,
    env: NodeJS.ProcessEnv,
    command = 'printf "%s" "$PNPM_HOME"',
  ) {
    const { shellArgs, wrapped } = await wrapShell(shell, cwd, env, command);
    const result = spawnSync(shell, [...shellArgs, wrapped], {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(result.status).toBe(0);
    return result.stdout;
  }
  function readSnapshot() {
    const dir = resolveShellSnapshotDirForTest();
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
      "SHELL",
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
    setSnapshotStateForTest(trustedStateDir, home);
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
        OPENCLAW_EXEC_SHELL_SNAPSHOT: "0",
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

    const { home, run } = setup(bash);
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

    expect(
      await run(
        "oc_snap_fn; printf ' '; oc_snap_alias; printf ' '; oc_snap_exec_alias; printf ' '; case \":$PATH:\" in *:/snapshot/bin:*) printf path-ok;; *) printf path-missing;; esac",
        { OPENCLAW_SHELL: "exec", OPENAI_API_KEY: "inherited-secret" },
      ),
    ).toBe("fn-ok alias-ok marker-ok path-ok");
    const snapshot = readSnapshot();
    expect(snapshot).toContain("oc_snap_fn");
    expect(snapshot).toContain("oc_snap_alias");
    expect(snapshot).not.toMatch(/snapshot-secret|inherited-secret|OPENAI_API_KEY/);
  });

  it("preserves per-call safe env overrides after trusted capture", async () => {
    const bash = resolveBashForTest();
    if (!bash) {
      return;
    }

    const { home, run } = setup(bash);
    process.env.PNPM_HOME = "/trusted";
    writeRc(home, 'export PNPM_HOME="${PNPM_HOME}/from-rc"\n');

    const runWithPnpmHome = (PNPM_HOME: string) => run(undefined, { PNPM_HOME });

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
      setSnapshotStateForTest(stateDir, home);
      writeRc(home, 'export PNPM_HOME="/rc-home"\n');

      const runWithCapturedPnpmHome = () =>
        runShell(bash, cwd, {
          ...process.env,
          HOME: home,
          OPENCLAW_STATE_DIR: stateDir,
        });

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

    const { home, run } = setup(bash);
    writeRc(home, [
      'if [ -n "$VIRTUAL_ENV" ]; then',
      "  alias oc_env_branch='printf virtual'",
      "else",
      "  alias oc_env_branch='printf plain'",
      "fi",
      "",
    ]);

    expect(await run("oc_env_branch", { VIRTUAL_ENV: "/tmp/venv" })).toBe("plain");
    const snapshot = readSnapshot();
    expect(snapshot).not.toMatch(/virtual|VIRTUAL_ENV/);
  });

  it("refuses to persist aliases or functions with literal secret-looking values", async () => {
    const bash = resolveBashForTest();
    if (!bash) {
      return;
    }

    const { home, wrap } = setup(bash);
    writeRc(home, [
      "alias oc_secret_alias='GITHUB_TOKEN=ghp_literal_secret gh'",
      "alias oc_aws_secret_alias='AWS_SECRET_ACCESS_KEY=literal-secret aws sts get-caller-identity'",
      "",
    ]);

    const command = "echo fallback";
    const { wrapped } = await wrap(command);

    expect(wrapped).toBe(command);
    const snapshotDir = resolveShellSnapshotDirForTest();
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

    const { home, run } = setup(zsh);
    writeRc(
      home,
      [
        "alias oc_snap_zsh_alias='printf zsh-alias-ok'",
        "oc_snap_zsh_fn() { printf zsh-fn-ok; }",
        "",
      ],
      ".zshrc",
    );
    expect(await run("oc_snap_zsh_fn; printf ' '; oc_snap_zsh_alias")).toBe(
      "zsh-fn-ok zsh-alias-ok",
    );
  });

  it("captures zsh startup state from ZDOTDIR", async () => {
    const zsh = resolveZshForTest();
    if (!zsh) {
      return;
    }

    const { home, run } = setup(zsh);
    const zdotdir = makeDir();
    setTestEnvValue("ZDOTDIR", zdotdir);
    writeRc(home, "alias oc_snap_zdot_alias='printf wrong-home'\n", ".zshrc");
    writeRc(
      zdotdir,
      ["[[ -o interactive ]] || return", "alias oc_snap_zdot_alias='printf zdotdir-ok'", ""],
      ".zshrc",
    );
    expect(await run("oc_snap_zdot_alias", { ZDOTDIR: zdotdir })).toBe("zdotdir-ok");
  });
});
