import { createIdentityFromStatus } from "@openclaw/acp-core/runtime/session-identity";
import { expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { createTestAdmittedRunContext } from "../../agents/admitted-run-context.test-support.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { readAcpSessionEntry, upsertAcpSessionMeta } from "../runtime/session-meta.js";
import {
  readDurableAcpSignals,
  withAcpCancellationFixture,
} from "./manager.cancel-session.worker.test-support.js";

it.each(["owner", "lifecycle"] as const)(
  "preserves successor metadata after %s replacement during cancelled-turn identity reconciliation",
  async (replacement) => {
    await withAcpCancellationFixture(async (f) => {
      const entered = createDeferred();
      const statusEntered = createDeferred();
      const releaseStatus = createDeferred();
      let signal: AbortSignal | undefined;
      f.runTurn.mockImplementationOnce(async function* (input) {
        signal = input.signal;
        entered.resolve();
        await new Promise<void>((resolve) => {
          input.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        yield { type: "done", stopReason: "cancel" };
      });
      f.getStatus.mockImplementation(async () => {
        if (signal?.aborted) {
          statusEntered.resolve();
          await releaseStatus.promise;
          return { agentSessionId: "old-runtime-observation" };
        }
        return { summary: "ready" };
      });
      const context = createTestAdmittedRunContext("identity-worker");
      const turn = f.manager.runTurn({
        ...f.target,
        admittedRunContext: context,
        provenance: "system",
        mode: "prompt",
        text: "first",
        requestId: "identity-worker",
      });
      const turnResult = Promise.allSettled([turn]);
      await Promise.race([
        entered.promise,
        turnResult.then(() => {
          throw new Error("Turn ended before runtime entry.");
        }),
      ]);
      let sql = observeHostDataSql();
      const cancellation = f.manager.cancelSession({
        ...f.target,
        expectedRunId: "identity-worker",
        expectedInstanceId: context.operationalRunInstance.instanceId,
        expectedOwnerKey: "agent:main:main",
      });
      const result = Promise.allSettled([cancellation, turn]);
      try {
        await Promise.race([
          statusEntered.promise,
          result.then(() => {
            throw new Error("Cancellation ended before final identity observation.");
          }),
        ]);
        sql.restore();
        expect(sql.queries).toEqual([]);
        // The replacement producer uses its existing native API while getStatus is held.
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
        releaseStatus.resolve();
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
        releaseStatus.resolve();
        await Promise.allSettled([result, turnResult]);
      }
    });
  },
);
