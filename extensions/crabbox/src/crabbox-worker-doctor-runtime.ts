import { runCommandWithTimeout, type SpawnResult } from "openclaw/plugin-sdk/process-runtime";
import type { CrabboxCommandRunner } from "./crabbox-worker-command.js";

// Include prereleases of the first fixed patch; 0.53.0 predates the WSL2 fixes.
export const CRABBOX_WSL2_MIN_VERSION = "0.53.1";

function parseCrabboxVersion(output: string) {
  const match =
    /(?:^|\s)v?((\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)(?:\s|$)/u.exec(
      output,
    );
  if (!match?.[1]) {
    return undefined;
  }
  return {
    version: match[1],
    major: Number(match[2]),
    minor: Number(match[3]),
    patch: Number(match[4]),
  };
}

function isCrabboxVersionAtLeast(version: string, minimumVersion: string): boolean {
  const current = parseCrabboxVersion(version);
  const minimum = parseCrabboxVersion(minimumVersion);
  return (
    current !== undefined &&
    minimum !== undefined &&
    (current.major > minimum.major ||
      (current.major === minimum.major &&
        (current.minor > minimum.minor ||
          (current.minor === minimum.minor && current.patch >= minimum.patch))))
  );
}

export function supportsCrabboxWsl2(version: string): boolean {
  return isCrabboxVersionAtLeast(version, CRABBOX_WSL2_MIN_VERSION);
}

const CRABBOX_VERSION_TIMEOUT_MS = 2_000;
const CRABBOX_VERSION_MAX_OUTPUT_BYTES = 64 * 1024;

type CrabboxVersionProbe =
  | { status: "supported"; version: string }
  | { status: "outdated"; version: string }
  | { status: "indeterminate"; reason: string };

export async function probeCrabboxVersion(
  binary: string,
  runCommand: CrabboxCommandRunner = runCommandWithTimeout,
): Promise<CrabboxVersionProbe> {
  let result: SpawnResult;
  try {
    result = await runCommand([binary, "--version"], {
      killProcessTree: true,
      maxOutputBytes: CRABBOX_VERSION_MAX_OUTPUT_BYTES,
      timeoutMs: CRABBOX_VERSION_TIMEOUT_MS,
    });
  } catch {
    return { status: "indeterminate", reason: "version command could not start" };
  }
  if (result.termination !== "exit" || result.code !== 0 || result.outputLimitExceeded) {
    const reason =
      result.termination === "timeout"
        ? `version command timed out after ${CRABBOX_VERSION_TIMEOUT_MS} ms`
        : result.outputLimitExceeded
          ? "version output exceeded 64 KiB"
          : result.termination !== "exit"
            ? `version command did not exit normally (${result.termination})`
            : `version command exited with code ${result.code ?? "unknown"}`;
    return { status: "indeterminate", reason };
  }
  const parsed = parseCrabboxVersion(`${result.stdout}\n${result.stderr}`.trim());
  if (!parsed) {
    return { status: "indeterminate", reason: "version output was not recognized" };
  }
  const { version } = parsed;
  const supported = isCrabboxVersionAtLeast(version, "0.41.1");
  return supported ? { status: "supported", version } : { status: "outdated", version };
}

export function createCrabboxVersionResolver(runCommand: CrabboxCommandRunner) {
  const versionsByBinary = new Map<string, Promise<CrabboxVersionProbe>>();
  return (binary: string): Promise<CrabboxVersionProbe> => {
    let probe = versionsByBinary.get(binary);
    if (!probe) {
      probe = probeCrabboxVersion(binary, runCommand).then((result) => {
        if (result.status === "indeterminate") {
          versionsByBinary.delete(binary);
        }
        return result;
      });
      versionsByBinary.set(binary, probe);
    }
    return probe;
  };
}
