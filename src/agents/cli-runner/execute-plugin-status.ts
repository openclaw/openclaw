import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { CliBackendTurnStatus } from "../../plugins/cli-backend-turn-status.types.js";
import type {
  ReplyBackendTurnAssessment,
  ReplyBackendTurnStatus,
} from "../../sessions/session-controller.turn-status.types.js";

function readTurnAssessment(value: unknown): ReplyBackendTurnAssessment {
  if (isRecord(value)) {
    const { state, basis } = value;
    if (state === "closed" && (basis === "process_exited" || basis === "transport_closed")) {
      return { state, basis };
    }
    if (
      state === "unknown" &&
      (basis === "process_present" ||
        basis === "status_unsupported" ||
        basis === "busy" ||
        basis === "transient_error")
    ) {
      return { state, basis };
    }
  }
  return { state: "unknown", basis: "invalid" };
}

/** Bind plugin facts to the host's exact registration; the watchdog owns the only timeout. */
export function bindCliTurnStatus(
  status: CliBackendTurnStatus,
  ownsRegistration: () => boolean,
): ReplyBackendTurnStatus {
  return {
    capture() {
      if (!ownsRegistration()) {
        return undefined;
      }
      const captured = status.capture();
      if (!captured) {
        return undefined;
      }
      const isCurrent = () => ownsRegistration() && captured.isCurrent() && ownsRegistration();
      return {
        isCurrent,
        async assess({ signal }) {
          if (!isCurrent()) {
            return { state: "unknown", basis: "status_unsupported" };
          }
          const result = await captured.assess({ signal });
          return isCurrent()
            ? readTurnAssessment(result)
            : { state: "unknown", basis: "status_unsupported" };
        },
      };
    },
  };
}
