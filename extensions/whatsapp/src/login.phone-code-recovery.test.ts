import { createNonExitingRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import { success } from "openclaw/plugin-sdk/runtime-env";
import { describe, expect, it, vi } from "vitest";
import { prepareWebAuthForLogin } from "./auth-store.js";
import { loginWebWithPhoneCode } from "./login.js";
import {
  createPhoneCodeSocket,
  resolveSocketAfterImmediateQr,
  flushAsyncTurns,
  flushImmediate,
  setupWebLoginTest,
} from "./login.test-helpers.js";
import { createWaSocket, type waitForWaConnection } from "./session.js";

vi.mock("./session.js", async () => {
  const { createMockWebLoginSession } = await import("./login.test-helpers.js");
  return await createMockWebLoginSession();
});

vi.mock("./auth-store.js", async () => {
  const { createMockWebLoginAuthStore } = await import("./login.test-helpers.js");
  return await createMockWebLoginAuthStore();
});

describe("web phone-code login recovery", () => {
  setupWebLoginTest();

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
    expect(vi.mocked(createWaSocket).mock.calls.map((call) => call[2]?.browser)).toEqual([
      ["Mac OS", "Chrome", expect.any(String)],
      ["Mac OS", "Chrome", expect.any(String)],
    ]);
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
