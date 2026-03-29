import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const WINDOWS_UNSAFE_CMD_CHARS_RE = /[&|<>^%\r\n]/;

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function removePathIfExists(targetPath) {
  fs.rmSync(targetPath, { recursive: true, force: true });
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function moveDirIntoPlace(sourceDir, targetDir) {
  try {
    fs.renameSync(sourceDir, targetDir);
    return;
  } catch (error) {
    const code = error && typeof error === "object" ? error.code : undefined;
    const isWindowsRenameLock =
      process.platform === "win32" && (code === "EPERM" || code === "EBUSY");
    if (!isWindowsRenameLock) {
      throw error;
    }
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      fs.cpSync(sourceDir, targetDir, { recursive: true, force: true });
      removePathIfExists(sourceDir);
      return;
    } catch (error) {
      if (attempt === 2) {
        throw error;
      }
      sleepMs(100 * (attempt + 1));
    }
  }
}

function makeTempDir(parentDir, prefix) {
  return fs.mkdtempSync(path.join(parentDir, prefix));
}

function listBundledPluginRuntimeDirs(repoRoot) {
  const extensionsRoot = path.join(repoRoot, "dist", "extensions");
  if (!fs.existsSync(extensionsRoot)) {
    return [];
  }

  return fs
    .readdirSync(extensionsRoot, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => path.join(extensionsRoot, dirent.name))
    .filter((pluginDir) => fs.existsSync(path.join(pluginDir, "package.json")));
}

function hasRuntimeDeps(packageJson) {
  return (
    Object.keys(packageJson.dependencies ?? {}).length > 0 ||
    Object.keys(packageJson.optionalDependencies ?? {}).length > 0
  );
}

function shouldStageRuntimeDeps(packageJson) {
  return packageJson.openclaw?.bundle?.stageRuntimeDependencies === true;
}

function sanitizeBundledManifestForRuntimeInstall(pluginDir) {
  const manifestPath = path.join(pluginDir, "package.json");
  const packageJson = readJson(manifestPath);
  let changed = false;

  if (packageJson.peerDependencies?.openclaw) {
    const nextPeerDependencies = { ...packageJson.peerDependencies };
    delete nextPeerDependencies.openclaw;
    if (Object.keys(nextPeerDependencies).length === 0) {
      delete packageJson.peerDependencies;
    } else {
      packageJson.peerDependencies = nextPeerDependencies;
    }
    changed = true;
  }

  if (packageJson.peerDependenciesMeta?.openclaw) {
    const nextPeerDependenciesMeta = { ...packageJson.peerDependenciesMeta };
    delete nextPeerDependenciesMeta.openclaw;
    if (Object.keys(nextPeerDependenciesMeta).length === 0) {
      delete packageJson.peerDependenciesMeta;
    } else {
      packageJson.peerDependenciesMeta = nextPeerDependenciesMeta;
    }
    changed = true;
  }

  if (packageJson.devDependencies?.openclaw) {
    const nextDevDependencies = { ...packageJson.devDependencies };
    delete nextDevDependencies.openclaw;
    if (Object.keys(nextDevDependencies).length === 0) {
      delete packageJson.devDependencies;
    } else {
      packageJson.devDependencies = nextDevDependencies;
    }
    changed = true;
  }

  if (changed) {
    writeJson(manifestPath, packageJson);
  }

  return packageJson;
}

function resolveRuntimeDepsStampPath(pluginDir) {
  return path.join(pluginDir, ".openclaw-runtime-deps-stamp.json");
}

function createRuntimeDepsFingerprint(packageJson) {
  return createHash("sha256").update(JSON.stringify(packageJson)).digest("hex");
}

function readRuntimeDepsStamp(stampPath) {
  if (!fs.existsSync(stampPath)) {
    return null;
  }
  try {
    return readJson(stampPath);
  } catch {
    return null;
  }
}

export function resolveNpmRunner(params = {}) {
  const execPath = params.execPath ?? process.execPath;
  const npmArgs = params.npmArgs ?? [];
  const existsSync = params.existsSync ?? fs.existsSync;
  const env = params.env ?? process.env;
  const platform = params.platform ?? process.platform;
  const comSpec = params.comSpec ?? env.ComSpec ?? "cmd.exe";
  const pathImpl = platform === "win32" ? path.win32 : path.posix;
  const nodeDir = pathImpl.dirname(execPath);
  const npmToolchain = resolveToolchainNpmRunner({
    comSpec,
    existsSync,
    nodeDir,
    npmArgs,
    pathImpl,
    platform,
  });
  if (npmToolchain) {
    return npmToolchain;
  }
  if (platform === "win32") {
    const expectedPaths = [
      pathImpl.resolve(nodeDir, "../lib/node_modules/npm/bin/npm-cli.js"),
      pathImpl.resolve(nodeDir, "node_modules/npm/bin/npm-cli.js"),
      pathImpl.resolve(nodeDir, "npm.exe"),
      pathImpl.resolve(nodeDir, "npm.cmd"),
    ];
    throw new Error(
      `failed to resolve a toolchain-local npm next to ${execPath}. ` +
        `Checked: ${expectedPaths.join(", ")}. ` +
        "OpenClaw refuses to shell out to bare npm on Windows; install a Node.js toolchain that bundles npm or run with a matching Node installation.",
    );
  }
  const pathKey = resolvePathEnvKey(env);
  const currentPath = env[pathKey];
  return {
    command: "npm",
    args: npmArgs,
    shell: false,
    env: {
      ...env,
      [pathKey]:
        typeof currentPath === "string" && currentPath.length > 0
          ? `${nodeDir}${path.delimiter}${currentPath}`
          : nodeDir,
    },
  };
}

function resolveToolchainNpmRunner(params) {
  const npmCliCandidates = [
    params.pathImpl.resolve(params.nodeDir, "../lib/node_modules/npm/bin/npm-cli.js"),
    params.pathImpl.resolve(params.nodeDir, "node_modules/npm/bin/npm-cli.js"),
  ];
  const npmCliPath = npmCliCandidates.find((candidate) => params.existsSync(candidate));
  if (npmCliPath) {
    return {
      command:
        params.platform === "win32"
          ? params.pathImpl.join(params.nodeDir, "node.exe")
          : params.pathImpl.join(params.nodeDir, "node"),
      args: [npmCliPath, ...params.npmArgs],
      shell: false,
    };
  }
  if (params.platform !== "win32") {
    return null;
  }
  const npmExePath = params.pathImpl.resolve(params.nodeDir, "npm.exe");
  if (params.existsSync(npmExePath)) {
    return {
      command: npmExePath,
      args: params.npmArgs,
      shell: false,
    };
  }
  const npmCmdPath = params.pathImpl.resolve(params.nodeDir, "npm.cmd");
  if (params.existsSync(npmCmdPath)) {
    return {
      command: params.comSpec,
      args: ["/d", "/s", "/c", buildCmdExeCommandLine(npmCmdPath, params.npmArgs)],
      shell: false,
      windowsVerbatimArguments: true,
    };
  }
  return null;
}

function resolvePathEnvKey(env) {
  return Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
}

function escapeForCmdExe(arg) {
  if (WINDOWS_UNSAFE_CMD_CHARS_RE.test(arg)) {
    throw new Error(`unsafe Windows cmd.exe argument detected: ${JSON.stringify(arg)}`);
  }
  if (!arg.includes(" ") && !arg.includes('"')) {
    return arg;
  }
  return `"${arg.replace(/"/g, '""')}"`;
}

function buildCmdExeCommandLine(command, args) {
  return [escapeForCmdExe(command), ...args.map(escapeForCmdExe)].join(" ");
}

function installPluginRuntimeDeps(params) {
  const { fingerprint, packageJson, pluginDir, pluginId } = params;
  const nodeModulesDir = path.join(pluginDir, "node_modules");
  const stampPath = resolveRuntimeDepsStampPath(pluginDir);
  const tempInstallDir = makeTempDir(pluginDir, ".runtime-deps-");
  const npmRunner = resolveNpmRunner({
    npmArgs: [
      "install",
      "--omit=dev",
      "--silent",
      "--ignore-scripts",
      "--legacy-peer-deps",
      "--package-lock=false",
    ],
  });
  try {
    writeJson(path.join(tempInstallDir, "package.json"), packageJson);
    const result = spawnSync(npmRunner.command, npmRunner.args, {
      cwd: tempInstallDir,
      encoding: "utf8",
      env: npmRunner.env,
      stdio: "pipe",
      shell: npmRunner.shell,
      windowsVerbatimArguments: npmRunner.windowsVerbatimArguments,
    });
    if (result.status !== 0) {
      const output = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
      throw new Error(
        `failed to stage bundled runtime deps for ${pluginId}: ${output || "npm install failed"}`,
      );
    }

    const stagedNodeModulesDir = path.join(tempInstallDir, "node_modules");
    if (!fs.existsSync(stagedNodeModulesDir)) {
      throw new Error(
        `failed to stage bundled runtime deps for ${pluginId}: npm install produced no node_modules directory`,
      );
    }

    removePathIfExists(nodeModulesDir);
    moveDirIntoPlace(stagedNodeModulesDir, nodeModulesDir);
    writeJson(stampPath, {
      fingerprint,
      generatedAt: new Date().toISOString(),
    });
  } finally {
    removePathIfExists(tempInstallDir);
  }
}

export function stageBundledPluginRuntimeDeps(params = {}) {
  const repoRoot = params.cwd ?? params.repoRoot ?? process.cwd();
  const installPluginRuntimeDepsImpl =
    params.installPluginRuntimeDepsImpl ?? installPluginRuntimeDeps;
  for (const pluginDir of listBundledPluginRuntimeDirs(repoRoot)) {
    const pluginId = path.basename(pluginDir);
    const packageJson = sanitizeBundledManifestForRuntimeInstall(pluginDir);
    const nodeModulesDir = path.join(pluginDir, "node_modules");
    const stampPath = resolveRuntimeDepsStampPath(pluginDir);
    if (!hasRuntimeDeps(packageJson) || !shouldStageRuntimeDeps(packageJson)) {
      removePathIfExists(nodeModulesDir);
      removePathIfExists(stampPath);
      continue;
    }
    const fingerprint = createRuntimeDepsFingerprint(packageJson);
    const stamp = readRuntimeDepsStamp(stampPath);
    if (fs.existsSync(nodeModulesDir) && stamp?.fingerprint === fingerprint) {
      continue;
    }
    installPluginRuntimeDepsImpl({
      fingerprint,
      packageJson,
      pluginDir,
      pluginId,
    });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  stageBundledPluginRuntimeDeps();
}
