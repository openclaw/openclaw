import type { ServerResponse } from "node:http";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { resolveQaDebugRequestCursor } from "../shared/debug-request-cursor.js";
import { writeJson, writeJsonArray } from "../shared/http-json.js";
import type { QaMockContinuationCheckpoint, QaMockContinuationHold } from "../shared/types.js";
import {
  MOCK_OPENAI_DEBUG_REQUEST_LIMIT,
  type MockOpenAiRequestSnapshot,
  type MockOpenAiRequestSnapshotInput,
} from "./mock-openai-contracts.js";

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
      } else if (
        url.pathname === "/debug/requests" ||
        url.pathname === "/debug/request-plans"
      ) {
        const afterText = url.searchParams.get("after");
        const after =
          afterText === null
            ? null
            : resolveQaDebugRequestCursor(
                afterText,
                requests[0]?.cursor ?? nextCursor,
                nextCursor - 1,
              );
        if (after !== null && typeof after !== "number") {
          writeJson(res, after.status, after.body);
          return true;
        }
        // Freeze membership before streaming: rotation or new requests must not change this read.
        const selected = requests.filter((request) => after === null || request.cursor > after);
        if (url.pathname === "/debug/request-plans") {
          const inputContains = url.searchParams.get("inputContains")?.toLowerCase();
          if (!inputContains) {
            writeJson(res, 400, { error: "inputContains must be non-empty" });
            return true;
          }
          writeJson(
            res,
            200,
            selected
              .filter((request) => request.allInputText.toLowerCase().includes(inputContains))
              .map((request) => ({
                cursor: request.cursor,
                plannedToolName: request.plannedToolName ?? null,
              })),
          );
        } else {
          writeJsonArray(res, selected);
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
