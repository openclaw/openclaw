// Windows cmd.exe quoting helpers for npm/pnpm command shims.
import path from "node:path";

const WINDOWS_UNSAFE_CMD_CHARS_RE = /[&|<>%\r\n]/;
const DEFAULT_WINDOWS_SYSTEM_ROOT = "C:\\Windows";

function normalizeWindowsString(value) {
  const trimmed = String(value ?? "").trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Resolves the Windows system root directory (e.g. C:\Windows).
 * Falls back through env vars SystemRoot, WINDIR, then the hard-coded default.
 */
export function resolveWindowsSystemRoot(env = process.env) {
  return (
    normalizeWindowsString(env.SystemRoot) ??
    normalizeWindowsString(env.WINDIR) ??
    DEFAULT_WINDOWS_SYSTEM_ROOT
  );
}

/**
 * Resolves a Windows System32 executable to its absolute path without
 * trusting the process PATH, so worker processes launched with a
 * truncated environment can still invoke reg.exe, taskkill.exe, etc.
 */
export function resolveWindowsSystem32Path(executableName, env = process.env) {
  if (
    path.win32.basename(executableName) !== executableName ||
    !/^[A-Za-z0-9_.-]+\.exe$/u.test(executableName)
  ) {
    throw new Error(`Invalid Windows System32 executable name: ${executableName}`);
  }
  return path.win32.join(resolveWindowsSystemRoot(env), "System32", executableName);
}

export function resolveWindowsCmdExePath(env = process.env) {
  return resolveWindowsSystem32Path("cmd.exe", env);
}

export function resolveWindowsPowerShellPath(env = process.env) {
  return path.win32.join(
    resolveWindowsSystemRoot(env),
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

/**
 * Resolves the correctly cased PATH key in a Windows-style env object.
 */
export function resolvePathEnvKey(env) {
  return Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
}

function escapeForCmdExe(arg) {
  if (WINDOWS_UNSAFE_CMD_CHARS_RE.test(arg)) {
    throw new Error(`unsafe Windows cmd.exe argument detected: ${JSON.stringify(arg)}`);
  }
  const escaped = arg.replace(/\^/g, "^^");
  if (!escaped.includes(" ") && !escaped.includes('"')) {
    return escaped;
  }
  return `"${escaped.replace(/"/g, '""')}"`;
}

/**
 * Builds a cmd.exe-safe command line or rejects unsafe shell metacharacters.
 */
export function buildCmdExeCommandLine(command, args) {
  const escapedCommand = escapeForCmdExe(command);
  const commandLine = [escapedCommand, ...args.map(escapeForCmdExe)].join(" ");
  return escapedCommand.startsWith('"') ? `"${commandLine}"` : commandLine;
}
