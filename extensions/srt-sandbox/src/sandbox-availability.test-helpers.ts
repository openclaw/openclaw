import { assertSrtSandboxAvailable, SrtSandboxUnavailableError } from "./dependency-probe.js";

/**
 * Live suites need the host's real sandbox toolchain (bwrap/socat/ripgrep/seccomp
 * on Linux). Reuse the production fail-closed probe so hosts without it skip
 * those suites instead of failing; any other probe error still surfaces.
 */
export async function isSrtSandboxAvailable(): Promise<boolean> {
  try {
    await assertSrtSandboxAvailable();
    return true;
  } catch (error) {
    if (error instanceof SrtSandboxUnavailableError) {
      return false;
    }
    throw error;
  }
}
