/** Converts Codex PathUri protocol values into sandbox-backend path strings. */
import { fileURLToPath } from "node:url";

const URI_SCHEME_RE = /^([A-Za-z][A-Za-z0-9+.-]*):/u;
const WINDOWS_ABSOLUTE_PATH_RE = /^[A-Za-z]:[\\/]/u;
const WINDOWS_DRIVE_PATH_RE = /^\/[A-Za-z]:(?:\/|$)/u;

/** Resolves one Codex exec-server path while retaining legacy native absolute paths. */
export function resolveExecServerPath(rawPath: string, label: string): string {
  const scheme = WINDOWS_ABSOLUTE_PATH_RE.test(rawPath)
    ? undefined
    : URI_SCHEME_RE.exec(rawPath)?.[1]?.toLowerCase();
  if (!scheme) {
    // Codex versions before PathUri sent native absolute paths here.
    return rawPath;
  }
  if (scheme !== "file") {
    throw new Error(`${label} URI must use the file scheme, received ${scheme}.`);
  }

  let pathUrl: URL;
  try {
    pathUrl = new URL(rawPath);
  } catch (error) {
    throw new Error(
      `${label} must be a valid file URI: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (pathUrl.search || pathUrl.hash) {
    throw new Error(`${label} file URI must not include a query or fragment.`);
  }
  let resolved: string;
  try {
    // The URI names the sandbox target, so decode with POSIX rules even when
    // the Gateway host is Windows. Docker and SSH backends own POSIX workdirs.
    resolved = fileURLToPath(pathUrl, { windows: false });
  } catch (error) {
    throw new Error(
      `${label} file URI is not valid for the sandbox: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (WINDOWS_DRIVE_PATH_RE.test(resolved)) {
    // OpenClaw exec-server backends currently expose Docker/SSH POSIX paths.
    // Reject foreign drive URIs instead of silently rewriting their meaning.
    throw new Error(`${label} Windows file URI is not supported by the sandbox.`);
  }
  if (resolved.includes("\0")) {
    throw new Error(`${label} file URI must not contain a null byte.`);
  }
  return resolved;
}
