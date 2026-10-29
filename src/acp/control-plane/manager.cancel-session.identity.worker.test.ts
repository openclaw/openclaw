import { createIdentityFromStatus } from "@openclaw/acp-core/runtime/session-identity";
import { expect, it } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { readAcpSessionEntry, upsertAcpSessionMeta } from "../runtime/session-meta.js";
import {
  readDurableAcpSignals,
  withAcpCancellationFixture,
} from "./manager.cancel-session.worker.test-support.js";
import {
  createGate,
  startTurn,
  untilAborted,
} from "./manager.cancellation-locator.test-support.js";
import { stopAcpControllerTurns } from "./manager.controller-test-support.js";

it.each(["owner", "lifecycle"] as const)(
  "preserves successor metadata after %s replacement during cancelled-turn identity reconciliation",
  (replacement) =>
    withAcpCancellationFixture(async (f) => {
      const entered = createDeferred();
      const status = createGate("Cancellation ended before final identity observation.");
      let signal: AbortSignal | undefined;
      f.runTurn.mockImplementationOnce(async function* (input) {
        signal = input.signal;
        entered.resolve();
        await untilAborted(input.signal);
        yield { type: "done", stopReason: "cancel" };
      });
      f.getStatus.mockImplementation(async () => {
        if (signal?.aborted) {
          await status.wait();
          return { agentSessionId: "old-runtime-observation" };
        }
        return { summary: "ready" };
      });
      const turnResult = Promise.allSettled([startTurn(f, "identity-worker", { text: "first" })]);
      await awaitGateBeforeSettlement(entered.promise, turnResult, "Turn ended before entry.");
      let sql = observeHostDataSql();
      const result = Promise.allSettled([stopAcpControllerTurns(f.target), turnResult]);
      try {
        await status.reached(result);
        sql.restore();
        expect(sql.queries).toEqual([]);
        await replaceSessionEntry(f.target, {
          sessionId: "cancellation-session",
          lifecycleRevision:
            replacement === "lifecycle" ? "successor-lifecycle" : "cancellation-lifecycle",
          updatedAt: 200,
          spawnedBy: replacement === "owner" ? "agent:other:parent" : "agent:main:main",
        });
        await upsertAcpSessionMeta({
          ...f.target,
          skipMaintenance: true,
          mutate: () => ({
            backend: "cancellation-proof",
            agent: "main",
            runtimeSessionName: "successor-runtime",
            mode: "persistent",
            state: "running",
            lastActivityAt: 200,
            identity: createIdentityFromStatus({
              status: { agentSessionId: "successor-agent" },
              now: 200,
            }),
          }),
        });
        sql = observeHostDataSql();
        status.open();
        await result;
        sql.restore();
        expect(readAcpSessionEntry(f.target)?.acp).toMatchObject({
          runtimeSessionName: "successor-runtime",
          state: "running",
          identity: { agentSessionId: "successor-agent" },
        });
        expect(readDurableAcpSignals(f, "identity-worker")).toMatchObject([{ kind: "run_failed" }]);
        expect(f.cancel).toHaveBeenCalledOnce();
        expect(sql.queries).toEqual([]);
      } finally {
        sql.restore();
        status.open();
        await result;
      }
    }),
);
