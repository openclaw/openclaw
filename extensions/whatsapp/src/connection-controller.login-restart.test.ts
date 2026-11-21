import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControllerTestModules } from "./connection-controller.test-helpers.js";
import {
  createLoginResultHarness,
  createSocketWithTransportEmitter,
  loadConnectionControllerTestModules,
  resetConnectionControllerTestMocks,
} from "./connection-controller.test-helpers.js";

let modules!: ControllerTestModules;

describe("WhatsApp login socket restarts", () => {
  beforeAll(async () => {
    modules = await loadConnectionControllerTestModules();
  });

  beforeEach(() => {
    resetConnectionControllerTestMocks(modules);
  });

  it("preserves socket options and guards through 408 recovery then post-pairing 515 restart", async () => {
    const harness = createLoginResultHarness(modules.login.waitForWhatsAppLoginResult);
    const afterTimeoutSock = createSocketWithTransportEmitter();
    const afterPairingRestartSock = createSocketWithTransportEmitter();
    const onQr = vi.fn();
    const onSocketReplaced = vi.fn();
    const beforeCredentialPersistence = vi.fn(async () => {});
    const onCredentialPersistenceError = vi.fn();
    const onCredentialPersistenceTask = vi.fn();
    const waitForCredentialPersistence = vi.fn(async () => {});
    const socketTiming = {
      connectTimeoutMs: 10_000,
      defaultQueryTimeoutMs: 20_000,
      keepAliveIntervalMs: 30_000,
    };
    const waitForConnection = vi
      .fn()
      .mockRejectedValueOnce({ output: { statusCode: 408 } })
      .mockRejectedValueOnce({ output: { statusCode: 515 } })
      .mockResolvedValueOnce(undefined);
    const createSocket = modules.createWaSocketMock
      .mockImplementationOnce(async (_printQr, _verbose, opts) => {
        opts?.onQr?.("replacement-qr");
        return afterTimeoutSock as never;
      })
      .mockResolvedValueOnce(afterPairingRestartSock as never);

    const result = await modules.login.waitForWhatsAppLoginResult({
      sock: harness.initialSock as never,
      authDir: "/tmp/wa-auth",
      isLegacyAuthDir: false,
      runtime: harness.runtime,
      verbose: true,
      waitForConnection: waitForConnection as never,
      socketTiming,
      onQr,
      onSocketReplaced,
      beforeCredentialPersistence,
      onCredentialPersistenceError,
      onCredentialPersistenceTask,
      waitForCredentialPersistence,
    });

    expect(result).toEqual({
      outcome: "connected",
      restarted: true,
      sock: afterPairingRestartSock,
    });
    expect(createSocket).toHaveBeenCalledTimes(2);
    expect(createSocket).toHaveBeenNthCalledWith(2, false, true, {
      authDir: "/tmp/wa-auth",
      ...socketTiming,
      onQr,
      beforeCredentialPersistence,
      onCredentialPersistenceError,
      onCredentialPersistenceTask,
    });
    expect(onQr).toHaveBeenCalledWith("replacement-qr");
    expect(onSocketReplaced.mock.calls).toEqual([[afterTimeoutSock], [afterPairingRestartSock]]);
    expect(waitForCredentialPersistence).toHaveBeenCalledOnce();
    expect(modules.prepareWebAuthForLoginMock).not.toHaveBeenCalled();
    for (const [index, sock] of [
      harness.initialSock,
      afterTimeoutSock,
      afterPairingRestartSock,
    ].entries()) {
      expect(waitForConnection).toHaveBeenNthCalledWith(index + 1, sock, { timeout: "none" });
    }
    expect(harness.initialSock.end).toHaveBeenCalledOnce();
    expect(afterTimeoutSock.end).toHaveBeenCalledOnce();
  });

  it("does not keep recreating sockets when login status 408 persists", async () => {
    const harness = createLoginResultHarness(modules.login.waitForWhatsAppLoginResult);
    const timeoutError = { output: { statusCode: 408 } };
    const waitForConnection = vi
      .fn()
      .mockRejectedValueOnce(timeoutError)
      .mockRejectedValueOnce(timeoutError);
    const createSocket = modules.createWaSocketMock.mockResolvedValueOnce(
      harness.replacementSock as never,
    );

    const result = await harness.run({ waitForConnection });

    expect(result).toMatchObject({
      outcome: "failed",
      statusCode: 408,
      error: timeoutError,
    });
    expect(createSocket).toHaveBeenCalledOnce();
    expect(waitForConnection).toHaveBeenCalledTimes(2);
  });
});
