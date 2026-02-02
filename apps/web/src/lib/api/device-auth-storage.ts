/**
 * Device Auth Token Storage
 *
 * Stores and retrieves device authentication tokens by device ID and role.
 * Tokens are persisted in localStorage and used for automatic re-authentication.
 */

export interface DeviceAuthEntry {
  token: string;
  role: string;
  scopes: string[];
  updatedAtMs: number;
}

interface DeviceAuthStore {
  version: 1;
  deviceId: string;
  tokens: Record<string, DeviceAuthEntry>;
}

const STORAGE_KEY = "clawdbrain-device-auth-v1";
const SHARED_TOKEN_KEY = "clawdbrain-gateway-token";

function normalizeRole(role: string): string {
  return role.trim();
}

function normalizeScopes(scopes: string[] | undefined): string[] {
  if (!Array.isArray(scopes)) return [];
  const out = new Set<string>();
  for (const scope of scopes) {
    const trimmed = scope.trim();
    if (trimmed) out.add(trimmed);
  }
  return [...out].sort();
}

function readStore(): DeviceAuthStore | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DeviceAuthStore;
    if (!parsed || parsed.version !== 1) return null;
    if (!parsed.deviceId || typeof parsed.deviceId !== "string") return null;
    if (!parsed.tokens || typeof parsed.tokens !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeStore(store: DeviceAuthStore): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // best-effort
  }
}

/**
 * Loads a device auth token for the given device ID and role.
 * Returns null if no token is stored or if the device ID doesn't match.
 */
export function loadDeviceAuthToken(params: {
  deviceId: string;
  role: string;
}): DeviceAuthEntry | null {
  const store = readStore();
  if (!store || store.deviceId !== params.deviceId) return null;
  const role = normalizeRole(params.role);
  const entry = store.tokens[role];
  if (!entry || typeof entry.token !== "string") return null;
  return entry;
}

/**
 * Stores a device auth token for the given device ID and role.
 * Returns the stored entry.
 */
export function storeDeviceAuthToken(params: {
  deviceId: string;
  role: string;
  token: string;
  scopes?: string[];
}): DeviceAuthEntry {
  const role = normalizeRole(params.role);
  const next: DeviceAuthStore = {
    version: 1,
    deviceId: params.deviceId,
    tokens: {},
  };
  const existing = readStore();
  if (existing && existing.deviceId === params.deviceId) {
    next.tokens = { ...existing.tokens };
  }
  const entry: DeviceAuthEntry = {
    token: params.token,
    role,
    scopes: normalizeScopes(params.scopes),
    updatedAtMs: Date.now(),
  };
  next.tokens[role] = entry;
  writeStore(next);
  return entry;
}

/**
 * Clears a device auth token for the given device ID and role.
 */
export function clearDeviceAuthToken(params: { deviceId: string; role: string }): void {
  const store = readStore();
  if (!store || store.deviceId !== params.deviceId) return;
  const role = normalizeRole(params.role);
  if (!store.tokens[role]) return;
  const next = { ...store, tokens: { ...store.tokens } };
  delete next.tokens[role];
  writeStore(next);
}

/**
 * Clears all device auth tokens.
 */
export function clearAllDeviceAuthTokens(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // best-effort
  }
}

// =====================================================================
// Shared Token Storage (user-entered tokens not tied to device identity)
// =====================================================================

/**
 * Loads the shared gateway token (user-entered, not device-specific).
 */
export function loadSharedGatewayToken(): string | null {
  try {
    return window.localStorage.getItem(SHARED_TOKEN_KEY);
  } catch {
    return null;
  }
}

/**
 * Stores a shared gateway token.
 */
export function storeSharedGatewayToken(token: string): void {
  try {
    window.localStorage.setItem(SHARED_TOKEN_KEY, token);
  } catch {
    // best-effort
  }
}

/**
 * Clears the shared gateway token.
 */
export function clearSharedGatewayToken(): void {
  try {
    window.localStorage.removeItem(SHARED_TOKEN_KEY);
  } catch {
    // best-effort
  }
}

// =====================================================================
// Auth Preference Storage
// =====================================================================

const AUTH_METHOD_KEY = "clawdbrain-auth-method";

export type AuthMethod = "token" | "password";

/**
 * Loads the user's preferred auth method.
 */
export function loadAuthMethodPreference(): AuthMethod {
  try {
    const stored = window.localStorage.getItem(AUTH_METHOD_KEY);
    if (stored === "password") return "password";
    return "token"; // default
  } catch {
    return "token";
  }
}

/**
 * Stores the user's preferred auth method.
 */
export function storeAuthMethodPreference(method: AuthMethod): void {
  try {
    window.localStorage.setItem(AUTH_METHOD_KEY, method);
  } catch {
    // best-effort
  }
}
