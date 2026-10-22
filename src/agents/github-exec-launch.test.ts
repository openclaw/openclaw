import { spawn, spawnSync, type SpawnOptions } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { quotePowerShellArg } from "../cli/quote-cli-arg.js";
import { withMockedWindowsPlatform } from "../test-utils/vitest-spies.js";
import { buildGitHubExecLaunchArgv } from "./github-exec-launch.js";
import { getShellConfig } from "./shell-utils.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const literalArgs = [
  "a b",
  "'quoted'",
  "‘quoted’",
  "‚quoted‛",
  "$HOME",
  "$(false)",
  "line\nbreak",
  "--literal",
];
async function tempRoot(parent = os.tmpdir()) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(parent, "github-launch-")));
  roots.push(root);
  return root;
}
async function profileAt(root: string, host: string, token?: string) {
  const profile = path.join(root, "profile 'with ‘spaces’'");
  await fs.mkdir(profile, { mode: 0o700 });
  if (token) {
    await fs.writeFile(path.join(profile, "hosts.yml"), `${host}:\n  oauth_token: ${token}\n`, {
      mode: 0o600,
    });
  }
  return profile;
}
async function run(argv: string[], options: SpawnOptions) {
  const child = spawn(argv[0]!, argv.slice(1), options);
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr!.on("data", (chunk) => {
    stderr += String(chunk);
  });
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    return { code, stdout, stderr };
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
}

const psArgs = ["-NoProfile", "-NonInteractive", "-Command"];
const powershell = process.platform === "win32" ? getShellConfig().shell : "pwsh";
const hasPowerShell =
  spawnSync(powershell, [...psArgs, "exit 0"], {
    env: {
      PATH: process.env.PATH,
      HOME: os.tmpdir(),
      SystemRoot: process.env.SystemRoot,
      POWERSHELL_TELEMETRY_OPTOUT: "1",
    },
  }).status === 0;

describe.skipIf(!hasPowerShell)("GitHub launch PowerShell boundary", () => {
  it.each([
    { credentialState: "available", externalCommand: false },
    { credentialState: "missing", externalCommand: false },
    { credentialState: "available", externalCommand: true },
    { credentialState: "missing", externalCommand: true },
    { credentialState: "available", externalCommand: true, host: "ghe.example.test" },
    { credentialState: "missing", externalCommand: false, host: "ghe.example.test" },
  ])(
    "keeps the PowerShell owner for $credentialState credentials (external: $externalCommand)",
    async ({ credentialState, externalCommand, host = "github.com" }) => {
      const root = await tempRoot();
      const profile = await profileAt(
        root,
        host,
        credentialState === "available" ? "synthetic-powershell-token" : undefined,
      );
      const target = path.join(root, "target 'with ‘spaces’'.cjs");
      await fs.writeFile(
        target,
        `
        process.stdout.write(JSON.stringify({
          cwd: process.cwd(), selected: process.env[${JSON.stringify(host === "github.com" ? "GH_TOKEN" : "GH_ENTERPRISE_TOKEN")}] === "synthetic-powershell-token",
          host: process.env.GH_HOST,
          cleared: !process.env.GITHUB_TOKEN && !process.env.GITHUB_ENTERPRISE_TOKEN && !process.env[${JSON.stringify(host === "github.com" ? "GH_ENTERPRISE_TOKEN" : "GH_TOKEN")}],
          args: process.argv.slice(2),
        }));
        process.exitCode = 7;
      `,
      );
      const args = literalArgs;
      const targetArgv = [process.execPath, target, ...args];
      const command = `& ${targetArgv.map(quotePowerShellArg).join(" ")}; exit $LASTEXITCODE`;
      const argv = externalCommand ? targetArgv : [powershell, ...psArgs, command];
      const shell = { shell: powershell, args: psArgs };
      const options = {
        githubHost: host,
        ...(externalCommand ? { externalCommandShell: shell } : {}),
      };
      const launchArgv = withMockedWindowsPlatform(() =>
        buildGitHubExecLaunchArgv(argv, profile, options),
      );
      expect(JSON.stringify(launchArgv)).not.toContain("synthetic-powershell-token");
      const { code, stdout, stderr } = await run(launchArgv, {
        cwd: root,
        env: {
          PATH: process.env.PATH,
          HOME: root,
          SystemRoot: process.env.SystemRoot,
          GH_TOKEN: "",
          GITHUB_TOKEN: "",
          POWERSHELL_TELEMETRY_OPTOUT: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (credentialState === "available") {
        expect({ code, stderr }).toEqual({ code: 7, stderr: "" });
        const expected = { cwd: root, host, selected: true, cleared: true, args };
        expect(JSON.parse(stdout)).toEqual(expected);
      } else {
        expect({ code, stdout }).toEqual({ code: 1, stdout: "" });
        expect(stderr).toContain("GitHub Identity credential is unavailable or insecure");
      }
      expect(path.basename(launchArgv[0]!)).toBe(path.basename(powershell));
      expect(`${stdout}${stderr}`).not.toContain("synthetic-powershell-token");
    },
  );
});

describe.skipIf(process.platform === "win32")("GitHub launch source runtimes", () => {
  for (const runtime of [process.execPath, "bun"]) {
    it.skipIf(runtime === "bun" && spawnSync("bun", ["--version"]).status !== 0)(
      `preserves exact argv, private output and lineage with ${path.basename(runtime)}`,
      async () => {
        const artifacts = path.join(process.cwd(), ".artifacts");
        await fs.mkdir(artifacts, { recursive: true });
        const root = await tempRoot(artifacts);
        const commandCwd = await tempRoot();
        const profile = await profileAt(root, "github.com", "synthetic-source-token");
        const target = path.join(root, "target.cjs");
        await fs.writeFile(
          target,
          `
          const fs = require("node:fs");
          const lineage = fs.fstatSync(3);
          process.stdout.write(JSON.stringify({
            args: process.argv.slice(2), cwd: process.cwd(),
            selected: process.env.GH_TOKEN === "synthetic-source-token",
            cleared: process.env.GITHUB_TOKEN === "" && !process.env.GH_ENTERPRISE_TOKEN && !process.env.GITHUB_ENTERPRISE_TOKEN,
            lineage: lineage.isSocket() || lineage.isFIFO(),
          }));
        `,
        );
        const driver = path.join(root, "driver.mts");
        // Exercise the source route in each runtime; real exec tests cover prepared artifacts.
        const source = new URL("./github-exec-launch.ts", import.meta.url).href;
        await fs.writeFile(
          driver,
          `
          import { spawn } from "node:child_process";
          import { buildGitHubExecLaunchArgv } from ${JSON.stringify(source)};
          const argv = buildGitHubExecLaunchArgv([process.execPath, ...process.argv.slice(3)], process.argv[2]);
          const child = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "inherit", "inherit", 3] });
          child.on("error", () => { process.exitCode = 1; });
          child.on("close", (code) => { process.exitCode = code ?? 1; });
        `,
        );
        const args = literalArgs;
        const argv = [
          ...(runtime === "bun" ? [] : ["--import", createRequire(import.meta.url).resolve("tsx")]),
          driver,
          profile,
          target,
          ...args,
        ];
        const { code, stdout, stderr } = await run([runtime, ...argv], {
          cwd: commandCwd,
          env: {
            PATH: process.env.PATH,
            HOME: root,
            ZDOTDIR: root,
            GH_TOKEN: "",
            GITHUB_TOKEN: "",
          },
          stdio: ["ignore", "pipe", "pipe", "pipe"],
        });
        expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
        const expected = { args, cwd: commandCwd, selected: true, cleared: true, lineage: true };
        expect(JSON.parse(stdout)).toEqual(expected);
      },
    );
  }
});
