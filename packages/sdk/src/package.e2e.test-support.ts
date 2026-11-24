import { spawn, spawnSync, type SpawnOptionsWithoutStdio } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveNpmRunner } from "../../../scripts/npm-runner.mts";
import { resolvePnpmRunner } from "../../../scripts/pnpm-runner.mts";
import { type FileLockOptions, withFileLock } from "../../../src/infra/file-lock.js";
import { getWindowsSystem32ExePath } from "../../../src/infra/windows-install-roots.js";
import { createNodeEvalArgs } from "../../../src/test-utils/node-process.js";

type PackageManifest = {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  [key: string]: unknown;
};

type PackedPackage = { manifest: PackageManifest; tarball: string };
type WorkspacePackage = { root: string; manifest: PackageManifest };
type CommandOptions = { cwd: string; timeoutMs?: number } & Pick<
  SpawnOptionsWithoutStdio,
  "env" | "shell" | "windowsVerbatimArguments"
>;

const SDK_PACKAGE_BUILD_LOCK_OPTIONS = {
  retries: {
    retries: 180,
    factor: 1,
    minTimeout: 5_000,
    maxTimeout: 5_000,
    randomize: false,
  },
  stale: 20 * 60_000,
} satisfies FileLockOptions;

const createCommandEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  CI: process.env.CI ?? "true",
  npm_config_audit: "false",
  npm_config_fund: "false",
  PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: "false",
});

export function signalCommandProcess(
  child: ReturnType<typeof spawn>,
  runTaskkill: typeof spawnSync = spawnSync,
): void {
  if (process.platform === "win32") {
    if (typeof child.pid === "number") {
      const taskkillPath = getWindowsSystem32ExePath("taskkill.exe");
      const args = ["/PID", String(child.pid), "/T", "/F"];
      const result = runTaskkill(taskkillPath, args, { stdio: "ignore", windowsHide: true });
      if (!result.error && result.status === 0) {
        return;
      }
    }
  } else if (typeof child.pid === "number") {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        return;
      }
    }
  }
  child.kill("SIGKILL");
}

async function runCommand(command: string, args: string[], options: CommandOptions): Promise<void> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const { timeoutMs = 120_000, env = createCommandEnv(), ...spawnOptions } = options;
  const commandLine = [command, ...args].join(" ");
  const child = spawn(command, args, {
    ...spawnOptions,
    env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.setEncoding("utf8").on("data", (chunk) => stdout.push(String(chunk)));
  child.stderr?.setEncoding("utf8").on("data", (chunk) => stderr.push(String(chunk)));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const [code, signal] = await Promise.race([
      once(child, "exit"),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          signalCommandProcess(child);
          reject(new Error(`command timed out after ${timeoutMs}ms: ${commandLine}`));
        }, timeoutMs);
      }),
    ]);
    if (code !== 0) {
      throw new Error(
        `command failed (${String(code ?? signal)}): ${commandLine}\n` +
          `--- stdout ---\n${stdout.join("")}\n--- stderr ---\n${stderr.join("")}`,
      );
    }
  } finally {
    clearTimeout(timer);
  }
}

function runPackageCommand(
  manager: "npm" | "pnpm",
  args: string[],
  cwd: string,
  timeoutMs?: number,
): Promise<void> {
  const env = createCommandEnv();
  const runner: ReturnType<typeof resolveNpmRunner> =
    manager === "pnpm"
      ? resolvePnpmRunner({ cwd, env, pnpmArgs: args })
      : resolveNpmRunner({ env, npmArgs: args });
  return runCommand(runner.command, runner.args, {
    cwd,
    timeoutMs,
    env: runner.env ?? env,
    shell: runner.shell,
    windowsVerbatimArguments: runner.windowsVerbatimArguments,
  });
}

async function collectWorkspacePackages(repoRoot: string): Promise<WorkspacePackage[]> {
  const packages: WorkspacePackage[] = [];
  const visitedNames = new Set<string>();

  async function visit(expectedName: string): Promise<PackageManifest> {
    if (!expectedName.startsWith("@openclaw/")) {
      throw new Error(`unsupported workspace package name: ${expectedName}`);
    }
    const packageRoot = path.join(repoRoot, "packages", expectedName.slice("@openclaw/".length));
    const manifest: PackageManifest = JSON.parse(
      await fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
    );
    if (manifest.name !== expectedName) {
      throw new Error(
        `workspace dependency ${expectedName} resolved to unexpected package ${manifest.name}`,
      );
    }
    if (visitedNames.has(manifest.name)) {
      return manifest;
    }
    visitedNames.add(manifest.name);
    const dependencies = manifest.dependencies ?? {};
    const workspaceDependencies = Object.entries(dependencies)
      .filter(([, spec]) => spec.startsWith("workspace:"))
      .map(([name]) => name)
      .toSorted();
    for (const dependencyName of workspaceDependencies) {
      dependencies[dependencyName] = (await visit(dependencyName)).version;
    }
    packages.push({ root: packageRoot, manifest });
    return manifest;
  }

  await visit("@openclaw/sdk");
  return packages;
}

function writeJson(root: string, file: string, value: unknown): Promise<void> {
  return fs.writeFile(path.join(root, file), JSON.stringify(value, null, 2));
}

async function packPackage(
  { root: packageRoot, manifest }: WorkspacePackage,
  destinationRoot: string,
): Promise<PackedPackage> {
  const packageSlug = manifest.name.replace(/^@/, "").replace("/", "-");
  const stagingRoot = path.join(destinationRoot, `pack-${packageSlug}`);
  await fs.mkdir(stagingRoot, { recursive: true });
  await writeJson(stagingRoot, "package.json", manifest);
  const files: string[] = Array.isArray(manifest.files) ? (manifest.files as string[]) : [];
  for (const entry of files) {
    if (typeof entry === "string") {
      await fs.cp(path.join(packageRoot, entry), path.join(stagingRoot, entry), {
        recursive: true,
      });
    }
  }
  await runPackageCommand(
    "npm",
    ["pack", "--ignore-scripts", "--pack-destination", destinationRoot],
    stagingRoot,
  );
  const tarball = path.join(destinationRoot, `${packageSlug}-${manifest.version}.tgz`);
  await fs.stat(tarball);
  return { manifest, tarball };
}

export async function installPackedSdkConsumer(packages: PackedPackage[], root: string) {
  const sdkTarball = packages.find((pkg) => pkg.manifest.name === "@openclaw/sdk")?.tarball;
  if (!sdkTarball) {
    throw new Error("packed @openclaw/sdk tarball was not created");
  }
  await writeJson(root, "package.json", {
    private: true,
    type: "module",
    // Select local sources only for declared, compatible transitive edges. A loopback
    // HTTP registry needlessly mixes protocols in npm's proxy-agent cache.
    overrides: Object.fromEntries(
      packages
        .filter(({ manifest }) => manifest.name !== "@openclaw/sdk")
        .map(({ manifest, tarball }) => [
          `${manifest.name}@${manifest.version}`,
          `file:${tarball}`,
        ]),
    ),
  });
  await runPackageCommand(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", sdkTarball],
    root,
  );
}

export async function createPackedSdkConsumer() {
  const repoRoot = process.cwd();
  const packages = await collectWorkspacePackages(repoRoot);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sdk-consumer-"));
  try {
    const packedPackages: PackedPackage[] = [];
    const buildLockTarget = path.join(repoRoot, ".artifacts", "sdk-package-e2e-build");
    await fs.mkdir(path.dirname(buildLockTarget), { recursive: true });
    // Builds clean shared dist directories: lock through packing and validation.
    await withFileLock(buildLockTarget, SDK_PACKAGE_BUILD_LOCK_OPTIONS, async () => {
      for (const { manifest } of packages) {
        await runPackageCommand(
          "pnpm",
          ["--filter", manifest.name, manifest.scripts?.prepack ? "prepack" : "build"],
          repoRoot,
          180_000,
        );
      }
      for (const pkg of packages) {
        packedPackages.push(await packPackage(pkg, root));
      }
    });
    await installPackedSdkConsumer(packedPackages, root);
  } catch (error) {
    await fs.rm(root, { recursive: true, force: true });
    throw error;
  }

  return {
    root,
    run: (script: string) =>
      runCommand(process.execPath, createNodeEvalArgs(script, { evalFlag: "-e" }), { cwd: root }),
    typecheck: async (source: string) => {
      const tsconfigPath = path.join(root, "tsconfig.json");
      await fs.writeFile(path.join(root, "consumer.ts"), source);
      await writeJson(root, "tsconfig.json", {
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          noEmit: true,
          skipLibCheck: true,
          strict: true,
          types: [],
        },
        include: ["consumer.ts"],
      });
      await runCommand(
        process.execPath,
        [path.join(repoRoot, "scripts", "run-tsgo.mjs"), "-p", tsconfigPath, "--pretty", "false"],
        { cwd: repoRoot },
      );
    },
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}
