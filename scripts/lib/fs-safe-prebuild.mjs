// Package-local repair for npm installs that omitted fs-safe's precompiled addon.
import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildCmdExeCommandLine, resolveWindowsCmdExePath } from "../windows-cmd-helpers.mjs";

const PROBE_TIMEOUT_MS = 10_000;
const INSTALL_TIMEOUT_MS = 60_000;
const scriptPath = fileURLToPath(import.meta.url);
const NPM_CLI_REPORT = "OPENCLAW_NPM_CLI:";
// Inline preloading gives delayed manager descendants no temporary file to outlive.
// It reports the selected CLI before npm initializes or can run package scripts.
const NPM_CLI_PRELOAD = `data:text/javascript;base64,${Buffer.from(`
  import fs from "node:fs";
  import path from "node:path";
  try {
    const cli = fs.realpathSync(process.argv[1]);
    if (path.basename(cli) === "npm-cli.js" &&
        JSON.parse(fs.readFileSync(path.join(path.dirname(cli), "../package.json"), "utf8")).name === "npm") {
      fs.writeFileSync(1, ${JSON.stringify(NPM_CLI_REPORT)} + JSON.stringify(cli) + "\\n");
      process.exit(0);
    }
  } catch {}
`).toString("base64")}`;

async function probePrebuild(packageRoot) {
  const requireFromPackage = createRequire(path.join(packageRoot, "package.json"));
  const manifestPath = requireFromPackage.resolve("@openclaw/fs-safe/package.json");
  const entryDirectory = path.dirname(requireFromPackage.resolve("@openclaw/fs-safe"));
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const dependencies = manifest.optionalDependencies ?? {};
  const { configureFsSafeNative, getFsSafeNativeConfig } = await import(
    pathToFileURL(requireFromPackage.resolve("@openclaw/fs-safe/config")).href
  );
  if (getFsSafeNativeConfig().mode === "off") {
    return { status: "disabled" };
  }
  configureFsSafeNative({ mode: "require" });
  const { readCloneFileMetadata } = await import(
    pathToFileURL(requireFromPackage.resolve("@openclaw/fs-safe/copy")).href
  );
  try {
    // An empty metadata query enters N-API without touching any filesystem path.
    await readCloneFileMetadata([]);
    return { status: "ready" };
  } catch (error) {
    // Let fs-safe select the platform/libc. Only Node's exact missing-package
    // error permits repair; a broken addon or a failed filesystem call does not.
    const firstLine = error?.cause?.message?.split("\n", 1)[0];
    const name = Object.keys(dependencies).find(
      (candidate) =>
        /^@openclaw\/fs-safe-[a-z0-9-]+$/u.test(candidate) &&
        firstLine === `Cannot find module '${candidate}'`,
    );
    if (
      error?.code !== "helper-unavailable" ||
      error?.cause?.code !== "MODULE_NOT_FOUND" ||
      path.dirname(error.cause.requireStack?.[0] ?? "") !== entryDirectory ||
      !name
    ) {
      return { status: "unavailable", reason: "the native binding could not be loaded or used" };
    }
    const version = dependencies[name];
    if (
      typeof version !== "string" ||
      !/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/u.test(version)
    ) {
      return { status: "unavailable", reason: "the native dependency is not an exact version" };
    }
    const requireFromFsSafe = createRequire(manifestPath);
    try {
      requireFromFsSafe.resolve(`${name}/package.json`);
      return { status: "unavailable", reason: "the installed native package is incomplete" };
    } catch (resolveError) {
      if (resolveError?.code !== "MODULE_NOT_FOUND") {
        throw resolveError;
      }
    }
    return { status: "missing", name, version, root: path.dirname(manifestPath) };
  }
}

function runProbe(packageRoot, env) {
  const result = spawnSync(process.execPath, [scriptPath, "--probe", packageRoot], {
    encoding: "utf8",
    env,
    timeout: PROBE_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 64 * 1024,
  });
  if (result.status !== 0 || result.error) {
    throw new Error("the native binding check failed");
  }
  return JSON.parse(result.stdout);
}

function inspectNpmCli(launcher, env, cwd) {
  const batch = process.platform === "win32" && /\.(?:cmd|bat)$/iu.test(launcher);
  const command = batch ? resolveWindowsCmdExePath(env) : launcher;
  const args = batch
    ? ["/d", "/s", "/c", buildCmdExeCommandLine(launcher, ["--version"])]
    : ["--version"];
  // Managers retain their own startup/pin selection. Only discovery uses the
  // shim; the download below always runs as a directly owned Node process.
  const result = spawnSync(command, args, {
    cwd,
    env: {
      ...env,
      NODE_OPTIONS: [env.NODE_OPTIONS, `--import=${NPM_CLI_PRELOAD}`].filter(Boolean).join(" "),
    },
    encoding: "utf8",
    timeout: PROBE_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 64 * 1024,
  });
  if (result.status !== 0 || result.error) {
    throw new Error(
      result.error?.code === "ETIMEDOUT"
        ? "npm launcher discovery timed out"
        : "the selected npm launcher could not be inspected",
    );
  }
  const reports = result.stdout.split(/\r?\n/u).filter((line) => line.startsWith(NPM_CLI_REPORT));
  const cli = reports.length === 1 ? JSON.parse(reports[0].slice(NPM_CLI_REPORT.length)) : null;
  if (
    typeof cli !== "string" ||
    !path.isAbsolute(cli) ||
    path.basename(cli) !== "npm-cli.js" ||
    !statSync(cli).isFile()
  ) {
    throw new Error("the selected npm launcher did not report its npm-cli.js");
  }
  return realpathSync(cli);
}

function resolveNpmCli(env, cwd) {
  const npmExecPath = env.npm_execpath;
  if (npmExecPath && path.basename(npmExecPath).toLowerCase() === "npm-cli.js") {
    return npmExecPath;
  }
  const pathValue = Object.entries(env).find(([key]) => key.toLowerCase() === "path")?.[1] ?? "";
  const pathExt = Object.entries(env).find(([key]) => key.toLowerCase() === "pathext")?.[1];
  const extensions =
    process.platform === "win32"
      ? (pathExt ?? ".COM;.EXE;.BAT;.CMD").split(";").map((extension) => extension.toLowerCase())
      : [""];
  for (const entry of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const launcher = path.resolve(cwd, entry.replace(/^"(.*)"$/u, "$1"), `npm${extension}`);
      try {
        if (!statSync(launcher).isFile()) {
          continue;
        }
        if (process.platform !== "win32") {
          accessSync(launcher, constants.X_OK);
        }
      } catch {
        continue;
      }
      // Direct package layouts need no discovery. Other shims must reveal their
      // selected npm; never skip an earlier PATH owner to try a different one.
      const cli =
        process.platform === "win32" && extension === ".cmd"
          ? path.join(path.dirname(launcher), "node_modules", "npm", "bin", "npm-cli.js")
          : realpathSync(launcher);
      if (path.basename(cli) === "npm-cli.js" && existsSync(cli) && statSync(cli).isFile()) {
        return cli;
      }
      return inspectNpmCli(launcher, env, cwd);
    }
  }
  throw new Error("npm is unavailable for the native dependency download");
}

function runNpmInstall(npmCli, ownerRoot, stageRoot, spec, env) {
  const args = [
    "install",
    spec,
    "--prefix",
    stageRoot,
    "--global=false",
    "--location=project",
    "--workspaces=false",
    "--include=optional",
    "--ignore-scripts",
    "--package-lock=false",
    "--save=false",
    "--no-audit",
    "--no-fund",
    "--loglevel=error",
    "--fetch-retries=0",
  ];
  // A global lifecycle exports its CLI-only allow-scripts policy. npm rejects
  // that policy in a local project even with --ignore-scripts; this repair runs none.
  const childEnv = Object.fromEntries(
    Object.entries(env).filter(([key]) => key.toLowerCase() !== "npm_config_allow_scripts"),
  );
  const result = spawnSync(process.execPath, [npmCli, ...args], {
    cwd: ownerRoot,
    env: childEnv,
    encoding: "utf8",
    timeout: INSTALL_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 64 * 1024,
  });
  if (result.status !== 0 || result.error) {
    throw new Error(`npm could not download ${spec}`);
  }
}

function ensurePackageDirectory(directory) {
  try {
    mkdirSync(directory);
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw error;
    }
  }
  if (!lstatSync(directory).isDirectory()) {
    throw new Error("the native dependency directory is not a real directory");
  }
}

/** Restores only the missing, exact native dependency inside its installed owner. */
export function restoreFsSafePrebuild(packageRoot, env = process.env, log = console) {
  let stageRoot;
  let installedRoot;
  try {
    if (!existsSync(path.join(packageRoot, "package.json"))) {
      return;
    }
    const manifest = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
    if (!manifest.dependencies?.["@openclaw/fs-safe"]) {
      return;
    }
    const probe = runProbe(packageRoot, env);
    if (probe.status === "ready" || probe.status === "disabled") {
      return;
    }
    if (probe.status !== "missing") {
      throw new Error(probe.reason);
    }
    const ownerRoot = realpathSync(packageRoot);
    const fsSafeRoot = realpathSync(probe.root);
    const relativeRoot = path.relative(ownerRoot, fsSafeRoot);
    if (
      !relativeRoot ||
      relativeRoot.startsWith(`..${path.sep}`) ||
      relativeRoot === ".." ||
      path.isAbsolute(relativeRoot)
    ) {
      throw new Error("the native dependency belongs to another package-manager installation");
    }
    const npmCli = resolveNpmCli(env, ownerRoot);
    stageRoot = mkdtempSync(path.join(ownerRoot, ".openclaw-prebuild-"));
    writeFileSync(path.join(stageRoot, "package.json"), '{"private":true}\n');
    runNpmInstall(npmCli, ownerRoot, stageRoot, `${probe.name}@${probe.version}`, env);
    const stagedPackage = path.join(stageRoot, "node_modules", probe.name);
    const installed = JSON.parse(readFileSync(path.join(stagedPackage, "package.json"), "utf8"));
    if (installed.name !== probe.name || installed.version !== probe.version) {
      throw new Error("npm did not install the matching native package");
    }
    const destination = path.join(fsSafeRoot, "node_modules", probe.name);
    ensurePackageDirectory(path.join(fsSafeRoot, "node_modules"));
    ensurePackageDirectory(path.dirname(destination));
    // An exclusive directory reservation preserves any pre-existing package.
    mkdirSync(destination);
    installedRoot = destination;
    cpSync(stagedPackage, destination, { recursive: true, force: false, errorOnExist: true });
    if (runProbe(packageRoot, env).status !== "ready") {
      throw new Error("the restored native binding could not be loaded or used");
    }
    installedRoot = undefined;
    log.log?.(`[postinstall] restored ${probe.name}@${probe.version}`);
  } catch (error) {
    log.warn?.(
      `[postinstall] fs-safe native support is unavailable: ${error instanceof Error ? error.message : String(error)}. Installation will continue; retry the OpenClaw installation to restore native support.`,
    );
  } finally {
    for (const ownedRoot of [installedRoot, stageRoot]) {
      if (!ownedRoot) {
        continue;
      }
      try {
        rmSync(ownedRoot, { recursive: true, force: true });
      } catch {
        log.warn?.("[postinstall] could not clean up the fs-safe native repair directory");
      }
    }
  }
}

if (
  process.argv[2] === "--probe" &&
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  try {
    process.stdout.write(JSON.stringify(await probePrebuild(process.argv[3])));
  } catch {
    process.exitCode = 1;
  }
}
