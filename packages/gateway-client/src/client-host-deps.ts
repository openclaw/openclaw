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
  return Object.fromEntries(
    Object.entries(DEFAULT_HOST_DEPS).map(([key, fallback]) => [
      key,
      overrides?.[key as keyof GatewayClientHostDeps] ?? fallback,
    ]),
  ) as Required<GatewayClientHostDeps>;
}
