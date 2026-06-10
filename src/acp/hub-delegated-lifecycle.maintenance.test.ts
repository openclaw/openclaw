// Hub-delegated maintenance scans, ownership filters, and expiry selection.
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeSessionStoreForTest } from "../config/sessions/test-helpers.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import {
  listHubDelegatedMaintenanceCandidates,
  listOwnedHubDelegatedSessionEntries,
  resolveExpiredHubDelegatedCandidates,
} from "./hub-delegated-lifecycle.js";
import {
  HUB_OWNER_A,
  delegateSessionKey,
  hubDelegatedEntry,
  writeDelegateStore,
} from "./test-helpers/hub-delegated-lifecycle-fixtures.js";

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

describe("hub-delegated lifecycle maintenance", () => {
  it("lists hub-delegated rows from configured stores without sqlite metadata", async () => {
    await withTempDir({ prefix: "openclaw-hub-delegate-maint-" }, async (home) => {
      const storePath = path.join(home, "agents/codex/sessions/sessions.json");
      const sessionKey = delegateSessionKey("codex", "store-only-delegate");
      writeDelegateStore(storePath, sessionKey, hubDelegatedEntry({ label: "refactor" }));
      runtimeConfigState.cfg = {
        session: { store: storePath },
        acp: { allowedAgents: ["codex"] },
      };

      const entries = await listHubDelegatedMaintenanceCandidates({});
      expect(entries.map((candidate) => candidate.sessionKey)).toEqual([sessionKey]);
      expect(entries[0]?.acp).toBeUndefined();
    });
  });

  it("lists hub-delegated rows from discovered stores for unconfigured harness agents", async () => {
    await withStateDirEnv("openclaw-hub-delegate-maint-", async ({ stateDir }) => {
      const storePath = path.join(stateDir, "agents/retired-harness/sessions/sessions.json");
      const sessionKey = delegateSessionKey("retired-harness", "orphan-delegate");
      writeDelegateStore(
        storePath,
        sessionKey,
        hubDelegatedEntry({ sessionId: "sess-orphan-delegate", label: "orphan" }),
      );
      runtimeConfigState.cfg = {};

      const entries = await listHubDelegatedMaintenanceCandidates({});
      expect(entries.some((candidate) => candidate.sessionKey === sessionKey)).toBe(true);
    });
  });

  it("returns only requester-owned rows", async () => {
    await withStateDirEnv("openclaw-hub-delegate-maint-", async ({ stateDir }) => {
      const storePath = path.join(stateDir, "agents/codex/sessions/sessions.json");
      const ownedKey = delegateSessionKey("codex", "owned-delegate");
      const foreignKey = delegateSessionKey("codex", "foreign-delegate");
      writeSessionStoreForTest(storePath, {
        [ownedKey]: hubDelegatedEntry({
          sessionId: "sess-owned",
          ownerSessionKey: HUB_OWNER_A,
          label: "owned",
        }),
        [foreignKey]: hubDelegatedEntry({
          sessionId: "sess-foreign",
          ownerSessionKey: "agent:main:discord:other",
          label: "foreign",
        }),
      });
      runtimeConfigState.cfg = {};

      const entries = await listOwnedHubDelegatedSessionEntries({
        requesterSessionKey: HUB_OWNER_A,
      });
      expect(entries.map((entry) => entry.sessionKey)).toEqual([ownedKey]);
    });
  });

  it.each([
    [
      "expired store-only delegate",
      Date.now() - 8 * 24 * 60 * 60 * 1000,
      Date.now() - 8 * 24 * 60 * 60 * 1000,
      { idleHours: 72, maxAgeHours: 168 },
      1,
    ],
    [
      "recent JSON activity skips idle expiry",
      Date.now() - 8 * 24 * 60 * 60 * 1000,
      Date.now() - 60 * 60 * 1000,
      { idleHours: 72, maxAgeHours: 0 },
      0,
    ],
  ] as const)(
    "selects expiry candidates for $0",
    (_label, createdAt, updatedAt, delegatePolicy, expectedCount) => {
      const sessionKey = delegateSessionKey("codex", "expiry");
      const expired = resolveExpiredHubDelegatedCandidates({
        cfg: { acp: { delegate: delegatePolicy } },
        entries: [
          {
            cfg: {},
            storePath: "/tmp/store.json",
            sessionKey,
            storeSessionKey: sessionKey,
            entry: hubDelegatedEntry({
              sessionId: "sess-expiry",
              createdAt,
              updatedAt,
            }),
            acp: undefined,
          },
        ],
      });
      expect(expired).toHaveLength(expectedCount);
    },
  );
});
