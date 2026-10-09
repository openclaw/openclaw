import { fileURLToPath } from "node:url";
import {
  captureCodexSessionContextReader,
  readCodexSessionContextProjection,
  SessionTranscriptReadFenceError,
  type CodexSessionContextReader,
} from "openclaw/plugin-sdk/codex-session-transcript-runtime";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
  WorkerTaskPool,
} from "openclaw/plugin-sdk/process-runtime";
import { isIncognitoSessionKey } from "openclaw/plugin-sdk/session-key-runtime";
import {
  runCodexHistoryWorkerInput,
  type CodexHistoryWorkerInput,
  type CodexHistoryWorkerResult,
} from "./session-history.worker.js";
import {
  codexHistoryRejectionReason,
  type CodexHistoryReadResult,
} from "./src/app-server/history-rejection.js";
import type { JsonValue } from "./src/app-server/protocol.js";
import { consumeCodexHistory } from "./src/app-server/session-history-read.js";
import {
  resolveCodexHistoryTarget,
  type CodexMirroredSessionHistoryTarget,
} from "./src/app-server/session-history.js";
import type { SettledTurnMessages } from "./src/app-server/settled-turn-evidence.js";
import { projectVerifiedSettledCodexMessages } from "./src/app-server/settled-turn-evidence.js";

const codexHistoryWorkerEntrypoint = {
  currentModuleUrl: import.meta.url,
  sourceWorkerName: "session-history.worker",
  distWorkerPath: "extensions/codex/session-history.worker.js",
  package: {
    name: "@openclaw/codex",
    distWorkerPath: "session-history.worker.js",
  },
} as const;

const sourceWorkerUrl = resolveRuntimeWorkerUrl(codexHistoryWorkerEntrypoint);
const sourceNeedsBuiltFallback =
  /\.[cm]?ts$/u.test(sourceWorkerUrl.pathname) &&
  (typeof process.versions.bun === "string" ||
    resolveRuntimeWorkerArgv(sourceWorkerUrl).length === 1);
// oxlint-disable-next-line no-warning-comments -- removal awaits Bun Worker preload resolver support.
// TODO: Remove this fallback once Bun Workers apply resolver hooks from execArgv --import preloads.
const historyReads = new WorkerTaskPool<CodexHistoryWorkerInput, CodexHistoryWorkerResult>({
  workerUrl: sourceNeedsBuiltFallback
    ? resolveRuntimeWorkerUrl({
        ...codexHistoryWorkerEntrypoint,
        root: fileURLToPath(new URL("../..", import.meta.url)),
      })
    : sourceWorkerUrl,
  workerClass: "reader",
  // Published plugin supports older hosts that only understand numeric sizing.
  maxWorkers: 1,
});

export async function projectCodexSettledHistoryInWorker(
  target: CodexMirroredSessionHistoryTarget & SettledTurnMessages,
  signal?: AbortSignal,
  contextReader?: CodexSessionContextReader,
): Promise<CodexHistoryReadResult<JsonValue[]>> {
  signal?.throwIfAborted();
  if (contextReader && !target.sessionTarget) {
    throw new Error("Actor history requires a captured sessionTarget");
  }
  const resolved = resolveCodexHistoryTarget(target);
  const reader =
    contextReader ??
    (target.sessionTarget && resolved.kind === "sqlite"
      ? captureCodexSessionContextReader({ ...target.sessionTarget, ...resolved.target }, signal)
      : undefined);
  if (reader) {
    if (resolved.kind !== "sqlite") {
      throw new Error("Actor history requires a complete matching sessionTarget");
    }
    let result: CodexHistoryReadResult<JsonValue[]>;
    try {
      result = await reader(resolved.target, (messages, header) => {
        signal?.throwIfAborted();
        try {
          return {
            status: "ok",
            value: consumeCodexHistory(messages, header, target.sessionId, (history) =>
              projectVerifiedSettledCodexMessages(history, target),
            ),
          };
        } catch (error) {
          return { status: "rejected", reason: codexHistoryRejectionReason(error) };
        }
      });
    } catch (error) {
      if (error instanceof SessionTranscriptReadFenceError) {
        result = { status: "rejected", reason: "snapshot_invalidated" };
      } else {
        throw error;
      }
    }
    signal?.throwIfAborted();
    return result;
  }
  const evidence = {
    mirroredMessages: target.mirroredMessages,
    settledMessages: target.settledMessages,
    turnId: target.turnId,
  };
  if (resolved.kind === "sqlite") {
    try {
      return await readCodexSessionContextProjection(
        resolved.target,
        async ({ target: captured, admission, physicalSource }) => {
          const input: CodexHistoryWorkerInput = {
            target: { kind: "sqlite", target: captured },
            sessionId: target.sessionId,
            admission,
            physicalSource,
            evidence,
          };
          // Legacy process-held incognito cannot be reopened in another worker.
          const result = isIncognitoSessionKey(captured.sessionKey)
            ? await runCodexHistoryWorkerInput(input)
            : await historyReads.run(input, { timeoutMs: 60_000, signal });
          return { value: result.result, version: result.version };
        },
        signal,
      );
    } catch (error) {
      signal?.throwIfAborted();
      return {
        status: "rejected",
        reason:
          error instanceof SessionTranscriptReadFenceError
            ? "snapshot_invalidated"
            : codexHistoryRejectionReason(error),
      };
    }
  }
  const input: CodexHistoryWorkerInput = {
    target: resolved,
    sessionId: target.sessionId,
    evidence,
  };
  const result = await historyReads.run(input, { timeoutMs: 60_000, signal });
  signal?.throwIfAborted();
  return result.result;
}
