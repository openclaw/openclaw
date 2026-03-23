import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DisconnectReason } from "@whiskeysockets/baileys";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rmMock = vi.spyOn(fs, "rm");
const sessionMocks = vi.hoisted(() => {
  const sockA = { ws: { close: vi.fn() } };
  const sockB = { ws: { close: vi.fn() } };
  const createWaSocket = vi.fn(async () => (createWaSocket.mock.calls.length <= 1 ? sockA : sockB));
  return {
    sockA,
    sockB,
    createWaSocket,
    waitForWaConnection: vi.fn(),
    formatError: vi.fn((err: unknown) => `formatted:${String(err)}`),
    getStatusCode: vi.fn(
      (err: unknown) =>
        (err as { output?: { statusCode?: number } })?.output?.statusCode ??
        (err as { status?: number })?.status ??
        (err as { error?: { output?: { statusCode?: number } } })?.error?.output?.statusCode,
    ),
    waitForCredsSaveQueueWithTimeout: vi.fn(async () => {}),
  };
});
let loginWeb: typeof import("./login.js").loginWeb;

function resolveTestAuthDir() {
  return path.join(os.tmpdir(), "wa-creds");
}

const authDir = resolveTestAuthDir();

vi.mock("openclaw/plugin-sdk/config-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/config-runtime")>(
    "openclaw/plugin-sdk/config-runtime",
  );
  return {
    ...actual,
    loadConfig: () =>
      ({
        channels: {
          whatsapp: {
            accounts: {
              default: { enabled: true, authDir: resolveTestAuthDir() },
            },
          },
        },
      }) as never,
  };
});

vi.mock("./session.js", () => {
  const authDir = resolveTestAuthDir();
  return {
    createWaSocket: sessionMocks.createWaSocket,
    waitForWaConnection: sessionMocks.waitForWaConnection,
    formatError: sessionMocks.formatError,
    getStatusCode: sessionMocks.getStatusCode,
    waitForCredsSaveQueueWithTimeout: sessionMocks.waitForCredsSaveQueueWithTimeout,
    WA_WEB_AUTH_DIR: authDir,
    logoutWeb: vi.fn(async (params: { authDir?: string }) => {
      await fs.rm(params.authDir ?? authDir, {
        recursive: true,
        force: true,
      });
      return true;
    }),
  };
});

async function flushTasks() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("loginWeb coverage", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.clearAllMocks();
    ({ loginWeb } = await import("./login.js"));
    sessionMocks.sockA.ws.close.mockClear();
    sessionMocks.sockB.ws.close.mockClear();
    sessionMocks.createWaSocket.mockClear();
    sessionMocks.waitForWaConnection.mockReset().mockResolvedValue(undefined);
    sessionMocks.waitForCredsSaveQueueWithTimeout.mockReset().mockResolvedValue(undefined);
    sessionMocks.formatError
      .mockReset()
      .mockImplementation((err: unknown) => `formatted:${String(err)}`);
    rmMock.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("restarts once when WhatsApp requests code 515", async () => {
    let releaseCredsFlush: (() => void) | undefined;
    const credsFlushGate = new Promise<void>((resolve) => {
      releaseCredsFlush = resolve;
    });
    sessionMocks.waitForWaConnection
      .mockRejectedValueOnce({ error: { output: { statusCode: 515 } } })
      .mockResolvedValueOnce(undefined);
    sessionMocks.waitForCredsSaveQueueWithTimeout.mockReturnValueOnce(credsFlushGate);

    const runtime = { log: vi.fn(), error: vi.fn() } as never;
    const pendingLogin = loginWeb(false, sessionMocks.waitForWaConnection as never, runtime);
    await flushTasks();

    expect(sessionMocks.createWaSocket).toHaveBeenCalledTimes(1);
    expect(sessionMocks.waitForCredsSaveQueueWithTimeout).toHaveBeenCalledOnce();
    expect(sessionMocks.waitForCredsSaveQueueWithTimeout).toHaveBeenCalledWith(authDir);

    releaseCredsFlush?.();
    await pendingLogin;

    expect(sessionMocks.createWaSocket).toHaveBeenCalledTimes(2);
    const firstSock = await sessionMocks.createWaSocket.mock.results[0]?.value;
    expect(firstSock.ws.close).toHaveBeenCalled();
    vi.runAllTimers();
    const secondSock = await sessionMocks.createWaSocket.mock.results[1]?.value;
    expect(secondSock.ws.close).toHaveBeenCalled();
  });

  it("clears creds and throws when logged out", async () => {
    sessionMocks.waitForWaConnection.mockRejectedValueOnce({
      output: { statusCode: DisconnectReason.loggedOut },
    });

    await expect(loginWeb(false, sessionMocks.waitForWaConnection as never)).rejects.toThrow(
      /cache cleared/i,
    );
    expect(rmMock).toHaveBeenCalledWith(authDir, {
      recursive: true,
      force: true,
    });
  });

  it("formats and rethrows generic errors", async () => {
    sessionMocks.waitForWaConnection.mockRejectedValueOnce(new Error("boom"));
    await expect(loginWeb(false, sessionMocks.waitForWaConnection as never)).rejects.toThrow(
      "formatted:Error: boom",
    );
    expect(sessionMocks.formatError).toHaveBeenCalled();
  });
});
