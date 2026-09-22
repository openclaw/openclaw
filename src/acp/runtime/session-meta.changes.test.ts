import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { readAcpSessionMeta, upsertAcpSessionMeta } from "./session-meta.js";

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

it("persists bare global metadata under a configured fixed-store owner", async () => {
  await withTestDir({ prefix: "openclaw-acp-global-owner-" }, async (dir) => {
    const storePath = path.join(dir, "sessions.json");
    const cfg = {
      session: { scope: "global", store: storePath },
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "ops" } },
        entries: { ops: {}, research: {} },
      },
    } satisfies OpenClawConfig;
    const databasePath = path.join(dir, "state", "openclaw.sqlite");
    await replaceSessionEntry(
      {
        agentId: "ops",
        storePath,
        sessionKey: "global",
      },
      { sessionId: "ops-global", updatedAt: 100, sessionStartedAt: 100 },
    );
    const mutate = () => ({
      backend: "acpx",
      agent: "codex",
      runtimeSessionName: "global",
      mode: "persistent" as const,
      state: "idle" as const,
      lastActivityAt: 123,
    });

    const observed: Array<string | undefined> = [];
    const unsubscribe = sessionChanges.subscribe((change) => {
      if ("sessionKey" in change && change.sessionKey === "global" && change.agentId === "ops") {
        observed.push(
          readAcpSessionMeta({ cfg, databasePath, sessionKey: "global" })?.runtimeSessionName,
        );
      }
    });
    try {
      const persisted = await upsertAcpSessionMeta({
        cfg,
        databasePath,
        sessionKey: "global",
        mutate,
      });

      expect(persisted?.acp?.runtimeSessionName).toBe("global");
      expect(
        readAcpSessionMeta({
          cfg,
          databasePath,
          sessionKey: "global",
        })?.runtimeSessionName,
      ).toBe("global");
      const conflictingMutate = vi.fn(mutate);
      await expect(
        upsertAcpSessionMeta({
          cfg,
          databasePath,
          sessionKey: "global",
          agentId: "research",
          mutate: conflictingMutate,
        }),
      ).rejects.toMatchObject({ code: "AGENT_SELECTION_REQUIRED" });
      expect(conflictingMutate).not.toHaveBeenCalled();
      const ownerlessCfg = {
        ...cfg,
        agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
      } satisfies OpenClawConfig;
      const ownerlessMutate = vi.fn(mutate);
      await expect(
        upsertAcpSessionMeta({
          cfg: ownerlessCfg,
          databasePath,
          sessionKey: "ownerless-global",
          mutate: ownerlessMutate,
        }),
      ).rejects.toMatchObject({ code: "AGENT_SELECTION_REQUIRED" });
      expect(ownerlessMutate).not.toHaveBeenCalled();
      expect(observed.at(-1)).toBe("global");
      const beforeDelete = observed.length;
      await upsertAcpSessionMeta({ cfg, databasePath, sessionKey: "global", mutate: () => null });
      expect(observed.length).toBeGreaterThan(beforeDelete);
      expect(observed.at(-1)).toBeUndefined();
    } finally {
      unsubscribe();
    }
  });
});
