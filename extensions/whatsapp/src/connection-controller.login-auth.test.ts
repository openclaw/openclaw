import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControllerTestModules } from "./connection-controller.test-helpers.js";
import {
  createLoginResultHarness,
  loggedOutError,
  loginAuthDir,
  loadConnectionControllerTestModules,
  resetConnectionControllerTestMocks,
} from "./connection-controller.test-helpers.js";

let modules!: ControllerTestModules;

async function runLoggedOutRecovery(opts: {
  preparation?: "cleared" | "not-cleared" | "unstable" | "not-needed";
  secondWait?: "resolve" | "logged-out";
}) {
  if (opts.preparation) {
    modules.prepareWebAuthForLoginMock.mockResolvedValueOnce(opts.preparation);
  }
  const harness = createLoginResultHarness(modules.login.waitForWhatsAppLoginResult);
  const error = loggedOutError();
  const waitForConnection = vi.fn().mockRejectedValueOnce(error);
  if (opts.secondWait === "resolve") {
    waitForConnection.mockResolvedValueOnce(undefined);
  } else if (opts.secondWait === "logged-out") {
    waitForConnection.mockRejectedValueOnce(error);
  }
  const createSocket = vi.fn(async () => harness.replacementSock);
  const result = await harness.run({ waitForConnection, createSocket });
  return { createSocket, error, harness, result, waitForConnection };
}

describe("WhatsApp logged-out login recovery", () => {
  beforeAll(async () => {
    modules = await loadConnectionControllerTestModules();
  });

  beforeEach(() => {
    resetConnectionControllerTestMocks(modules);
  });

  it("clears stale logged-out auth once and continues login with a fresh socket", async () => {
    const harness = createLoginResultHarness(modules.login.waitForWhatsAppLoginResult);
    const error = loggedOutError();
    const waitForConnection = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce(undefined);
    const onQr = vi.fn();
    const onSocketReplaced = vi.fn();
    const createSocket = vi.fn(
      async (_printQr: boolean, _verbose: boolean, opts?: { onQr?: (qr: string) => void }) => {
        opts?.onQr?.("qr-after-logout");
        return harness.replacementSock;
      },
    );

    const result = await harness.run({
      verbose: true,
      waitForConnection,
      createSocket,
      onQr,
      onSocketReplaced,
    });

    expect(result).toEqual({
      outcome: "connected",
      restarted: true,
      sock: harness.replacementSock,
    });
    expect(modules.prepareWebAuthForLoginMock).toHaveBeenCalledWith({
      authDir: loginAuthDir,
      isLegacyAuthDir: false,
      mode: "clear-existing",
      runtime: harness.runtime,
    });
    expect(harness.initialSock.end).toHaveBeenCalledOnce();
    expect(createSocket).toHaveBeenCalledWith(false, true, {
      authDir: loginAuthDir,
      onQr,
    });
    expect(onQr).toHaveBeenCalledWith("qr-after-logout");
    expect(onSocketReplaced).toHaveBeenCalledWith(harness.replacementSock);
    expect(waitForConnection).toHaveBeenNthCalledWith(1, harness.initialSock, {
      timeout: "none",
    });
    expect(waitForConnection).toHaveBeenNthCalledWith(2, harness.replacementSock, {
      timeout: "none",
    });
  });

  it("does not retry logged-out login when existing auth cannot be cleared", async () => {
    const { createSocket, error, harness, result, waitForConnection } = await runLoggedOutRecovery({
      preparation: "not-cleared",
    });

    expect(result).toEqual({
      outcome: "failed",
      message:
        "existing auth could not be cleared. Remove or fix the configured WhatsApp auth directory, then retry login.",
      error,
    });
    expect(modules.prepareWebAuthForLoginMock).toHaveBeenCalledWith({
      authDir: loginAuthDir,
      isLegacyAuthDir: false,
      mode: "clear-existing",
      runtime: harness.runtime,
    });
    expect(harness.initialSock.end).toHaveBeenCalledOnce();
    expect(createSocket).not.toHaveBeenCalled();
    expect(waitForConnection).toHaveBeenCalledOnce();
  });

  it("does not retry logged-out login while auth cleanup is unstable", async () => {
    const { createSocket, result, waitForConnection } = await runLoggedOutRecovery({
      preparation: "unstable",
    });

    expect(result.outcome).toBe("failed");
    if (result.outcome === "failed") {
      expect(result.message).toMatch(/saving the linked credentials has not settled/i);
      expect((result.error as { code?: string })?.code).toBe("whatsapp-auth-unstable");
    }
    expect(createSocket).not.toHaveBeenCalled();
    expect(waitForConnection).toHaveBeenCalledOnce();
  });

  it("retries logged-out login when cleanup is a no-op because no auth exists", async () => {
    const { createSocket, harness, result, waitForConnection } = await runLoggedOutRecovery({
      preparation: "not-needed",
      secondWait: "resolve",
    });

    expect(result).toEqual({
      outcome: "connected",
      restarted: true,
      sock: harness.replacementSock,
    });
    expect(createSocket).toHaveBeenCalledOnce();
    expect(waitForConnection).toHaveBeenNthCalledWith(2, harness.replacementSock, {
      timeout: "none",
    });
  });

  it("does not clear stale logged-out auth more than once", async () => {
    const { createSocket, error, result, waitForConnection } = await runLoggedOutRecovery({
      secondWait: "logged-out",
    });

    expect(result).toMatchObject({
      outcome: "logged-out",
      statusCode: 401,
      error,
    });
    expect(modules.prepareWebAuthForLoginMock).toHaveBeenCalledOnce();
    expect(createSocket).toHaveBeenCalledOnce();
    expect(waitForConnection).toHaveBeenCalledTimes(2);
  });
});
