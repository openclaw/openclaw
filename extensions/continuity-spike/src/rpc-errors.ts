import { ErrorCodes, errorShape } from "openclaw/plugin-sdk/gateway-runtime";
import { ContinuityError } from "./state-helpers.js";

/** Keep method failure categories distinct without extending the Gateway protocol. */
export function continuityRpcError(error: unknown): ReturnType<typeof errorShape> {
  const context =
    error instanceof Error
      ? /^continuity-context(?:-host)?:([a-z-]+)$/.exec(error.message)?.[1]
      : undefined;
  const reason =
    error instanceof ContinuityError && /^[a-z][a-z-]{0,127}$/.test(error.code)
      ? error.code
      : context;
  if (!reason) {
    // Unknown backend errors may contain private paths or an uncertain write outcome.
    return errorShape(ErrorCodes.UNAVAILABLE, "continuity-spike-unavailable", {
      retryable: false,
      details: { pluginId: "continuity-spike", category: "service" },
    });
  }
  const service =
    reason === "service-not-running" ||
    reason === "plugin-retired" ||
    reason === "host-retired" ||
    reason === "native-session-scheduler-unavailable" ||
    reason === "scheduled-turn-cleanup-failed" ||
    reason === "state-write-not-committed" ||
    reason === "atomic-store-update-unavailable" ||
    reason === "invalid-stored-role" ||
    reason === "invalid-store" ||
    reason === "invalid-aggregate-bounds";
  const denied = reason.includes("denied") || reason === "personal-requires-host-capability";
  const input =
    reason.startsWith("invalid-") ||
    reason.startsWith("missing-rpc-") ||
    reason === "unexpected-field" ||
    reason === "duplicate-selection" ||
    reason === "choose-exact-selection-or-conversation" ||
    reason === "selection-not-in-conversation";
  const category = service ? "service" : denied ? "denied" : input ? "input" : "conflict";
  return errorShape(
    service ? ErrorCodes.UNAVAILABLE : denied ? ErrorCodes.FORBIDDEN : ErrorCodes.INVALID_REQUEST,
    context && error instanceof Error ? error.message : reason,
    {
      retryable:
        reason === "service-not-running" || reason === "native-session-scheduler-unavailable",
      details: { pluginId: "continuity-spike", category, reason },
    },
  );
}
