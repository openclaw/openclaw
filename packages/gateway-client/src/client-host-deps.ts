import { normalizeTlsFingerprint } from "./client-address-utils.js";
import type { GatewayClientDeviceAuthStorage } from "./client-device-auth.js";

export type DeviceIdentity = {
  deviceId: string;
  privateKeyPem: string;
  publicKeyPem: string;
};

// The package stays reusable by depending on host callbacks for OpenClaw-owned
// state: device keys, token storage, proxy routing, logging, and TLS formatting.
export type GatewayClientHostDeps = GatewayClientDeviceAuthStorage & {
  loadOrCreateDeviceIdentity?: () => DeviceIdentity | undefined;
  signDevicePayload?: (privateKeyPem: string, payload: string) => string;
  publicKeyRawBase64UrlFromPem?: (publicKeyPem: string) => string;
  beforeConnect?: () => void;
  registerGatewayLoopbackBypass?: (url: string) => (() => void) | undefined;
  logDebug?: (message: string) => void;
  logError?: (message: string) => void;
  redactForLog?: (message: string) => string;
  normalizeTlsFingerprint?: (fingerprint: string | undefined) => string;
};

const DEFAULT_HOST_DEPS: Required<GatewayClientHostDeps> = {
  loadOrCreateDeviceIdentity: () => undefined,
  signDevicePayload: () => {
    throw new Error("GatewayClient device signature dependency is not configured");
  },
  publicKeyRawBase64UrlFromPem: () => {
    throw new Error("GatewayClient public key dependency is not configured");
  },
  loadDeviceAuthToken: () => null,
  storeDeviceAuthToken: () => {},
  clearDeviceAuthToken: () => {},
  beforeConnect: () => {},
  registerGatewayLoopbackBypass: () => undefined,
  logDebug: () => {},
  logError: () => {},
  redactForLog: (message) => message,
  normalizeTlsFingerprint,
};

export function resolveHostDeps(
  overrides?: GatewayClientHostDeps,
): Required<GatewayClientHostDeps> {
  const resolved = Object.fromEntries(
    Object.entries(DEFAULT_HOST_DEPS).map(([key, fallback]) => [
      key,
      // SAFETY: Object.entries widens keys to string; these keys are DEFAULT_HOST_DEPS's own.
      overrides?.[key as keyof GatewayClientHostDeps] ?? fallback,
    ]),
  );
  // SAFETY: every DEFAULT_HOST_DEPS key is present, paired with its override or its default.
  return resolved as Required<GatewayClientHostDeps>;
}
