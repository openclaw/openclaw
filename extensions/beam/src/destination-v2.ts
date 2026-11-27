import { dispatchGatewayMethod } from "openclaw/plugin-sdk/gateway-method-runtime";
import type { GatewayRequestAuthorityV1 } from "openclaw/plugin-sdk/gateway-request-authority";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { BeamHandoff } from "./types.js";

export type BeamDestination =
  | { state: "released_unbound" | "creating" | "needs_reconciliation" }
  | { state: "ready"; reference: string; sessionKey: string; sessionId: string };

export async function readBeamDestination(
  row: BeamHandoff,
  hasSnapshot: boolean,
  auth: GatewayRequestAuthorityV1,
  dispatch = dispatchGatewayMethod,
): Promise<BeamDestination | "unavailable" | "source_owned"> {
  auth.assertCurrent();
  const shared = auth.scopes.some((scope) =>
    ["operator.read", "operator.write", "operator.admin"].includes(scope),
  );
  const owned =
    auth.requiredGrantPluginId === "visitor-access" &&
    auth.scopes.includes("operator.sessions.write") &&
    auth.personProfileId &&
    auth.personProfileId === row.publisherProfileId;
  if (!shared && !owned) {
    return "unavailable";
  }
  if (!row.handoffId) {
    return "source_owned";
  }
  const binding = row.continuation;
  if (!binding) {
    return { state: hasSnapshot ? "released_unbound" : "needs_reconciliation" };
  }
  if (!binding.ready && !binding.creating) {
    // Reserving a key is reversible until creation starts. With no retained transcript,
    // a reserved or rolled-back binding cannot start a destination.
    return { state: hasSnapshot ? "creating" : "needs_reconciliation" };
  }
  const result = await dispatch(shared ? "sessions.catalog.resolve" : "beam.owned.resolve", {
    catalogId: "beam",
    hostId: "gateway",
    threadId: row.beamId,
    agentId: binding.agentId,
  });
  auth.assertCurrent();
  if (!result.ok) {
    if (result.error?.code !== "UNAVAILABLE") {
      return "unavailable";
    }
    return { state: binding.ready || !hasSnapshot ? "needs_reconciliation" : "creating" };
  }
  const verified = result.payload;
  // The host returns the actual session incarnation from the same row it checked for
  // this catalog's provenance. A second lookup by key alone could select a replacement.
  if (
    !isRecord(verified) ||
    verified.sessionKey !== binding.sessionKey ||
    typeof verified.sessionId !== "string" ||
    !verified.sessionId
  ) {
    return { state: "needs_reconciliation" };
  }
  auth.assertCurrent();
  return {
    state: "ready",
    reference: binding.id,
    sessionKey: binding.sessionKey,
    sessionId: verified.sessionId,
  };
}
