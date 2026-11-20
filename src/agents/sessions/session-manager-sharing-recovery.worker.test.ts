import assert from "node:assert/strict";
import path from "node:path";
import { expect, it } from "vitest";
import { useSqliteWorkerFault } from "../../../test/helpers/sqlite-worker-fault.js";
import { captureRuntimeConfigAsyncReader } from "../../config/io.runtime.js";
import { readSessionSharingAuthorityHealth } from "../../config/sessions/session-sharing-authority-state.js";
import { prepareSessionMutationFacts } from "../../gateway/session-sharing-preparation.js";
import { hasSqliteWorkerOutcomeUnknown } from "../../infra/sqlite-worker-contract.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { withSessionMetadataWorker } from "./session-manager-metadata-runtime.js";
import { withSessionManagerWrite } from "./session-manager-write-admission.js";

const fault = useSqliteWorkerFault([
  { match: /^insert into session_nodes\b/iu, exitOnMatch: 1, afterCommit: true },
]);

it("reconciles a SessionManager initialization whose committed worker receipt was lost", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    await captureRuntimeConfigAsyncReader()();
    const target = {
      agentId: "main",
      storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
      sessionKey: "agent:main:manager-loss",
      sessionId: "manager-loss",
    };
    const manager = { getSessionTarget: () => target, getSessionId: () => target.sessionId };
    const cfg = { agents: { entries: { main: {} } } };
    const old = await prepareSessionMutationFacts({ cfg, ...target, allowMissing: true });
    try {
      fault.enable();
      const failure = await withSessionManagerWrite(manager, async (admission) => {
        assert(admission);
        return withSessionMetadataWorker(
          admission.options,
          admission.database,
          () => admission.assertCurrent(),
          (worker) =>
            worker.execute({
              type: "session.metadata.initialize",
              input: { scope: target, entry: { sessionId: target.sessionId, updatedAt: 1 } },
            }),
        );
      }).catch((error: unknown) => error);
      fault.disable();
      expect(hasSqliteWorkerOutcomeUnknown(failure), String(failure)).toBe(true);
      expect(readSessionSharingAuthorityHealth(true)?.sessionKeys).toContain(target.sessionKey);
      const fresh = await prepareSessionMutationFacts({ cfg, ...target });
      try {
        expect(fresh.readCurrent(cfg).target?.entry?.sessionId).toBe(target.sessionId);
        expect(readSessionSharingAuthorityHealth(true)).toBeUndefined();
        expect(() => old.readCurrent(cfg)).toThrow("Session access facts are unavailable");
      } finally {
        fresh.release();
      }
    } finally {
      fault.disable();
      old.release();
    }
  });
});
