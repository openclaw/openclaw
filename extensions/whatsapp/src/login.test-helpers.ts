import { EventEmitter } from "node:events";
import { resetLogger, setLoggerOverride } from "openclaw/plugin-sdk/runtime-env";
import { afterEach, beforeEach, vi } from "vitest";

export async function createMockWebLoginSession() {
  const actual = await vi.importActual<typeof import("./session.js")>("./session.js");
  const ev = new EventEmitter();
  const sock = {
    ev,
    ws: { close: vi.fn() },
    authState: { creds: { registered: false } },
    requestPairingCode: vi.fn().mockResolvedValue("12345678"),
    sendPresenceUpdate: vi.fn(),
    sendMessage: vi.fn(),
  };
  return {
    ...actual,
    createWaSocket: vi.fn().mockResolvedValue(sock),
    waitForWaConnection: vi.fn().mockResolvedValue(undefined),
    readWebAuthExistsForDecision: vi.fn(async () => ({
      outcome: "stable" as const,
      exists: true,
    })),
  };
}

export async function createMockWebLoginAuthStore() {
  const actual = await vi.importActual<typeof import("./auth-store.js")>("./auth-store.js");
  return {
    ...actual,
    prepareWebAuthForLogin: vi.fn(async () => "not-needed"),
    restoreCredsFromBackupIfNeeded: vi.fn(async () => false),
  };
}

export function createPhoneCodeSocket(
  pairingCode: string,
  creds: Record<string, unknown> = { registered: false },
) {
  return {
    ev: new EventEmitter(),
    ws: { close: vi.fn() },
    authState: { creds },
    requestPairingCode: vi.fn().mockResolvedValue(pairingCode),
    sendPresenceUpdate: vi.fn(),
    sendMessage: vi.fn(),
  };
}

export function resolveSocketAfterImmediateQr(sock: ReturnType<typeof createPhoneCodeSocket>) {
  return async (_printQr: boolean, _verbose: boolean, opts?: { onQr?: (qr: string) => void }) => {
    opts?.onQr?.("ready");
    return sock as never;
  };
}

export async function flushAsyncTurns(count = 8): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve();
  }
}

export async function flushImmediate(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

export function setupWebLoginTest(): void {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetLogger();
    setLoggerOverride(null);
  });
}
