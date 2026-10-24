import "./subagent-announce.requester-settle-dispatch-mocks.test-support.js";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../../config/runtime-snapshot.js";
import {
  loadSessionEntry,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import { writeSessionEntry } from "../../../config/sessions/session-accessor.sqlite-entry-store.js";
import { resolvePhysicalSessionStorePath } from "../../../config/sessions/session-store-path.js";
import * as workerAdmission from "../../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../../infra/sqlite-worker-owner-probe.test-support.js";
import { publishSystemEventStoreResolver } from "../../../infra/system-event-ownership.js";
import { bindGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
import { registerSessionStateWatch } from "../../../sessions/session-state-events.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { openOpenClawAgentDatabase } from "../../../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../../../state/openclaw-state-db.js";
import { observeMainThreadSql } from "../../../test-utils/main-thread-sql-spies.test-support.js";
import { createOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { prepareSystemAgentRunAdmission } from "../../admitted-run-context.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  prepareGatewayToolCallerAssertion,
  withGatewayToolCallerIdentity,
} from "../../tools/gateway-caller-context.js";
import * as announceDelivery from "./subagent-announce-delivery.js";
import * as deliveryRuntime from "./subagent-announce-delivery.runtime.js";
import type { sendSubagentAnnounceDirectly } from "./subagent-announce-direct-delivery.js";
import { setSubagentAnnounceDeliveryDepsForTest } from "./subagent-announce-overrides.test-support.js";
import {
  deliver,
  registryRead,
  readDescendantFacts,
  REQUESTER_KEY,
  settledChild,
  wakeParams,
  useRequesterSettleDispatchFixture,
  createRequesterSettleContext as createContext,
} from "./subagent-announce.requester-settle-dispatch.test-support.js";
import { maybeWakeRequesterAfterAllChildrenSettled } from "./subagent-announce.requester-settle-wake.js";

describe("requester settle watch admission", () => {
  useRequesterSettleDispatchFixture();
  afterEach(() => clearRuntimeConfigSnapshot());

  it("waits for requester startup preparation before reserving a delivery attempt", async () => {
    setRuntimeConfigSnapshot({});
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const child = settledChild();
    const pendingState = structuredClone(child.requesterSettleWake);
    const preparation = createDeferredCore();
    const preparationObserved = createDeferredCore();
    const context = createContext();
    context.agentDatabaseStartup = {
      hasPendingAgents: true,
      waitForAgentPreparation: (agentId) => {
        expect(agentId).toBe("main");
        preparationObserved.resolve();
        return preparation.promise;
      },
    };
    bindGatewayContextResolver(child, () => context);
    registryRead.listSubagentRunsForRequester.mockReturnValue([child]);
    deliver.mockResolvedValue({ delivered: true, path: "direct" });
    const completeBatch = vi.fn();
    const wake = maybeWakeRequesterAfterAllChildrenSettled(wakeParams(child, completeBatch));
    try {
      await expect(
        Promise.race([
          preparationObserved.promise.then(() => "preparing"),
          wake.then(() => "completed"),
        ]),
      ).resolves.toBe("preparing");
      expect(deliver).not.toHaveBeenCalled();
      expect(completeBatch).not.toHaveBeenCalled();
      expect(child.requesterSettleWake).toEqual(pendingState);

      preparation.resolve();
      await expect(wake).resolves.toBe(true);
      expect(deliver).toHaveBeenCalledOnce();
      expect(completeBatch).toHaveBeenCalledOnce();
      expect(Date.now()).toBe(10_000);
    } finally {
      preparation.resolve();
      await wake;
    }
  });

  it.each(["current", "owner reset", "same-store handoff"] as const)(
    "fences a settled requester's worker watch without retiring its wake (%s)",
    async (change) => {
      const resetRequester = change === "owner reset";
      const sameStoreHandoff = change === "same-store handoff";
      const state = await createOpenClawTestState({
        prefix: "settle-watch-",
        layout: "state-only",
      });
      onTestFinished(() => state.cleanup());
      const storePath = state.statePath("requester-watch.sqlite");
      const target = { agentId: "main", sessionKey: REQUESTER_KEY, storePath };
      const cfg = { session: { store: storePath } };
      setRuntimeConfigSnapshot(cfg);
      const requesterEntry = {
        sessionId: "requester-session",
        lifecycleRevision: "requester-revision",
        updatedAt: 100,
      };
      await replaceSessionEntry(target, requesterEntry);
      setSubagentAnnounceDeliveryDepsForTest({ getRuntimeConfig: () => cfg });
      vi.mocked(deliveryRuntime.captureRequesterSessionEntryCurrent).mockRestore();
      const requesterRead = vi
        .spyOn(announceDelivery, "loadRequesterSessionEntry")
        .mockImplementation(async () => ({
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
          publishSystemEventStoreResolver(() => storePath);
          return { unsettled: false, active: 0 };
        });
      }
      registryRead.listSubagentRunsForRequester.mockReturnValue([child]);
      const writer = resetRequester
        ? openOpenClawAgentDatabase({
            agentId: target.agentId,
            path: resolvePhysicalSessionStorePath(target),
          })
        : undefined;
      const admission = prepareSystemAgentRunAdmission(
        cfg,
        "settle-watch",
        "main",
        "settle-watch-test",
      );
      onTestFinished(() => admission.close());
      const admittedRunContext = await admission.admit("gateway");
      let watched: boolean | undefined;
      let sqlCount: number | undefined;
      let witnessed = false;
      const watchTarget = "agent:main:dashboard:settle-watch-target";
      deliver.mockImplementation(
        async (params: Parameters<typeof sendSubagentAnnounceDirectly>[0]) => {
          const interception =
            writer || sameStoreHandoff
              ? probe.admission(workerAdmission, (request, grant, admit) => {
                  if (
                    request.stage === "commit" &&
                    !witnessed &&
                    request.facts !== null &&
                    typeof request.facts === "object" &&
                    "kind" in request.facts &&
                    request.facts.kind === "session-entry-current"
                  ) {
                    witnessed = true;
                    if (writer) {
                      writeSessionEntry(writer, REQUESTER_KEY, {
                        ...requesterEntry,
                        lifecycleRevision: "replaced-requester-revision",
                      });
                    } else {
                      publishSystemEventStoreResolver(() => storePath);
                    }
                  }
                  admit(request, grant);
                })
              : undefined;
          const caller = createAdmittedGatewayToolCallerIdentity({
            admittedRunContext,
            agentId: "main",
            sessionKey: REQUESTER_KEY,
            receiptAuthority: params.isSourceSessionEffectsAllowed,
            receiptAdmission: params.sourceReceiptAdmission,
          });
          const sql = writer ? undefined : observeMainThreadSql();
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
        maybeWakeRequesterAfterAllChildrenSettled(wakeParams(child, completeBatch)),
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
