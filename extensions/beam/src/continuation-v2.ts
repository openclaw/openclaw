import { createHash, randomUUID } from "node:crypto";
import { dispatchGatewayMethod } from "openclaw/plugin-sdk/gateway-method-runtime";
import type { GatewayRequestAuthorityV1 } from "openclaw/plugin-sdk/gateway-request-authority";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type {
  BeamSendActor,
  BeamSendOperations,
  BeamSendRefusal,
  BeamSendState,
} from "../continuation-operation-api.js";
import { readBeamDestination } from "./destination-v2.js";
import type { BeamPublication } from "./store.js";
import { BEAM_MAX_WRITE_RECEIPTS, BEAM_RETENTION_MS, type BeamHandoff } from "./types.js";

type SendInput = { requestId: string; instruction: string; agent?: string };
type ReadStore = { readPublication(beamId: string): Promise<BeamPublication> };
type PublicOutcome = {
  requestId: string;
  state: BeamSendState;
  destination?: { state: "ready"; reference: string };
};
export type BeamContinuationResult = PublicOutcome | BeamSendRefusal;

function digest(...parts: (string | null)[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}
function sendActor(
  auth: GatewayRequestAuthorityV1,
  row: BeamHandoff,
  readOnly: boolean,
): BeamSendActor | undefined {
  if (
    auth.scopes.includes("operator.admin") ||
    auth.scopes.includes("operator.write") ||
    (readOnly && auth.scopes.includes("operator.read"))
  ) {
    return {
      key: auth.personProfileId
        ? digest("person", auth.personProfileId)
        : digest("shared-operator"),
    };
  }
  const profile = auth.personProfileId;
  if (
    profile &&
    profile === row.publisherProfileId &&
    auth.requiredGrantPluginId === "visitor-access" &&
    auth.scopes.includes("operator.sessions.write")
  )
    return { key: digest("person", profile), guestProfileId: profile };
  return undefined;
}

export function createBeamContinuation(
  runtime: PluginRuntime,
  store: ReadStore,
  dispatch = dispatchGatewayMethod,
) {
  const handoffs = runtime.state.openKeyedStoreV2<BeamHandoff>({
    namespace: "handoffs",
    retention: "retained",
  });
  const identities = runtime.state.openKeyedStoreV2({
    namespace: "continuation-identities",
    retention: "retained",
  });
  const receipts = runtime.state.openKeyedStoreV2({
    namespace: "continuation-requests",
    maxEntries: BEAM_MAX_WRITE_RECEIPTS,
    overflowPolicy: "reject-new",
    defaultTtlMs: BEAM_RETENTION_MS,
  });

  async function run(
    initial: BeamHandoff,
    requestId: string,
    auth: GatewayRequestAuthorityV1,
    input?: SendInput,
  ): Promise<BeamContinuationResult> {
    const generation = initial.publicationId;
    if (!generation) return "unavailable";
    async function current() {
      await auth.revalidate();
      auth.assertCurrent();
      const publication = await store.readPublication(initial.beamId);
      const row = publication.snapshot ?? publication.ownership;
      if (!row || row.publicationId !== generation) return;
      const actor = sendActor(auth, row, !input);
      if (!actor) return;
      const destination = await readBeamDestination(
        row,
        Boolean(publication.snapshot),
        auth,
        dispatch,
      );
      return { row, actor, destination };
    }
    let view = await current();
    if (!view) return "unavailable";
    if (typeof view.destination === "string") return view.destination;
    if (input && view.destination.state === "released_unbound") {
      // The host owns authorization, one destination binding and crash reconciliation.
      // An adoption ACK is never a message-send ACK.
      const adopted = await dispatch(
        view.actor.guestProfileId ? "beam.owned.continue" : "sessions.catalog.continue",
        {
          catalogId: "beam",
          hostId: "gateway",
          threadId: view.row.beamId,
          ...(input.agent ? { agentId: input.agent } : {}),
        },
      );
      if (!adopted.ok && adopted.error?.code !== "UNAVAILABLE") return "unavailable";
      view = await current();
      if (!view) return "unavailable";
    }
    if (typeof view.destination === "string") return view.destination;
    if (!input && view.destination.state === "released_unbound") return "unavailable";
    if (view.destination.state !== "ready") return { requestId, state: "needs_reconciliation" };
    const target = view.destination;
    const lookup = {
      beamId: initial.beamId,
      generation,
      actor: view.actor,
      requestKey: digest("continue", initial.beamId, generation, requestId),
      target,
    };
    const operation = handoffs.createOperation?.<BeamSendOperations>(
      [handoffs, identities, receipts],
      { moduleName: "continuation-operation-api.js", exportName: "executeBeamSend" },
      { assertCurrent: auth.assertCurrent },
    );
    if (!operation) throw new Error("Beam continuation requires worker-owned state operations");
    const act = async (action: BeamSendOperations["request"]["input"]) => {
      const writes = action.op === "status" ? [] : action.op === "claim" ? [1, 2] : [2];
      try {
        const receipt = await operation.execute(
          { type: "request", input: action },
          { writeStores: writes },
        );
        await auth.revalidate();
        auth.assertCurrent();
        return receipt.value;
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "PLUGIN_STATE_LIMIT_EXCEEDED"
        )
          return "rate_limited" as const;
        throw error;
      }
    };
    const expose = (state: BeamSendState | BeamSendRefusal): BeamContinuationResult =>
      state === "needs_reconciliation"
        ? { state, requestId }
        : state === "accepted" || state === "pending"
          ? { state, requestId, destination: { state: "ready", reference: target.reference } }
          : state;
    const claim = randomUUID();
    const decision = await act(
      input
        ? {
            op: "claim",
            lookup,
            claim,
            ...(input.agent ? { agent: input.agent } : {}),
            fingerprint: digest(input.instruction, input.agent ?? null),
          }
        : { op: "status", lookup },
    );
    if (decision !== "claimed") return expose(decision);
    if (!input) throw new Error("read-only Beam status claimed a send");
    // From here a crash, timeout, or missing host ACK must never trigger another native turn.
    let accepted = false;
    let denied = false;
    try {
      await auth.revalidate();
      auth.assertCurrent();
      const reply = await dispatch("chat.send", {
        sessionKey: target.sessionKey,
        sessionId: target.sessionId,
        expectedSessionId: target.sessionId,
        message: input.instruction,
        idempotencyKey: claim,
      });
      denied = !reply.ok && reply.error?.code === "FORBIDDEN";
      accepted =
        reply.ok &&
        isRecord(reply.payload) &&
        reply.payload.runId === claim &&
        (reply.payload.status === "started" || reply.payload.status === "in_flight");
    } catch {
      // Transport failure leaves delivery unknown; the durable claim prevents a second dispatch.
    }
    const state = await act({
      op: "settle",
      lookup,
      claim,
      state: accepted ? "accepted" : "needs_reconciliation",
    });
    if (denied) return "unavailable";
    if (state === "claimed") throw new Error("invalid Beam send settlement");
    return expose(state);
  }

  return {
    continue: (row: BeamHandoff, input: SendInput, auth: GatewayRequestAuthorityV1) =>
      run(row, input.requestId, auth, input),
    status: (row: BeamHandoff, requestId: string, auth: GatewayRequestAuthorityV1) =>
      run(row, requestId, auth),
  };
}

export type BeamContinueService = ReturnType<typeof createBeamContinuation>;
