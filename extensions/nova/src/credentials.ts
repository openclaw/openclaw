import type { NovaConfig, NovaCredentials } from "./types.js";

const DEFAULT_BASE_URL = "wss://ws.nova-claw.agi.amazon.dev";

/**
 * Stable deviceId generated once per process lifetime.
 * Reused across reconnects so the server can correlate sessions to the same device.
 */
let cachedDeviceId: string | undefined;

/**
 * Resolve Nova credentials from config with env var fallbacks.
 * Returns `undefined` when any required field is missing.
 */
export function resolveNovaCredentials(cfg?: NovaConfig): NovaCredentials | undefined {
  const baseUrl = cfg?.baseUrl?.trim() || process.env.NOVA_BASE_URL?.trim() || DEFAULT_BASE_URL;
  const apiKey = cfg?.apiKey?.trim() || process.env.NOVA_API_KEY?.trim();
  const userId = cfg?.userId?.trim() || process.env.NOVA_USER_ID?.trim();

  if (!apiKey || !userId) {
    return undefined;
  }

  const deviceId =
    cfg?.deviceId?.trim() ||
    process.env.NOVA_DEVICE_ID?.trim() ||
    (cachedDeviceId ??= crypto.randomUUID());

  return { baseUrl, apiKey, userId, deviceId };
}
