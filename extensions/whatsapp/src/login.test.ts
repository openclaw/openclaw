import { success } from "openclaw/plugin-sdk/runtime-env";
import { describe, expect, it, vi } from "vitest";
import { restoreCredsFromBackupIfNeeded } from "./auth-store.js";
import { loginWeb, loginWebWithPhoneCode } from "./login.js";
import {
  setupWebLoginTest,
  createPhoneCodeSocket,
  resolveSocketAfterImmediateQr,
  flushImmediate,
} from "./login.test-helpers.js";
import { normalizeWhatsAppPairingPhoneNumber } from "./phone-code.js";
import { createWaSocket, type waitForWaConnection } from "./session.js";

vi.mock("./session.js", async () => {
  const { createMockWebLoginSession } = await import("./login.test-helpers.js");
  return await createMockWebLoginSession();
});

vi.mock("./auth-store.js", async () => {
  const { createMockWebLoginAuthStore } = await import("./login.test-helpers.js");
  return await createMockWebLoginAuthStore();
});

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
  setupWebLoginTest();

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
});
