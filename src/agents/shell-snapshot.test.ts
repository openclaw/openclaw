import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import {
  EXEC_SHELL_SNAPSHOT_ENV,
  maybeWrapCommandWithShellSnapshot,
  resetShellSnapshotCacheForTests,
  resolveShellSnapshotDir,
} from "./shell-snapshot.js";
import { getPosixShellArgs, resolveShellFromPath } from "./shell-utils.js";

const isWin = process.platform === "win32";

function resolveBashForTest(): string | null {
  if (isWin) {
    return null;
  }
  if (fs.existsSync("/bin/bash")) {
    return "/bin/bash";
  }
  return resolveShellFromPath("bash") ?? null;
}

function resolveZshForTest(): string | null {
  if (isWin) {
    return null;
  }
  if (fs.existsSync("/bin/zsh")) {
    return "/bin/zsh";
  }
  return resolveShellFromPath("zsh") ?? null;
}

function enableSnapshotForTest(stateDir: string): void {
  process.env.OPENCLAW_STATE_DIR = stateDir;
  process.env[EXEC_SHELL_SNAPSHOT_ENV] = "1";
}

describe("exec shell snapshots", () => {
  const tempDirs: string[] = [];
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeEach(() => {
    envSnapshot = captureEnv(["HOME", "OPENCLAW_STATE_DIR", EXEC_SHELL_SNAPSHOT_ENV]);
  });

  afterEach(() => {
    resetShellSnapshotCacheForTests();
    envSnapshot.restore();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves commands unchanged unless explicitly enabled", async () => {
    const command = "echo unchanged";
    const wrapped = await maybeWrapCommandWithShellSnapshot({
      command,
      shell: "/bin/bash",
      shellArgs: ["--noprofile", "--norc", "-c"],
      cwd: os.tmpdir(),
      env: {},
      enabled: true,
    });

    expect(wrapped).toBe(command);
  });

  it("does not honor per-call env for enabling snapshots or selecting state dir", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-snapshot-untrusted-state-"));
    tempDirs.push(stateDir);
    const command = "echo unchanged";
    const wrapped = await maybeWrapCommandWithShellSnapshot({
      command,
      shell: "/bin/bash",
      shellArgs: ["--noprofile", "--norc", "-c"],
      cwd: os.tmpdir(),
      env: {
        OPENCLAW_STATE_DIR: stateDir,
        [EXEC_SHELL_SNAPSHOT_ENV]: "1",
      },
      enabled: true,
    });

    expect(wrapped).toBe(command);
    expect(fs.existsSync(resolveShellSnapshotDir({ OPENCLAW_STATE_DIR: stateDir }))).toBe(false);
  });

  it("captures bash startup aliases, functions, and safe environment without secrets", async () => {
    const bash = resolveBashForTest();
    if (!bash) {
      return;
    }

    const home = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-snapshot-home-"));
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-snapshot-state-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-snapshot-cwd-"));
    tempDirs.push(home, stateDir, cwd);
    enableSnapshotForTest(stateDir);
    fs.writeFileSync(
      path.join(home, ".bashrc"),
      [
        "alias oc_snap_alias='printf alias-ok'",
        'alias oc_snap_secret="printf $OPENAI_API_KEY"',
        "oc_snap_fn() { printf fn-ok; }",
        'export PATH="/snapshot/bin:$PATH"',
        'export OPENAI_API_KEY="snapshot-secret"',
        "",
      ].join("\n"),
    );

    const env = {
      ...process.env,
      HOME: home,
      OPENCLAW_STATE_DIR: stateDir,
      OPENAI_API_KEY: "inherited-secret",
      [EXEC_SHELL_SNAPSHOT_ENV]: "1",
    };
    const shellArgs = getPosixShellArgs(bash);
    const wrapped = await maybeWrapCommandWithShellSnapshot({
      command:
        "oc_snap_fn; printf ' '; oc_snap_alias; printf ' '; case \":$PATH:\" in *:/snapshot/bin:*) printf path-ok;; *) printf path-missing;; esac",
      shell: bash,
      shellArgs,
      cwd,
      env,
      enabled: true,
    });

    const result = spawnSync(bash, [...shellArgs, wrapped], {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("fn-ok alias-ok path-ok");

    const snapshotFiles = fs
      .readdirSync(resolveShellSnapshotDir(env))
      .filter((entry) => entry.endsWith(".sh"));
    expect(snapshotFiles).toHaveLength(1);
    const snapshot = fs.readFileSync(
      path.join(resolveShellSnapshotDir(env), snapshotFiles[0]),
      "utf8",
    );
    expect(snapshot).toContain("oc_snap_fn");
    expect(snapshot).toContain("oc_snap_alias");
    expect(snapshot).not.toContain("snapshot-secret");
    expect(snapshot).not.toContain("inherited-secret");
    expect(snapshot).not.toContain("OPENAI_API_KEY");
  });

  it("captures bash aliases behind common interactive-only guards", async () => {
    const bash = resolveBashForTest();
    if (!bash) {
      return;
    }

    const home = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-snapshot-interactive-home-"));
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-snapshot-interactive-state-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-snapshot-interactive-cwd-"));
    tempDirs.push(home, stateDir, cwd);
    enableSnapshotForTest(stateDir);
    fs.writeFileSync(
      path.join(home, ".bashrc"),
      [
        "case $- in",
        "  *i*) ;;",
        "  *) return;;",
        "esac",
        "alias oc_interactive_alias='printf interactive-ok'",
        "",
      ].join("\n"),
    );

    const env = {
      ...process.env,
      HOME: home,
      [EXEC_SHELL_SNAPSHOT_ENV]: "1",
    };
    const shellArgs = getPosixShellArgs(bash);
    const wrapped = await maybeWrapCommandWithShellSnapshot({
      command: "oc_interactive_alias",
      shell: bash,
      shellArgs,
      cwd,
      env,
      enabled: true,
    });
    const result = spawnSync(bash, [...shellArgs, wrapped], {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("interactive-ok");
  });

  it("does not reuse captured safe env exports across different exec environments", async () => {
    const bash = resolveBashForTest();
    if (!bash) {
      return;
    }

    const home = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-snapshot-env-home-"));
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-snapshot-env-state-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-snapshot-env-cwd-"));
    tempDirs.push(home, stateDir, cwd);
    enableSnapshotForTest(stateDir);
    fs.writeFileSync(path.join(home, ".bashrc"), 'export PNPM_HOME="${PNPM_HOME}/from-rc"\n');

    const shellArgs = getPosixShellArgs(bash);
    const runWithPnpmHome = async (pnpmHome: string): Promise<string> => {
      const env = {
        ...process.env,
        HOME: home,
        OPENCLAW_STATE_DIR: stateDir,
        PNPM_HOME: pnpmHome,
        [EXEC_SHELL_SNAPSHOT_ENV]: "1",
      };
      const wrapped = await maybeWrapCommandWithShellSnapshot({
        command: 'printf "%s" "$PNPM_HOME"',
        shell: bash,
        shellArgs,
        cwd,
        env,
        enabled: true,
      });
      const result = spawnSync(bash, [...shellArgs, wrapped], {
        cwd,
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      expect(result.status).toBe(0);
      return result.stdout;
    };

    await expect(runWithPnpmHome("/first")).resolves.toBe("/first/from-rc");
    await expect(runWithPnpmHome("/second")).resolves.toBe("/second/from-rc");
  });

  it("does not let non-fingerprinted env change captured shell state", async () => {
    const bash = resolveBashForTest();
    if (!bash) {
      return;
    }

    const home = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-snapshot-branch-home-"));
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-snapshot-branch-state-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-snapshot-branch-cwd-"));
    tempDirs.push(home, stateDir, cwd);
    enableSnapshotForTest(stateDir);
    fs.writeFileSync(
      path.join(home, ".bashrc"),
      [
        'if [ -n "$VIRTUAL_ENV" ]; then',
        "  alias oc_env_branch='printf virtual'",
        "else",
        "  alias oc_env_branch='printf plain'",
        "fi",
        "",
      ].join("\n"),
    );

    const env = {
      ...process.env,
      HOME: home,
      OPENCLAW_STATE_DIR: stateDir,
      VIRTUAL_ENV: "/tmp/venv",
      [EXEC_SHELL_SNAPSHOT_ENV]: "1",
    };
    const shellArgs = getPosixShellArgs(bash);
    const wrapped = await maybeWrapCommandWithShellSnapshot({
      command: "oc_env_branch",
      shell: bash,
      shellArgs,
      cwd,
      env,
      enabled: true,
    });
    const result = spawnSync(bash, [...shellArgs, wrapped], {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("plain");
    const snapshotFiles = fs
      .readdirSync(resolveShellSnapshotDir(env))
      .filter((entry) => entry.endsWith(".sh"));
    expect(snapshotFiles).toHaveLength(1);
    const snapshot = fs.readFileSync(
      path.join(resolveShellSnapshotDir(env), snapshotFiles[0]),
      "utf8",
    );
    expect(snapshot).not.toContain("virtual");
    expect(snapshot).not.toContain("VIRTUAL_ENV");
  });

  it("refreshes stale snapshot files when startup files source alias fragments", async () => {
    const bash = resolveBashForTest();
    if (!bash) {
      return;
    }

    const home = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-snapshot-refresh-home-"));
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-snapshot-refresh-state-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-snapshot-refresh-cwd-"));
    tempDirs.push(home, stateDir, cwd);
    enableSnapshotForTest(stateDir);
    const aliasPath = path.join(home, ".bash_aliases");
    fs.writeFileSync(path.join(home, ".bashrc"), `. ${JSON.stringify(aliasPath)}\n`);
    fs.writeFileSync(aliasPath, "alias oc_refresh_alias='printf old'\n");

    const env = {
      ...process.env,
      HOME: home,
      [EXEC_SHELL_SNAPSHOT_ENV]: "1",
    };
    const shellArgs = getPosixShellArgs(bash);
    const runAlias = async (): Promise<string> => {
      const wrapped = await maybeWrapCommandWithShellSnapshot({
        command: "oc_refresh_alias",
        shell: bash,
        shellArgs,
        cwd,
        env,
        enabled: true,
      });
      const result = spawnSync(bash, [...shellArgs, wrapped], {
        cwd,
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      expect(result.status).toBe(0);
      return result.stdout;
    };

    await expect(runAlias()).resolves.toBe("old");
    fs.writeFileSync(aliasPath, "alias oc_refresh_alias='printf new'\n");
    const snapshotDir = resolveShellSnapshotDir();
    const snapshotFiles = fs.readdirSync(snapshotDir).filter((entry) => entry.endsWith(".sh"));
    expect(snapshotFiles).toHaveLength(1);
    const staleTime = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(path.join(snapshotDir, snapshotFiles[0]), staleTime, staleTime);
    resetShellSnapshotCacheForTests();

    await expect(runAlias()).resolves.toBe("new");
  });

  it("refuses to persist aliases or functions with literal secret-looking values", async () => {
    const bash = resolveBashForTest();
    if (!bash) {
      return;
    }

    const home = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-snapshot-secret-home-"));
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-snapshot-secret-state-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-snapshot-secret-cwd-"));
    tempDirs.push(home, stateDir, cwd);
    enableSnapshotForTest(stateDir);
    fs.writeFileSync(
      path.join(home, ".bashrc"),
      [
        "alias oc_secret_alias='GITHUB_TOKEN=ghp_literal_secret gh'",
        "alias oc_aws_secret_alias='AWS_SECRET_ACCESS_KEY=literal-secret aws sts get-caller-identity'",
        "",
      ].join("\n"),
    );

    const env = {
      ...process.env,
      HOME: home,
      OPENCLAW_STATE_DIR: stateDir,
      [EXEC_SHELL_SNAPSHOT_ENV]: "1",
    };
    const command = "echo fallback";
    const wrapped = await maybeWrapCommandWithShellSnapshot({
      command,
      shell: bash,
      shellArgs: getPosixShellArgs(bash),
      cwd,
      env,
      enabled: true,
    });

    expect(wrapped).toBe(command);
    const snapshotDir = resolveShellSnapshotDir(env);
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

    const home = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-snapshot-zsh-home-"));
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-snapshot-zsh-state-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-snapshot-zsh-cwd-"));
    tempDirs.push(home, stateDir, cwd);
    enableSnapshotForTest(stateDir);
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
      [EXEC_SHELL_SNAPSHOT_ENV]: "1",
    };
    const shellArgs = getPosixShellArgs(zsh);
    const wrapped = await maybeWrapCommandWithShellSnapshot({
      command: "oc_snap_zsh_fn; printf ' '; oc_snap_zsh_alias",
      shell: zsh,
      shellArgs,
      cwd,
      env,
      enabled: true,
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

    const home = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-snapshot-zdot-home-"));
    const zdotdir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-snapshot-zdot-dir-"));
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-snapshot-zdot-state-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-snapshot-zdot-cwd-"));
    tempDirs.push(home, zdotdir, stateDir, cwd);
    enableSnapshotForTest(stateDir);
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
      [EXEC_SHELL_SNAPSHOT_ENV]: "1",
    };
    const shellArgs = getPosixShellArgs(zsh);
    const wrapped = await maybeWrapCommandWithShellSnapshot({
      command: "oc_snap_zdot_alias",
      shell: zsh,
      shellArgs,
      cwd,
      env,
      enabled: true,
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
