// Fail-closed dependency probe for the SRT sandbox backend.
//
// Design posture (v8 §7 / v7 §2): the backend must refuse to register/create
// rather than silently degrade or fall back to the host when the sandbox
// cannot be enforced. The probe therefore throws — never returns a "disabled"
// handle — when the platform or the SRT toolchain is unusable.
//
// SRT probe surface pinned to @anthropic-ai/sandbox-runtime@0.0.76:
//   SandboxManager.isSupportedPlatform()   (src/sandbox/sandbox-manager.ts:984)
//   SandboxManager.checkDependenciesAsync() (src/sandbox/sandbox-manager.ts:1075)
//     → SandboxDependencyCheck { errors, warnings }
//       (src/sandbox/linux-sandbox-utils.ts:544) — a non-empty `errors` means
//       the sandbox cannot run.
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";

/** Platforms the S1 backend supports. Linux (bwrap) and Windows are later stages. */
const S1_SUPPORTED_PLATFORMS = new Set<NodeJS.Platform>(["darwin"]);

export class SrtSandboxUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SrtSandboxUnavailableError";
  }
}

function platformGuidance(platform: NodeJS.Platform): string {
  if (platform === "linux") {
    return "Linux (Bubblewrap + seccomp) support is a later SRT sandbox stage and is not enabled in S1.";
  }
  if (platform === "win32") {
    return "Windows (low-privilege account + NTFS ACL + WFP) support is a later SRT sandbox stage and is not enabled in S1.";
  }
  return `Platform "${platform}" is not supported by the SRT sandbox backend.`;
}

/**
 * Verify the SRT sandbox can be enforced on this host. Throws
 * {@link SrtSandboxUnavailableError} (fail-closed) when it cannot.
 *
 * S1 gate: macOS only. The SRT toolchain check (sandbox-exec on macOS) runs via
 * the runtime's own dependency probe so we surface the same errors SRT would.
 */
export async function assertSrtSandboxAvailable(): Promise<void> {
  const platform = process.platform;
  if (!S1_SUPPORTED_PLATFORMS.has(platform)) {
    throw new SrtSandboxUnavailableError(
      `SRT sandbox backend cannot start: ${platformGuidance(platform)}`,
    );
  }
  if (!SandboxManager.isSupportedPlatform()) {
    throw new SrtSandboxUnavailableError(
      "SRT sandbox backend cannot start: the sandbox runtime reports this platform as unsupported.",
    );
  }
  const check = await SandboxManager.checkDependenciesAsync();
  if (check.errors.length > 0) {
    throw new SrtSandboxUnavailableError(
      `SRT sandbox backend cannot start: missing dependencies — ${check.errors.join("; ")}`,
    );
  }
}
