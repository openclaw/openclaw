// Whatsapp tests cover login plugin behavior.
import { EventEmitter } from "node:events";
import { resetLogger, setLoggerOverride, success } from "openclaw/plugin-sdk/runtime-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { restoreCredsFromBackupIfNeeded } from "./auth-store.js";
import { loginWeb, loginWebWithPhoneCode, normalizeWhatsAppPairingPhoneNumber } from "./login.js";
import { createWaSocket, type waitForWaConnection } from "./session.js";

const waiter = vi.fn<typeof waitForWaConnection>();
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

async function startGuardedLogin() {
  const pending = loginWeb(false, waiter, undefined, undefined, {
    beforeCredentialPersistence: async () => {},
  });
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
  expect(createWaSocket).toHaveBeenCalled();
  return { pending, options: vi.mocked(createWaSocket).mock.calls.at(-1)?.[2] };
}

describe("web login", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    waiter.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    resetLogger();
    setLoggerOverride(null);
  });

  it("loginWeb waits for connection and closes", async () => {
    const close = vi.spyOn((await createWaSocket(false, false)).ws, "close");
    await loginWeb(false, waiter);
    expect(close).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(499);
    expect(close).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("prints a backup recovery success message when creds are restored from backup", async () => {
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
    waiter.mockImplementationOnce(() => new Promise<void>(() => {}));
    const { pending, options } = await startGuardedLogin();
    options?.onCredentialPersistenceError?.(persistenceError);
    await expect(pending).rejects.toBe(persistenceError);
  });

  it("waits for Baileys post-open key persistence before reporting login success", async () => {
    const keyRead = Promise.withResolvers<void>();
    const keyWrite = Promise.withResolvers<void>();
    const { pending, options } = await startGuardedLogin();
    options?.onCredentialPersistenceTask?.(keyRead.promise);
    void keyRead.promise.then(() => options?.onCredentialPersistenceTask?.(keyWrite.promise));
    await vi.advanceTimersByTimeAsync(0);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    keyRead.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    keyWrite.resolve();
    await expect(pending).resolves.toBeUndefined();
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
    expect(runtime.log).toHaveBeenCalledWith(success("WhatsApp pairing code: 1111 2222"));
    expect(runtime.log).toHaveBeenCalledWith(success("WhatsApp pairing code: 3333 4444"));
    expect(waiter).toHaveBeenCalledTimes(2);
  });
});
