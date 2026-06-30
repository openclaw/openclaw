import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { clearSessionStoreCaches } from "../../config/sessions/store-cache.js";
import { withSessionStoreWriterForTest } from "../../config/sessions/store-writer.js";
import { loadSessionStore } from "../../config/sessions/store.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveSessionWithReservation } from "./session-resolution-reservation.js";
import { resolveSession } from "./session.js";

/** Flush queued micro/macro tasks so an in-flight reservation reaches its persist. */
async function flushPendingWork(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

async function withTempStore<T>(
  run: (params: { cfg: OpenClawConfig; storePath: string }) => Promise<T>,
): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-reservation-"));
  const storePath = path.join(dir, "sessions.json");
  const cfg = { session: { store: storePath, mainKey: "main" } } as OpenClawConfig;
  try {
    return await run({ cfg, storePath });
  } finally {
    clearSessionStoreCaches();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

afterEach(() => {
  clearSessionStoreCaches();
});

describe("resolveSessionWithReservation", () => {
  const sessionKey = "agent:main:finn:c1";

  it("forks distinct sessionIds without the reservation lock (regression repro)", async () => {
    await withTempStore(async ({ cfg }) => {
      const first = resolveSession({ cfg, sessionKey });
      const second = resolveSession({ cfg, sessionKey });
      expect(first.isNewSession).toBe(true);
      expect(second.isNewSession).toBe(true);
      // Without serialization both requests mint their own id, so the second
      // request runs in an isolated, memory-less session.
      expect(first.sessionId).not.toBe(second.sessionId);
    });
  });

  it("gives concurrent same-key requests one shared sessionId", async () => {
    await withTempStore(async ({ cfg, storePath }) => {
      const [first, second] = await Promise.all([
        resolveSessionWithReservation({ cfg, sessionKey }),
        resolveSessionWithReservation({ cfg, sessionKey }),
      ]);
      expect(first.sessionId).toBe(second.sessionId);
      // Exactly one resolution created the session; the other adopted it.
      expect([first.isNewSession, second.isNewSession].filter(Boolean)).toHaveLength(1);
      // The reserved mapping is persisted so later turns resume the same session.
      const persisted = loadSessionStore(storePath, { skipCache: true })[sessionKey];
      expect(persisted?.sessionId).toBe(first.sessionId);
    });
  });

  it("reuses the reserved id for a follow-up after the first request", async () => {
    await withTempStore(async ({ cfg }) => {
      const first = await resolveSessionWithReservation({ cfg, sessionKey });
      const second = await resolveSessionWithReservation({ cfg, sessionKey });
      expect(second.sessionId).toBe(first.sessionId);
      expect(second.isNewSession).toBe(false);
    });
  });

  it("leaves the explicit sessionId path unchanged", async () => {
    await withTempStore(async ({ cfg }) => {
      const resolution = await resolveSessionWithReservation({
        cfg,
        sessionId: "explicit-123",
      });
      expect(resolution.sessionId).toBe("explicit-123");
    });
  });

  it("does not write a visible store row for internal handoffs (suppressVisibleSessionEffects)", async () => {
    await withTempStore(async ({ cfg, storePath }) => {
      const resolution = await resolveSessionWithReservation({
        cfg,
        sessionKey,
        suppressVisibleSessionEffects: true,
      });
      expect(resolution.isNewSession).toBe(true);
      expect(resolution.sessionId).toBeTruthy();
      // Internal handoffs must not leak a visible session-store row.
      const persisted = loadSessionStore(storePath, { skipCache: true })[sessionKey];
      expect(persisted).toBeUndefined();
    });
  });

  it("adopts a concurrent rebind instead of reverting it to the reserved id", async () => {
    await withTempStore(async ({ cfg, storePath }) => {
      const now = Date.now();
      let releaseHold: () => void = () => {};
      const held = new Promise<void>((resolve) => {
        releaseHold = resolve;
      });
      let signalHeld: () => void = () => {};
      const queueHeld = new Promise<void>((resolve) => {
        signalHeld = resolve;
      });

      // Hold the per-store writer queue so the competing rebind and the
      // reservation's persist run under the lock in a deterministic order.
      const holder = withSessionStoreWriterForTest(storePath, async () => {
        signalHeld();
        await held;
      });
      await queueHeld;

      // A non-reservation writer (models /reset or another endpoint) claims the
      // key with a different sessionId; it is queued ahead of the reservation
      // persist while the reservation still observes an empty key.
      const rebind = replaceSessionEntry(
        { sessionKey, storePath },
        { sessionId: "rebind-id", updatedAt: now, sessionStartedAt: now },
      );

      // The reservation mints its own id and its persist queues behind the
      // rebind, so the rebind wins the store write lock first.
      const reservation = resolveSessionWithReservation({ cfg, sessionKey });
      await flushPendingWork();

      releaseHold();
      const [, resolution] = await Promise.all([rebind, reservation, holder]);

      // The reservation must not stamp its stale minted id back over the newer
      // rebind; it adopts the winning identity instead.
      expect(resolution.sessionId).toBe("rebind-id");
      const persisted = loadSessionStore(storePath, { skipCache: true })[sessionKey];
      expect(persisted?.sessionId).toBe("rebind-id");
    });
  });
});
