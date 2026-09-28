import type { ServerResponse } from "node:http";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { resolveQaDebugRequestCursor } from "../shared/debug-request-cursor.js";
import { writeJson } from "../shared/http-json.js";
import {
  MOCK_OPENAI_DEBUG_REQUEST_LIMIT,
  type MockOpenAiRequestSnapshot,
  type MockOpenAiRequestSnapshotInput,
} from "./mock-openai-contracts.js";

/** Provider observation only; Gateway run/receipt identity must be collected separately. */
export type QaMockContinuationCheckpoint = Readonly<{
  cursor: number;
  sessionId: string;
  toolOutputCallId: string;
}>;

export type QaMockContinuationHold = {
  reached: Promise<QaMockContinuationCheckpoint>;
  release(): void;
  cancel(): void;
};

export function createMockOpenAiRequestLog() {
  const requests: MockOpenAiRequestSnapshot[] = [];
  let nextCursor = 1;
  let stopped = false;
  let hold:
    | {
        sessionId: string;
        captured: boolean;
        reached: ReturnType<typeof createDeferred<QaMockContinuationCheckpoint>>;
        resume: ReturnType<typeof createDeferred<void>>;
        finish(error?: Error): void;
      }
    | undefined;
  return {
    record(snapshot: MockOpenAiRequestSnapshotInput) {
      const recorded = { ...snapshot, cursor: nextCursor++ };
      requests.push(recorded);
      if (requests.length > MOCK_OPENAI_DEBUG_REQUEST_LIMIT) {
        requests.splice(0, requests.length - MOCK_OPENAI_DEBUG_REQUEST_LIMIT);
      }
      return recorded;
    },
    handleGet(url: URL, res: ServerResponse) {
      if (url.pathname === "/debug/last-request") {
        writeJson(res, 200, requests.at(-1) ?? { ok: false, error: "no request recorded" });
      } else if (url.pathname === "/debug/request-cursor") {
        writeJson(res, 200, { cursor: nextCursor - 1 });
      } else if (url.pathname === "/debug/requests") {
        const afterText = url.searchParams.get("after");
        if (afterText === null) {
          writeJson(res, 200, requests);
          return true;
        }
        const after = resolveQaDebugRequestCursor(
          afterText,
          requests[0]?.cursor ?? nextCursor,
          nextCursor - 1,
        );
        if (typeof after !== "number") {
          writeJson(res, after.status, after.body);
        } else {
          writeJson(
            res,
            200,
            requests.filter((request) => request.cursor > after),
          );
        }
      } else {
        return false;
      }
      return true;
    },
    holdNextContinuation(
      this: void,
      sessionId: string,
      signal: AbortSignal,
    ): QaMockContinuationHold {
      signal.throwIfAborted();
      if (stopped || hold || !sessionId.trim()) {
        throw new Error(
          "QA continuation hold requires a live provider, an idle hold and a sessionId",
        );
      }
      const current = {
        sessionId,
        captured: false,
        reached: createDeferred<QaMockContinuationCheckpoint>(),
        resume: createDeferred<void>(),
        finish(error?: Error) {
          if (hold !== current) {
            return;
          }
          hold = undefined;
          signal.removeEventListener("abort", onAbort);
          if (error) {
            current.reached.reject(error);
            current.resume.reject(error);
          } else {
            current.resume.resolve();
          }
        },
      };
      const onAbort = () => current.finish(new Error("QA continuation hold aborted"));
      // Cancellation can precede the scenario awaiting either promise.
      void current.reached.promise.catch(() => {});
      void current.resume.promise.catch(() => {});
      hold = current;
      signal.addEventListener("abort", onAbort, { once: true });
      return {
        reached: current.reached.promise,
        release() {
          if (!current.captured) {
            throw new Error("QA continuation has not reached its checkpoint");
          }
          current.finish();
        },
        cancel: () => current.finish(new Error("QA continuation hold cancelled")),
      };
    },
    waitForContinuation(request: MockOpenAiRequestSnapshot) {
      if (
        !hold ||
        hold.captured ||
        request.sessionId !== hold.sessionId ||
        request.requestKind !== "tool-continuation" ||
        !request.toolOutputCallId
      ) {
        return undefined;
      }
      hold.captured = true;
      hold.reached.resolve(
        Object.freeze({
          cursor: request.cursor,
          sessionId: hold.sessionId,
          toolOutputCallId: request.toolOutputCallId,
        }),
      );
      return hold.resume.promise;
    },
    stop() {
      stopped = true;
      hold?.finish(new Error("QA continuation provider stopped"));
    },
  };
}
