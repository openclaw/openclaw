import path from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import type { SessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.types.js";
import { SessionTranscriptStorageUnavailableError } from "../../config/sessions/session-transcript-projection-error.js";
import type { PreparedSessionTranscriptHydration } from "../../config/sessions/session-transcript-worker.types.js";
import {
  SessionTranscriptWriterClaimReboundError,
  withOwnedSessionTranscriptWrites,
} from "../../config/sessions/transcript-write-context.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { SessionManager } from "./session-manager.js";

const observed = vi.hoisted(() => ({
  read: vi.fn<() => Promise<PreparedSessionTranscriptHydration>>(),
}));
vi.mock("../../config/sessions/session-transcript-hydration.js", () => ({
  prepareSessionTranscriptHydration: (target: SessionTranscriptRuntimeTarget) => ({
    target,
    read: observed.read,
    assertCurrent: () => {},
  }),
}));
beforeEach(() => observed.read.mockReset());

it.each([
  { method: "full", revoke: false },
  { method: "full", revoke: true },
  { method: "bounded", revoke: false },
  { method: "bounded", revoke: true },
  { method: "retarget", revoke: false },
  { method: "retarget", revoke: true },
  { method: "reload", revoke: false },
  { method: "reload", revoke: true },
])(
  "keeps $method read failure bound to its write owner (revoke=$revoke)",
  async ({ method, revoke }) => {
    const target = {
      agentId: "main",
      sessionId: "hydration-owner",
      sessionKey: "agent:main:hydration-owner",
      storePath: path.resolve("synthetic-hydration-owner.sqlite"),
    };
    observed.read.mockResolvedValueOnce({
      kind: "full",
      snapshot: { events: [], version: { generation: null, rawSeq: null, updatedAt: null } },
    });
    const manager = await SessionManager.openAsync(target);
    const originalTarget = manager.getSessionTarget();
    const entered = createDeferredCore();
    const read = createDeferredCore<PreparedSessionTranscriptHydration>();
    observed.read.mockImplementationOnce(() => {
      entered.resolve();
      return read.promise;
    });
    const missing = new SessionTranscriptStorageUnavailableError("database-missing");
    const revoked = new SessionTranscriptWriterClaimReboundError();
    let current = true;
    const pending = withOwnedSessionTranscriptWrites(
      {
        sessionTarget: target,
        assertCommitAllowed: () => {
          if (!current) {
            throw revoked;
          }
        },
        withTranscriptWrite: async (run) => await run(),
      },
      async () => {
        if (method === "full") {
          await SessionManager.openAsync(target);
        } else if (method === "bounded") {
          await SessionManager.openBoundedAsync(target, { maxBytes: 4096, maxEvents: 5 });
        } else if (method === "retarget") {
          await manager.setSessionTargetAsync(target);
        } else {
          await manager.reloadPersistedTranscriptAsync();
        }
      },
    );
    const result = pending.catch((error: unknown) => error);
    try {
      await entered.promise;
      current = !revoke;
      read.reject(missing);
      expect(await result).toBe(revoke ? revoked : missing);
      expect(manager.getSessionTarget()).toEqual(originalTarget);
    } finally {
      read.reject(missing);
      await Promise.allSettled([pending, result]);
    }
  },
);
