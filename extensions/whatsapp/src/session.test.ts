import { EventEmitter } from "node:events";
import fsSync from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetLogger, setLoggerOverride } from "../../../src/logging.js";
import { baileys, getLastSocket, resetBaileysMocks, resetLoadConfigMock } from "./test-helpers.js";

const { httpsProxyAgentSpy, envHttpProxyAgentSpy, undiciFetchMock } = vi.hoisted(() => ({
  httpsProxyAgentSpy: vi.fn(),
  envHttpProxyAgentSpy: vi.fn(),
  undiciFetchMock: vi.fn(),
}));

vi.mock("https-proxy-agent", () => ({
  HttpsProxyAgent: vi.fn(function MockHttpsProxyAgent(
    this: { proxyUrl: string },
    proxyUrl: string,
  ) {
    this.proxyUrl = proxyUrl;
    httpsProxyAgentSpy(proxyUrl);
  }),
}));

vi.mock("undici", async (importOriginal) => {
  const actual = await importOriginal<typeof import("undici")>();
  class MockEnvHttpProxyAgent {
    options?: Record<string, unknown>;
    constructor(options?: Record<string, unknown>) {
      this.options = options;
      envHttpProxyAgentSpy(options);
    }
  }
  return {
    ...actual,
    EnvHttpProxyAgent: MockEnvHttpProxyAgent,
    fetch: undiciFetchMock,
  };
});

const { createWaSocket, formatError, logWebSelfId, waitForWaConnection } =
  await import("./session.js");
const useMultiFileAuthStateMock = vi.mocked(baileys.useMultiFileAuthState);

async function flushCredsUpdate() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function emitCredsUpdateAndReadSaveCreds() {
  const sock = getLastSocket();
  const saveCreds = (await useMultiFileAuthStateMock.mock.results[0]?.value)?.saveCreds;
  sock.ev.emit("creds.update", {});
  await flushCredsUpdate();
  return saveCreds;
}

function mockCredsJsonSpies(readContents: string) {
  const credsSuffix = path.join(".openclaw", "credentials", "whatsapp", "default", "creds.json");
  const copySpy = vi.spyOn(fsSync, "copyFileSync").mockImplementation(() => {});
  const existsSpy = vi.spyOn(fsSync, "existsSync").mockImplementation((p) => {
    if (typeof p !== "string") {
      return false;
    }
    return p.endsWith(credsSuffix);
  });
  const statSpy = vi.spyOn(fsSync, "statSync").mockImplementation((p) => {
    if (typeof p === "string" && p.endsWith(credsSuffix)) {
      return { isFile: () => true, size: 12 } as never;
    }
    throw new Error(`unexpected statSync path: ${String(p)}`);
  });
  const readSpy = vi.spyOn(fsSync, "readFileSync").mockImplementation((p) => {
    if (typeof p === "string" && p.endsWith(credsSuffix)) {
      return readContents as never;
    }
    throw new Error(`unexpected readFileSync path: ${String(p)}`);
  });
  return {
    copySpy,
    credsSuffix,
    restore: () => {
      copySpy.mockRestore();
      existsSpy.mockRestore();
      statSpy.mockRestore();
      readSpy.mockRestore();
    },
  };
}

describe("web session", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetBaileysMocks();
    resetLoadConfigMock();
    delete process.env.http_proxy;
    delete process.env.https_proxy;
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
    delete process.env.no_proxy;
    delete process.env.NO_PROXY;
  });

  afterEach(() => {
    resetLogger();
    setLoggerOverride(null);
    vi.useRealTimers();
  });

  it("creates WA socket with QR handler", async () => {
    await createWaSocket(true, false);
    const makeWASocket = baileys.makeWASocket as ReturnType<typeof vi.fn>;
    expect(makeWASocket).toHaveBeenCalledWith(
      expect.objectContaining({ printQRInTerminal: false }),
    );
    const passed = makeWASocket.mock.calls[0][0];
    const passedLogger = (passed as { logger?: { level?: string; trace?: unknown } }).logger;
    expect(passedLogger?.level).toBe("silent");
    expect(typeof passedLogger?.trace).toBe("function");
    const sock = getLastSocket();
    const saveCreds = (await useMultiFileAuthStateMock.mock.results[0]?.value)?.saveCreds;
    // trigger creds.update listener
    sock.ev.emit("creds.update", {});
    await flushCredsUpdate();
    expect(saveCreds).toHaveBeenCalled();
  });

  it("adds explicit proxy agents when https proxy env is configured", async () => {
    process.env.HTTPS_PROXY = "http://proxy.test:3128";

    await createWaSocket(false, false);

    const makeWASocket = baileys.makeWASocket as ReturnType<typeof vi.fn>;
    const passed = makeWASocket.mock.calls[0]?.[0] as
      | { agent?: unknown; fetchAgent?: unknown }
      | undefined;

    expect(passed?.agent).toBeDefined();
    expect(passed?.fetchAgent).toBeDefined();
    expect(httpsProxyAgentSpy).toHaveBeenCalledWith("http://proxy.test:3128");
    expect(envHttpProxyAgentSpy).toHaveBeenCalled();
  });

  it("does not force the websocket through the proxy when NO_PROXY excludes web.whatsapp.com", async () => {
    process.env.HTTPS_PROXY = "http://proxy.test:3128";
    process.env.NO_PROXY = "web.whatsapp.com";

    await createWaSocket(false, false);

    const makeWASocket = baileys.makeWASocket as ReturnType<typeof vi.fn>;
    const passed = makeWASocket.mock.calls[0]?.[0] as
      | { agent?: unknown; fetchAgent?: unknown }
      | undefined;

    expect(passed?.agent).toBeUndefined();
    expect(passed?.fetchAgent).toBeDefined();
    expect(httpsProxyAgentSpy).not.toHaveBeenCalled();
    expect(envHttpProxyAgentSpy).toHaveBeenCalled();
  });

  it("refreshes the WhatsApp Web version with Baileys headers when Baileys falls back", async () => {
    process.env.HTTPS_PROXY = "http://proxy.test:3128";
    vi.mocked(baileys.fetchLatestBaileysVersion).mockResolvedValueOnce({
      version: [2, 3000, 1027934701],
      isLatest: false,
    });
    undiciFetchMock.mockResolvedValueOnce({
      ok: true,
      headers: new Headers(),
      body: null,
      text: vi.fn().mockResolvedValue('self.client_revision="1035441841";'),
    } as unknown as Response);

    await createWaSocket(false, false);

    const makeWASocket = baileys.makeWASocket as ReturnType<typeof vi.fn>;
    const passed = makeWASocket.mock.calls[0]?.[0] as { version?: unknown } | undefined;
    expect(passed?.version).toEqual([2, 3000, 1035441841]);
    expect(undiciFetchMock).toHaveBeenCalledWith(
      "https://web.whatsapp.com/sw.js",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          "sec-fetch-site": "none",
          "user-agent": expect.stringContaining("Chrome/131.0.0.0"),
        }),
      }),
    );
  });

  it("waits for connection open", async () => {
    const ev = new EventEmitter();
    const promise = waitForWaConnection({ ev } as unknown as ReturnType<
      typeof baileys.makeWASocket
    >);
    ev.emit("connection.update", { connection: "open" });
    await expect(promise).resolves.toBeUndefined();
  });

  it("rejects when connection closes", async () => {
    const ev = new EventEmitter();
    const promise = waitForWaConnection({ ev } as unknown as ReturnType<
      typeof baileys.makeWASocket
    >);
    ev.emit("connection.update", {
      connection: "close",
      lastDisconnect: new Error("bye"),
    });
    await expect(promise).rejects.toBeInstanceOf(Error);
  });

  it("logWebSelfId prints cached E.164 when creds exist", () => {
    const existsSpy = vi.spyOn(fsSync, "existsSync").mockImplementation((p) => {
      if (typeof p !== "string") {
        return false;
      }
      return p.endsWith("creds.json");
    });
    const readSpy = vi.spyOn(fsSync, "readFileSync").mockImplementation((p) => {
      if (typeof p === "string" && p.endsWith("creds.json")) {
        return JSON.stringify({ me: { id: "12345@s.whatsapp.net" } });
      }
      throw new Error(`unexpected readFileSync path: ${String(p)}`);
    });
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    logWebSelfId("/tmp/wa-creds", runtime as never, true);

    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("Web Channel: +12345 (jid 12345@s.whatsapp.net)"),
    );
    existsSpy.mockRestore();
    readSpy.mockRestore();
  });

  it("formatError prints Boom-like payload message", () => {
    const err = {
      error: {
        isBoom: true,
        output: {
          statusCode: 408,
          payload: {
            statusCode: 408,
            error: "Request Time-out",
            message: "QR refs attempts ended",
          },
        },
      },
    };
    expect(formatError(err)).toContain("status=408");
    expect(formatError(err)).toContain("Request Time-out");
    expect(formatError(err)).toContain("QR refs attempts ended");
  });

  it("does not clobber creds backup when creds.json is corrupted", async () => {
    const creds = mockCredsJsonSpies("{");

    await createWaSocket(false, false);
    const saveCreds = await emitCredsUpdateAndReadSaveCreds();

    expect(creds.copySpy).not.toHaveBeenCalled();
    expect(saveCreds).toHaveBeenCalled();

    creds.restore();
  });

  it("serializes creds.update saves to avoid overlapping writes", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const saveCreds = vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await gate;
      inFlight -= 1;
    });
    useMultiFileAuthStateMock.mockResolvedValueOnce({
      state: { creds: {} as never, keys: {} as never },
      saveCreds,
    });

    await createWaSocket(false, false);
    const sock = getLastSocket();

    sock.ev.emit("creds.update", {});
    sock.ev.emit("creds.update", {});

    await flushCredsUpdate();
    expect(inFlight).toBe(1);

    (release as (() => void) | null)?.();

    // let both queued saves complete
    await flushCredsUpdate();
    await flushCredsUpdate();

    expect(saveCreds).toHaveBeenCalledTimes(2);
    expect(maxInFlight).toBe(1);
    expect(inFlight).toBe(0);
  });

  it("lets different authDir queues flush independently", async () => {
    let inFlightA = 0;
    let inFlightB = 0;
    let releaseA: (() => void) | null = null;
    let releaseB: (() => void) | null = null;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const gateB = new Promise<void>((resolve) => {
      releaseB = resolve;
    });

    const saveCredsA = vi.fn(async () => {
      inFlightA += 1;
      await gateA;
      inFlightA -= 1;
    });
    const saveCredsB = vi.fn(async () => {
      inFlightB += 1;
      await gateB;
      inFlightB -= 1;
    });
    useMultiFileAuthStateMock
      .mockResolvedValueOnce({
        state: { creds: {} as never, keys: {} as never },
        saveCreds: saveCredsA,
      })
      .mockResolvedValueOnce({
        state: { creds: {} as never, keys: {} as never },
        saveCreds: saveCredsB,
      });

    await createWaSocket(false, false, { authDir: "/tmp/wa-a" });
    const sockA = getLastSocket();
    await createWaSocket(false, false, { authDir: "/tmp/wa-b" });
    const sockB = getLastSocket();

    sockA.ev.emit("creds.update", {});
    sockB.ev.emit("creds.update", {});

    await flushCredsUpdate();

    expect(saveCredsA).toHaveBeenCalledTimes(1);
    expect(saveCredsB).toHaveBeenCalledTimes(1);
    expect(inFlightA).toBe(1);
    expect(inFlightB).toBe(1);

    (releaseA as (() => void) | null)?.();
    (releaseB as (() => void) | null)?.();
    await flushCredsUpdate();
    await flushCredsUpdate();

    expect(inFlightA).toBe(0);
    expect(inFlightB).toBe(0);
  });

  it("rotates creds backup when creds.json is valid JSON", async () => {
    const creds = mockCredsJsonSpies("{}");
    const backupSuffix = path.join(
      ".openclaw",
      "credentials",
      "whatsapp",
      "default",
      "creds.json.bak",
    );

    await createWaSocket(false, false);
    const saveCreds = await emitCredsUpdateAndReadSaveCreds();

    expect(creds.copySpy).toHaveBeenCalledTimes(1);
    const args = creds.copySpy.mock.calls[0] ?? [];
    expect(String(args[0] ?? "")).toContain(creds.credsSuffix);
    expect(String(args[1] ?? "")).toContain(backupSuffix);
    expect(saveCreds).toHaveBeenCalled();

    creds.restore();
  });
});
