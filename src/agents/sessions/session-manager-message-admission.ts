import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  captureSessionPendingInputWorkerCustody,
  type SessionPendingInputWorkerReceipt,
} from "../../config/sessions/session-accessor.sqlite-pending-inputs.js";
import type { SqliteWorkerAdmissionRequest } from "../../infra/sqlite-worker-operation-admission.js";
import type { SessionMetadataMessageControl } from "./session-manager-metadata.worker.js";

/** Host closures retain authority; worker commands carry only their matching custody facts. */
export function captureSessionMessageAdmission(
  assertCurrent: () => void,
  controls?: { beforeFreshMessageCommit?: () => void },
) {
  const pendingInput = captureSessionPendingInputWorkerCustody();
  const control: SessionMetadataMessageControl = {
    ...(pendingInput
      ? { pendingInput: { facts: pendingInput.facts, relocation: pendingInput.relocation } }
      : {}),
    ...(controls?.beforeFreshMessageCommit ? { freshMessageCheck: true } : {}),
  };
  return {
    control,
    assertAdmission(this: void, request: SqliteWorkerAdmissionRequest) {
      const facts = request.facts;
      if (!isRecord(facts) || facts.kind !== "session-message") {
        return request;
      }
      assertCurrent();
      if (facts.check === "pending") {
        if (!pendingInput) {
          throw new Error("Session message has no captured pending input owner");
        }
        pendingInput.assertCurrent();
      } else if (facts.check === "fresh") {
        if (!controls?.beforeFreshMessageCommit) {
          throw new Error("Session message has no captured fresh-message assertion");
        }
        controls.beforeFreshMessageCommit();
      } else if (facts.check !== undefined) {
        throw new Error("Session message requested an invalid admission check");
      }
      assertCurrent();
      return { ...request, facts: facts.domainFacts };
    },
    publish(receipt: SessionPendingInputWorkerReceipt | undefined) {
      if (receipt) {
        pendingInput?.publish(receipt);
      }
    },
  };
}
