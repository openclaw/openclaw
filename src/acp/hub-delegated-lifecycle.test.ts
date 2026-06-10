// Hub-delegated lifecycle: close ordering, rollback, lock, and maintenance scan.
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  delegateSessionKey,
  HUB_OWNER_A,
  hubDelegatedEntry,
} from "../../test/helpers/hub-delegated-fixtures.js";
import {
  readSessionStoreForTest,
  writeSessionStoreForTest,
} from "../config/sessions/test-helpers.js";
import { withHubDelegatedLabelPatchLock } from "../gateway/sessions-patch.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { closeHubDelegatedAcpWorker } from "./hub-delegated-lifecycle.js";

function setupDelegate(home: string, suffix: string) {
  const storePath = path.join(home, "sessions.json");
  const sessionKey = delegateSessionKey("codex", suffix);
  const createdAt = Date.now();
  writeSessionStoreForTest(storePath, {
    [sessionKey]: hubDelegatedEntry({
      sessionId: `sess-${suffix}`,
      label: "refactor",
      createdAt,
      updatedAt: createdAt,
    }),
  });
  return { storePath, sessionKey, marker: { ownerSessionKey: HUB_OWNER_A, createdAt } };
}

function closeDelegate(
  fixture: ReturnType<typeof setupDelegate>,
  closeRuntime: () => Promise<void>,
  unbind?: () => Promise<void>,
) {
  return closeHubDelegatedAcpWorker({
    cfg: { session: { store: fixture.storePath } },
    sessionKey: fixture.sessionKey,
    storePath: fixture.storePath,
    storeSessionKey: fixture.sessionKey,
    reason: "manual-delegate-close",
    closeRuntime,
    unbind,
  });
}

describe("hub-delegated lifecycle", () => {
  it("clears routing fields before runtime close and restores them on failure", async () => {
    await withTempDir({ prefix: "openclaw-hub-delegate-life-" }, async (home) => {
      const fixture = setupDelegate(home, "close-order");

      const successEvents: string[] = [];
      await closeDelegate(
        fixture,
        async () => {
          successEvents.push("close");
          const persisted = readSessionStoreForTest(fixture.storePath)[fixture.sessionKey];
          expect(persisted?.hubDelegated).toBeUndefined();
          expect(persisted?.label).toBeUndefined();
        },
        async () => {
          successEvents.push("unbind");
        },
      );
      expect(successEvents).toEqual(["close", "unbind"]);

      const restore = setupDelegate(home, "close-restore");
      await expect(
        closeDelegate(restore, async () => {
          throw new Error("close failed");
        }),
      ).rejects.toThrow("close failed");

      const restored = readSessionStoreForTest(restore.storePath)[restore.sessionKey];
      expect(restored?.hubDelegated).toEqual(restore.marker);
      expect(restored?.label).toBe("refactor");
    });
  });

  it("holds the hub-delegated label lock while clearing and restoring on close failure", async () => {
    await withTempDir({ prefix: "openclaw-hub-delegate-life-" }, async (home) => {
      const fixture = setupDelegate(home, "close-lock");

      let unblockClose!: () => void;
      const closeBlocked = new Promise<void>((resolve) => {
        unblockClose = resolve;
      });
      let closeRuntimeEntered!: () => void;
      const closeRuntimeEnteredPromise = new Promise<void>((resolve) => {
        closeRuntimeEntered = resolve;
      });
      let concurrentFinished = false;

      const closePromise = closeDelegate(fixture, async () => {
        closeRuntimeEntered();
        await closeBlocked;
        throw new Error("close failed");
      });
      await closeRuntimeEnteredPromise;
      const concurrent = withHubDelegatedLabelPatchLock(async () => {
        concurrentFinished = true;
      });
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 10);
      });
      expect(concurrentFinished).toBe(false);
      unblockClose();
      await expect(closePromise).rejects.toThrow("close failed");
      await concurrent;
      expect(concurrentFinished).toBe(true);
    });
  });
});
