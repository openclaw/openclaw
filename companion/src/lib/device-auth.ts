type DeviceAuthEntry = {
  token: string;
  role: string;
  scopes: string[];
  updatedAtMs: number;
};

type DeviceAuthStore = {
  version: 1;
  deviceId: string;
  tokens: Record<string, DeviceAuthEntry>;
};

const STORAGE_KEY = "openclaw.device.auth.v1";

function readStore(): DeviceAuthStore | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
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

function writeStore(store: DeviceAuthStore) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // best-effort
  }
}

export function loadDeviceAuthToken(params: {
  deviceId: string;
  role: string;
}): { token: string } | null {
  const store = readStore();
  if (!store || store.deviceId !== params.deviceId) return null;
  const entry = store.tokens[params.role];
  if (!entry || typeof entry.token !== "string") return null;
  return entry;
}

export function storeDeviceAuthToken(params: {
  deviceId: string;
  role: string;
  token: string;
  scopes?: string[];
}) {
  const next: DeviceAuthStore = {
    version: 1,
    deviceId: params.deviceId,
    tokens: {},
  };
  const existing = readStore();
  if (existing && existing.deviceId === params.deviceId) {
    next.tokens = { ...existing.tokens };
  }
  next.tokens[params.role] = {
    token: params.token,
    role: params.role,
    scopes: params.scopes ?? [],
    updatedAtMs: Date.now(),
  };
  writeStore(next);
}

export function clearDeviceAuthToken(params: { deviceId: string; role: string }) {
  const store = readStore();
  if (!store || store.deviceId !== params.deviceId) return;
  if (!store.tokens[params.role]) return;
  const next = { ...store, tokens: { ...store.tokens } };
  delete next.tokens[params.role];
  writeStore(next);
}
