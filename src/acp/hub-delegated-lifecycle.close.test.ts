// Hub-delegated close ordering, rollback, lock, and marker cleanup.
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readSessionStoreForTest } from "../config/sessions/test-helpers.js";
import { withHubDelegatedLabelPatchLock } from "../gateway/sessions-patch.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import {
  clearHubDelegatedSessionMarker,
  closeHubDelegatedAcpWorker,
} from "./hub-delegated-lifecycle.js";
import {
  HUB_OWNER_A,
  delegateSessionKey,
  hubDelegatedEntry,
  writeDelegateStore,
} from "./test-helpers/hub-delegated-lifecycle-fixtures.js";

describe("hub-delegated lifecycle close", () => {
  it("clears routing fields before runtime close and restores them on failure", async () => {
    await withTempDir({ prefix: "openclaw-hub-delegate-close-" }, async (home) => {
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
          expect(persisted[sessionKey]?.spawnedBy).toBeUndefined();
        },
        unbind: async () => {
          successEvents.push("unbind");
        },
      });
      expect(successEvents).toEqual(["close", "unbind"]);

      writeDelegateStore(
        storePath,
        delegateSessionKey("codex", "close-restore"),
        hubDelegatedEntry({
          sessionId: "sess-close-restore",
          ownerSessionKey: HUB_OWNER_A,
          label: "refactor",
          createdAt: marker.createdAt,
          updatedAt: marker.createdAt,
        }),
      );
      const restoreKey = delegateSessionKey("codex", "close-restore");
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
      expect(restored?.spawnedBy).toBe(HUB_OWNER_A);
    });
  });

  it("repairs runtime metadata before clearing the delegate marker", async () => {
    await withTempDir({ prefix: "openclaw-hub-delegate-close-" }, async (home) => {
      const storePath = path.join(home, "sessions.json");
      const sessionKey = delegateSessionKey("codex", "repair-before-close");
      writeDelegateStore(
        storePath,
        sessionKey,
        hubDelegatedEntry({
          sessionId: "sess-repair-before-close",
          ownerSessionKey: HUB_OWNER_A,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }),
      );
      const events: string[] = [];

      await closeHubDelegatedAcpWorker({
        cfg: { session: { store: storePath } },
        sessionKey,
        storePath,
        storeSessionKey: sessionKey,
        reason: "manual-delegate-close",
        prepareRuntime: async () => {
          events.push("prepare");
          expect(readSessionStoreForTest(storePath)[sessionKey]?.hubDelegated).toBeDefined();
        },
        closeRuntime: async () => {
          events.push("close");
        },
      });

      expect(events).toEqual(["prepare", "close"]);
    });
  });

  it("holds the hub-delegated label lock while clearing and restoring on close failure", async () => {
    await withTempDir({ prefix: "openclaw-hub-delegate-close-" }, async (home) => {
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
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(concurrentFinished).toBe(false);
      unblockClose();
      await expect(closePromise).rejects.toThrow("close failed");
      await concurrent;
      expect(concurrentFinished).toBe(true);

      const persisted = readSessionStoreForTest(storePath)[sessionKey];
      expect(persisted?.hubDelegated).toEqual(marker);
      expect(persisted?.label).toBe("refactor");
    });
  });

  it("clears delegate routing fields and hides closed rows from label filters", async () => {
    await withTempDir({ prefix: "openclaw-hub-delegate-close-" }, async (home) => {
      const storePath = path.join(home, "sessions.json");
      const sessionKey = delegateSessionKey("codex", "closed-delegate");
      writeDelegateStore(
        storePath,
        sessionKey,
        hubDelegatedEntry({
          sessionId: "sess-closed-delegate",
          ownerSessionKey: HUB_OWNER_A,
          label: "refactor",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }),
      );

      await clearHubDelegatedSessionMarker({ storePath, storeSessionKey: sessionKey });
      const closedStore = readSessionStoreForTest(storePath);
      expect(closedStore[sessionKey]?.hubDelegated).toBeUndefined();
      expect(closedStore[sessionKey]?.label).toBeUndefined();

      const { listSessionsFromStore } = await import("../gateway/session-utils.js");
      const ownerScoped = listSessionsFromStore({
        cfg: {},
        storePath,
        store: closedStore,
        opts: { label: "refactor", hubDelegatedOwner: HUB_OWNER_A },
      });
      const spawnedScoped = listSessionsFromStore({
        cfg: {},
        storePath,
        store: closedStore,
        opts: { label: "refactor", spawnedBy: HUB_OWNER_A },
      });
      expect(ownerScoped.sessions).toHaveLength(0);
      expect(spawnedScoped.sessions).toHaveLength(0);
    });
  });
});
