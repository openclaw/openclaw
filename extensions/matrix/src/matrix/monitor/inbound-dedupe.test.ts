import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMatrixInboundEventDeduper } from "./inbound-dedupe.js";

describe("Matrix inbound event dedupe", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    resetPluginStateStoreForTests();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function createStoragePath(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-matrix-inbound-dedupe-"));
    tempDirs.push(dir);
    return path.join(dir, "inbound-dedupe.json");
  }

  const auth = {
    accountId: "ops",
    homeserver: "https://matrix.example.org",
    userId: "@bot:example.org",
    accessToken: "token",
    deviceId: "DEVICE",
  } as const;

  it("persists committed events across restarts", async () => {
    const storagePath = createStoragePath();
    const first = await createMatrixInboundEventDeduper({
      auth: auth as never,
      storagePath,
    });

    expect(first.claimEvent({ roomId: "!room:example.org", eventId: "$event-1" })).toBe(true);
    await first.commitEvent({
      roomId: "!room:example.org",
      eventId: "$event-1",
    });
    await first.stop();

    const second = await createMatrixInboundEventDeduper({
      auth: auth as never,
      storagePath,
    });
    expect(second.claimEvent({ roomId: "!room:example.org", eventId: "$event-1" })).toBe(false);
  });

  it("does not persist released pending claims", async () => {
    const storagePath = createStoragePath();
    const first = await createMatrixInboundEventDeduper({
      auth: auth as never,
      storagePath,
    });

    expect(first.claimEvent({ roomId: "!room:example.org", eventId: "$event-2" })).toBe(true);
    first.releaseEvent({ roomId: "!room:example.org", eventId: "$event-2" });
    await first.stop();

    const second = await createMatrixInboundEventDeduper({
      auth: auth as never,
      storagePath,
    });
    expect(second.claimEvent({ roomId: "!room:example.org", eventId: "$event-2" })).toBe(true);
  });

  it("prunes expired and overflowed entries on load", async () => {
    const storagePath = createStoragePath();
    let now = 10;
    const first = await createMatrixInboundEventDeduper({
      auth: auth as never,
      storagePath,
      ttlMs: 1_000,
      maxEntries: 10,
      nowMs: () => now,
    });
    for (const eventId of ["$old", "$keep-1", "$keep-2", "$keep-3"]) {
      expect(first.claimEvent({ roomId: "!room:example.org", eventId })).toBe(true);
      await first.commitEvent({ roomId: "!room:example.org", eventId });
      now += eventId === "$old" ? 80 : 5;
    }
    await first.stop();

    const deduper = await createMatrixInboundEventDeduper({
      auth: auth as never,
      storagePath,
      ttlMs: 20,
      maxEntries: 2,
      nowMs: () => 100,
    });

    expect(deduper.claimEvent({ roomId: "!room:example.org", eventId: "$old" })).toBe(true);
    expect(deduper.claimEvent({ roomId: "!room:example.org", eventId: "$keep-1" })).toBe(true);
    expect(deduper.claimEvent({ roomId: "!room:example.org", eventId: "$keep-2" })).toBe(false);
    expect(deduper.claimEvent({ roomId: "!room:example.org", eventId: "$keep-3" })).toBe(false);
  });

  it("retains replayed backlog events based on processing time", async () => {
    const storagePath = createStoragePath();
    let now = 100;
    const first = await createMatrixInboundEventDeduper({
      auth: auth as never,
      storagePath,
      ttlMs: 20,
      nowMs: () => now,
    });

    expect(first.claimEvent({ roomId: "!room:example.org", eventId: "$backlog" })).toBe(true);
    await first.commitEvent({
      roomId: "!room:example.org",
      eventId: "$backlog",
    });
    await first.stop();

    now = 110;
    const second = await createMatrixInboundEventDeduper({
      auth: auth as never,
      storagePath,
      ttlMs: 20,
      nowMs: () => now,
    });
    expect(second.claimEvent({ roomId: "!room:example.org", eventId: "$backlog" })).toBe(false);
  });

  it("does not create the legacy JSON file", async () => {
    const storagePath = createStoragePath();
    const deduper = await createMatrixInboundEventDeduper({
      auth: auth as never,
      storagePath,
    });

    expect(deduper.claimEvent({ roomId: "!room:example.org", eventId: "$sqlite" })).toBe(true);
    await deduper.commitEvent({ roomId: "!room:example.org", eventId: "$sqlite" });
    await deduper.stop();

    expect(fs.existsSync(storagePath)).toBe(false);
  });
});
