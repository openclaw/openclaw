import fs from "node:fs";
import path from "node:path";

const WINDOWS_SHELL_EXTENSIONS = new Set([".cmd", ".bat", ".com"]);
const WINDOWS_UNSAFE_SHELL_ARG_PATTERN = /[\r\n"&|<>^%!]/;

export function which(cmd, env = process.env, platform = process.platform) {
  const pathKey = platform === "win32" ? "Path" : "PATH";
  const pathValue = env[pathKey] ?? env.PATH ?? "";
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const searchPaths = pathValue.split(pathApi.delimiter).filter(Boolean);
  const extensions =
    platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean) : [""];

  for (const entry of searchPaths) {
    for (const ext of extensions) {
      const candidate = pathApi.join(entry, platform === "win32" ? `${cmd}${ext}` : cmd);
      try {
        if (fs.existsSync(candidate)) {
          return candidate;
        }
      } catch {
        // Ignore unreadable directories and continue searching.
      }
    }
  }

  return null;
}

export function shouldUseShellForCommand(cmd, platform = process.platform) {
  if (platform !== "win32") {
    return false;
  }
  const extension = path.win32.extname(cmd).toLowerCase();
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
  throw new Error(
    `Unsafe Windows shell argument: ${unsafeArg}. Remove shell metacharacters (" & | < > ^ % !).`,
  );
}

export function resolvePnpmRunner(params = {}) {
  const env = params.env ?? process.env;
  const platform = params.platform ?? process.platform;

  const pnpm = which("pnpm", env, platform);
  if (pnpm) {
    return {
      command: pnpm,
      prefixArgs: [],
      shell: shouldUseShellForCommand(pnpm, platform),
    };
  }

  const corepack = which("corepack", env, platform);
  if (corepack) {
    return {
      command: corepack,
      prefixArgs: ["pnpm"],
      shell: shouldUseShellForCommand(corepack, platform),
    };
  }

  return null;
}

export function resolvePnpmRunnerOrThrow(params = {}) {
  const runner = resolvePnpmRunner(params);
  if (runner) {
    return runner;
  }
  throw new Error("Missing pnpm or corepack; install a package runner or expose it on PATH.");
}

export function buildPnpmInvocation(runner, args, platform = process.platform) {
  const invocationArgs = [...runner.prefixArgs, ...args];
  if (runner.shell) {
    assertSafeWindowsShellArgs(invocationArgs, platform);
  }
  return {
    command: runner.command,
    args: invocationArgs,
    shell: runner.shell,
  };
}
