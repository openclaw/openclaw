const WINDOWS_UNSAFE_CMD_CHARS_RE = /[&|<>%\r\n]/;

export function resolvePathEnvKey(env) {
  return Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
}

export function escapeForCmdExe(arg) {
  if (WINDOWS_UNSAFE_CMD_CHARS_RE.test(arg)) {
    throw new Error(`unsafe Windows cmd.exe argument detected: ${JSON.stringify(arg)}`);
  }
  const escaped = arg.replace(/\^/g, "^^");
  if (!escaped.includes(" ") && !escaped.includes('"')) {
    return escaped;
  }
  return `"${escaped.replace(/"/g, '""')}"`;
}

export function escapeCommandPathForCmdExe(arg) {
  const escaped = arg
    .replace(/\^/g, "^^")
    .replace(/%/g, "%%")
    .replace(/[&|<>]/g, "^$&");
  if (!escaped.includes(" ") && !escaped.includes('"')) {
    return escaped;
  }
  return `"${escaped.replace(/"/g, '""')}"`;
}

export function buildCmdExeCommandLine(command, args) {
  return [escapeForCmdExe(command), ...args.map(escapeForCmdExe)].join(" ");
}

export function buildCmdExeBatchCommandLine(commandPath, args) {
  return ["call", escapeCommandPathForCmdExe(commandPath), ...args.map(escapeForCmdExe)].join(" ");
}
