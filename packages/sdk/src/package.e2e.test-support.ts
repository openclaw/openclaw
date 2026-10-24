import { spawn, spawnSync, type SpawnOptionsWithoutStdio } from "node:child_process";
import { once } from "node:events";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
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

function resolveWorkspacePackageRoot(repoRoot: string, packageName: string): string {
  const prefix = "@openclaw/";
  if (!packageName.startsWith(prefix)) {
    throw new Error(`unsupported workspace package name: ${packageName}`);
  }
  return path.join(repoRoot, "packages", packageName.slice(prefix.length));
}

async function readPackageManifest(packageRoot: string): Promise<PackageManifest> {
  return JSON.parse(
    await fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
  ) as PackageManifest;
}

async function collectWorkspacePackageRoots(repoRoot: string): Promise<string[]> {
  const orderedRoots: string[] = [];
  const visitedNames = new Set<string>();

  async function visit(packageRoot: string, expectedName?: string): Promise<void> {
    const manifest = await readPackageManifest(packageRoot);
    if (expectedName && manifest.name !== expectedName) {
      throw new Error(
        `workspace dependency ${expectedName} resolved to unexpected package ${manifest.name}`,
      );
    }
    if (visitedNames.has(manifest.name)) {
      return;
    }
    visitedNames.add(manifest.name);
    const workspaceDependencies = Object.entries(manifest.dependencies ?? {})
      .filter(([, spec]) => spec.startsWith("workspace:"))
      .map(([name]) => name)
      .toSorted();
    for (const dependencyName of workspaceDependencies) {
      await visit(resolveWorkspacePackageRoot(repoRoot, dependencyName), dependencyName);
    }
    orderedRoots.push(packageRoot);
  }

  await visit(path.join(repoRoot, "packages", "sdk"));
  return orderedRoots;
}

function writeJson(root: string, file: string, value: unknown): Promise<void> {
  return fs.writeFile(path.join(root, file), JSON.stringify(value, null, 2));
}

async function packPackage(packageRoot: string, destinationRoot: string): Promise<PackedPackage> {
  const manifest = await readPackageManifest(packageRoot);
  const dependencies = manifest.dependencies ?? {};
  for (const [name, spec] of Object.entries(dependencies)) {
    if (name.startsWith("@openclaw/") && spec.startsWith("workspace:")) {
      const root = resolveWorkspacePackageRoot(path.resolve(packageRoot, "..", ".."), name);
      dependencies[name] = (await readPackageManifest(root)).version;
    }
  }
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

async function startOpenClawRegistry(packages: PackedPackage[]) {
  const byName = new Map(packages.map((pkg) => [pkg.manifest.name, pkg]));
  const byTarball = new Map(packages.map((pkg) => [path.basename(pkg.tarball), pkg]));
  const server = createServer((req, res) => {
    const origin = `http://${req.headers.host ?? "127.0.0.1"}`;
    const decodedPath = decodeURIComponent(new URL(req.url ?? "/", origin).pathname);
    const isTarball = decodedPath.startsWith("/tarballs/");
    const pkg = isTarball
      ? byTarball.get(decodedPath.slice("/tarballs/".length))
      : byName.get(decodedPath.slice(1));
    if (!pkg) {
      res.writeHead(404).end();
      return;
    }
    if (isTarball) {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      createReadStream(pkg.tarball).pipe(res);
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    const { manifest, tarball } = pkg;
    const dist = { tarball: `${origin}/tarballs/${encodeURIComponent(path.basename(tarball))}` };
    res.end(
      JSON.stringify({
        name: manifest.name,
        "dist-tags": { latest: manifest.version },
        versions: { [manifest.version]: { ...manifest, dist } },
      }),
    );
  });
  const close = promisify(server.close.bind(server));
  await once(server.listen(0, "127.0.0.1"), "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    await close();
    throw new Error("registry server did not bind to a TCP port");
  }
  return { registryUrl: `http://127.0.0.1:${address.port}/`, close };
}

export async function createPackedSdkConsumer() {
  const repoRoot = process.cwd();
  const packageRoots = await collectWorkspacePackageRoots(repoRoot);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sdk-consumer-"));
  try {
    const packedPackages: PackedPackage[] = [];
    const buildLockTarget = path.join(repoRoot, ".artifacts", "sdk-package-e2e-build");
    await fs.mkdir(path.dirname(buildLockTarget), { recursive: true });
    // Builds clean shared dist directories: lock through packing and validation.
    await withFileLock(buildLockTarget, SDK_PACKAGE_BUILD_LOCK_OPTIONS, async () => {
      for (const packageRoot of packageRoots) {
        const manifest = await readPackageManifest(packageRoot);
        await runPackageCommand(
          "pnpm",
          ["--filter", manifest.name, manifest.scripts?.prepack ? "prepack" : "build"],
          repoRoot,
          180_000,
        );
      }
      for (const packageRoot of packageRoots) {
        packedPackages.push(await packPackage(packageRoot, root));
      }
    });
    const sdkTarball =
      packedPackages.find((pkg) => pkg.manifest.name === "@openclaw/sdk")?.tarball ?? "";
    if (!sdkTarball) {
      throw new Error("packed @openclaw/sdk tarball was not created");
    }
    const registry = await startOpenClawRegistry(packedPackages);
    await writeJson(root, "package.json", { private: true, type: "module" });
    await fs.writeFile(path.join(root, ".npmrc"), `@openclaw:registry=${registry.registryUrl}`);
    try {
      await runPackageCommand(
        "npm",
        ["install", "--ignore-scripts", "--no-audit", "--no-fund", sdkTarball],
        root,
      );
    } finally {
      await registry.close();
    }
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
