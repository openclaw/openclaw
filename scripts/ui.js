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
  // When `which()` resolves to an absolute path like
  // `C:\Program Files\nodejs\pnpm.CMD`, spawning that directly works
  // without `shell: true`. Using `shell: true` with such paths causes
  // Windows to split on the space (`C:\Program`) and fail.
  //
  // To avoid this, only route through the shell for bare command names
  // (no path separators). Anything that already contains a path is
  // executed directly.
  const hasPathSeparator = cmd.includes("\\") || cmd.includes("/");
  if (hasPathSeparator) {
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
  // Reject risky metacharacters when we have to construct a cmd.exe
  // command line to avoid shell injection issues.
  throw new Error(
    `Unsafe Windows shell argument: ${unsafeArg}. Remove shell metacharacters (" & | < > ^ % !).`,
  );
}

function createSpawnOptions(_cmd, _args, envOverride) {
  return {
    cwd: uiDir,
    stdio: "inherit",
    env: envOverride ?? process.env,
  };
}

function normalizeWindowsCommand(cmd, args) {
  if (process.platform !== "win32") {
    return { command: cmd, commandArgs: args };
  }
  const extension = path.extname(cmd).toLowerCase();
  if (!WINDOWS_SHELL_EXTENSIONS.has(extension)) {
    return { command: cmd, commandArgs: args };
  }

  const hasPathSeparator = cmd.includes("\\") || cmd.includes("/");
  const quotedCmd = hasPathSeparator ? `"${cmd}"` : cmd;
  const commandLine = args.length > 0 ? `${quotedCmd} ${args.join(" ")}` : quotedCmd;

  const command = process.env.comspec || "cmd.exe";
  const commandArgs = ["/d", "/s", "/c", commandLine];
  return { command, commandArgs };
}

function run(cmd, args) {
  let child;
  const { command, commandArgs } = normalizeWindowsCommand(cmd, args);
  try {
    child = spawn(command, commandArgs, createSpawnOptions(command, commandArgs));
  } catch (err) {
    console.error(`Failed to launch ${cmd}:`, err);
    process.exit(1);
    return;
  }

  child.on("error", (err) => {
    console.error(`Failed to launch ${cmd}:`, err);
    process.exit(1);
  });
  child.on("exit", (code) => {
    if (code !== 0) {
      process.exit(code ?? 1);
    }
  });
}

function runSync(cmd, args, envOverride) {
  let result;
  const { command, commandArgs } = normalizeWindowsCommand(cmd, args);
  try {
    result = spawnSync(command, commandArgs, createSpawnOptions(command, commandArgs, envOverride));
  } catch (err) {
    console.error(`Failed to launch ${cmd}:`, err);
    process.exit(1);
    return;
  }
  if (result.signal) {
    process.exit(1);
  }
  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1);
  }
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

export function main(argv = process.argv.slice(2)) {
  const [action, ...rest] = argv;
  if (!action) {
    usage();
    process.exit(2);
  }

  const runner = resolveRunner();
  if (!runner) {
    process.stderr.write("Missing UI runner: install pnpm, then retry.\n");
    process.exit(1);
  }

  const script = resolveScriptAction(action);
  if (action !== "install" && !script) {
    usage();
    process.exit(2);
  }

  if (action === "install") {
    run(runner.cmd, ["install", ...rest]);
    return;
  }

  if (!depsInstalled(action === "test" ? "test" : "build")) {
    const installEnv =
      action === "build" ? { ...process.env, NODE_ENV: "production" } : process.env;
    const installArgs = action === "build" ? ["install", "--prod"] : ["install"];
    runSync(runner.cmd, installArgs, installEnv);
  }

  run(runner.cmd, ["run", script, ...rest]);
}

const isDirectExecution = (() => {
  const entry = process.argv[1];
  return Boolean(entry && path.resolve(entry) === fileURLToPath(import.meta.url));
})();

if (isDirectExecution) {
  main();
}
