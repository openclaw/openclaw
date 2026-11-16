import type {
  CapturedSessionEntryCurrentRead,
  SessionEntryCurrentFacts,
} from "../../../config/sessions/session-entry-current.types.js";
import { isIncognitoSessionKey } from "../../../routing/session-key.js";
import { evaluateGatewayToolCallerReceiptAdmission } from "../../tools/gateway-caller-context.js";
import type { GatewayToolCallerReceiptAdmission } from "../../tools/gateway-caller-receipt.types.js";

/** The durable wake follows the requester by key; it keeps its ordinary handoff rules. */
export function createRequesterSettleReceiptAdmission(params: {
  requester: { canonicalKey: string; agentId?: string; storePath?: string };
  readCurrent(): SessionEntryCurrentFacts | undefined;
}) {
  // The session key is the address: a reset or a compaction successor stays current.
  const isEntryCurrent = (entry: SessionEntryCurrentFacts | undefined) => entry !== undefined;
  const admission: GatewayToolCallerReceiptAdmission = {
    async prepare() {
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
            return isEntryCurrent(current.kind === "file" ? currentEntry : current.readCurrent());
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
  });
}
