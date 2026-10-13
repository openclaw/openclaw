import fs from "node:fs";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createTestAdmittedRunContext } from "../../agents/admitted-run-context.test-support.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { getOpenIncognitoAgentDatabase } from "../../state/openclaw-agent-db-lifecycle.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { withOpenClawStateDatabaseReadSnapshot } from "../../state/openclaw-state-db-readonly.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import * as stateWorker from "../../state/openclaw-state-worker-store.js";
import { buildAcpDatabaseSessionKey } from "../runtime/session-meta-keys.js";
import { applyAcpSessionMutation } from "../runtime/session-meta-write.kernel.js";
import { readAcpSessionEntry, writeAcpSessionMetaForMigration } from "../runtime/session-meta.js";
import { withAcpCancellationFixture } from "./manager.cancel-session.worker.test-support.js";

it.each([
  ["incognito", "rebind", "live"],
  ["incognito", "clear", "snapshot"],
  ["durable", "same-binding", "live"],
  ["durable", "clear", "live"],
  ["durable", "rebind", "live"],
  ["durable", "owner", "live"],
] as const)(
  "rechecks %s global ACP metadata after a signal wait and %s mutation under %s reads",
  async (sourceKind, change, readScope) => {
    await withAcpCancellationFixture(
      async (f) => {
        const path = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env: f.state.env });
        const memory = getOpenIncognitoAgentDatabase("main", path);
        if (sourceKind === "incognito") {
          expect(memory?.db.location()).toBeFalsy();
          expect(memory).toBeDefined();
          expect(fs.existsSync(path)).toBe(false);
        }
        const originalMeta = readAcpSessionEntry(f.target)?.acp;
        if (!originalMeta) {
          throw new Error("Expected canonical global ACP metadata.");
        }
        const actorEntered = createDeferred();
        const releaseActor = createDeferred();
        f.getStatus.mockImplementationOnce(async () => {
          actorEntered.resolve();
          await releaseActor.promise;
          return { summary: "ready" };
        });
        const actor = f.manager.getSessionStatus(f.target);
        const actorResult = Promise.allSettled([actor]);
        await Promise.race([
          actorEntered.promise,
          actorResult.then(() => {
            throw new Error("Actor ended before gate.");
          }),
        ]);
        const reached = createDeferred();
        const release = createDeferred();
        const original = stateWorker.runOpenClawStateWorkerOperation;
        let paused = false;
        const intercepted = vi
          .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
          .mockImplementation((context, operation, options) =>
            original(
              context,
              (worker) =>
                operation({
                  ...worker,
                  execute: new Proxy(worker.execute, {
                    apply(execute, receiver, args: Parameters<typeof worker.execute>) {
                      if (!paused && args[0].type === "sessionState.record") {
                        paused = true;
                        reached.resolve();
                        return release.promise.then(() => {
                          return Reflect.apply(execute, receiver, args);
                        });
                      }
                      return Reflect.apply(execute, receiver, args);
                    },
                  }),
                }),
              options,
            ),
          );
        const admittedRunContext = createTestAdmittedRunContext("incognito-parity");
        const events: unknown[] = [];
        const runCancellation = () => {
          const turn = f.manager.runTurn({
            ...f.target,
            admittedRunContext,
            provenance: "system",
            mode: "prompt",
            text: "private",
            requestId: "incognito-parity",
            onEvent: (event) => {
              events.push(event);
            },
          });
          const cancellation = f.manager.cancelSession({
            ...f.target,
            expectedRunId: "incognito-parity",
            expectedInstanceId: admittedRunContext.operationalRunInstance.instanceId,
            expectedOwnerKey: "agent:main:main",
          });
          return Promise.allSettled([cancellation, turn]);
        };
        const result =
          readScope === "snapshot"
            ? withOpenClawStateDatabaseReadSnapshot(runCancellation, { env: f.state.env })
            : runCancellation();
        try {
          await Promise.race([
            reached.promise,
            result.then(() => {
              throw new Error("Cancellation ended before mutation gate.");
            }),
          ]);
          if (change === "clear") {
            runOpenClawStateWriteTransaction(
              ({ db }) =>
                applyAcpSessionMutation(db, {
                  agentId: "main",
                  sessionKey: f.target.sessionKey,
                  storageSessionKey: f.target.sessionKey,
                  entry: {
                    sessionId: "cancellation-session",
                    lifecycleRevision: "cancellation-lifecycle",
                    updatedAt: 100,
                  },
                  decision: { kind: "clear" },
                }),
              { env: f.state.env },
            );
          } else if (change === "owner") {
            await replaceSessionEntry(f.target, {
              sessionId: "cancellation-session",
              lifecycleRevision: "cancellation-lifecycle",
              updatedAt: 200,
              spawnedBy: "agent:other:parent",
            });
          } else {
            writeAcpSessionMetaForMigration({
              env: f.state.env,
              sessionKey: buildAcpDatabaseSessionKey(f.target.sessionKey, "main"),
              lifecycleRevision:
                change === "rebind" ? "replacement-lifecycle" : "cancellation-lifecycle",
              meta: { ...originalMeta, lastActivityAt: 200 },
            });
          }
          release.resolve();
          const settled = await result;
          const signals = openOpenClawStateDatabase({ env: f.state.env })
            .db.prepare("SELECT kind FROM session_state_events WHERE run_id = ?")
            .all("incognito-parity");
          expect(signals).toEqual(change === "same-binding" ? [{ kind: "run_failed" }] : []);
          const authorityCurrent = change === "same-binding";
          expect(events).toEqual(
            authorityCurrent ? [{ type: "done", status: "cancelled", stopReason: "cancel" }] : [],
          );
          expect(settled).toMatchObject(
            authorityCurrent
              ? [{ status: "fulfilled" }, { status: "fulfilled" }]
              : [{ status: "rejected" }, { status: "rejected" }],
          );
          if (sourceKind === "incognito") {
            expect(getOpenIncognitoAgentDatabase("main", path)).toBe(memory);
            expect(fs.existsSync(path)).toBe(false);
          }
          expect(f.runTurn).not.toHaveBeenCalled();
          expect(f.cancel).not.toHaveBeenCalled();
        } finally {
          release.resolve();
          intercepted.mockRestore();
          releaseActor.resolve();
          await Promise.allSettled([result, actorResult]);
        }
      },
      {
        sessionKey:
          sourceKind === "incognito"
            ? "agent:main:dashboard:incognito-cancel-parity"
            : "agent:main:acp:signal-cancel-parity",
      },
    );
  },
);
