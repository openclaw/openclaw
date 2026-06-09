// Hub-delegated lifecycle helpers keep store scans and close ordering consistent.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readSessionStoreForTest,
  writeSessionStoreForTest,
} from "../config/sessions/test-helpers.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import {
  clearHubDelegatedSessionMarker,
  closeHubDelegatedAcpWorker,
  listHubDelegatedMaintenanceCandidates,
  listOwnedHubDelegatedSessionEntries,
  resolveExpiredHubDelegatedCandidates,
} from "./hub-delegated-lifecycle.js";

const runtimeConfigState = vi.hoisted(() => ({
  cfg: {} as {
    session?: { store?: string };
    acp?: { allowedAgents?: string[]; delegate?: { idleHours?: number; maxAgeHours?: number } };
  },
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => runtimeConfigState.cfg,
}));

afterEach(() => {
  runtimeConfigState.cfg = {};
});

describe("hub-delegated lifecycle", () => {
  it("lists hub-delegated rows from JSON stores even when sqlite metadata is missing", async () => {
    await withTempDir({ prefix: "openclaw-hub-delegate-life-" }, async (home) => {
      const storePath = path.join(home, "agents/codex/sessions/sessions.json");
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      const sessionKey = "agent:codex:acp:store-only-delegate";
      const entry: SessionEntry = {
        sessionId: "sess-store-only",
        updatedAt: Date.now(),
        label: "refactor",
        hubDelegated: {
          ownerSessionKey: "agent:main:main",
          createdAt: Date.now(),
        },
      };
      writeSessionStoreForTest(storePath, { [sessionKey]: entry });
      runtimeConfigState.cfg = {
        session: { store: storePath },
        acp: { allowedAgents: ["codex"] },
      };

      const entries = await listHubDelegatedMaintenanceCandidates({});
      expect(entries).toHaveLength(1);
      expect(entries[0]?.sessionKey).toBe(sessionKey);
      expect(entries[0]?.acp).toBeUndefined();
    });
  });

  it("clears hubDelegated before closing runtime", async () => {
    await withTempDir({ prefix: "openclaw-hub-delegate-life-" }, async (home) => {
      const storePath = path.join(home, "agents/codex/sessions/sessions.json");
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      const sessionKey = "agent:codex:acp:close-order";
      const entry: SessionEntry = {
        sessionId: "sess-close-order",
        updatedAt: Date.now(),
        hubDelegated: {
          ownerSessionKey: "agent:main:main",
          createdAt: Date.now(),
        },
      };
      writeSessionStoreForTest(storePath, { [sessionKey]: entry });
      const events: string[] = [];
      await closeHubDelegatedAcpWorker({
        cfg: { session: { store: storePath } },
        sessionKey,
        storePath,
        storeSessionKey: sessionKey,
        reason: "manual-delegate-close",
        closeRuntime: async () => {
          events.push("close");
          const persisted = readSessionStoreForTest(storePath);
          expect(persisted[sessionKey]?.hubDelegated).toBeUndefined();
        },
        unbind: async () => {
          events.push("unbind");
        },
      });
      expect(events).toEqual(["close", "unbind"]);
    });
  });

  it("repairs runtime metadata before clearing the delegate marker", async () => {
    await withTempDir({ prefix: "openclaw-hub-delegate-life-" }, async (home) => {
      const storePath = path.join(home, "sessions.json");
      const sessionKey = "agent:codex:acp:repair-before-close";
      writeSessionStoreForTest(storePath, {
        [sessionKey]: {
          sessionId: "sess-repair-before-close",
          updatedAt: Date.now(),
          hubDelegated: { ownerSessionKey: "agent:main:main", createdAt: Date.now() },
        },
      });
      const events: string[] = [];

      await closeHubDelegatedAcpWorker({
        cfg: { session: { store: storePath } },
        sessionKey,
        storePath,
        storeSessionKey: sessionKey,
        reason: "manual-delegate-close",
        prepareRuntime: async () => {
          events.push("prepare");
          const persisted = readSessionStoreForTest(storePath);
          expect(persisted[sessionKey]?.hubDelegated).toBeDefined();
        },
        closeRuntime: async () => {
          events.push("close");
        },
      });

      expect(events).toEqual(["prepare", "close"]);
    });
  });

  it("restores hubDelegated when runtime close fails", async () => {
    await withTempDir({ prefix: "openclaw-hub-delegate-life-" }, async (home) => {
      const storePath = path.join(home, "agents/codex/sessions/sessions.json");
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      const sessionKey = "agent:codex:acp:close-restore";
      const marker = {
        ownerSessionKey: "agent:main:main",
        createdAt: Date.now(),
      };
      const entry: SessionEntry = {
        sessionId: "sess-close-restore",
        updatedAt: Date.now(),
        hubDelegated: marker,
      };
      writeSessionStoreForTest(storePath, { [sessionKey]: entry });

      await expect(
        closeHubDelegatedAcpWorker({
          cfg: { session: { store: storePath } },
          sessionKey,
          storePath,
          storeSessionKey: sessionKey,
          reason: "manual-delegate-close",
          closeRuntime: async () => {
            throw new Error("close failed");
          },
        }),
      ).rejects.toThrow("close failed");

      const persisted = readSessionStoreForTest(storePath);
      expect(persisted[sessionKey]?.hubDelegated).toEqual(marker);
    });
  });

  it("lists hub-delegated rows from discovered stores for unconfigured harness agents", async () => {
    await withStateDirEnv("openclaw-hub-delegate-life-", async ({ stateDir }) => {
      const storePath = path.join(stateDir, "agents/retired-harness/sessions/sessions.json");
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      const sessionKey = "agent:retired-harness:acp:orphan-delegate";
      const entry: SessionEntry = {
        sessionId: "sess-orphan-delegate",
        updatedAt: Date.now(),
        label: "orphan",
        hubDelegated: {
          ownerSessionKey: "agent:main:main",
          createdAt: Date.now(),
        },
      };
      writeSessionStoreForTest(storePath, { [sessionKey]: entry });
      runtimeConfigState.cfg = {};

      const entries = await listHubDelegatedMaintenanceCandidates({});
      expect(entries.some((candidate) => candidate.sessionKey === sessionKey)).toBe(true);
    });
  });

  it("listOwnedHubDelegatedSessionEntries returns only requester-owned rows", async () => {
    await withStateDirEnv("openclaw-hub-delegate-life-", async ({ stateDir }) => {
      const storePath = path.join(stateDir, "agents/codex/sessions/sessions.json");
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      const ownedKey = "agent:codex:acp:owned-delegate";
      const foreignKey = "agent:codex:acp:foreign-delegate";
      writeSessionStoreForTest(storePath, {
        [ownedKey]: {
          sessionId: "sess-owned",
          updatedAt: Date.now(),
          label: "owned",
          hubDelegated: {
            ownerSessionKey: "agent:main:webchat:main",
            createdAt: Date.now(),
          },
        },
        [foreignKey]: {
          sessionId: "sess-foreign",
          updatedAt: Date.now(),
          label: "foreign",
          hubDelegated: {
            ownerSessionKey: "agent:main:discord:other",
            createdAt: Date.now(),
          },
        },
      });
      runtimeConfigState.cfg = {};

      const entries = await listOwnedHubDelegatedSessionEntries({
        requesterSessionKey: "agent:main:webchat:main",
      });
      expect(entries.map((entry) => entry.sessionKey)).toEqual([ownedKey]);
      expect(entries[0]?.acp).toBeUndefined();
    });
  });

  it("resolveExpiredHubDelegatedCandidates includes store-only expired delegates", async () => {
    const createdAt = Date.now() - 8 * 24 * 60 * 60 * 1000;
    const expired = resolveExpiredHubDelegatedCandidates({
      cfg: {
        acp: { delegate: { idleHours: 72, maxAgeHours: 168 } },
      },
      entries: [
        {
          cfg: {},
          storePath: "/tmp/store.json",
          sessionKey: "agent:codex:acp:expired",
          storeSessionKey: "agent:codex:acp:expired",
          entry: {
            sessionId: "sess-expired",
            updatedAt: createdAt,
            hubDelegated: {
              ownerSessionKey: "agent:main:main",
              createdAt,
            },
          },
          acp: undefined,
        },
      ],
    });
    expect(expired).toHaveLength(1);
  });

  it("clearHubDelegatedSessionMarker removes hubDelegated from the store row", async () => {
    await withTempDir({ prefix: "openclaw-hub-delegate-life-" }, async (home) => {
      const storePath = path.join(home, "sessions.json");
      const sessionKey = "agent:codex:acp:marker";
      writeSessionStoreForTest(storePath, {
        [sessionKey]: {
          sessionId: "sess-marker",
          updatedAt: Date.now(),
          hubDelegated: {
            ownerSessionKey: "agent:main:main",
            createdAt: Date.now(),
          },
        },
      });
      await clearHubDelegatedSessionMarker({ storePath, storeSessionKey: sessionKey });
      const persisted = readSessionStoreForTest(storePath);
      expect(persisted[sessionKey]?.hubDelegated).toBeUndefined();
    });
  });
});
