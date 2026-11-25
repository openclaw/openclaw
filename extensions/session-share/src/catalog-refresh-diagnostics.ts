import {
  areDiagnosticsEnabledForProcess,
  createSubsystemLogger,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

const log = createSubsystemLogger("gateway/session-catalog");
const nodeErrorCodes = new Set([
  "TIMEOUT",
  "NOT_CONNECTED",
  "PAIRING_CHANGED",
  "ROUTE_CHANGED",
  "ABORTED",
  "UNAVAILABLE",
  "POLICY_CHANGED",
  "APPROVAL_AUTHORITY_CLOSED",
]);

export async function observeCatalogRefresh<T>(operation: () => Promise<T>, warn: () => boolean) {
  if (!areDiagnosticsEnabledForProcess() || !log.isEnabled("warn")) {
    return operation();
  }
  const started = performance.now();
  const finish = (outcome: "resolved" | "rejected", error?: unknown) => {
    try {
      if (!areDiagnosticsEnabledForProcess() || !log.isEnabled("warn")) {
        return;
      }
      const elapsedMs = performance.now() - started;
      if (elapsedMs < 1_000 || !warn()) {
        return;
      }
      const details = asOptionalRecord(asOptionalRecord(error)?.details);
      const nodeError = asOptionalRecord(details?.nodeError);
      const nodeErrorCode = nodeError?.code;
      log.warn("slow Session Share catalog refresh", {
        elapsedMs: Math.round(elapsedMs),
        outcome,
        ...(nodeError
          ? {
              nodeErrorCode:
                typeof nodeErrorCode === "string" && nodeErrorCodes.has(nodeErrorCode)
                  ? nodeErrorCode
                  : "unknown",
            }
          : {}),
        ...(typeof details?.nodeCommandDispatched === "boolean"
          ? { nodeCommandDispatched: details.nodeCommandDispatched }
          : {}),
      });
    } catch {
      // A diagnostic sink must not replace the catalog result or error.
    }
  };
  try {
    const value = await operation();
    finish("resolved");
    return value;
  } catch (error) {
    finish("rejected", error);
    throw error;
  }
}
