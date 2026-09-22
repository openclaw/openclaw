/** Closed ACP metadata stays readable for provenance only, never for lifecycle readers. */
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import {
  listAcpSessionEntries,
  readAcpSessionEntry,
  readAcpSessionMeta,
  readAcpSessionMetaBatch,
  upsertAcpSessionMeta,
} from "./session-meta.js";

const ACP_AGENT_ID = "codex";

describe("ACP session metadata closed rows", () => {
  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
  });

  it("hides closed metadata from lifecycle readers unless a projection opts in", async () => {
    await withTestDir({ prefix: "openclaw-acp-meta-closed-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const databasePath = path.join(dir, "state", "openclaw.sqlite");
      const cfg = { session: { store: storePath } } as OpenClawConfig;
      const sessionKey = "agent:codex:acp:closed-session";
      await upsertAcpSessionMeta({
        cfg,
        databasePath,
        sessionKey,
        mutate: () => ({
          backend: "acpx",
          agent: "codex",
          runtimeSessionName: "codex-closed",
          mode: "persistent",
          state: "idle",
          lastActivityAt: 100,
        }),
      });
      await upsertAcpSessionMeta({
        cfg,
        databasePath,
        sessionKey,
        mutate: (current) =>
          current ? { ...current, state: "closed", lastActivityAt: 500, closedAt: 500 } : null,
      });
      const entry = loadSessionEntry({ agentId: ACP_AGENT_ID, storePath, sessionKey });
      expect(entry).toBeDefined();
      const batchEntries = [{ sessionKey, agentId: ACP_AGENT_ID, entry: entry! }];

      expect(readAcpSessionMeta({ cfg, databasePath, sessionKey })).toBeUndefined();
      expect(readAcpSessionEntry({ cfg, databasePath, sessionKey })?.acp).toBeUndefined();
      expect(await listAcpSessionEntries({ cfg, databasePath })).toHaveLength(0);
      expect(
        readAcpSessionMetaBatch({ cfg, databasePath, entries: batchEntries }).get(entry!),
      ).toBeUndefined();

      expect(
        readAcpSessionMeta({ cfg, databasePath, sessionKey, includeClosed: true }),
      ).toMatchObject({
        backend: "acpx",
        agent: "codex",
        runtimeSessionName: "codex-closed",
        state: "closed",
        lastActivityAt: 500,
        closedAt: 500,
      });
      expect(
        readAcpSessionEntry({ cfg, databasePath, sessionKey, includeClosed: true })?.acp?.state,
      ).toBe("closed");
      expect(
        readAcpSessionMetaBatch({
          cfg,
          databasePath,
          includeClosed: true,
          entries: batchEntries,
        }).get(entry!)?.closedAt,
      ).toBe(500);
    });
  });
});
