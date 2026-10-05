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
import { openOpenClawAgentDatabase } from "../../../state/openclaw-agent-db.js";
import { isSessionFileEntry } from "../../sessions/session-file-parser.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { withInterruptedTurn } from "./attempt-session-replay.test-support.js";

vi.mock("node:worker_threads", async () =>
  (
    await import("../../../config/sessions/session-transcript-reconcile.test-support.js")
  ).createObservedWorkerThreads(),
);

const observer = useReconcileWorkerObserver();

it("waits for the owning shared-store projection before retrying a fresh turn", async () => {
  await withInterruptedTurn(
    false,
    async ({ target, prepare }) => {
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
      const open = vi.spyOn(SessionManager, "openAsync");
      const preparing = prepare();
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
      }
    },
    { interruptedTurn: false, sharedStore: true },
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
      const open = vi.spyOn(SessionManager, "openAsync");
      open.mockRejectedValueOnce(first).mockRejectedValueOnce(second);
      try {
        await expect(prepare()).rejects.toBe(second);
        expect(open).toHaveBeenCalledTimes(2);
      } finally {
        open.mockRestore();
      }
    },
    { interruptedTurn: false },
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
        const open = vi.spyOn(SessionManager, "openAsync");
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
      { interruptedTurn: false },
    );
  },
);
