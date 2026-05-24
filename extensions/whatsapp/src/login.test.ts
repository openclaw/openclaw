import { EventEmitter } from "node:events";
import { resetLogger, setLoggerOverride, success } from "openclaw/plugin-sdk/runtime-env";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renderQrPngBase64 } from "./qr-image.js";

vi.mock("./session.js", async () => {
  const actual = await vi.importActual<typeof import("./session.js")>("./session.js");
  const ev = new EventEmitter();
  const sock = {
    ev,
    authState: { creds: { registered: false } },
    requestPairingCode: vi.fn(async () => "ABCD1234"),
    ws: { close: vi.fn() },
    sendPresenceUpdate: vi.fn(),
    sendMessage: vi.fn(),
  };
  return {
    ...actual,
    createWaSocket: vi.fn().mockResolvedValue(sock),
    waitForWaConnection: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("./auth-store.js", async () => {
  const actual = await vi.importActual<typeof import("./auth-store.js")>("./auth-store.js");
  return {
    ...actual,
    clearStalePhoneCodePairingAuthIfNeeded: vi.fn(async () => false),
    hasWebCredsSync: vi.fn(() => false),
    restoreCredsFromBackupIfNeeded: vi.fn(async () => false),
  };
});

import type { waitForWaConnection } from "./session.js";
let loginWeb: typeof import("./login.js").loginWeb;
let loginWebWithPhoneCode: typeof import("./login.js").loginWebWithPhoneCode;
let normalizeWhatsAppPairingPhoneNumber: typeof import("./login.js").normalizeWhatsAppPairingPhoneNumber;
let createWaSocket: typeof import("./session.js").createWaSocket;
let clearStalePhoneCodePairingAuthIfNeeded: typeof import("./auth-store.js").clearStalePhoneCodePairingAuthIfNeeded;
let hasWebCredsSync: typeof import("./auth-store.js").hasWebCredsSync;
let restoreCredsFromBackupIfNeeded: typeof import("./auth-store.js").restoreCredsFromBackupIfNeeded;

describe("web login", () => {
  beforeAll(async () => {
    ({ loginWeb, loginWebWithPhoneCode, normalizeWhatsAppPairingPhoneNumber } =
      await import("./login.js"));
    ({ createWaSocket } = await import("./session.js"));
    ({ clearStalePhoneCodePairingAuthIfNeeded, hasWebCredsSync, restoreCredsFromBackupIfNeeded } =
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

  it("loginWebWithPhoneCode requests a pairing code and waits for connection", async () => {
    const waiter: typeof waitForWaConnection = vi.fn().mockResolvedValue(undefined);
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

    const pendingLogin = loginWebWithPhoneCode(false, "+44 7123-456-789", waiter, runtime);
    await Promise.resolve();
    await Promise.resolve();

    const sock = (await vi.mocked(createWaSocket).mock.results[0]?.value) as {
      ev: EventEmitter;
      requestPairingCode: ReturnType<typeof vi.fn>;
    };
    sock.ev.emit("connection.update", { qr: "pairing-ready" });
    await pendingLogin;

    expect(vi.mocked(createWaSocket)).toHaveBeenCalledWith(
      false,
      false,
      expect.objectContaining({ browser: expect.any(Array) }),
    );
    expect(sock.requestPairingCode).toHaveBeenCalledWith("447123456789");
    expect(runtime.log).toHaveBeenCalledWith("WhatsApp pairing code: ABCD 1234");
    expect(runtime.log).toHaveBeenCalledWith(
      "On your phone, open WhatsApp → Linked Devices → Link with phone number, then enter this code.",
    );
  });

  it("does not request a pairing code when usable linked creds already exist", async () => {
    vi.mocked(hasWebCredsSync).mockReturnValueOnce(true);
    const waiter: typeof waitForWaConnection = vi.fn().mockResolvedValue(undefined);
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

    await loginWebWithPhoneCode(false, "+44 7123-456-789", waiter, runtime);

    const sock = (await vi.mocked(createWaSocket).mock.results[0]?.value) as {
      requestPairingCode: ReturnType<typeof vi.fn>;
    };
    expect(sock.requestPairingCode).not.toHaveBeenCalled();
    expect(waiter).toHaveBeenCalled();
  });

  it("clears partial phone-code credentials after a failed pairing attempt", async () => {
    const waiter: typeof waitForWaConnection = vi.fn().mockRejectedValue({
      output: { statusCode: 428 },
    });
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

    const pendingLogin = loginWebWithPhoneCode(false, "+44 7123-456-789", waiter, runtime);
    await Promise.resolve();
    await Promise.resolve();

    const sock = (await vi.mocked(createWaSocket).mock.results[0]?.value) as {
      ev: EventEmitter;
    };
    sock.ev.emit("connection.update", { qr: "pairing-ready" });

    await expect(pendingLogin).rejects.toThrow(/status=428/);
    expect(clearStalePhoneCodePairingAuthIfNeeded).toHaveBeenCalledTimes(2);
  });

  it("normalizes phone-code login numbers for Baileys", () => {
    expect(normalizeWhatsAppPairingPhoneNumber(" +44 7123-456-789 ")).toBe("447123456789");
    expect(() => normalizeWhatsAppPairingPhoneNumber("not a number")).toThrow(
      /requires --phone-number/,
    );
    expect(() => normalizeWhatsAppPairingPhoneNumber("+44 (0) 7123-456-789")).toThrow(
      /omit optional trunk prefixes/,
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
