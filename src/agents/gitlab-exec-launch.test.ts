import { spawn, spawnSync, type SpawnOptions } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { withMockedWindowsPlatform } from "../test-utils/vitest-spies.js";
import { buildGitLabExecLaunchArgv } from "./gitlab-exec-launch.js";
import { getShellConfig } from "./shell-utils.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function run(argv: string[], cwd: string, options: SpawnOptions = {}) {
  const child = spawn(argv[0]!, argv.slice(1), {
    cwd,
    stdio: ["ignore", "pipe", "pipe", "pipe"],
    ...options,
    env: {
      PATH: process.env.PATH,
      HOME: cwd,
      GITLAB_TOKEN: "synthetic-ambient-bot",
      GITLAB_ACCESS_TOKEN: "synthetic-ambient-bot",
      OAUTH_TOKEN: "synthetic-ambient-bot",
      CI_JOB_TOKEN: "synthetic-ambient-bot",
      GITLAB_CI: "true",
      GLAB_CI: "true",
      CI_SERVER_FQDN: "other.example.test",
      CI_SERVER_HOST: "other.example.test",
      GITLAB_HOST: "other.example.test",
      GITLAB_URI: "other.example.test",
      GL_HOST: "other.example.test",
      GITLAB_API_HOST: "other.example.test",
      GLAB_API_HOST: "other.example.test",
      GITLAB_SUBFOLDER: "bot",
      GLAB_API_PROTOCOL: "http",
      API_PROTOCOL: "http",
      GLAB_CONFIG_DIR: cwd,
      ...options.env,
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (data) => {
    stdout += String(data);
  });
  child.stderr!.on("data", (data) => {
    stderr += String(data);
  });
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    return { code, stdout, stderr, pid: child.pid };
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
}

it.skipIf(process.platform === "win32")(
  "resolves the selected token inside the child and preserves shell exec semantics",
  async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gitlab-launch-")));
    roots.push(root);
    const profile = path.join(root, "managed 'profile'");
    await fs.mkdir(profile, { mode: 0o700 });
    const token = "synthetic-selected-token";
    await fs.writeFile(
      path.join(profile, "config.yml"),
      `hosts:\n  gitlab.example.test:\n    token: ${token}\n  other.example.test:\n    token: synthetic-other-token\n`,
      { mode: 0o600 },
    );
    const target = path.join(root, "target.cjs");
    await fs.writeFile(
      target,
      `const fs = require("node:fs");
      const blocked = ["GITLAB_ACCESS_TOKEN", "OAUTH_TOKEN", "CI_JOB_TOKEN", "GITLAB_CI", "GLAB_CI", "CI_SERVER_FQDN", "CI_SERVER_HOST", "GITLAB_URI", "GL_HOST", "GITLAB_API_HOST", "GLAB_API_HOST", "GITLAB_SUBFOLDER", "API_PROTOCOL"];
      process.stdout.write(JSON.stringify({
        pid: process.pid,
        args: process.argv.slice(2),
        selected: process.env.GITLAB_TOKEN === ${JSON.stringify(token)},
        host: process.env.GITLAB_HOST,
        profile: process.env.GLAB_CONFIG_DIR,
        protocol: process.env.GLAB_API_PROTOCOL,
        clear: blocked.every((name) => !process.env[name]),
        lineage: fs.fstatSync(3).isFIFO() || fs.fstatSync(3).isSocket(),
      }));`,
    );
    const args = ["a b", "'quoted'", "$HOME", "$(false)", "line\nbreak"];
    const argv = buildGitLabExecLaunchArgv([process.execPath, target, ...args], profile, {
      issuer: "https://gitlab.example.test",
    });
    expect(JSON.stringify(argv)).not.toContain(token);
    const result = await run(argv, root);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      pid: result.pid,
      args,
      selected: true,
      host: "gitlab.example.test",
      profile,
      protocol: "https",
      clear: true,
      lineage: true,
    });
    expect(`${result.stdout}${result.stderr}`).not.toContain(token);

    await fs.rm(path.join(profile, "config.yml"));
    const missing = await run(argv, root);
    expect({ code: missing.code, stdout: missing.stdout }).toEqual({ code: 1, stdout: "" });
    expect(missing.stderr).toContain("GitLab Identity credential is unavailable or insecure");
    expect(`${missing.stdout}${missing.stderr}`).not.toContain("synthetic-ambient-bot");
  },
);

const powershell = process.platform === "win32" ? getShellConfig().shell : "pwsh";
const psArgs = ["-NoProfile", "-NonInteractive", "-Command"];
const hasPowerShell = spawnSync(powershell, [...psArgs, "exit 0"]).status === 0;

it.skipIf(!hasPowerShell)(
  "keeps the PowerShell command owner and selected GitLab identity",
  async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gitlab-powershell-")));
    roots.push(root);
    const profile = path.join(root, "managed 'profile'");
    await fs.mkdir(profile, { mode: 0o700 });
    const token = "synthetic-powershell-token";
    await fs.writeFile(
      path.join(profile, "config.yml"),
      `hosts:\n  gitlab.example.test:\n    token: ${token}\n`,
      { mode: 0o600 },
    );
    const target = path.join(root, "target.cjs");
    await fs.writeFile(
      target,
      `process.stdout.write(JSON.stringify({
      selected: process.env.GITLAB_TOKEN === ${JSON.stringify(token)},
      host: process.env.GITLAB_HOST,
      config: process.env.GLAB_CONFIG_DIR,
      protocol: process.env.GLAB_API_PROTOCOL,
      cleared: !process.env.GITLAB_ACCESS_TOKEN && !process.env.OAUTH_TOKEN && !process.env.CI_JOB_TOKEN && !process.env.GITLAB_CI && !process.env.GLAB_CI && !process.env.CI_SERVER_FQDN && !process.env.CI_SERVER_HOST && !process.env.GITLAB_URI && !process.env.GL_HOST && !process.env.GITLAB_API_HOST && !process.env.GLAB_API_HOST && !process.env.API_PROTOCOL,
      args: process.argv.slice(2),
    }));
    process.exitCode = 7;`,
    );
    const args = ["a b", "'quoted'", "$HOME", "$(false)"];
    const targetArgv = [process.execPath, target, ...args];
    const launchArgv = withMockedWindowsPlatform(() =>
      buildGitLabExecLaunchArgv(targetArgv, profile, {
        issuer: "https://gitlab.example.test",
        externalCommandShell: { shell: powershell, args: psArgs },
      }),
    );
    expect(JSON.stringify(launchArgv)).not.toContain(token);
    const result = await run(launchArgv, root, {
      env: { POWERSHELL_TELEMETRY_OPTOUT: "1" },
    });
    expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 7, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual({
      selected: true,
      host: "gitlab.example.test",
      config: profile,
      protocol: "https",
      cleared: true,
      args,
    });
    expect(`${result.stdout}${result.stderr}`).not.toContain(token);
  },
);
