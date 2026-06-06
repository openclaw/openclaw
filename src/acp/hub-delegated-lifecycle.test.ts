// Hub-delegated lifecycle helpers keep store scans and close ordering consistent.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions/types.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import {
  clearHubDelegatedSessionMarker,
  closeHubDelegatedAcpWorker,
  listHubDelegatedMaintenanceCandidates,
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
      fs.writeFileSync(storePath, JSON.stringify({ [sessionKey]: entry }));
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
      fs.writeFileSync(storePath, JSON.stringify({ [sessionKey]: entry }));
      const events: string[] = [];
      await closeHubDelegatedAcpWorker({
        cfg: { session: { store: storePath } },
        sessionKey,
        storePath,
        storeSessionKey: sessionKey,
        reason: "manual-delegate-close",
        closeRuntime: async () => {
          events.push("close");
          const persisted = JSON.parse(fs.readFileSync(storePath, "utf8")) as Record<
            string,
            SessionEntry
          >;
          expect(persisted[sessionKey]?.hubDelegated).toBeUndefined();
        },
        unbind: async () => {
          events.push("unbind");
        },
      });
      expect(events).toEqual(["close", "unbind"]);
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
      fs.writeFileSync(
        storePath,
        JSON.stringify({
          [sessionKey]: {
            sessionId: "sess-marker",
            updatedAt: Date.now(),
            hubDelegated: {
              ownerSessionKey: "agent:main:main",
              createdAt: Date.now(),
            },
          },
        }),
      );
      await clearHubDelegatedSessionMarker({ storePath, storeSessionKey: sessionKey });
      const persisted = JSON.parse(fs.readFileSync(storePath, "utf8")) as Record<
        string,
        SessionEntry
      >;
      expect(persisted[sessionKey]?.hubDelegated).toBeUndefined();
    });
  });
});
