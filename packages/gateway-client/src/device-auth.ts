/**
 * Normalizes optional device metadata before it becomes part of a signed auth
 * payload.
 */
export function normalizeDeviceMetadataForAuth(value?: string | null): string {
  if (typeof value !== "string") {
    return "";
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  // Preserve the gateway's historical ASCII-only case fold; locale-sensitive
  // lowercasing would change existing signatures for non-ASCII device names.
  return trimmed.replace(/[A-Z]/g, (char) => String.fromCharCode(char.charCodeAt(0) + 32));
}

type DeviceAuthPayloadParams = {
  /** Stable device id paired with the gateway. */
  deviceId: string;
  /** Client application id, such as the desktop or mobile client. */
  clientId: string;
  /** Gateway client mode included in the signed payload. */
  clientMode: string;
  /** Requested gateway role for the authenticated device. */
  role: string;
  /** Ordered scope list; order is signature-significant. */
  scopes: string[];
  /** Signing timestamp in epoch milliseconds. */
  signedAtMs: number;
  /** Optional bootstrap token; null/undefined still reserves the v2/v3 field. */
  token?: string | null;
  /** Per-request nonce included to prevent replay. */
  nonce: string;
};

type DeviceAuthPayloadV3Params = DeviceAuthPayloadParams & {
  /** Optional normalized platform metadata appended after the v2 fields. */
  platform?: string | null;
  /** Optional normalized device-family metadata appended after platform. */
  deviceFamily?: string | null;
};

/** Builds the canonical v2 device-auth string that the gateway verifies byte-for-byte. */
export function buildDeviceAuthPayload(params: DeviceAuthPayloadParams): string {
  const scopes = params.scopes.join(",");
  const token = params.token ?? "";
  return [
    "v2",
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    scopes,
    String(params.signedAtMs),
    token,
    params.nonce,
  ].join("|");
}

/** Builds the canonical v3 device-auth string with normalized platform/family metadata. */
export function buildDeviceAuthPayloadV3(params: DeviceAuthPayloadV3Params): string {
  const scopes = params.scopes.join(",");
  const token = params.token ?? "";
  // Device signatures are byte-for-byte compared by the gateway. Normalize
  // optional metadata before joining so case differences do not break auth.
  const platform = normalizeDeviceMetadataForAuth(params.platform);
  const deviceFamily = normalizeDeviceMetadataForAuth(params.deviceFamily);
  return [
    "v3",
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    scopes,
    String(params.signedAtMs),
    token,
    params.nonce,
    platform,
    deviceFamily,
  ].join("|");
}
