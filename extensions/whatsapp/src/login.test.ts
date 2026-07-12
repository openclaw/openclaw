// Whatsapp tests cover login plugin behavior.
import { EventEmitter } from "node:events";
import { createNonExitingRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import { resetLogger, setLoggerOverride, success } from "openclaw/plugin-sdk/runtime-env";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createCompletedPhoneCodeCreds } from "./phone-code.test-helpers.js";
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
    prepareWebAuthForLogin: vi.fn(async () => "not-needed"),
    restoreCredsFromBackupIfNeeded: vi.fn(async () => false),
  };
});

import type { waitForWaConnection } from "./session.js";
let loginWeb: typeof import("./login.js").loginWeb;
let loginWebWithPhoneCode: typeof import("./login.js").loginWebWithPhoneCode;
let normalizeWhatsAppPairingPhoneNumber: typeof import("./login.js").normalizeWhatsAppPairingPhoneNumber;
let createWaSocket: typeof import("./session.js").createWaSocket;
let prepareWebAuthForLogin: typeof import("./auth-store.js").prepareWebAuthForLogin;
let restoreCredsFromBackupIfNeeded: typeof import("./auth-store.js").restoreCredsFromBackupIfNeeded;

function createPhoneCodeSocket(
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

async function flushImmediate(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

type PersistenceTestMode = "qr" | "phone-code";

function startPersistenceTestLogin(
  mode: PersistenceTestMode,
  waiter: typeof waitForWaConnection,
): Promise<void> {
  if (mode === "qr") {
    return loginWeb(false, waiter);
  }
  const sock = createPhoneCodeSocket("12345678");
  vi.mocked(createWaSocket).mockImplementationOnce(resolveSocketAfterImmediateQr(sock));
  return loginWebWithPhoneCode(false, "+15551234567", waiter);
}

describe("web login", () => {
  beforeAll(async () => {
    ({ loginWeb, loginWebWithPhoneCode, normalizeWhatsAppPairingPhoneNumber } =
      await import("./login.js"));
    ({ createWaSocket } = await import("./session.js"));
    ({ prepareWebAuthForLogin, restoreCredsFromBackupIfNeeded } = await import("./auth-store.js"));
  });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
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

  it.each(["qr", "phone-code"] as const)(
    "rejects a delayed %s credential write failure even when old auth is still readable",
    async (mode) => {
      const persistenceError = new Error("credential write failed");
      const waiter: typeof waitForWaConnection = vi.fn(() => new Promise<void>(() => {}));
      const pendingLogin = startPersistenceTestLogin(mode, waiter);
      for (let index = 0; index < 5; index += 1) {
        await Promise.resolve();
      }
      expect(vi.mocked(createWaSocket)).toHaveBeenCalled();
      const socketOptions = vi.mocked(createWaSocket).mock.calls.at(-1)?.[2] as
        | { onCredentialPersistenceError?: (error: unknown) => void }
        | undefined;

      socketOptions?.onCredentialPersistenceError?.(persistenceError);

      await expect(pendingLogin).rejects.toBe(persistenceError);
    },
  );

  it.each(["qr", "phone-code"] as const)(
    "waits for %s post-open key persistence before reporting login success",
    async (mode) => {
      let releaseKeyRead = () => {};
      let releaseKeyWrite = () => {};
      const keyRead = new Promise<void>((resolve) => {
        releaseKeyRead = resolve;
      });
      const keyWrite = new Promise<void>((resolve) => {
        releaseKeyWrite = resolve;
      });
      const waiter: typeof waitForWaConnection = vi.fn().mockResolvedValue(undefined);
      const pendingLogin = startPersistenceTestLogin(mode, waiter);
      for (let index = 0; index < 5; index += 1) {
        await Promise.resolve();
      }
      expect(vi.mocked(createWaSocket)).toHaveBeenCalled();
      const socketOptions = vi.mocked(createWaSocket).mock.calls.at(-1)?.[2] as
        | { onCredentialPersistenceTask?: (task: Promise<unknown>) => void }
        | undefined;
      socketOptions?.onCredentialPersistenceTask?.(keyRead);
      void keyRead.then(() => socketOptions?.onCredentialPersistenceTask?.(keyWrite));
      await flushImmediate();
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
    },
  );

  it.each([
    ["+1 (213) 373-4253", "12133734253"],
    ["12133734253", "12133734253"],
    ["+39 06 6982", "39066982"],
  ])("normalizes phone-code login number %s for Baileys", (input, expected) => {
    expect(normalizeWhatsAppPairingPhoneNumber(input)).toBe(expected);
  });

  it.each([
    "abc123456",
    "+1 213 c373 4253",
    "+1 213 373 4253 ext 89",
    "+44 (0) 20 7946 0958",
    "+44 0 20 7946 0958",
    "+1 23",
    "+1234567890123456",
  ])("rejects non-canonical phone-code login number %s", (input) => {
    expect(() => normalizeWhatsAppPairingPhoneNumber(input)).toThrow(
      "requires an international phone number",
    );
  });

  it("requests a phone pairing code and waits for the existing login result flow", async () => {
    const sock = createPhoneCodeSocket("12345678");
    vi.mocked(createWaSocket).mockImplementationOnce(resolveSocketAfterImmediateQr(sock));
    const waiter: typeof waitForWaConnection = vi.fn().mockResolvedValue(undefined);
    const runtime = createNonExitingRuntimeEnv();

    const loginPromise = loginWebWithPhoneCode(false, "+1 (555) 123-4567", waiter, runtime);
    await loginPromise;

    expect(sock.requestPairingCode).toHaveBeenCalledWith("15551234567");
    expect(waiter).toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith(success("WhatsApp pairing code: 1234 5678"));
    expect(runtime.log).toHaveBeenCalledWith(
      success("✅ Linked with phone code! Credentials saved for future sends."),
    );
  });

  it("waits for delayed socket readiness before requesting a phone pairing code", async () => {
    const sock = createPhoneCodeSocket("12345678");
    vi.mocked(createWaSocket).mockResolvedValueOnce(sock as never);
    const waiter: typeof waitForWaConnection = vi.fn().mockResolvedValue(undefined);
    const pendingLogin = loginWebWithPhoneCode(false, "+15551234567", waiter);

    await flushAsyncTurns();
    expect(sock.requestPairingCode).not.toHaveBeenCalled();

    sock.ev.emit("connection.update", { qr: "ready" });

    await expect(pendingLogin).resolves.toBeUndefined();
    expect(sock.requestPairingCode).toHaveBeenCalledWith("15551234567");
  });

  it("surfaces credential persistence failure while waiting for phone readiness", async () => {
    const sock = createPhoneCodeSocket("12345678");
    vi.mocked(createWaSocket).mockResolvedValueOnce(sock as never);
    const waiter: typeof waitForWaConnection = vi.fn().mockResolvedValue(undefined);
    const persistenceError = new Error("credential write failed before readiness");
    const pendingLogin = loginWebWithPhoneCode(false, "+15551234567", waiter);
    const rejection = expect(pendingLogin).rejects.toBe(persistenceError);

    await flushAsyncTurns();
    const socketOptions = vi.mocked(createWaSocket).mock.calls[0]?.[2];
    socketOptions?.onCredentialPersistenceError?.(persistenceError);

    await rejection;
    expect(sock.requestPairingCode).not.toHaveBeenCalled();
    expect(waiter).not.toHaveBeenCalled();
  });

  it("rejects when the socket closes before phone pairing becomes ready", async () => {
    const sock = createPhoneCodeSocket("12345678");
    vi.mocked(createWaSocket).mockResolvedValueOnce(sock as never);
    const waiter: typeof waitForWaConnection = vi.fn().mockResolvedValue(undefined);
    const closeError = new Error("pairing socket closed");
    const pendingLogin = loginWebWithPhoneCode(false, "+15551234567", waiter);
    const rejection = expect(pendingLogin).rejects.toMatchObject({
      message: "pairing socket closed",
      cause: closeError,
    });

    await flushAsyncTurns();
    sock.ev.emit("connection.update", {
      connection: "close",
      lastDisconnect: { error: closeError },
    });

    await rejection;
    expect(sock.requestPairingCode).not.toHaveBeenCalled();
    expect(waiter).not.toHaveBeenCalled();
  });

  it("times out when phone pairing readiness never arrives", async () => {
    const sock = createPhoneCodeSocket("12345678");
    vi.mocked(createWaSocket).mockResolvedValueOnce(sock as never);
    const waiter: typeof waitForWaConnection = vi.fn().mockResolvedValue(undefined);
    const pendingLogin = loginWebWithPhoneCode(false, "+15551234567", waiter);
    const rejection = expect(pendingLogin).rejects.toThrow(
      "Timed out waiting for WhatsApp to offer phone-code pairing.",
    );

    await flushAsyncTurns();
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    await rejection;
    expect(sock.requestPairingCode).not.toHaveBeenCalled();
    expect(waiter).not.toHaveBeenCalled();
  });

  it("fails before socket creation when stale phone-code creds could not be cleared", async () => {
    vi.mocked(prepareWebAuthForLogin).mockResolvedValueOnce("not-cleared");
    const waiter: typeof waitForWaConnection = vi.fn().mockResolvedValue(undefined);
    const runtime = createNonExitingRuntimeEnv();

    await expect(
      loginWebWithPhoneCode(false, "+1 (555) 123-4567", waiter, runtime, "work"),
    ).rejects.toThrow(
      /Previous WhatsApp phone-code login.*openclaw channels logout --channel whatsapp --account work/,
    );

    expect(createWaSocket).not.toHaveBeenCalled();
    expect(waiter).not.toHaveBeenCalled();
  });

  it("fails before socket creation when stale auth cleanup is unstable", async () => {
    vi.mocked(prepareWebAuthForLogin).mockResolvedValueOnce("unstable");
    const waiter: typeof waitForWaConnection = vi.fn().mockResolvedValue(undefined);
    const runtime = createNonExitingRuntimeEnv();

    const error = await loginWebWithPhoneCode(false, "+1 (555) 123-4567", waiter, runtime).catch(
      (caught: unknown) => caught,
    );

    expect(error).toMatchObject({ code: "whatsapp-auth-unstable" });
    expect(createWaSocket).not.toHaveBeenCalled();
    expect(waiter).not.toHaveBeenCalled();
  });

  it("connects completed phone-code creds without waiting for a fresh QR", async () => {
    const sock = createPhoneCodeSocket("12345678", createCompletedPhoneCodeCreds());
    vi.mocked(createWaSocket).mockResolvedValueOnce(sock as never);
    const waiter: typeof waitForWaConnection = vi.fn().mockResolvedValue(undefined);
    const runtime = createNonExitingRuntimeEnv();

    await loginWebWithPhoneCode(false, "+1 (555) 123-4567", waiter, runtime);

    expect(sock.requestPairingCode).not.toHaveBeenCalled();
    expect(waiter).toHaveBeenCalledWith(sock, { timeout: "none" });
    expect(runtime.log).toHaveBeenCalledWith(
      success("✅ Linked with phone code! Credentials saved for future sends."),
    );
  });

  it("rejects completed phone-code creds linked to a different requested number", async () => {
    const sock = createPhoneCodeSocket("12345678", createCompletedPhoneCodeCreds());
    vi.mocked(createWaSocket).mockResolvedValueOnce(sock as never);
    const waiter: typeof waitForWaConnection = vi.fn().mockResolvedValue(undefined);
    const runtime = createNonExitingRuntimeEnv();

    await expect(
      loginWebWithPhoneCode(false, "+1 (666) 123-4567", waiter, runtime, "work"),
    ).rejects.toThrow("Existing WhatsApp credentials are linked to +15551234567");

    expect(sock.requestPairingCode).not.toHaveBeenCalled();
    expect(waiter).not.toHaveBeenCalled();
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("not +16661234567"));
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("openclaw channels logout --channel whatsapp --account work"),
    );
  });

  it("keeps LID-only completed phone-code creds when the linked phone cannot be proven different", async () => {
    const sock = createPhoneCodeSocket(
      "12345678",
      createCompletedPhoneCodeCreds({ me: { lid: "12345@lid" } }),
    );
    vi.mocked(createWaSocket).mockResolvedValueOnce(sock as never);
    const waiter: typeof waitForWaConnection = vi.fn().mockResolvedValue(undefined);
    const runtime = createNonExitingRuntimeEnv();

    await loginWebWithPhoneCode(false, "+1 (555) 123-4567", waiter, runtime);

    expect(sock.requestPairingCode).not.toHaveBeenCalled();
    expect(waiter).toHaveBeenCalledWith(sock, { timeout: "none" });
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
    const runtime = createNonExitingRuntimeEnv();

    const loginPromise = loginWebWithPhoneCode(false, "+15551234567", waiter, runtime);
    await flushAsyncTurns();
    await loginPromise;

    expect(firstSock.requestPairingCode).toHaveBeenCalledWith("15551234567");
    expect(secondSock.requestPairingCode).toHaveBeenCalledWith("15551234567");
    expect(prepareWebAuthForLogin).toHaveBeenCalledTimes(2);
    const cleanupBeforeReplacement = vi.mocked(prepareWebAuthForLogin).mock.invocationCallOrder[1];
    const replacementCreate = vi.mocked(createWaSocket).mock.invocationCallOrder[1];
    if (cleanupBeforeReplacement === undefined || replacementCreate === undefined) {
      throw new Error("expected cleanup and replacement socket calls");
    }
    expect(cleanupBeforeReplacement).toBeLessThan(replacementCreate);
    expect(runtime.log).toHaveBeenCalledWith(success("WhatsApp pairing code: 1111 2222"));
    expect(runtime.log).toHaveBeenCalledWith(success("WhatsApp pairing code: 3333 4444"));
    expect(waiter).toHaveBeenCalledTimes(2);
  });

  it("does not create a timeout replacement socket while auth cleanup is unstable", async () => {
    const firstSock = createPhoneCodeSocket("11112222");
    vi.mocked(createWaSocket).mockImplementationOnce(resolveSocketAfterImmediateQr(firstSock));
    vi.mocked(prepareWebAuthForLogin)
      .mockResolvedValueOnce("not-needed")
      .mockResolvedValueOnce("unstable");
    const timeoutError = Object.assign(new Error("timeout"), {
      output: { statusCode: 408 },
    });
    const waiter: typeof waitForWaConnection = vi.fn().mockRejectedValueOnce(timeoutError);
    const runtime = createNonExitingRuntimeEnv();

    const error = await loginWebWithPhoneCode(false, "+15551234567", waiter, runtime).catch(
      (caught: unknown) => caught,
    );

    expect(error).toMatchObject({ code: "whatsapp-auth-unstable" });
    expect(createWaSocket).toHaveBeenCalledOnce();
    expect(firstSock.requestPairingCode).toHaveBeenCalledOnce();
    expect(prepareWebAuthForLogin).toHaveBeenCalledTimes(2);
  });

  it("preserves phone-code credentials across the post-pairing restart", async () => {
    const firstSock = createPhoneCodeSocket("11112222");
    const secondSock = createPhoneCodeSocket("33334444");
    vi.mocked(createWaSocket)
      .mockImplementationOnce(resolveSocketAfterImmediateQr(firstSock))
      .mockResolvedValueOnce(secondSock as never);
    const restartError = Object.assign(new Error("restart required"), {
      output: { statusCode: 515 },
    });
    const waiter: typeof waitForWaConnection = vi
      .fn()
      .mockRejectedValueOnce(restartError)
      .mockResolvedValueOnce(undefined);
    const runtime = createNonExitingRuntimeEnv();

    await loginWebWithPhoneCode(false, "+15551234567", waiter, runtime);

    expect(firstSock.requestPairingCode).toHaveBeenCalledWith("15551234567");
    expect(secondSock.requestPairingCode).not.toHaveBeenCalled();
    expect(prepareWebAuthForLogin).toHaveBeenCalledOnce();
    expect(waiter).toHaveBeenNthCalledWith(2, secondSock, { timeout: "none" });
  });

  it("requests a fresh phone pairing code after logged-out recovery", async () => {
    const firstSock = createPhoneCodeSocket("11112222");
    const secondSock = createPhoneCodeSocket("33334444");
    vi.mocked(createWaSocket)
      .mockImplementationOnce(resolveSocketAfterImmediateQr(firstSock))
      .mockImplementationOnce(resolveSocketAfterImmediateQr(secondSock));
    const loggedOutError = Object.assign(new Error("logged out"), {
      output: { statusCode: 401 },
    });
    const waiter: typeof waitForWaConnection = vi
      .fn()
      .mockRejectedValueOnce(loggedOutError)
      .mockResolvedValueOnce(undefined);

    await loginWebWithPhoneCode(false, "+15551234567", waiter);

    expect(firstSock.requestPairingCode).toHaveBeenCalledWith("15551234567");
    expect(secondSock.requestPairingCode).toHaveBeenCalledWith("15551234567");
    expect(prepareWebAuthForLogin).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ mode: "clear-existing" }),
    );
    expect(waiter).toHaveBeenCalledTimes(2);
  });

  it("reports an account-scoped relink command after repeated logged-out responses", async () => {
    const firstSock = createPhoneCodeSocket("11112222");
    const secondSock = createPhoneCodeSocket("33334444");
    vi.mocked(createWaSocket)
      .mockImplementationOnce(resolveSocketAfterImmediateQr(firstSock))
      .mockImplementationOnce(resolveSocketAfterImmediateQr(secondSock));
    const loggedOutError = Object.assign(new Error("logged out"), {
      output: { statusCode: 401 },
    });
    const waiter: typeof waitForWaConnection = vi
      .fn()
      .mockRejectedValueOnce(loggedOutError)
      .mockRejectedValueOnce(loggedOutError);
    const runtime = createNonExitingRuntimeEnv();

    await expect(
      loginWebWithPhoneCode(false, "+15551234567", waiter, runtime, "work"),
    ).rejects.toThrow("Session logged out; cache cleared");

    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("openclaw channels login --channel whatsapp --account work"),
    );
  });

  it("surfaces a completed credential write failure during the 515 handoff", async () => {
    const firstSock = createPhoneCodeSocket("11112222");
    const secondSock = createPhoneCodeSocket("33334444");
    const persistenceError = new Error("completed credential write failed");
    vi.mocked(createWaSocket)
      .mockImplementationOnce(resolveSocketAfterImmediateQr(firstSock))
      .mockImplementationOnce(async (_printQr, _verbose, options) => {
        options?.onCredentialPersistenceError?.(persistenceError);
        return secondSock as never;
      });
    const restartError = Object.assign(new Error("restart required"), {
      output: { statusCode: 515 },
    });
    const waiter: typeof waitForWaConnection = vi
      .fn()
      .mockRejectedValueOnce(restartError)
      .mockResolvedValueOnce(undefined);
    const runtime = createNonExitingRuntimeEnv();

    await expect(loginWebWithPhoneCode(false, "+15551234567", waiter, runtime)).rejects.toBe(
      persistenceError,
    );

    expect(createWaSocket).toHaveBeenCalledTimes(2);
    expect(runtime.log).not.toHaveBeenCalledWith(
      success("✅ Linked after restart; web session ready."),
    );
  });

  it("rejects when post-open key persistence fails", async () => {
    const sock = createPhoneCodeSocket("12345678");
    vi.mocked(createWaSocket).mockImplementationOnce(resolveSocketAfterImmediateQr(sock));
    const waiter: typeof waitForWaConnection = vi.fn().mockResolvedValue(undefined);
    let rejectKeyWrite = (_error: Error) => {};
    const keyWrite = new Promise<void>((_resolve, reject) => {
      rejectKeyWrite = reject;
    });
    const runtime = createNonExitingRuntimeEnv();
    const pendingLogin = loginWebWithPhoneCode(false, "+15551234567", waiter, runtime);

    await flushAsyncTurns();
    const socketOptions = vi.mocked(createWaSocket).mock.calls[0]?.[2];
    socketOptions?.onCredentialPersistenceTask?.(keyWrite);
    await flushImmediate();

    const persistenceError = new Error("post-open key write failed");
    socketOptions?.onCredentialPersistenceError?.(persistenceError);
    rejectKeyWrite(persistenceError);

    await expect(pendingLogin).rejects.toBe(persistenceError);
    expect(runtime.log).not.toHaveBeenCalledWith(
      success("✅ Linked with phone code! Credentials saved for future sends."),
    );
  });
});

describe("renderQrPngBase64", () => {
  it("renders a PNG data payload", async () => {
    const b64 = await renderQrPngBase64("openclaw");
    const buf = Buffer.from(b64, "base64");
    expect(buf.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  });
});
