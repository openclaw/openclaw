#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const uiDir = path.join(repoRoot, "ui");

const WINDOWS_SHELL_EXTENSIONS = new Set([".cmd", ".bat", ".com"]);
const WINDOWS_UNSAFE_SHELL_ARG_PATTERN = /[\r\n"&|<>^%!]/;

function usage() {
  // keep this tiny; it's invoked from npm scripts too
  process.stderr.write("Usage: node scripts/ui.js <install|dev|build|test> [...args]\n");
}

function which(cmd) {
  try {
    const key = process.platform === "win32" ? "Path" : "PATH";
    const paths = (process.env[key] ?? process.env.PATH ?? "")
      .split(path.delimiter)
      .filter(Boolean);
    const extensions =
      process.platform === "win32"
        ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
        : [""];
    for (const entry of paths) {
      for (const ext of extensions) {
        const candidate = path.join(entry, process.platform === "win32" ? `${cmd}${ext}` : cmd);
        try {
          if (fs.existsSync(candidate)) {
            return candidate;
          }
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // ignore
  }
  return null;
}

function resolveRunner() {
  const pnpm = which("pnpm");
  if (pnpm) {
    return { cmd: pnpm, kind: "pnpm" };
  }
  return null;
}

export function shouldUseShellForCommand(cmd, platform = process.platform) {
  if (platform !== "win32") {
    return false;
  }
  const extension = path.extname(cmd).toLowerCase();
  return WINDOWS_SHELL_EXTENSIONS.has(extension);
}

export function assertSafeWindowsShellArgs(args, platform = process.platform) {
  if (platform !== "win32") {
    return;
  }
  const unsafeArg = args.find((arg) => WINDOWS_UNSAFE_SHELL_ARG_PATTERN.test(arg));
  if (!unsafeArg) {
    return;
  }
  // SECURITY: `shell: true` routes through cmd.exe; reject risky metacharacters
  // in forwarded args to prevent shell control-flow/env-expansion injection.
  throw new Error(
    `Unsafe Windows shell argument: ${unsafeArg}. Remove shell metacharacters (" & | < > ^ % !).`,
  );
}

function createSpawnOptions(cmd, args, envOverride) {
  const useShell = shouldUseShellForCommand(cmd);
  if (useShell) {
    assertSafeWindowsShellArgs(args);
  }
  return {
    cwd: uiDir,
    stdio: "inherit",
    env: envOverride ?? process.env,
    ...(useShell ? { shell: true } : {}),
  };
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, createSpawnOptions(cmd, args));
    } catch (err) {
      reject(err);
      return;
    }

    child.on("error", (err) => {
      reject(err);
    });
    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${cmd} exited with signal ${signal}`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

function runSync(cmd, args, envOverride) {
  let result;
  try {
    result = spawnSync(cmd, args, createSpawnOptions(cmd, args, envOverride));
  } catch (err) {
    throw new Error(`Failed to launch ${cmd}: ${String(err)}`, { cause: err });
  }
  if (result.signal) {
    return 1;
  }
  return result.status ?? 1;
}

function depsInstalled(kind) {
  try {
    const require = createRequire(path.join(uiDir, "package.json"));
    require.resolve("vite");
    require.resolve("dompurify");
    if (kind === "test") {
      require.resolve("vitest");
      require.resolve("@vitest/browser-playwright");
      require.resolve("playwright");
    }
    return true;
  } catch {
    return false;
  }
}

function resolveScriptAction(action) {
  if (action === "install") {
    return null;
  }
  if (action === "dev") {
    return "dev";
  }
  if (action === "build") {
    return "build";
  }
  if (action === "test") {
    return "test";
  }
  return null;
}

function resolveComparablePath(filePath) {
  const resolved = path.resolve(filePath);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

export function isDirectExecutionForEntry(entry = process.argv[1], moduleUrl = import.meta.url) {
  if (!entry) {
    return false;
  }
  // Treat symlinked absolute script paths as direct execution too, so
  // installed wrappers that point back into a repo checkout still run `main()`.
  return resolveComparablePath(entry) === resolveComparablePath(fileURLToPath(moduleUrl));
}

export async function main(argv = process.argv.slice(2)) {
  const [action, ...rest] = argv;
  if (!action) {
    usage();
    return 2;
  }

  const runner = resolveRunner();
  if (!runner) {
    process.stderr.write("Missing UI runner: install pnpm, then retry.\n");
    return 1;
  }

  const script = resolveScriptAction(action);
  if (action !== "install" && !script) {
    usage();
    return 2;
  }

  if (action === "install") {
    try {
      return await run(runner.cmd, ["install", ...rest]);
    } catch (err) {
      console.error(`Failed to launch ${runner.cmd}:`, err);
      return 1;
    }
  }

  if (!depsInstalled(action === "test" ? "test" : "build")) {
    const installEnv =
      action === "build" ? { ...process.env, NODE_ENV: "production" } : process.env;
    const installArgs = action === "build" ? ["install", "--prod"] : ["install"];
    try {
      const installCode = runSync(runner.cmd, installArgs, installEnv);
      if (installCode !== 0) {
        return installCode;
      }
    } catch (err) {
      console.error(`Failed to launch ${runner.cmd}:`, err);
      return 1;
    }
  }

  try {
    return await run(runner.cmd, ["run", script, ...rest]);
  } catch (err) {
    console.error(`Failed to launch ${runner.cmd}:`, err);
    return 1;
  }
}

const isDirectExecution = isDirectExecutionForEntry();

if (isDirectExecution) {
  void main().then((code) => {
    if (code !== 0) {
      process.exit(code);
    }
  });
}
