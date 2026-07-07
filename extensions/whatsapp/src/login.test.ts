// Whatsapp tests cover login plugin behavior.
import { EventEmitter } from "node:events";
import { resetLogger, setLoggerOverride, success } from "openclaw/plugin-sdk/runtime-env";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renderQrPngBase64 } from "./qr-image.js";

vi.mock("./session.js", async () => {
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
});

vi.mock("./auth-store.js", async () => {
  const actual = await vi.importActual<typeof import("./auth-store.js")>("./auth-store.js");
  return {
    ...actual,
    clearStalePhoneCodePairingAuthIfNeeded: vi.fn(async () => false),
    restoreCredsFromBackupIfNeeded: vi.fn(async () => false),
  };
});

import type { waitForWaConnection } from "./session.js";
let loginWeb: typeof import("./login.js").loginWeb;
let loginWebWithPhoneCode: typeof import("./login.js").loginWebWithPhoneCode;
let normalizeWhatsAppPairingPhoneNumber: typeof import("./login.js").normalizeWhatsAppPairingPhoneNumber;
let createWaSocket: typeof import("./session.js").createWaSocket;
let clearStalePhoneCodePairingAuthIfNeeded: typeof import("./auth-store.js").clearStalePhoneCodePairingAuthIfNeeded;
let restoreCredsFromBackupIfNeeded: typeof import("./auth-store.js").restoreCredsFromBackupIfNeeded;

function createPhoneCodeSocket(pairingCode: string) {
  return {
    ev: new EventEmitter(),
    ws: { close: vi.fn() },
    authState: { creds: { registered: false } },
    requestPairingCode: vi.fn().mockResolvedValue(pairingCode),
    sendPresenceUpdate: vi.fn(),
    sendMessage: vi.fn(),
  };
}

function resolveSocketAfterImmediateQr(sock: ReturnType<typeof createPhoneCodeSocket>) {
  return async (_printQr: boolean, _verbose: boolean, opts?: { onQr?: (qr: string) => void }) => {
    opts?.onQr?.("ready");
    return sock as never;
  };
}

async function flushAsyncTurns(count = 8): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve();
  }
}

describe("web login", () => {
  beforeAll(async () => {
    ({ loginWeb, loginWebWithPhoneCode, normalizeWhatsAppPairingPhoneNumber } =
      await import("./login.js"));
    ({ createWaSocket } = await import("./session.js"));
    ({ clearStalePhoneCodePairingAuthIfNeeded, restoreCredsFromBackupIfNeeded } =
      await import("./auth-store.js"));
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetLogger();
    setLoggerOverride(null);
  });

  it("loginWeb waits for connection and closes", async () => {
    const sock = await (
      createWaSocket as unknown as () => Promise<{ ws: { close: () => void } }>
    )();
    const close = vi.spyOn(sock.ws, "close");
    const waiter: typeof waitForWaConnection = vi.fn().mockResolvedValue(undefined);
    await loginWeb(false, waiter);
    expect(close).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(499);
    expect(close).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("prints a backup recovery success message when creds are restored from backup", async () => {
    const waiter: typeof waitForWaConnection = vi.fn().mockResolvedValue(undefined);
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(restoreCredsFromBackupIfNeeded).mockResolvedValueOnce(true);

    await loginWeb(false, waiter);

    expect(consoleLog).toHaveBeenCalledWith(
      success("✅ Recovered from creds.json.bak; web session ready."),
    );
    consoleLog.mockRestore();
  });

  it("rejects a delayed credential write failure even when old auth is still readable", async () => {
    const persistenceError = new Error("credential write failed");
    const waiter: typeof waitForWaConnection = vi.fn(() => new Promise<void>(() => {}));
    const pendingLogin = loginWeb(false, waiter, undefined, undefined, {
      beforeCredentialPersistence: async () => {},
    });
    for (let index = 0; index < 5; index += 1) {
      await Promise.resolve();
    }
    expect(vi.mocked(createWaSocket)).toHaveBeenCalled();
    const socketOptions = vi.mocked(createWaSocket).mock.calls.at(-1)?.[2] as
      | { onCredentialPersistenceError?: (error: unknown) => void }
      | undefined;

    socketOptions?.onCredentialPersistenceError?.(persistenceError);

    await expect(pendingLogin).rejects.toBe(persistenceError);
  });

  it("waits for Baileys post-open key persistence before reporting login success", async () => {
    let releaseKeyRead = () => {};
    let releaseKeyWrite = () => {};
    const keyRead = new Promise<void>((resolve) => {
      releaseKeyRead = resolve;
    });
    const keyWrite = new Promise<void>((resolve) => {
      releaseKeyWrite = resolve;
    });
    const waiter: typeof waitForWaConnection = vi.fn().mockResolvedValue(undefined);
    const pendingLogin = loginWeb(false, waiter, undefined, undefined, {
      beforeCredentialPersistence: async () => {},
    });
    for (let index = 0; index < 5; index += 1) {
      await Promise.resolve();
    }
    expect(vi.mocked(createWaSocket)).toHaveBeenCalled();
    const socketOptions = vi.mocked(createWaSocket).mock.calls.at(-1)?.[2] as
      | { onCredentialPersistenceTask?: (task: Promise<unknown>) => void }
      | undefined;
    socketOptions?.onCredentialPersistenceTask?.(keyRead);
    void keyRead.then(() => socketOptions?.onCredentialPersistenceTask?.(keyWrite));
    await vi.advanceTimersByTimeAsync(0);
    let settled = false;
    void pendingLogin.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseKeyRead();
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseKeyWrite();
    await expect(pendingLogin).resolves.toBeUndefined();
  });

  it("normalizes phone-code login numbers for Baileys", () => {
    expect(normalizeWhatsAppPairingPhoneNumber("+1 (555) 123-4567")).toBe("15551234567");
    expect(() => normalizeWhatsAppPairingPhoneNumber("+44 (0) 20 7946 0958")).toThrow(
      "must omit optional trunk prefixes",
    );
  });

  it("requests a phone pairing code and waits for the existing login result flow", async () => {
    const sock = createPhoneCodeSocket("12345678");
    vi.mocked(createWaSocket).mockImplementationOnce(resolveSocketAfterImmediateQr(sock));
    const waiter: typeof waitForWaConnection = vi.fn().mockResolvedValue(undefined);
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    const loginPromise = loginWebWithPhoneCode(
      false,
      "+1 (555) 123-4567",
      waiter,
      runtime as never,
    );
    await loginPromise;

    expect(sock.requestPairingCode).toHaveBeenCalledWith("15551234567");
    expect(waiter).toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith(success("WhatsApp pairing code: 1234 5678"));
    expect(runtime.log).toHaveBeenCalledWith(
      success("✅ Linked with phone code! Credentials saved for future sends."),
    );
  });

  it("requests a new phone pairing code after a timeout replacement socket", async () => {
    const firstSock = createPhoneCodeSocket("11112222");
    const secondSock = createPhoneCodeSocket("33334444");
    vi.mocked(createWaSocket)
      .mockImplementationOnce(resolveSocketAfterImmediateQr(firstSock))
      .mockImplementationOnce(resolveSocketAfterImmediateQr(secondSock));
    const timeoutError = Object.assign(new Error("timeout"), {
      output: { statusCode: 408 },
    });
    const waiter: typeof waitForWaConnection = vi
      .fn()
      .mockRejectedValueOnce(timeoutError)
      .mockResolvedValueOnce(undefined);
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    const loginPromise = loginWebWithPhoneCode(false, "+15551234567", waiter, runtime as never);
    await flushAsyncTurns();
    await loginPromise;

    expect(firstSock.requestPairingCode).toHaveBeenCalledWith("15551234567");
    expect(secondSock.requestPairingCode).toHaveBeenCalledWith("15551234567");
    expect(clearStalePhoneCodePairingAuthIfNeeded).toHaveBeenCalledTimes(2);
    const cleanupBeforeReplacement = vi.mocked(clearStalePhoneCodePairingAuthIfNeeded).mock
      .invocationCallOrder[1];
    const replacementCreate = vi.mocked(createWaSocket).mock.invocationCallOrder[1];
    if (cleanupBeforeReplacement === undefined || replacementCreate === undefined) {
      throw new Error("expected cleanup and replacement socket calls");
    }
    expect(cleanupBeforeReplacement).toBeLessThan(replacementCreate);
    expect(runtime.log).toHaveBeenCalledWith(success("WhatsApp pairing code: 1111 2222"));
    expect(runtime.log).toHaveBeenCalledWith(success("WhatsApp pairing code: 3333 4444"));
    expect(waiter).toHaveBeenCalledTimes(2);
  });
});

describe("renderQrPngBase64", () => {
  it("renders a PNG data payload", async () => {
    const b64 = await renderQrPngBase64("openclaw");
    const buf = Buffer.from(b64, "base64");
    expect(buf.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  });
});
