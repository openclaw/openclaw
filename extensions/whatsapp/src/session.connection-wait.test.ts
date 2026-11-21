import { EventEmitter } from "node:events";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupSessionTest, resetSessionTestMocks } from "./session-test-helpers.js";
import { baileys } from "./test-helpers.js";

let session!: typeof import("./session.js");

describe("web session connection wait", () => {
  beforeAll(async () => {
    session = await import("./session.js");
  });

  beforeEach(() => {
    resetSessionTestMocks();
  });

  afterEach(async () => {
    await cleanupSessionTest(session.waitForCredsSaveQueue);
  });

  it("keeps one-argument callers on the old no-timeout wait policy", async () => {
    const ev = new EventEmitter();
    const promise = session.waitForWaConnection({ ev } as unknown as ReturnType<
      typeof baileys.makeWASocket
    >);
    ev.emit("connection.update", { connection: "open" });
    await expect(promise).resolves.toBeUndefined();
  });

  it("rejects when connection closes", async () => {
    const ev = new EventEmitter();
    const promise = session.waitForWaConnection(
      { ev } as unknown as ReturnType<typeof baileys.makeWASocket>,
      { timeout: "none" },
    );
    ev.emit("connection.update", {
      connection: "close",
      lastDisconnect: new Error("bye"),
    });
    await expect(promise).rejects.toBeInstanceOf(Error);
  });

  it("preserves the underlying Baileys disconnect error", async () => {
    const ev = new EventEmitter();
    const promise = session.waitForWaConnection(
      { ev } as unknown as ReturnType<typeof baileys.makeWASocket>,
      { timeout: "none" },
    );
    const disconnectError = Object.assign(new Error("logged out"), {
      output: { statusCode: 401 },
    });
    ev.emit("connection.update", {
      connection: "close",
      lastDisconnect: { date: new Date(), error: disconnectError },
    });
    const error = await promise.catch((caught: unknown) => caught);
    expect(error).toBe(disconnectError);
    expect(error).toMatchObject({ message: "logged out", output: { statusCode: 401 } });
  });

  it("rejects after timeout with no connection event", async () => {
    vi.useFakeTimers();
    const ev = new EventEmitter();
    const promise = session.waitForWaConnection(
      { ev } as unknown as ReturnType<typeof baileys.makeWASocket>,
      { timeoutMs: 100 },
    );
    vi.advanceTimersByTime(100);
    const error = await promise.catch((err: unknown) => err);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("timed out after 100ms");
    expect(error).toMatchObject({ output: { statusCode: 408 } });
    expect(ev.listenerCount("connection.update")).toBe(0);
    vi.useRealTimers();
  });

  it("clears timeout when connection opens before timeout", async () => {
    vi.useFakeTimers();
    const ev = new EventEmitter();
    const promise = session.waitForWaConnection(
      { ev } as unknown as ReturnType<typeof baileys.makeWASocket>,
      { timeoutMs: 5000 },
    );
    ev.emit("connection.update", { connection: "open" });
    await expect(promise).resolves.toBeUndefined();
    expect(ev.listenerCount("connection.update")).toBe(0);
    vi.useRealTimers();
  });
});
