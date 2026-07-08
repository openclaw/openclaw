import { posix, win32 } from "node:path";

export type MxcContainment = "process" | "processcontainer";

export type MxcNetworkMode = "none" | "default";

const CONTAINMENTS = new Set<MxcContainment>(["process", "processcontainer"]);

export type MxcConfig = {
  mxcBinaryPath?: string;
  containment: MxcContainment;
  network: MxcNetworkMode;
  timeoutSeconds: number;
  timeoutSecondsConfigured?: boolean;
  debug: boolean;
  mxcPolicyPaths?: string[];
};

const DEFAULT_CONTAINMENT: MxcContainment = "process";
const DEFAULT_NETWORK: MxcNetworkMode = "none";
const DEFAULT_TIMEOUT_SECONDS = 120;

export function resolveConfig(raw: unknown): MxcConfig {
  if (raw == null || typeof raw !== "object") {
    return {
      containment: DEFAULT_CONTAINMENT,
      network: DEFAULT_NETWORK,
      timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
      debug: false,
    };
  }
  const input = raw as Record<string, unknown>;
  const containment = resolveContainment(input);

  const network =
    input.network === "none" || input.network === "default"
      ? (input.network as MxcNetworkMode)
      : DEFAULT_NETWORK;

  const inputTimeoutSeconds = input.timeoutSeconds;
  let timeoutSecondsConfigured = false;
  let timeoutSeconds = DEFAULT_TIMEOUT_SECONDS;
  if (
    typeof inputTimeoutSeconds === "number" &&
    Number.isFinite(inputTimeoutSeconds) &&
    inputTimeoutSeconds >= 1
  ) {
    timeoutSecondsConfigured = true;
    timeoutSeconds = inputTimeoutSeconds;
  }

  const resolved: MxcConfig = {
    mxcBinaryPath:
      typeof input.mxcBinaryPath === "string" && input.mxcBinaryPath.trim().length > 0
        ? input.mxcBinaryPath.trim()
        : undefined,
    containment,
    network,
    timeoutSeconds,
    debug: input.debug === true,
    mxcPolicyPaths: resolveMxcPolicyPaths(input.mxcPolicyPaths),
  };

  if (timeoutSecondsConfigured) {
    resolved.timeoutSecondsConfigured = true;
  }

  return resolved;
}

function resolveContainment(input: Record<string, unknown>): MxcContainment {
  return typeof input.containment === "string" &&
    CONTAINMENTS.has(input.containment as MxcContainment)
    ? (input.containment as MxcContainment)
    : DEFAULT_CONTAINMENT;
}

function resolveMxcPolicyPaths(value: unknown): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new TypeError("MXC config field mxcPolicyPaths must be an array of absolute paths.");
  }

  return value.map((entry, index) => {
    if (typeof entry !== "string") {
      throw new TypeError(`MXC config field mxcPolicyPaths[${index}] must be a string.`);
    }
    const trimmed = entry.trim();
    if (trimmed.length === 0 || !isAbsolutePath(trimmed)) {
      throw new TypeError(
        `MXC config field mxcPolicyPaths[${index}] must be a non-empty absolute path.`,
      );
    }
    return trimmed;
  });
}

function isAbsolutePath(value: string): boolean {
  return win32.isAbsolute(value) || posix.isAbsolute(value);
}
