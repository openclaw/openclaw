import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DisconnectReason } from "@whiskeysockets/baileys";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sessionMocks = vi.hoisted(() => ({
  createWaSocketMock: vi.fn(),
  waitForWaConnectionMock: vi.fn(),
  waitForCredsSaveQueueWithTimeoutMock: vi.fn(),
  formatErrorMock: vi.fn(),
  getStatusCodeMock: vi.fn(),
  logoutWebMock: vi.fn(),
}));

const rmMock = vi.spyOn(fs, "rm");

function resolveTestAuthDir() {
  return path.join(os.tmpdir(), "wa-creds");
}

const authDir = resolveTestAuthDir();
const sockA = { ws: { close: vi.fn() } };
const sockB = { ws: { close: vi.fn() } };

vi.mock("./accounts.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./accounts.js")>();
  return {
    ...actual,
    resolveWhatsAppAccount: () =>
      ({
        accountId: "default",
        authDir,
        isLegacyAuthDir: false,
      }) as never,
  };
});

vi.mock("./session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session.js")>();
  return {
    ...actual,
    createWaSocket: (...args: Parameters<typeof actual.createWaSocket>) =>
      sessionMocks.createWaSocketMock(...args),
    waitForWaConnection: (...args: Parameters<typeof actual.waitForWaConnection>) =>
      sessionMocks.waitForWaConnectionMock(...args),
    waitForCredsSaveQueueWithTimeout: (
      ...args: Parameters<typeof actual.waitForCredsSaveQueueWithTimeout>
    ) => sessionMocks.waitForCredsSaveQueueWithTimeoutMock(...args),
    formatError: (...args: Parameters<typeof actual.formatError>) =>
      sessionMocks.formatErrorMock(...args),
    getStatusCode: (...args: Parameters<typeof actual.getStatusCode>) =>
      sessionMocks.getStatusCodeMock(...args),
    logoutWeb: (...args: Parameters<typeof actual.logoutWeb>) =>
      sessionMocks.logoutWebMock(...args),
  };
});

async function loadSubject() {
  return import("./login.js");
}

async function flushTasks() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("loginWeb coverage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.clearAllMocks();
    rmMock.mockClear();
    sockA.ws.close.mockClear();
    sockB.ws.close.mockClear();

    sessionMocks.createWaSocketMock.mockReset();
    sessionMocks.createWaSocketMock
      .mockImplementationOnce(async () => sockA)
      .mockImplementationOnce(async () => sockB);

    sessionMocks.waitForWaConnectionMock.mockReset();
    sessionMocks.waitForCredsSaveQueueWithTimeoutMock.mockReset();
    sessionMocks.waitForCredsSaveQueueWithTimeoutMock.mockImplementation(async () => {});
    sessionMocks.formatErrorMock.mockReset();
    sessionMocks.formatErrorMock.mockImplementation((err: unknown) => `formatted:${String(err)}`);
    sessionMocks.getStatusCodeMock.mockReset();
    sessionMocks.getStatusCodeMock.mockImplementation(
      (err: unknown) =>
        (err as { output?: { statusCode?: number } })?.output?.statusCode ??
        (err as { status?: number })?.status ??
        (err as { error?: { output?: { statusCode?: number } } })?.error?.output?.statusCode,
    );
    sessionMocks.logoutWebMock.mockReset();
    sessionMocks.logoutWebMock.mockImplementation(async (params: { authDir?: string }) => {
      await fs.rm(params.authDir ?? authDir, {
        recursive: true,
        force: true,
      });
      return true;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(() => {
    vi.doUnmock("./accounts.js");
    vi.doUnmock("./session.js");
  });

  it("restarts once when WhatsApp requests code 515", async () => {
    const { loginWeb } = await loadSubject();
    let releaseCredsFlush: (() => void) | undefined;
    const credsFlushGate = new Promise<void>((resolve) => {
      releaseCredsFlush = resolve;
    });
    sessionMocks.waitForWaConnectionMock
      .mockRejectedValueOnce({ error: { output: { statusCode: 515 } } })
      .mockResolvedValueOnce(undefined);
    sessionMocks.waitForCredsSaveQueueWithTimeoutMock.mockReturnValueOnce(credsFlushGate);

    const runtime = { log: vi.fn(), error: vi.fn() } as never;
    const pendingLogin = loginWeb(false, sessionMocks.waitForWaConnectionMock as never, runtime);
    await flushTasks();

    expect(sessionMocks.createWaSocketMock).toHaveBeenCalledTimes(1);
    expect(sessionMocks.waitForCredsSaveQueueWithTimeoutMock).toHaveBeenCalledOnce();
    expect(sessionMocks.waitForCredsSaveQueueWithTimeoutMock).toHaveBeenCalledWith(authDir);

    releaseCredsFlush?.();
    await pendingLogin;

    expect(sessionMocks.createWaSocketMock).toHaveBeenCalledTimes(2);
    const firstSock = await sessionMocks.createWaSocketMock.mock.results[0]?.value;
    expect(firstSock.ws.close).toHaveBeenCalled();
    vi.runAllTimers();
    const secondSock = await sessionMocks.createWaSocketMock.mock.results[1]?.value;
    expect(secondSock.ws.close).toHaveBeenCalled();
  });

  it("clears creds and throws when logged out", async () => {
    const { loginWeb } = await loadSubject();
    sessionMocks.waitForWaConnectionMock.mockRejectedValueOnce({
      output: { statusCode: DisconnectReason.loggedOut },
    });

    await expect(loginWeb(false, sessionMocks.waitForWaConnectionMock as never)).rejects.toThrow(
      /cache cleared/i,
    );
    expect(rmMock).toHaveBeenCalledWith(authDir, {
      recursive: true,
      force: true,
    });
  });

  it("formats and rethrows generic errors", async () => {
    const { loginWeb } = await loadSubject();
    sessionMocks.waitForWaConnectionMock.mockRejectedValueOnce(new Error("boom"));

    await expect(loginWeb(false, sessionMocks.waitForWaConnectionMock as never)).rejects.toThrow(
      "formatted:Error: boom",
    );
    expect(sessionMocks.formatErrorMock).toHaveBeenCalled();
  });
});
