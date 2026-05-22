import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearSessionStoreCaches } from "../../config/sessions/store-cache.js";
import { loadSessionStore } from "../../config/sessions/store.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveSessionWithReservation } from "./session-resolution-reservation.js";
import { resolveSession } from "./session.js";

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
});
