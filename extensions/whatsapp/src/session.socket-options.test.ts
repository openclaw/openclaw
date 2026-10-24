import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupSessionTest,
  readLastSocketOptions,
  resetSessionTestMocks,
} from "./session-test-helpers.js";
import { baileys } from "./test-helpers.js";

const OPENCLAW_WHATSAPP_WEB_SOCKET_URL_ENV = "OPENCLAW_WHATSAPP_WEB_SOCKET_URL";
let session!: typeof import("./session.js");

describe("web session socket options", () => {
  beforeAll(async () => {
    session = await import("./session.js");
  });

  beforeEach(() => {
    resetSessionTestMocks();
  });

  afterEach(async () => {
    await cleanupSessionTest(session.waitForCredsSaveQueue);
  });

  it("passes explicit Baileys socket timing overrides", async () => {
    await session.createWaSocket(false, false, {
      keepAliveIntervalMs: 10_000,
      connectTimeoutMs: 90_000,
      defaultQueryTimeoutMs: 120_000,
      qrTimeoutMs: 300_000,
      browser: ["openclaw", "Chrome", "test"],
    });

    const passed = readLastSocketOptions();
    expect(passed.keepAliveIntervalMs).toBe(10_000);
    expect(passed.connectTimeoutMs).toBe(90_000);
    expect(passed.defaultQueryTimeoutMs).toBe(120_000);
    expect(passed.qrTimeout).toBe(300_000);
    expect(passed.browser).toEqual(["openclaw", "Chrome", "test"]);
  });

  it("passes explicit Baileys WebSocket URL overrides", async () => {
    await session.createWaSocket(false, false, {
      waWebSocketUrl: " ws://127.0.0.1:49152/ws/chat ",
    });

    expect(readLastSocketOptions().waWebSocketUrl).toBe("ws://127.0.0.1:49152/ws/chat");
  });

  it("uses OPENCLAW_WHATSAPP_WEB_SOCKET_URL as the default Baileys WebSocket URL", async () => {
    vi.stubEnv(OPENCLAW_WHATSAPP_WEB_SOCKET_URL_ENV, " ws://127.0.0.1:49153/ws/chat ");

    await session.createWaSocket(false, false);

    expect(readLastSocketOptions().waWebSocketUrl).toBe("ws://127.0.0.1:49153/ws/chat");
  });

  it("ignores blank Baileys WebSocket URL environment overrides", async () => {
    vi.stubEnv(OPENCLAW_WHATSAPP_WEB_SOCKET_URL_ENV, " ");

    await session.createWaSocket(false, false);

    expect(readLastSocketOptions().waWebSocketUrl).toBeUndefined();
  });

  it("rejects invalid OPENCLAW_WHATSAPP_WEB_SOCKET_URL values", async () => {
    vi.stubEnv(OPENCLAW_WHATSAPP_WEB_SOCKET_URL_ENV, "http://127.0.0.1:14567/ws");

    await expect(session.createWaSocket(false, false)).rejects.toThrow(
      "OPENCLAW_WHATSAPP_WEB_SOCKET_URL must use ws:// or wss://.",
    );
    expect(baileys.makeWASocket).not.toHaveBeenCalled();
  });

  it("preserves explicit Baileys WebSocket URL options over invalid environment", async () => {
    vi.stubEnv(OPENCLAW_WHATSAPP_WEB_SOCKET_URL_ENV, "http://127.0.0.1:49153/ws/chat");

    await session.createWaSocket(false, false, {
      waWebSocketUrl: "ws://127.0.0.1:49154/ws/chat",
    });

    expect(readLastSocketOptions().waWebSocketUrl).toBe("ws://127.0.0.1:49154/ws/chat");
  });
});
