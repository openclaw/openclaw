import { assertSrtSandboxAvailable, SrtSandboxUnavailableError } from "./dependency-probe.js";

/**
 * Live suites need the host's real sandbox toolchain (bwrap/socat/ripgrep/seccomp
 * on Linux). Reuse the production fail-closed probe so hosts without it skip
 * those suites instead of failing; any other probe error still surfaces.
 *
 * Qualification runs set OPENCLAW_SRT_SANDBOX_REQUIRE_LIVE=1 on a host that must
 * run them (native Linux, macOS). There an unavailable toolchain fails the suite
 * with the probe's reason instead of skipping the live network and policy tests.
 */
export async function isSrtSandboxAvailable(): Promise<boolean> {
  try {
    await assertSrtSandboxAvailable();
    return true;
  } catch (error) {
    if (error instanceof SrtSandboxUnavailableError) {
      if (process.env.OPENCLAW_SRT_SANDBOX_REQUIRE_LIVE === "1") {
        throw new Error("OPENCLAW_SRT_SANDBOX_REQUIRE_LIVE=1 but the SRT sandbox is unavailable", {
          cause: error,
        });
      }
      return false;
    }
    throw error;
  }
}
