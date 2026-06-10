// Hub-delegated lifecycle: close ordering, rollback, lock, and maintenance scan.
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  delegateSessionKey,
  HUB_OWNER_A,
  hubDelegatedEntry,
  writeDelegateStore,
} from "../../test/helpers/hub-delegated-fixtures.js";
import { readSessionStoreForTest } from "../config/sessions/test-helpers.js";
import { withHubDelegatedLabelPatchLock } from "../gateway/sessions-patch.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { closeHubDelegatedAcpWorker } from "./hub-delegated-lifecycle.js";

describe("hub-delegated lifecycle", () => {
  it("clears routing fields before runtime close and restores them on failure", async () => {
    await withTempDir({ prefix: "openclaw-hub-delegate-life-" }, async (home) => {
      const storePath = path.join(home, "sessions.json");
      const sessionKey = delegateSessionKey("codex", "close-order");
      const marker = { ownerSessionKey: HUB_OWNER_A, createdAt: Date.now() };
      writeDelegateStore(
        storePath,
        sessionKey,
        hubDelegatedEntry({
          sessionId: "sess-close-order",
          ownerSessionKey: HUB_OWNER_A,
          label: "refactor",
          createdAt: marker.createdAt,
          updatedAt: marker.createdAt,
        }),
      );

      const successEvents: string[] = [];
      await closeHubDelegatedAcpWorker({
        cfg: { session: { store: storePath } },
        sessionKey,
        storePath,
        storeSessionKey: sessionKey,
        reason: "manual-delegate-close",
        closeRuntime: async () => {
          successEvents.push("close");
          const persisted = readSessionStoreForTest(storePath);
          expect(persisted[sessionKey]?.hubDelegated).toBeUndefined();
          expect(persisted[sessionKey]?.label).toBeUndefined();
        },
        unbind: async () => {
          successEvents.push("unbind");
        },
      });
      expect(successEvents).toEqual(["close", "unbind"]);

      const restoreKey = delegateSessionKey("codex", "close-restore");
      writeDelegateStore(
        storePath,
        restoreKey,
        hubDelegatedEntry({
          sessionId: "sess-close-restore",
          ownerSessionKey: HUB_OWNER_A,
          label: "refactor",
          createdAt: marker.createdAt,
          updatedAt: marker.createdAt,
        }),
      );
      await expect(
        closeHubDelegatedAcpWorker({
          cfg: { session: { store: storePath } },
          sessionKey: restoreKey,
          storePath,
          storeSessionKey: restoreKey,
          reason: "manual-delegate-close",
          closeRuntime: async () => {
            throw new Error("close failed");
          },
        }),
      ).rejects.toThrow("close failed");

      const restored = readSessionStoreForTest(storePath)[restoreKey];
      expect(restored?.hubDelegated).toEqual(marker);
      expect(restored?.label).toBe("refactor");
    });
  });

  it("holds the hub-delegated label lock while clearing and restoring on close failure", async () => {
    await withTempDir({ prefix: "openclaw-hub-delegate-life-" }, async (home) => {
      const storePath = path.join(home, "sessions.json");
      const sessionKey = delegateSessionKey("codex", "close-lock");
      const marker = { ownerSessionKey: HUB_OWNER_A, createdAt: Date.now() };
      writeDelegateStore(
        storePath,
        sessionKey,
        hubDelegatedEntry({
          sessionId: "sess-close-lock",
          ownerSessionKey: HUB_OWNER_A,
          label: "refactor",
          createdAt: marker.createdAt,
          updatedAt: marker.createdAt,
        }),
      );

      let unblockClose!: () => void;
      const closeBlocked = new Promise<void>((resolve) => {
        unblockClose = resolve;
      });
      let closeRuntimeEntered!: () => void;
      const closeRuntimeEnteredPromise = new Promise<void>((resolve) => {
        closeRuntimeEntered = resolve;
      });
      let concurrentFinished = false;

      const closePromise = closeHubDelegatedAcpWorker({
        cfg: { session: { store: storePath } },
        sessionKey,
        storePath,
        storeSessionKey: sessionKey,
        reason: "manual-delegate-close",
        closeRuntime: async () => {
          closeRuntimeEntered();
          await closeBlocked;
          throw new Error("close failed");
        },
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
