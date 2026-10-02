import "./subagent-announce.requester-settle-dispatch-mocks.test-support.js";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  loadSessionEntry,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import { resolvePhysicalSessionStorePath } from "../../../config/sessions/session-store-path.js";
import * as workerAdmission from "../../../infra/sqlite-worker-operation-admission.js";
import { publishSystemEventStoreResolver } from "../../../infra/system-event-ownership.js";
import { registerSessionStateWatch } from "../../../sessions/session-state-events.js";
import { openOpenClawStateDatabase } from "../../../state/openclaw-state-db.js";
import { observeMainThreadSql } from "../../../test-utils/main-thread-sql-spies.test-support.js";
import { createOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../../admitted-run-context.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  prepareGatewayToolCallerAssertion,
  withGatewayToolCallerIdentity,
} from "../../tools/gateway-caller-context.js";
import * as announceDelivery from "./subagent-announce-delivery.js";
import type { sendSubagentAnnounceDirectly } from "./subagent-announce-direct-delivery.js";
import { setSubagentAnnounceDeliveryDepsForTest } from "./subagent-announce-overrides.test-support.js";
import {
  deliver,
  registryRead,
  readDescendantFacts,
  REQUESTER_KEY,
  settledChild,
  publishWakeTransition,
  useRequesterSettleDispatchFixture,
} from "./subagent-announce.requester-settle-dispatch.test-support.js";
import { maybeWakeRequesterAfterAllChildrenSettled } from "./subagent-announce.requester-settle-wake.js";

describe("requester settle watch admission", () => {
  useRequesterSettleDispatchFixture();

  it.each(["current", "foreign reset", "same-store handoff"] as const)(
    "fences a settled requester's worker watch without retiring its wake (%s)",
    async (change) => {
      const resetRequester = change === "foreign reset";
      const sameStoreHandoff = change === "same-store handoff";
      const state = await createOpenClawTestState({
        prefix: "settle-watch-",
        layout: "state-only",
      });
      onTestFinished(() => state.cleanup());
      const storePath = state.statePath("requester-watch.sqlite");
      const target = { agentId: "main", sessionKey: REQUESTER_KEY, storePath };
      const cfg = { session: { store: storePath } };
      await replaceSessionEntry(target, {
        sessionId: "requester-session",
        lifecycleRevision: "requester-revision",
        updatedAt: 100,
      });
      setSubagentAnnounceDeliveryDepsForTest({ getRuntimeConfig: () => cfg });
      const requesterRead = vi
        .spyOn(announceDelivery, "loadRequesterSessionEntry")
        .mockImplementation(() => ({
          cfg,
          storePath,
          canonicalKey: REQUESTER_KEY,
          agentId: "main",
          entry: loadSessionEntry(target),
        }));
      onTestFinished(() => requesterRead.mockRestore());
      const child = settledChild();
      if (sameStoreHandoff) {
        child.requesterStorePath = storePath;
        publishSystemEventStoreResolver(() => storePath);
        onTestFinished(() => publishSystemEventStoreResolver(undefined));
        readDescendantFacts.mockImplementationOnce(async () => {
          // A same-store handoff while the wake prepares must not consume its obligation.
          publishSystemEventStoreResolver(() => storePath);
          return { unsettled: false, active: 0 };
        });
      }
      registryRead.listSubagentRunsForRequester.mockReturnValue([child]);
      const peer = resetRequester
        ? new DatabaseSync(resolvePhysicalSessionStorePath(target))
        : undefined;
      onTestFinished(() => peer?.close());
      const admission = prepareAgentRunAdmission({
        cfg,
        operationalRunInstance: createOperationalRunInstanceRef("settle-watch"),
        facts: {
          runId: "settle-watch",
          agentId: "main",
          ingress: { kind: "system", boundary: "settle-watch-test", state: "present" },
        },
      });
      onTestFinished(() => admission.close());
      const admittedRunContext = await admission.admit("gateway");
      let watched: boolean | undefined;
      let sqlCount: number | undefined;
      let witnessed = false;
      const watchTarget = "agent:main:dashboard:settle-watch-target";
      deliver.mockImplementation(
        async (params: Parameters<typeof sendSubagentAnnounceDirectly>[0]) => {
          const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
          const interception =
            peer || sameStoreHandoff
              ? vi
                  .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
                  .mockImplementation((admit, attachment) =>
                    createAdmission((request, grant) => {
                      if (
                        request.stage === "commit" &&
                        !witnessed &&
                        request.facts !== null &&
                        typeof request.facts === "object" &&
                        "kind" in request.facts &&
                        request.facts.kind === "session-entry-current"
                      ) {
                        witnessed = true;
                        if (peer) {
                          // Independent native writer changes the requester after the worker's read.
                          peer
                            .prepare(
                              "UPDATE session_nodes SET entry_json = json_set(entry_json, '$.lifecycleRevision', ?) WHERE session_key = ?",
                            )
                            .run("replaced-requester-revision", REQUESTER_KEY);
                        } else {
                          publishSystemEventStoreResolver(() => storePath);
                        }
                      }
                      admit(request, grant);
                    }, attachment),
                  )
              : undefined;
          const caller = createAdmittedGatewayToolCallerIdentity({
            admittedRunContext,
            agentId: "main",
            sessionKey: REQUESTER_KEY,
            receiptAuthority: params.isSourceSessionEffectsAllowed,
            receiptAdmission: params.sourceReceiptAdmission,
          });
          const sql = peer ? undefined : observeMainThreadSql();
          try {
            sql?.calibrate();
            watched = await withGatewayToolCallerIdentity(caller, () =>
              registerSessionStateWatch(
                { watcherSessionKey: REQUESTER_KEY, targetSessionKey: watchTarget },
                { prepareCurrent: prepareGatewayToolCallerAssertion },
              ),
            );
            sqlCount = sql?.count();
          } finally {
            sql?.restore();
            interception?.mockRestore();
          }
          return { delivered: true, path: "direct" };
        },
      );
      const completeBatch = vi.fn<
        Parameters<typeof maybeWakeRequesterAfterAllChildrenSettled>[0]["completeBatch"]
      >(() => {
        child.requesterSettleWake = undefined;
      });
      await expect(
        maybeWakeRequesterAfterAllChildrenSettled({
          requesterSessionKey: REQUESTER_KEY,
          settledEntry: child,
          isSourceCurrent: () => true,
          transitionBatch: publishWakeTransition,
          completeBatch,
        }),
      ).resolves.toBe(true);
      expect(deliver).toHaveBeenCalledOnce();
      expect(completeBatch).toHaveBeenCalledOnce();
      expect(completeBatch.mock.calls[0]?.[2]).toMatchObject({ delivered: true });
      expect(watched).toBe(change === "current");
      if (change !== "current") {
        expect(witnessed).toBe(true);
      }
      if (!resetRequester) {
        expect(sqlCount).toBe(0);
      }
      const cursor = openOpenClawStateDatabase()
        .db.prepare(
          "SELECT target_session_key FROM session_watch_cursors WHERE watcher_session_key = ? AND target_session_key = ?",
        )
        .get(REQUESTER_KEY, watchTarget);
      expect(Boolean(cursor)).toBe(change === "current");
    },
  );
});
