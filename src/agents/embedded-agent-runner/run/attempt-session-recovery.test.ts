import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { loadTranscriptEventsSync } from "../../../config/sessions/session-accessor.js";
import {
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "../../../config/sessions/session-accessor.sqlite-scope.js";
import { SessionTranscriptProjectionUnavailableError } from "../../../config/sessions/session-transcript-projection-error.js";
import { waitForSessionTranscriptIndexReconcile } from "../../../config/sessions/session-transcript-reconcile.js";
import { useReconcileWorkerObserver } from "../../../config/sessions/session-transcript-reconcile.test-support.js";
import type { SessionTranscriptReconcileWorkerMessage } from "../../../config/sessions/session-transcript-reconcile.worker.js";
import { enqueueCommandInLane, getCommandLaneSnapshot } from "../../../process/command-queue.js";
import { openOpenClawAgentDatabase } from "../../../state/openclaw-agent-db.js";
import { isSessionFileEntry } from "../../sessions/session-file-parser.js";
import { sessionManagerOpenTranscriptCohort } from "../../sessions/session-manager-core.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { openSessionAfterProjectionRecovery } from "./attempt-session-projection-recovery.js";
import { withInterruptedTurn } from "./attempt-session-replay.test-support.js";
import { cleanupEmbeddedAttemptResources } from "./attempt-subscription-cleanup.js";
import { withReleasableExecutionCapacity } from "./execution-capacity.js";

vi.mock("node:worker_threads", async () =>
  (
    await import("../../../config/sessions/session-transcript-reconcile.test-support.js")
  ).createObservedWorkerThreads(),
);

const observer = useReconcileWorkerObserver();

it("recovers a fresh admitted turn when its active projection is rebuilding", async () => {
  await withInterruptedTurn(
    false,
    async ({ target, prepare }) => {
      await waitForSessionTranscriptIndexReconcile({ agentId: target.agentId });
      const database = openOpenClawAgentDatabase({ agentId: target.agentId });
      expect(
        database.db
          .prepare(
            "UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?",
          )
          .run(target.sessionId).changes,
      ).toBe(1);
      const prepared = await prepare();
      try {
        expect(
          prepared.sessionManager
            .getBranch()
            .filter((entry) => entry.type === "message" && entry.message.role === "user"),
        ).toHaveLength(1);
      } finally {
        await cleanupEmbeddedAttemptResources({
          sessionManager: prepared.sessionManager,
          flushPendingToolResultsAfterIdle: async () => {},
        });
      }
    },
    { interruptedTurn: false },
  );
});

it.each(["window-changed", "other-session", "read-failure"])(
  "does not retry hydration for %s",
  async (failure) => {
    const error =
      failure === "read-failure"
        ? new Error("read failed")
        : new SessionTranscriptProjectionUnavailableError(
            failure === "other-session" ? "different-session" : "current-session",
            failure === "window-changed" ? "window-changed" : "rebuilding",
          );
    const open = vi.fn().mockRejectedValue(error);
    await expect(
      openSessionAfterProjectionRecovery({
        open,
        target: {
          agentId: "main",
          sessionId: "current-session",
          sessionKey: "agent:main:current-session",
          storePath: "/synthetic/sessions.sqlite",
        },
        timeoutMs: 1_000,
        signal: new AbortController().signal,
        assertCurrent() {},
      }),
    ).rejects.toBe(error);
    expect(open).toHaveBeenCalledOnce();
  },
);

it("waits for the owning shared-store projection before retrying a fresh turn", async () => {
  await withInterruptedTurn(
    false,
    async ({ attempt, target, prepare }) => {
      attempt.sessionTarget = { sessionId: target.sessionId };
      const databaseOptions = toDatabaseOptions(resolveSqliteTranscriptScope(target));
      await waitForSessionTranscriptIndexReconcile(databaseOptions);
      const database = openOpenClawAgentDatabase(databaseOptions);
      expect(
        database.db
          .prepare(
            "UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?",
          )
          .run(target.sessionId).changes,
      ).toBe(1);
      const claimed = createDeferred();
      let releaseWorker: (() => void) | undefined;
      observer.onTask = ({ port, observeMessage }) => {
        const postMessage = port.postMessage.bind(port);
        let claiming = false;
        observeMessage((message: SessionTranscriptReconcileWorkerMessage) => {
          claiming = message.type === "plan-start" && message.plan.sessionId === target.sessionId;
        });
        port.postMessage = (message: unknown, transferList) => {
          const options = Array.isArray(transferList) ? { transfer: transferList } : transferList;
          if (claiming && !releaseWorker) {
            releaseWorker = () => postMessage(message, options);
            claimed.resolve();
            return;
          }
          postMessage(message, options);
        };
      };
      const open = vi.spyOn(SessionManager, sessionManagerOpenTranscriptCohort);
      let created: SessionManager | undefined;
      const lane = "shared-projection-recovery";
      const preparing = withReleasableExecutionCapacity(
        (task, options) => enqueueCommandInLane(lane, task, options),
        () =>
          prepare((manager) => {
            created = manager;
          }),
      );
      const outcome = preparing.then(
        () => ({ kind: "resolved" as const }),
        (error: unknown) => ({ kind: "rejected" as const, error }),
      );
      try {
        await Promise.race([
          claimed.promise,
          outcome.then(() => {
            throw new Error("preparation settled before the owning projection was claimed");
          }),
        ]);
        expect(open).toHaveBeenCalledTimes(1);
        expect(getCommandLaneSnapshot(lane).activeCount).toBe(0);
        await expect(enqueueCommandInLane(lane, async () => "sibling finished")).resolves.toBe(
          "sibling finished",
        );
        releaseWorker?.();
        await expect(preparing).resolves.toBeDefined();
        expect(open).toHaveBeenCalledTimes(2);
        expect(
          loadTranscriptEventsSync(target).filter(
            (event) =>
              isSessionFileEntry(event) &&
              event.type === "message" &&
              event.message.role === "user",
          ),
        ).toHaveLength(1);
      } finally {
        open.mockRestore();
        releaseWorker?.();
        await Promise.all([outcome, waitForSessionTranscriptIndexReconcile(databaseOptions)]);
        await cleanupEmbeddedAttemptResources({
          sessionManager: created,
          flushPendingToolResultsAfterIdle: async () => {},
        });
      }
    },
    { interruptedTurn: false, sharedStore: true, selectedOwner: true, admittedReceipt: true },
  );
});

it("stops after one retry if the same projection remains unavailable", async () => {
  await withInterruptedTurn(
    false,
    async ({ target, prepare }) => {
      const first = new SessionTranscriptProjectionUnavailableError(target.sessionId, "rebuilding");
      const second = new SessionTranscriptProjectionUnavailableError(
        target.sessionId,
        "rebuilding",
      );
      const open = vi.spyOn(SessionManager, sessionManagerOpenTranscriptCohort);
      open.mockRejectedValueOnce(first).mockRejectedValueOnce(second);
      try {
        await expect(prepare()).rejects.toBe(second);
        expect(open).toHaveBeenCalledTimes(2);
      } finally {
        open.mockRestore();
      }
    },
    { interruptedTurn: false, selectedOwner: true, admittedReceipt: true },
  );
});

it("publishes a cohort manager for cleanup when its writer is revoked during consumption", async () => {
  await withInterruptedTurn(
    false,
    async ({ prepare, revoke }) => {
      const original = SessionManager[sessionManagerOpenTranscriptCohort].bind(SessionManager);
      const open = vi.spyOn(SessionManager, sessionManagerOpenTranscriptCohort);
      open.mockImplementation(async (target, options, selection, consume) =>
        original(target, options, selection, (manager, prepared, assertView) => {
          revoke();
          consume(manager, prepared, assertView);
        }),
      );
      let created: SessionManager | undefined;
      try {
        await expect(
          prepare((manager) => {
            created = manager;
          }),
        ).rejects.toThrow("original writer closed");
        expect(open).toHaveBeenCalledTimes(1);
        expect(created).toBeDefined();
      } finally {
        open.mockRestore();
        await cleanupEmbeddedAttemptResources({
          sessionManager: created,
          flushPendingToolResultsAfterIdle: async () => {},
        });
      }
    },
    { interruptedTurn: false, selectedOwner: true, admittedReceipt: true },
  );
});

it.each(["cancelled", "deadline"])(
  "leaves a shared projection rebuild running when fresh-turn preparation reaches %s",
  async (exit) => {
    await withInterruptedTurn(
      false,
      async ({ attempt, target, prepare }) => {
        const databaseOptions = toDatabaseOptions(resolveSqliteTranscriptScope(target));
        await waitForSessionTranscriptIndexReconcile(databaseOptions);
        const database = openOpenClawAgentDatabase(databaseOptions);
        database.db
          .prepare(
            "UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?",
          )
          .run(target.sessionId);
        const claimed = createDeferred();
        let releaseWorker: (() => void) | undefined;
        observer.onTask = ({ port, observeMessage }) => {
          const postMessage = port.postMessage.bind(port);
          let claiming = false;
          observeMessage((message: SessionTranscriptReconcileWorkerMessage) => {
            claiming = message.type === "plan-start" && message.plan.sessionId === target.sessionId;
          });
          port.postMessage = (message: unknown, transferList) => {
            const options = Array.isArray(transferList) ? { transfer: transferList } : transferList;
            if (claiming && !releaseWorker) {
              releaseWorker = () => postMessage(message, options);
              claimed.resolve();
              return;
            }
            postMessage(message, options);
          };
        };
        const controller = new AbortController();
        if (exit === "deadline") {
          attempt.timeoutMs = 1_000;
          vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        }
        const open = vi.spyOn(SessionManager, sessionManagerOpenTranscriptCohort);
        const preparing = prepare(undefined, { runAbortSignal: controller.signal });
        const outcome = preparing.then(
          () => ({ kind: "resolved" as const }),
          (error: unknown) => ({ kind: "rejected" as const, error }),
        );
        try {
          await Promise.race([
            claimed.promise,
            outcome.then(() => {
              throw new Error("preparation settled before its projection was claimed");
            }),
          ]);
          if (exit === "deadline") {
            vi.advanceTimersByTime(attempt.timeoutMs);
            await expect(outcome).resolves.toMatchObject({
              kind: "rejected",
              error: { name: "SessionTranscriptProjectionUnavailableError", reason: "rebuilding" },
            });
          } else {
            const reason = new Error("cancel fresh-turn preparation");
            controller.abort(reason);
            await expect(outcome).resolves.toMatchObject({ kind: "rejected", error: reason });
          }
          expect(open).toHaveBeenCalledTimes(1);
          expect(
            loadTranscriptEventsSync(target).filter(
              (event) =>
                isSessionFileEntry(event) &&
                event.type === "message" &&
                event.message.role === "user",
            ),
          ).toHaveLength(1);
        } finally {
          vi.useRealTimers();
          open.mockRestore();
          releaseWorker?.();
          await Promise.all([outcome, waitForSessionTranscriptIndexReconcile(databaseOptions)]);
        }
      },
      { interruptedTurn: false, selectedOwner: true, admittedReceipt: true },
    );
  },
);
