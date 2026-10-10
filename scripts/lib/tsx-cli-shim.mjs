// Bootstraps documented JavaScript entrypoints before the TypeScript loader is active.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { constants as osConstants } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ensureRepoNodeModulesLink } from "./local-check-runtime.mts";
import { hasManagedCleanupParent } from "./managed-cleanup-handoff.mts";

const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];
const DEFAULT_FORCE_KILL_DELAY_MS = 5_000;
const FORWARDED_COMPILER_FLAGS = new Set([
  "--maglev",
  "--no-maglev",
  "--concurrent-sparkplug",
  "--no-concurrent-sparkplug",
]);
const SHIM_CHECKOUT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// Forward compiler policy without replaying parent loaders, evals, or debuggers.
export function resolveForwardedNodeCompilerArgs(execArgv = process.execArgv) {
  return execArgv.filter((arg) => FORWARDED_COMPILER_FLAGS.has(arg));
}

export function resolveConfiguredModulesDir(checkoutRoot) {
  const modulesDir =
    (process.env.PNPM_CONFIG_MODULES_DIR ?? process.env.pnpm_config_modules_dir) ||
    process.env.npm_config_modules_dir;
  return modulesDir ? path.resolve(checkoutRoot, modulesDir) : undefined;
}

export function resolveTsxImport(checkoutRoot) {
  const localModulesDir = path.resolve(checkoutRoot, "node_modules");
  const configuredModulesDir = resolveConfiguredModulesDir(checkoutRoot);
  const candidates = configuredModulesDir
    ? [configuredModulesDir, localModulesDir]
    : [localModulesDir];
  for (const selectedModulesDir of candidates) {
    const tsxManifest = path.join(selectedModulesDir, "tsx", "package.json");
    if (!existsSync(tsxManifest)) {
      continue;
    }
    const require = createRequire(tsxManifest);
    // Keep compiled ESM native: tsx's CJS hook rewrites its import-only
    // dependency edges into require() calls with incompatible export conditions.
    const importUrl = pathToFileURL(require.resolve("tsx/esm")).href;
    if (selectedModulesDir === configuredModulesDir) {
      ensureRepoNodeModulesLink(selectedModulesDir, { cwd: checkoutRoot });
    }
    return importUrl;
  }
  throw new Error(
    `Repository dependencies are missing from ${localModulesDir}. Run pnpm install --frozen-lockfile in an independently owned checkout.`,
  );
}

function configureToolingTsx() {
  // tsx indexes the entire shared disk cache before expiration, coupling startup
  // to other checkouts' cache size. This flag retains its in-process Map and
  // reaches descendant tooling before their loaders initialize.
  process.env.TSX_DISABLE_CACHE = "1";
  // Fixtures run this checkout's tooling from a cwd without a tsconfig, which
  // disables tsx paths mapping for workspace imports. Pin this checkout's
  // tsconfig only for that foreign cwd; explicit env and cwd tsconfigs win.
  const checkoutTsconfig = path.join(SHIM_CHECKOUT_ROOT, "tsconfig.json");
  if (
    process.env.TSX_TSCONFIG_PATH === undefined &&
    !existsSync(path.join(process.cwd(), "tsconfig.json")) &&
    existsSync(checkoutTsconfig)
  ) {
    process.env.TSX_TSCONFIG_PATH = checkoutTsconfig;
  }
}

export async function registerToolingTsx() {
  configureToolingTsx();
  await import(resolveTsxImport(SHIM_CHECKOUT_ROOT));
}

function signalExitCode(signal) {
  const signalNumber = osConstants.signals[signal];
  return typeof signalNumber === "number" ? 128 + signalNumber : 1;
}

function writeFailureTrailer(tool, exitCode) {
  if (tool && exitCode !== 0) {
    console.error(`[${tool}] FAILED (exit ${exitCode})`);
  }
}

function signalChild(child, signal, detached) {
  if (!child?.pid) {
    return;
  }
  try {
    if (detached && process.platform !== "win32") {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ESRCH") {
      console.error(error);
    }
  }
}

async function runCliShimInner(moduleUrl, options, nodeArgs) {
  // Native entrypoints need the explicit dependency link without loading TSX.
  if (nodeArgs.length === 0) {
    const modulesDir = resolveConfiguredModulesDir(SHIM_CHECKOUT_ROOT);
    if (modulesDir) {
      ensureRepoNodeModulesLink(modulesDir, { cwd: SHIM_CHECKOUT_ROOT });
    }
  }
  const nodeExecutable = options.executable ?? (process.versions.bun ? "node" : process.execPath);
  const commandArgs = [
    ...nodeArgs,
    ...resolveForwardedNodeCompilerArgs(),
    ...(options.execArgv ?? []),
    fileURLToPath(new URL(options.implementation, moduleUrl)),
    ...process.argv.slice(2),
  ];
  if (
    options.terminationOwner === "implementation" &&
    options.detached !== false &&
    hasManagedCleanupParent()
  ) {
    // A managed parent hands cleanup to this responsive shim. Synchronous
    // preparation stays in our child's group until its own owner is ready.
    const { runManagedCommand } = await import("./managed-child-process.mts");
    const exitCode = await runManagedCommand({
      bin: nodeExecutable,
      args: commandArgs,
      cwd: process.cwd(),
      env: process.env,
      stdio: options.stdio ?? "inherit",
      signalKillGraceMs: options.forceKillDelayMs,
      requireProcessTreeExit: true,
      shell: false,
    });
    writeFailureTrailer(options.failureTool, exitCode);
    process.exitCode = exitCode;
    return;
  }
  const detached = options.detached ?? (process.platform !== "win32" && !process.stdin.isTTY);
  const forceKillDelayMs = options.forceKillDelayMs ?? DEFAULT_FORCE_KILL_DELAY_MS;
  let child = null;
  let forceKillTimer = null;
  const signalHandlers = new Map();
  const cleanup = () => {
    if (forceKillTimer) {
      clearTimeout(forceKillTimer);
      forceKillTimer = null;
    }
    for (const [signal, handler] of signalHandlers) {
      process.off(signal, handler);
    }
    process.off("exit", exitHandler);
  };
  const exitHandler = () => signalChild(child, "SIGTERM", detached);

  for (const signal of FORWARDED_SIGNALS) {
    const handler = () => {
      signalChild(child, signal, detached);
      // A lifecycle-owning implementation must finish killing its own child groups.
      // A competing shim deadline can kill that owner and orphan those children.
      if (options.terminationOwner !== "implementation") {
        forceKillTimer ??= setTimeout(
          () => signalChild(child, "SIGKILL", detached),
          forceKillDelayMs,
        );
        forceKillTimer.unref();
      }
    };
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }
  process.on("exit", exitHandler);

  try {
    child = spawn(nodeExecutable, commandArgs, {
      cwd: process.cwd(),
      detached,
      env: process.env,
      stdio: options.stdio ?? "inherit",
    });
    const result = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    cleanup();

    if (result.signal) {
      writeFailureTrailer(options.failureTool, signalExitCode(result.signal));
      process.kill(process.pid, result.signal);
      return;
    }
    const exitCode = result.code ?? 1;
    writeFailureTrailer(options.failureTool, exitCode);
    process.exitCode = exitCode;
  } catch (error) {
    cleanup();
    console.error(error);
    writeFailureTrailer(options.failureTool, 1);
    process.exitCode = 1;
  }
}

async function runCliShim(moduleUrl, options, nodeArgs) {
  try {
    await runCliShimInner(moduleUrl, options, nodeArgs);
  } catch (error) {
    console.error(error);
    writeFailureTrailer(options.failureTool, 1);
    process.exitCode = 1;
  }
}

export function runNodeCliShim(moduleUrl, options = {}) {
  return runCliShim(moduleUrl, options, []);
}

export async function runTsxCliShim(moduleUrl, options = {}) {
  if (options.toolingDependencies) {
    try {
      const { toolingDependencyOptions } = await import("./tooling-dependencies.mjs");
      const tooling = toolingDependencyOptions(SHIM_CHECKOUT_ROOT, options.toolingDependencies, {
        tsx: true,
      });
      if (tooling.tsxImport) {
        configureToolingTsx();
        // Install qualified resolution before TSX loads source imports. Keeping
        // its absolute preload also preserves fork() without a workspace link.
        return runCliShim(moduleUrl, options, [...tooling.execArgv, "--import", tooling.tsxImport]);
      }
    } catch (error) {
      console.error(error);
      writeFailureTrailer(options.failureTool, 1);
      process.exitCode = 1;
      return;
    }
  }
  return runCliShim(moduleUrl, options, ["--import", new URL("../tsx.mjs", import.meta.url).href]);
}
