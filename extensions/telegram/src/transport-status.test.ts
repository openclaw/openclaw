import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/channel-contract";
import { expect, it, vi } from "vitest";
import { createTelegramStatusPublisher } from "./transport-status.js";

it.each(["polling", "webhook"] as const)(
  "%s keeps one disconnect episode across retries until ready or a new start",
  (mode) => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    let snapshot: Omit<ChannelAccountSnapshot, "accountId"> = {};
    const status = createTelegramStatusPublisher(mode, (patch) => {
      snapshot = { ...snapshot, ...patch };
    });
    try {
      status.noteStart();
      status.noteReady();
      status.noteError("connection lost", "recovering");
      const firstDisconnect = snapshot.lastDisconnect;
      expect(snapshot).toMatchObject({
        mode,
        connected: false,
        lifecycle: "recovering",
        lastDisconnect: { at: 1_000, error: "connection lost" },
        lastError: "connection lost",
      });
      now.mockReturnValue(91_000);
      status.noteActivity();
      status.noteRecovery();
      expect(snapshot.lastDisconnect).toEqual(firstDisconnect);
      expect(snapshot.lastError).toBe("connection lost");
      status.noteError("setup failed", "recovering");
      expect(snapshot.lastDisconnect).toEqual({ at: 1_000, error: "setup failed" });
      expect(firstDisconnect).toEqual({ at: 1_000, error: "connection lost" });

      status.noteError("unauthorized", "blocked");
      expect(snapshot).toMatchObject({ lifecycle: "blocked", terminalDisconnect: true });
      status.noteReady();
      expect(snapshot).toMatchObject({ connected: true, lifecycle: "ready", lastError: null });
      expect(snapshot.terminalDisconnect).toBeUndefined();
      now.mockReturnValue(92_000);
      status.noteRecovery();
      expect(snapshot).toMatchObject({ connected: false, lastDisconnect: { at: 92_000 } });
      expect(snapshot.lastDisconnect).toEqual({ at: 92_000 });

      now.mockReturnValue(93_000);
      status.noteStart();
      status.noteRecovery();
      expect(snapshot.lastDisconnect).toEqual({ at: 93_000 });
      status.noteStop();
      expect(snapshot.connected).toBe(false);
    } finally {
      now.mockRestore();
    }
  },
);
