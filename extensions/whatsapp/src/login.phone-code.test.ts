import { createNonExitingRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import { success } from "openclaw/plugin-sdk/runtime-env";
import { describe, expect, it, vi } from "vitest";
import { prepareWebAuthForLogin } from "./auth-store.js";
import { loginWebWithPhoneCode } from "./login.js";
import {
  createPhoneCodeSocket,
  resolveSocketAfterImmediateQr,
  flushAsyncTurns,
  setupWebLoginTest,
} from "./login.test-helpers.js";
import { createCompletedPhoneCodeCreds } from "./phone-code.test-helpers.js";
import { createWaSocket, type waitForWaConnection } from "./session.js";

vi.mock("./session.js", async () => {
  const { createMockWebLoginSession } = await import("./login.test-helpers.js");
  return await createMockWebLoginSession();
});

vi.mock("./auth-store.js", async () => {
  const { createMockWebLoginAuthStore } = await import("./login.test-helpers.js");
  return await createMockWebLoginAuthStore();
});

describe("web phone-code login", () => {
  setupWebLoginTest();

  it("requests a phone pairing code and waits for the existing login result flow", async () => {
    const sock = createPhoneCodeSocket("12345678");
    vi.mocked(createWaSocket).mockImplementationOnce(resolveSocketAfterImmediateQr(sock));
    const waiter: typeof waitForWaConnection = vi.fn().mockResolvedValue(undefined);
    const runtime = createNonExitingRuntimeEnv();

    const loginPromise = loginWebWithPhoneCode(false, "+1 (555) 123-4567", waiter, runtime);
    await loginPromise;

    expect(vi.mocked(createWaSocket).mock.calls[0]?.[2]).toMatchObject({
      browser: ["Mac OS", "Chrome", expect.any(String)],
      qrTimeoutMs: 5 * 60_000,
    });
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
});
