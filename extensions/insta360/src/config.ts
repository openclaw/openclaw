export type Insta360Config = {
  /** Base URL of the Insta360 camera OSC endpoint. Must be http:// on a private IP. */
  cameraHost: string;
  /** Local path to download media files to. Empty string means no auto-download. */
  downloadPath: string;
  /** Battery percentage at which a low-battery alert is fired. Clamped 1-100. */
  lowBatteryThreshold: number;
  /** Free storage in MB below which a low-storage alert is fired. Must be > 0. */
  lowStorageMB: number;
  /** How often to poll camera status in milliseconds. Minimum 5000. */
  pollIntervalMs: number;
};

const DEFAULT_CAMERA_HOST = "http://192.168.42.1";
const DEFAULT_DOWNLOAD_PATH = "";
const DEFAULT_LOW_BATTERY_THRESHOLD = 15;
const DEFAULT_LOW_STORAGE_MB = 500;
const DEFAULT_POLL_INTERVAL_MS = 30000;
const MIN_POLL_INTERVAL_MS = 5000;

/** Returns true if the hostname/IP is a private/loopback address. */
function isPrivateHost(host: string): boolean {
  // Allow localhost
  if (host === "localhost") {
    return true;
  }

  // Validate IPv4 private ranges: 10.x.x.x, 192.168.x.x, 172.16-31.x.x, 127.0.0.1
  const parts = host.split(".");
  if (parts.length !== 4) {
    return false;
  }
  const octets = parts.map(Number);
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false;
  }
  const [a, b] = octets;

  // 127.0.0.1 loopback
  if (a === 127 && b === 0 && octets[2] === 0 && octets[3] === 1) {
    return true;
  }
  // 10.x.x.x
  if (a === 10) {
    return true;
  }
  // 192.168.x.x
  if (a === 192 && b === 168) {
    return true;
  }
  // 172.16-31.x.x
  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  }

  return false;
}

function validateCameraHost(value: string): void {
  if (!value.startsWith("http://")) {
    throw new Error(`cameraHost must use http:// scheme, got: ${value}`);
  }
  // Extract hostname (strip http:// and any trailing path/port)
  const withoutScheme = value.slice("http://".length);
  const hostname = withoutScheme.split("/")[0].split(":")[0];

  if (!isPrivateHost(hostname)) {
    throw new Error(
      `cameraHost must be a private IP or localhost (10.x, 192.168.x, 172.16-31.x, 127.0.0.1, localhost), got host: ${hostname}`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse and validate plugin config from `api.pluginConfig`.
 * Returns an `Insta360Config` with all fields resolved to their defaults when absent.
 * Throws on invalid values that cannot be safely defaulted or clamped.
 */
export function parseInsta360Config(raw: unknown): Insta360Config {
  if (raw === undefined || raw === null) {
    return {
      cameraHost: DEFAULT_CAMERA_HOST,
      downloadPath: DEFAULT_DOWNLOAD_PATH,
      lowBatteryThreshold: DEFAULT_LOW_BATTERY_THRESHOLD,
      lowStorageMB: DEFAULT_LOW_STORAGE_MB,
      pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    };
  }

  if (!isRecord(raw)) {
    throw new Error("insta360 config must be an object");
  }

  // cameraHost
  let cameraHost = DEFAULT_CAMERA_HOST;
  if (raw.cameraHost !== undefined) {
    if (typeof raw.cameraHost !== "string") {
      throw new Error("cameraHost must be a string");
    }
    validateCameraHost(raw.cameraHost);
    // Normalize to origin to avoid path duplication (e.g. "http://192.168.42.1/osc" + "/osc/info")
    cameraHost = new URL(raw.cameraHost).origin;
  }

  // downloadPath
  let downloadPath = DEFAULT_DOWNLOAD_PATH;
  if (raw.downloadPath !== undefined) {
    if (typeof raw.downloadPath !== "string") {
      throw new Error("downloadPath must be a string");
    }
    downloadPath = raw.downloadPath;
  }

  // lowBatteryThreshold — clamp to 1-100
  let lowBatteryThreshold = DEFAULT_LOW_BATTERY_THRESHOLD;
  if (raw.lowBatteryThreshold !== undefined) {
    if (typeof raw.lowBatteryThreshold !== "number" || !Number.isFinite(raw.lowBatteryThreshold)) {
      throw new Error("lowBatteryThreshold must be a number");
    }
    lowBatteryThreshold = Math.min(100, Math.max(1, raw.lowBatteryThreshold));
  }

  // lowStorageMB — must be > 0
  let lowStorageMB = DEFAULT_LOW_STORAGE_MB;
  if (raw.lowStorageMB !== undefined) {
    if (
      typeof raw.lowStorageMB !== "number" ||
      !Number.isFinite(raw.lowStorageMB) ||
      raw.lowStorageMB <= 0
    ) {
      throw new Error("lowStorageMB must be a positive number");
    }
    lowStorageMB = raw.lowStorageMB;
  }

  // pollIntervalMs — clamp minimum to 5000
  let pollIntervalMs = DEFAULT_POLL_INTERVAL_MS;
  if (raw.pollIntervalMs !== undefined) {
    if (typeof raw.pollIntervalMs !== "number" || !Number.isFinite(raw.pollIntervalMs)) {
      throw new Error("pollIntervalMs must be a number");
    }
    pollIntervalMs = Math.max(MIN_POLL_INTERVAL_MS, raw.pollIntervalMs);
  }

  return { cameraHost, downloadPath, lowBatteryThreshold, lowStorageMB, pollIntervalMs };
}
