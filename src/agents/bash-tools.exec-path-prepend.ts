import path from "node:path";
import { findPathKey, removePathPrepend } from "../infra/path-prepend.js";

/**
 * Apply PATH prepends inside the shell command.
 * This ensures our paths take precedence even if user RC files (e.g. ~/.zshenv)
 * prepend their own entries to PATH during shell startup.
 */
export function wrapPosixCommandWithPathPrepend(
  command: string,
  env: Record<string, string>,
  pathPrepend?: string[],
): string {
  if (process.platform === "win32") {
    return command;
  }

  if (!pathPrepend || pathPrepend.length === 0) {
    return command;
  }

  // Strip prepended entries from the base env.PATH to avoid duplicate segments.
  // The wrapper will re-apply them after shell startup.
  const pathKey = findPathKey(env);
  const currentPath = env[pathKey];
  if (currentPath) {
    const newPath = removePathPrepend(currentPath, pathPrepend);
    if (newPath !== undefined) {
      env[pathKey] = newPath;
    }
  }

  // Pass the prepend string safely via a temporary environment variable.
  env.OPENCLAW_PREPEND_PATH = pathPrepend.join(path.delimiter);

  return `export PATH="\${OPENCLAW_PREPEND_PATH}\${PATH:+:$PATH}"; unset OPENCLAW_PREPEND_PATH; ${command}`;
}
