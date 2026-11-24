import { spawn, spawnSync, type SpawnOptions } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as cliInvocation from "../../cli-invocation.mjs";
import { CLI_PARENT_BOUND_PRELOAD } from "../../cli-parent-lifetime.mjs";
import { quotePowerShellArg } from "../cli/quote-cli-arg.js";
import { buildCliRespawnPlan } from "../entry.respawn.js";
import * as runtimeEntrypoints from "../infra/runtime-process-url.js";
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
async function run(argv: string[], home: string, options: SpawnOptions = {}) {
  const child = spawn(argv[0]!, argv.slice(1), {
    cwd: home,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
    env: {
      PATH: process.env.PATH,
      PATHEXT: process.env.PATHEXT,
      HOME: home,
      GH_TOKEN: "",
      GITHUB_TOKEN: "",
      ...options.env,
    },
  });
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
const powershell = process.platform === "win32" ? (await getShellConfig()).shell : "pwsh";
const hasPowerShell =
  spawnSync(powershell, [...psArgs, "exit 0"], {
    env: {
      PATH: process.env.PATH,
      PATHEXT: process.env.PATHEXT,
      HOME: os.tmpdir(),
      SystemRoot: process.env.SystemRoot,
      POWERSHELL_TELEMETRY_OPTOUT: "1",
    },
  }).status === 0;

describe.skipIf(!hasPowerShell)("GitHub launch PowerShell boundary", () => {
  it.skipIf(process.platform !== "win32").each([
    { form: "split", redirect: true },
    { form: "entry respawn", redirect: true },
    { form: "respawned equals", redirect: true },
    { form: "double respawn", redirect: true },
    { form: "package junction", redirect: true },
    { form: "unencoded package URL", redirect: true },
    { form: "missing", redirect: false },
    { form: "unrelated", redirect: false },
    { form: "not an import operand", redirect: false },
    { form: "wrong app root", redirect: false },
  ])("restricts the built credential child's preload ($form)", async ({ form, redirect }) => {
    const root = await tempRoot();
    const packageRoot = path.join(
      root,
      form === "unencoded package URL" ? "package~[test]" : "package",
    );
    const aliasRoot = path.join(root, "package-alias");
    const appRoot = path.join(packageRoot, "app");
    const startupAppRoot = form === "package junction" ? path.join(aliasRoot, "app") : appRoot;
    const stageRoot = path.join(root, "native-stage");
    const launcher = path.join(appRoot, "dist", "agents", "github-exec-launcher.js");
    const preload = path.join(packageRoot, "node", "native-redirect.mjs");
    const unrelated = path.join(root, "other.mjs");
    await fs.mkdir(path.dirname(launcher), { recursive: true });
    await fs.mkdir(path.dirname(preload));
    await fs.mkdir(stageRoot);
    if (form === "package junction") {
      await fs.symlink(packageRoot, aliasRoot, "junction");
    }
    await fs.writeFile(preload, "globalThis.packagedRedirectLoaded = true;");
    await fs.writeFile(unrelated, "globalThis.unrelatedHookLoaded = true;");
    await fs.writeFile(
      launcher,
      `if (Boolean(globalThis.packagedRedirectLoaded) !== ${redirect} || globalThis.unrelatedHookLoaded ||
             (${redirect} && (process.env.OPENCLAW_NATIVE_APP_ROOT !== ${JSON.stringify(startupAppRoot)} ||
                               process.env.OPENCLAW_NATIVE_STAGED_ROOT !== ${JSON.stringify(stageRoot)}))) {
           process.stderr.write("Wrong credential child startup hooks.");
           process.exitCode = 1;
         } else {
           process.stdout.write("synthetic-launch-witness");
         }`,
    );
    const encodedPreloadUrl = pathToFileURL(
      form === "package junction" ? path.join(aliasRoot, "node", "native-redirect.mjs") : preload,
    ).href;
    const preloadUrl =
      form === "unencoded package URL"
        ? encodedPreloadUrl.replace("/package%7E%5Btest%5D/", "/package~[test]/")
        : encodedPreloadUrl;
    const unrelatedUrl = pathToFileURL(unrelated).href;
    const packagedArgs = ["--import", preloadUrl, "--import", unrelatedUrl];
    const cliEntry = path.join(appRoot, "openclaw.mjs");
    const compileCacheRespawn = cliInvocation.resolveOpenClawCliRespawn({
      entryPath: cliEntry,
      execArgv: packagedArgs,
      args: [],
      env: {},
    });
    const planEntryRespawn = (execArgv: string[]) =>
      buildCliRespawnPlan({
        platform: "win32",
        argv: [process.execPath, cliEntry],
        execArgv,
        env: {},
      });
    const entryRespawn = planEntryRespawn(packagedArgs.slice(0, 2));
    const doubleRespawn = planEntryRespawn(compileCacheRespawn.args.slice(0, -1));
    expect(entryRespawn).not.toBeNull();
    expect(doubleRespawn).not.toBeNull();
    const imports: Record<string, string[]> = {
      "entry respawn": entryRespawn!.argv.slice(0, -1),
      "double respawn": doubleRespawn!.argv.slice(0, -1),
      missing: [],
      unrelated: ["--import", unrelatedUrl],
      "not an import operand": ["--title", "--import", preloadUrl],
      "respawned equals": [
        "--import",
        CLI_PARENT_BOUND_PRELOAD,
        "--stack-size=8192",
        `--import=${preloadUrl}`,
      ],
    };
    const startup = vi.spyOn(cliInvocation, "getWindowsNativeRedirectStartup");
    try {
      startup.mockReturnValue({
        appRoot: form === "wrong app root" ? root : startupAppRoot,
        stagedRoot: stageRoot,
        execArgv: imports[form] ?? packagedArgs,
      });
      const entry = vi.spyOn(runtimeEntrypoints, "resolveRuntimeProcessEntrypointUrl");
      try {
        entry.mockReturnValue(pathToFileURL(launcher));
        const argv = buildGitHubExecLaunchArgv(
          [
            powershell,
            ...psArgs,
            "if ($env:GH_TOKEN -eq 'synthetic-launch-witness' -and " +
              "$env:OPENCLAW_NATIVE_APP_ROOT -eq 'request-app' -and " +
              "$env:OPENCLAW_NATIVE_STAGED_ROOT -eq 'request-stage') { 'command-ran' } else { exit 2 }",
          ],
          path.join(root, "unused-profile"),
        );
        const result = await run(argv, root, {
          env: {
            openclaw_native_app_root: "request-app",
            OPENCLAW_NATIVE_STAGED_ROOT: "request-stage",
            SystemRoot: process.env.SystemRoot,
            POWERSHELL_TELEMETRY_OPTOUT: "1",
          },
        });

        expect(result).toEqual({
          code: 0,
          stdout: expect.stringMatching(/^command-ran\s*$/),
          stderr: "",
        });
      } finally {
        entry.mockRestore();
      }
    } finally {
      startup.mockRestore();
    }
  });

  it("does not consult the packaged startup inputs for a source worker or non-Windows host", () => {
    const appRoot = path.resolve("app");
    const startup = vi.spyOn(cliInvocation, "getWindowsNativeRedirectStartup");
    const entry = vi.spyOn(runtimeEntrypoints, "resolveRuntimeProcessEntrypointUrl");
    const argv = [powershell, ...psArgs, "Write-Output ok"];
    try {
      entry.mockReturnValue(pathToFileURL(path.join(appRoot, "src", "github-exec-launcher.ts")));
      withMockedWindowsPlatform(() => buildGitHubExecLaunchArgv(argv, "unused-profile"));
      entry.mockReturnValue(
        pathToFileURL(path.join(appRoot, "dist", "agents", "github-exec-launcher.js")),
      );
      const platform = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
      try {
        buildGitHubExecLaunchArgv(argv, "unused-profile");
      } finally {
        platform.mockRestore();
      }
      expect(startup).not.toHaveBeenCalled();
    } finally {
      startup.mockRestore();
      entry.mockRestore();
    }
  });

  it.skipIf(process.platform !== "win32")(
    "keeps the early CLI redirect roots when the bootstrap module is evaluated again",
    async () => {
      const root = await tempRoot();
      const bootstrap = new URL("../../cli-invocation.mjs", import.meta.url).href;
      const { code, stdout, stderr } = await run(
        [
          process.execPath,
          "--input-type=module",
          "--eval",
          `
              await import(${JSON.stringify(bootstrap)});
              process.env.OPENCLAW_NATIVE_APP_ROOT = "late-app";
              process.env.OPENCLAW_NATIVE_STAGED_ROOT = "late-stage";
              const second = await import(${JSON.stringify(`${bootstrap}?bundled-copy`)});
              const { appRoot, stagedRoot } = second.getWindowsNativeRedirectStartup();
              process.stdout.write(JSON.stringify({ appRoot, stagedRoot }));
              `,
        ],
        root,
        {
          env: {
            OPENCLAW_NATIVE_APP_ROOT: "startup-app",
            OPENCLAW_NATIVE_STAGED_ROOT: "startup-stage",
          },
        },
      );
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      expect(JSON.parse(stdout)).toEqual({
        appRoot: "startup-app",
        stagedRoot: "startup-stage",
      });
    },
  );
  it.each([
    { credentialState: "available", externalCommand: false },
    { credentialState: "missing", externalCommand: false },
    { credentialState: "insecure", externalCommand: false },
    { credentialState: "available", externalCommand: true },
    { credentialState: "available", externalCommand: true, host: "ghe.example.test" },
  ])(
    "keeps the PowerShell owner for $credentialState credentials (external: $externalCommand)",
    async ({ credentialState, externalCommand, host = "github.com" }) => {
      const root = await tempRoot();
      const profile =
        credentialState === "insecure"
          ? path.join(root, "not-a-profile-directory")
          : await profileAt(
              root,
              host,
              credentialState === "available" ? "synthetic-powershell-token" : undefined,
            );
      if (credentialState === "insecure") {
        await fs.writeFile(profile, "not a directory");
      }
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
      const { code, stdout, stderr } = await run(launchArgv, root, {
        env: {
          SystemRoot: process.env.SystemRoot,
          POWERSHELL_TELEMETRY_OPTOUT: "1",
        },
      });
      if (credentialState === "available") {
        expect({ code, stderr }).toEqual({ code: 7, stderr: "" });
        const expected = { cwd: root, host, selected: true, cleared: true, args };
        expect(JSON.parse(stdout)).toEqual(expected);
      } else {
        expect({ code, stdout }).toEqual({ code: 1, stdout: "" });
        expect(stderr).toContain("GitHub Identity credential is unavailable or insecure");
        expect(stderr).toContain("GitHub Identity stage: credential-read");
        expect(stderr).not.toContain(profile);
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
          ...(runtime === "bun"
            ? []
            : ["--import", new URL("../../scripts/tsx.mjs", import.meta.url).href]),
          driver,
          profile,
          target,
          ...args,
        ];
        const { code, stdout, stderr } = await run([runtime, ...argv], root, {
          cwd: commandCwd,
          env: { ZDOTDIR: root },
          stdio: ["ignore", "pipe", "pipe", "pipe"],
        });
        expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
        const expected = { args, cwd: commandCwd, selected: true, cleared: true, lineage: true };
        expect(JSON.parse(stdout)).toEqual(expected);
      },
    );
  }
});
