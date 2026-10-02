import { redactSensitiveText } from "../../src/logging/redact.js";
import { OpenClawStateLeaseAcquisitionError } from "../../src/state/openclaw-state-lease-error.js";
import {
  encodeOpenClawStateWorkerError,
  hydrateOpenClawStateWorkerError,
  retainOpenClawStateWorkerErrorPayload,
} from "../../src/state/openclaw-state-worker-error.js";

/** Render the closed error contract, never arbitrary thrown-object properties. */
export function formatProvisionError(error: unknown): string {
  const unavailable = "Provisioning failed; diagnostic unavailable.";
  try {
    const graph = encodeOpenClawStateWorkerError(error, { includeOrdinary: true });
    if (!graph) {
      return typeof error === "string"
        ? redactSensitiveText(error, { mode: "tools" })
        : unavailable;
    }
    // Error fields can be replaced at runtime. The wire owner validates all
    // graph fields before JSON can invoke a hostile field's toJSON hook.
    const carrier = new Error();
    retainOpenClawStateWorkerErrorPayload(carrier, graph);
    const validated = hydrateOpenClawStateWorkerError(carrier, { includeOrdinary: true });
    if (validated === carrier) {
      return unavailable;
    }
    let outcome;
    if (error instanceof OpenClawStateLeaseAcquisitionError) {
      const value = error.outcome;
      const { kind } = value;
      if (kind === "store-unavailable") {
        const { reason } = value;
        if (!["sqlite-busy", "lifecycle-busy", "storage-error"].includes(reason)) {
          return unavailable;
        }
        outcome = { kind, reason };
      } else if (kind === "held") {
        const { owner, epoch } = value.holder;
        if (typeof owner !== "string" || !Number.isSafeInteger(epoch)) {
          return unavailable;
        }
        outcome = { kind, holder: { owner, epoch } };
      } else if (kind === "aborted") {
        const { reason, elapsedMs } = value;
        if (reason !== "caller-signal" || !Number.isFinite(elapsedMs)) {
          return unavailable;
        }
        outcome = { kind, reason, elapsedMs };
      } else {
        return unavailable;
      }
    }
    return JSON.stringify(
      {
        error: encodeOpenClawStateWorkerError(validated, { includeOrdinary: true }),
        ...(outcome === undefined ? {} : { outcome }),
      },
      (_key, value: unknown) =>
        typeof value === "string" ? redactSensitiveText(value, { mode: "tools" }) : value,
    );
  } catch {
    // Reporting failures must not replace the provisioning failure or invoke coercion.
    return unavailable;
  }
}
