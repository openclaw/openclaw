import { EventEmitter } from "node:events";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import {
  cleanupSessionTest,
  createTempAuthDir,
  emitCredsUpdate,
  flushCredsUpdate,
  mockFsOpenForCredsWrites,
  readLastSocketOptions,
  requireValue,
  resetSessionTestMocks,
} from "./session-test-helpers.js";
import { DEFAULT_WHATSAPP_SOCKET_TIMING } from "./socket-timing.js";
import { baileys, getLastSocket } from "./test-helpers.js";

let session!: typeof import("./session.js");
let renderQrTerminalMock!: ReturnType<typeof vi.fn>;

describe("web session socket construction", () => {
  beforeAll(async () => {
    session = await import("./session.js");
    renderQrTerminalMock = vi.mocked((await import("./qr-terminal.js")).renderQrTerminal);
  });

  beforeEach(() => {
    resetSessionTestMocks();
  });

  afterEach(async () => {
    await cleanupSessionTest(session.waitForCredsSaveQueue);
  });

  it("creates WA socket with QR handler", async () => {
    const authDir = createTempAuthDir("openclaw-wa-creds-test");
    const openMock = mockFsOpenForCredsWrites();

    await session.createWaSocket(true, false, { authDir });
    const passed = readLastSocketOptions();
    expect(passed.printQRInTerminal).toBe(false);
    expect(passed.fireInitQueries).toBe(true);
    expect(passed.keepAliveIntervalMs).toBe(DEFAULT_WHATSAPP_SOCKET_TIMING.keepAliveIntervalMs);
    expect(passed.connectTimeoutMs).toBe(DEFAULT_WHATSAPP_SOCKET_TIMING.connectTimeoutMs);
    expect(passed.defaultQueryTimeoutMs).toBe(DEFAULT_WHATSAPP_SOCKET_TIMING.defaultQueryTimeoutMs);
    expect(passed.browser).toEqual(["openclaw", "cli", expect.any(String)]);
    const passedLogger = (passed as { logger?: { level?: string; trace?: unknown } }).logger;
    expect(passedLogger?.level).toBe("silent");
    if (typeof passedLogger?.trace !== "function") {
      throw new Error("expected WhatsApp socket logger trace no-op");
    }
    passedLogger.trace("ignored");
    await emitCredsUpdate(session.waitForCredsSaveQueue, authDir);

    const write = requireValue(openMock.writes[0], "WhatsApp credential write");
    const tempHandle = requireValue(openMock.tempHandles[0], "WhatsApp credential handle");
    expect(write.filePath).toContain(path.join(authDir, ".creds."));
    expect(typeof write.data).toBe("string");
    expect(tempHandle.mode).toBe(0o600);
    expect(tempHandle.flags).toBe("wx");
    openMock.restore();
  });

  it("creates standalone directory sockets without inbound message consumers", async () => {
    const authDir = createTempAuthDir("openclaw-wa-directory-socket");
    const ws = new EventEmitter() as EventEmitter & { close: ReturnType<typeof vi.fn> };
    ws.close = vi.fn();
    ws.on("CB:message", vi.fn());
    ws.on("CB:call", vi.fn());
    ws.on("CB:receipt", vi.fn());
    ws.on("CB:notification", vi.fn());
    ws.on("CB:ack,class:message", vi.fn());
    ws.on("CB:presence", vi.fn());
    ws.on("CB:chatstate", vi.fn());
    ws.on("CB:ib,,dirty", vi.fn());
    ws.on("CB:ib,,offline_preview", vi.fn());
    ws.on("CB:ib,,offline", vi.fn());
    ws.on("CB:ib,,edge_routing", vi.fn());
    const sock = {
      ev: new EventEmitter(),
      ws,
      groupFetchAllParticipating: vi.fn().mockResolvedValue({}),
    };
    vi.mocked(baileys.makeWASocket).mockReturnValueOnce(sock as never);

    await session.createWaDirectorySocket(authDir);

    expect(readLastSocketOptions().fireInitQueries).toBe(false);
    for (const event of [
      "CB:message",
      "CB:call",
      "CB:receipt",
      "CB:notification",
      "CB:ack,class:message",
      "CB:presence",
      "CB:chatstate",
      "CB:ib,,dirty",
      "CB:ib,,offline_preview",
      "CB:ib,,offline",
      "CB:ib,,edge_routing",
    ]) {
      expect(ws.listenerCount(event), event).toBe(0);
    }
  });

  it("prints compact terminal QR output when requested", async () => {
    const authDir = createTempAuthDir("openclaw-wa-terminal-qr");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      await session.createWaSocket(true, false, { authDir });
      getLastSocket().ev.emit("connection.update", { qr: "qr-data" });
      await flushCredsUpdate();

      expect(logSpy).toHaveBeenCalledWith(
        "Open the WhatsApp app, go to Linked Devices, then scan this QR:",
      );
      expect(renderQrTerminalMock).toHaveBeenCalledWith("qr-data", { small: true });
      expect(stdoutSpy).toHaveBeenCalledWith("ASCII-QR\n");
    } finally {
      logSpy.mockRestore();
      stdoutSpy.mockRestore();
    }
  });
});
