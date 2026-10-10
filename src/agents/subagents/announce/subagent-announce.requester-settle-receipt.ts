import type {
  CapturedSessionEntryCurrentRead,
  SessionEntryCurrentFacts,
} from "../../../config/sessions/session-entry-current.types.js";
import { captureSystemEventStoreCurrentCheck } from "../../../infra/system-event-ownership.js";
import { isIncognitoSessionKey } from "../../../routing/session-key.js";
import { evaluateGatewayToolCallerReceiptAdmission } from "../../tools/gateway-caller-context.js";
import type { GatewayToolCallerReceiptAdmission } from "../../tools/gateway-caller-receipt.types.js";

/** Watch effects retain their original stores; the durable wake keeps its ordinary handoff rules. */
export function createRequesterSettleReceiptAdmission(params: {
  requester: { canonicalKey: string; agentId?: string; storePath?: string };
  identity: { sessionId: string; lifecycleRevision?: string };
  storeSessionKey: string;
  storeAgentId?: string;
  storePaths(): readonly (string | null | undefined)[];
  isRecoveryCurrent(): boolean;
  readCurrent(): SessionEntryCurrentFacts | undefined;
  isStoreCurrent(): boolean;
}) {
  const isEntryCurrent = (entry: SessionEntryCurrentFacts | undefined) =>
    entry?.sessionId === params.identity.sessionId &&
    entry.lifecycleRevision === params.identity.lifecycleRevision &&
    params.isRecoveryCurrent();
  const admission: GatewayToolCallerReceiptAdmission = {
    async prepare() {
      const storeCurrent = captureSystemEventStoreCurrentCheck(
        params.storeSessionKey,
        params.storeAgentId,
      );
      const [
        { withSessionEntryReadOnlyInWorker },
        { captureSessionEntryCurrentRead, captureNativeSessionEntryCurrentRead },
      ] = await Promise.all([
        import("../../../config/sessions/session-entry-read-runtime.js"),
        import("../../../config/sessions/session-entry-current-runtime.js"),
      ]);
      const scope = {
        sessionKey: params.requester.canonicalKey,
        agentId: params.requester.agentId,
        storePath: params.requester.storePath,
        projection: "list" as const,
      };
      const bind = (
        current: CapturedSessionEntryCurrentRead,
        entry: SessionEntryCurrentFacts | undefined,
      ) => {
        let currentEntry = entry;
        const isCurrent = () => {
          try {
            current.assertSourceCurrent();
            return (
              params.storePaths().every(storeCurrent) &&
              isEntryCurrent(current.kind === "file" ? currentEntry : current.readCurrent())
            );
          } catch {
            return false;
          }
        };
        return {
          current: {
            sources: current.kind === "file" ? [current.source] : [],
            assertCurrent(entries: readonly (SessionEntryCurrentFacts | undefined)[]) {
              if (current.kind === "file") {
                currentEntry = entries[0];
              }
              if (!isCurrent()) {
                throw new Error("Requester settle authority changed during watch admission");
              }
            },
          },
          isCurrent,
        };
      };
      if (isIncognitoSessionKey(scope.sessionKey)) {
        return bind(captureNativeSessionEntryCurrentRead(scope), undefined);
      }
      return withSessionEntryReadOnlyInWorker(
        scope,
        () => {},
        async (read, owner) => {
          if (!read.ok) {
            throw read.error;
          }
          return bind(captureSessionEntryCurrentRead(scope, owner), read.value);
        },
      );
    },
  };
  return Object.assign(admission, {
    isRequesterCurrent: () => {
      try {
        return evaluateGatewayToolCallerReceiptAdmission(admission, () =>
          isEntryCurrent(params.readCurrent()),
        );
      } catch {
        return false;
      }
    },
    isStoreCurrent: () =>
      evaluateGatewayToolCallerReceiptAdmission(admission, () => params.isStoreCurrent()),
  });
}
