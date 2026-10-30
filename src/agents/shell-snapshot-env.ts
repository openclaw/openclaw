export const SAFE_ENV_NAMES: ReadonlySet<string> = new Set([
  "ASDF_DIR",
  "BUN_INSTALL",
  "CARGO_HOME",
  "CDPATH",
  "GOPATH",
  "GOROOT",
  "GOENV_ROOT",
  "HOMEBREW_CELLAR",
  "HOMEBREW_PREFIX",
  "HOMEBREW_REPOSITORY",
  "INFOPATH",
  "MANPATH",
  "NVM_DIR",
  "PATH",
  "PNPM_HOME",
  "PYENV_ROOT",
  "RBENV_ROOT",
  "RUSTUP_HOME",
  "VOLTA_HOME",
]);

export const SECRET_ENV_PATTERN =
  /(secret|token|password|passwd|credential|cookie|session|auth|key)/i;

/** Keep capture and replay on the same shell environment policy. */
export function captureShellSnapshotEnvironment(
  env: Record<string, unknown>,
): Record<string, string> {
  const captured: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (SAFE_ENV_NAMES.has(key) && !SECRET_ENV_PATTERN.test(key) && typeof value === "string") {
      captured[key] = value;
    }
  }
  return captured;
}
