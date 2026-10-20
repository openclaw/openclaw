import { rmSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { sanitizeTerminalText } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimeSpies } from "../../test-support/runtime-spies.js";
import { loginWeb } from "./login.js";
import { renderQrTerminal } from "./qr-terminal.js";
import { createWaSocket, formatError, waitForWaConnection } from "./session.js";

const rmMock = vi.spyOn(fs, "rm");
const runtime = createRuntimeSpies();
const testState = vi.hoisted(() => ({
  authDir: `${(process.env.TMPDIR ?? "/tmp").replace(/\/+$/, "")}/openclaw-wa-creds-${process.pid}-${Math.random().toString(16).slice(2)}`,
}));

vi.mock(import("openclaw/plugin-sdk/runtime-config-snapshot"), async (importOriginal) => ({
  ...(await importOriginal()),
  captureRuntimeConfigAsyncReader: () => async () => ({
    channels: {
      whatsapp: {
        accounts: {
          default: { enabled: true, authDir: testState.authDir },
        },
      },
    },
  }),
}));

vi.mock("./session.js", async () => ({
  ...(await vi.importActual<typeof import("./session.js")>("./session.js")),
  createWaSocket: vi.fn(async () => ({ ws: { close: vi.fn() } })),
  waitForWaConnection: vi.fn(),
  formatError: vi.fn((err: unknown) => `formatted:${String(err)}`),
  readWebAuthExistsForDecision: vi.fn(async () => ({
    outcome: "stable" as const,
    exists: true,
  })),
  logoutWeb: vi.fn(async (params: { authDir?: string }) => {
    await fs.rm(params.authDir ?? testState.authDir, {
      recursive: true,
      force: true,
    });
    return true;
  }),
}));

vi.mock("./qr-terminal.js", () => ({
  renderQrTerminal: vi.fn(async (qr: string) => `terminal:${qr}\n`),
}));

const createWaSocketMock = vi.mocked(createWaSocket);
const waitForWaConnectionMock = vi.mocked(waitForWaConnection);
const renderQrTerminalMock = vi.mocked(renderQrTerminal);

async function flushTasks() {
  await Promise.resolve();
  await Promise.resolve();
}

function runtimeMessageCalls(fn: ReturnType<typeof createRuntimeSpies>["log"]) {
  return fn.mock.calls.map(([message]) => sanitizeTerminalText(String(message)));
}

describe("loginWeb coverage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    waitForWaConnectionMock.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });
  afterAll(() => {
    rmSync(testState.authDir, { recursive: true, force: true });
  });

  it("routes QR output through runtime for initial and restart sockets", async () => {
    waitForWaConnectionMock.mockRejectedValueOnce({ error: { output: { statusCode: 515 } } });

    await loginWeb(false, waitForWaConnectionMock as never, runtime);

    expect(createWaSocketMock).toHaveBeenCalledTimes(2);
    expect(createWaSocketMock.mock.calls[0]?.[0]).toBe(false);
    const initialOpts = createWaSocketMock.mock.calls[0]?.[2];
    const restartOpts = createWaSocketMock.mock.calls[1]?.[2];
    expect(initialOpts?.onQr).toBe(restartOpts?.onQr);

    const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    try {
      for (const [opts, qr, prefix] of [
        [initialOpts, "initial-qr", ""],
        [restartOpts, "restart-qr", "\x1b[2J\x1b[H"],
      ] as const) {
        opts?.onQr?.(qr);
        await flushTasks();
        expect(runtime.log).toHaveBeenCalledWith(
          `${prefix}Open the WhatsApp app, go to Linked Devices, then scan this QR:\nterminal:${qr}`,
        );
        expect(renderQrTerminalMock).toHaveBeenCalledWith(qr, { small: true });
      }
    } finally {
      if (stdoutDescriptor) {
        Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
      } else {
        Reflect.deleteProperty(process.stdout, "isTTY");
      }
    }

    const firstSock = await createWaSocketMock.mock.results[0]?.value;
    expect(firstSock.ws.close).toHaveBeenCalled();
    vi.runAllTimers();
    const secondSock = await createWaSocketMock.mock.results[1]?.value;
    expect(secondSock.ws.close).toHaveBeenCalled();
  });

  it("clears stale creds and continues login when logged out", async () => {
    waitForWaConnectionMock.mockRejectedValueOnce({ output: { statusCode: 401 } });

    await loginWeb(false, waitForWaConnectionMock as never, runtime);

    expect(createWaSocketMock).toHaveBeenCalledTimes(2);
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtimeMessageCalls(runtime.log)).toContain(
      "✅ Linked after restart; web session ready.",
    );
    expect(rmMock).toHaveBeenCalledWith(path.resolve(testState.authDir), {
      recursive: true,
      force: true,
    });
  });

  it("formats and rethrows generic errors", async () => {
    waitForWaConnectionMock.mockRejectedValueOnce(new Error("boom"));
    await expect(loginWeb(false, waitForWaConnectionMock as never, runtime)).rejects.toThrow(
      "formatted:Error: boom",
    );
    expect(runtimeMessageCalls(runtime.error)).toEqual([
      "WhatsApp Web connection ended before fully opening. formatted:Error: boom",
    ]);
    expect(formatError).toHaveBeenCalled();
  });
});
