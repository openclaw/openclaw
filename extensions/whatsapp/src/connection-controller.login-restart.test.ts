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

  it("restarts login once on status 408 and preserves replacement socket options", async () => {
    const harness = createLoginResultHarness(modules.login.waitForWhatsAppLoginResult);
    const waitForConnection = vi
      .fn()
      .mockRejectedValueOnce({ output: { statusCode: 408 } })
      .mockResolvedValueOnce(undefined);
    const onQr = vi.fn();
    const onSocketReplaced = vi.fn();
    const createSocket = vi.fn(
      async (_printQr: boolean, _verbose: boolean, opts?: { onQr?: (qr: string) => void }) => {
        opts?.onQr?.("qr-after-timeout");
        return harness.replacementSock;
      },
    );

    const result = await harness.run({
      verbose: true,
      waitForConnection,
      createSocket,
      socketTiming: {
        connectTimeoutMs: 10_000,
        defaultQueryTimeoutMs: 20_000,
        keepAliveIntervalMs: 30_000,
      },
      onQr,
      onSocketReplaced,
    });

    expect(result).toEqual({
      outcome: "connected",
      restarted: true,
      sock: harness.replacementSock,
    });
    expect(harness.initialSock.end).toHaveBeenCalledOnce();
    expect(createSocket).toHaveBeenCalledWith(false, true, {
      authDir: "/tmp/wa-auth",
      connectTimeoutMs: 10_000,
      defaultQueryTimeoutMs: 20_000,
      keepAliveIntervalMs: 30_000,
      onQr,
    });
    expect(onQr).toHaveBeenCalledWith("qr-after-timeout");
    expect(onSocketReplaced).toHaveBeenCalledWith(harness.replacementSock);
    expect(waitForConnection).toHaveBeenNthCalledWith(1, harness.initialSock, {
      timeout: "none",
    });
    expect(waitForConnection).toHaveBeenNthCalledWith(2, harness.replacementSock, {
      timeout: "none",
    });
  });

  it("still honors the post-pairing 515 restart after a status 408 recovery", async () => {
    const harness = createLoginResultHarness(modules.login.waitForWhatsAppLoginResult);
    const afterTimeoutSock = createSocketWithTransportEmitter();
    const afterPairingRestartSock = createSocketWithTransportEmitter();
    const waitForConnection = vi
      .fn()
      .mockRejectedValueOnce({ output: { statusCode: 408 } })
      .mockRejectedValueOnce({ output: { statusCode: 515 } })
      .mockResolvedValueOnce(undefined);
    const createSocket = vi
      .fn()
      .mockResolvedValueOnce(afterTimeoutSock)
      .mockResolvedValueOnce(afterPairingRestartSock);

    const result = await harness.run({ waitForConnection, createSocket });

    expect(result).toEqual({
      outcome: "connected",
      restarted: true,
      sock: afterPairingRestartSock,
    });
    expect(createSocket).toHaveBeenCalledTimes(2);
    expect(waitForConnection).toHaveBeenCalledTimes(3);
    expect(waitForConnection).toHaveBeenNthCalledWith(1, harness.initialSock, {
      timeout: "none",
    });
    expect(waitForConnection).toHaveBeenNthCalledWith(2, afterTimeoutSock, { timeout: "none" });
    expect(waitForConnection).toHaveBeenNthCalledWith(3, afterPairingRestartSock, {
      timeout: "none",
    });
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
    const createSocket = vi.fn(async () => harness.replacementSock);

    const result = await harness.run({ waitForConnection, createSocket });

    expect(result).toMatchObject({
      outcome: "failed",
      statusCode: 408,
      error: timeoutError,
    });
    expect(createSocket).toHaveBeenCalledOnce();
    expect(waitForConnection).toHaveBeenCalledTimes(2);
  });
});
