import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import {
  clearLiveModelSwitchPending,
  consolidateLiveModelSwitchAfterRun,
} from "./live-model-switch.js";

describe("live model switch worker persistence", () => {
  const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-model-switch-worker-");

  it.each(["clear", "consolidate"] as const)(
    "%s consumes only the applied selection without host session SQL",
    async (operation) => {
      const storePath = path.join(sessionDirs.make(), "sessions.json");
      const scope = { storePath, sessionKey: "agent:main:model-switch" };
      const cfg = { session: { store: storePath } };
      const initial = {
        sessionId: "model-switch",
        updatedAt: 1,
        label: "keep this label",
        liveModelSwitchPending: true,
        providerOverride: "openai",
        modelOverride: "gpt-5.4",
      };
      await replaceSessionEntry(scope, initial);
      const apply = () =>
        operation === "clear"
          ? clearLiveModelSwitchPending({
              cfg,
              sessionKey: scope.sessionKey,
              agentId: "main",
              defaultProvider: "openai",
              defaultModel: "gpt-5.4",
              expectedSelection: { provider: "openai", model: "gpt-5.4" },
            })
          : consolidateLiveModelSwitchAfterRun({
              cfg,
              sessionKey: scope.sessionKey,
              agentId: "main",
              providerUsed: "openai",
              modelUsed: "gpt-5.4",
            });
      const sql = observeHostDataSql();
      try {
        await apply();
        expect(
          sql.queries.filter((query) =>
            /session_nodes|session_entry_snapshots|\b(?:BEGIN|COMMIT|ROLLBACK)\b/i.test(query),
          ),
        ).toEqual([]);
      } finally {
        sql.restore();
      }
      expect(loadSessionEntry(scope)).toMatchObject({
        sessionId: initial.sessionId,
        label: initial.label,
        modelOverride: initial.modelOverride,
      });
      expect(loadSessionEntry(scope)?.liveModelSwitchPending).toBeUndefined();

      await replaceSessionEntry(scope, { ...initial, modelOverride: "gpt-5.5" });
      await apply();
      expect(loadSessionEntry(scope)).toMatchObject({
        liveModelSwitchPending: true,
        modelOverride: "gpt-5.5",
      });
    },
  );
});
