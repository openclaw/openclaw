import { createHash, randomUUID } from "node:crypto";
import {
  dispatchGatewayMethod,
  sendToResolvedSession,
} from "openclaw/plugin-sdk/gateway-method-runtime";
import type { GatewayRequestAuthorityV1 } from "openclaw/plugin-sdk/gateway-request-authority";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
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
  ) {
    return { key: digest("person", profile), guestProfileId: profile };
  }
  return undefined;
}

export function createBeamContinuation(
  runtime: PluginRuntime,
  store: ReadStore,
  dispatch = dispatchGatewayMethod,
  send = sendToResolvedSession,
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
    const publicationId = initial.publicationId;
    const actor = sendActor(auth, initial, !input);
    if (!publicationId || !actor) {
      return "unavailable";
    }
    // HTTP already admitted a status read. It keeps that identity and request lifetime;
    // a new owned Visitor effect must still hold its original grant at dispatch and commit.
    const guestProfileId = actor.guestProfileId;
    const requiredGrant = input && guestProfileId ? "visitor-access" : undefined;
    const assertCurrent = () => auth.assertCurrent(requiredGrant);
    async function revalidate() {
      // Read-only status uses the captured dispatch lease. Only effects refresh asynchronous guards.
      if (input) {
        await auth.revalidate(requiredGrant);
      }
      assertCurrent();
    }
    async function current() {
      await revalidate();
      const publication = await store.readPublication(initial.beamId);
      const row = publication.snapshot ?? publication.ownership;
      if (
        !row ||
        row.publicationId !== publicationId ||
        (guestProfileId && guestProfileId !== row.publisherProfileId)
      ) {
        return undefined;
      }
      const destination = await readBeamDestination(
        row,
        Boolean(publication.snapshot),
        auth,
        dispatch,
      );
      assertCurrent();
      return { row, destination };
    }
    let view = await current();
    if (!view) {
      return "unavailable";
    }
    if (typeof view.destination === "string") {
      return view.destination;
    }
    if (input && view.destination.state === "released_unbound") {
      // The host owns authorization, one destination binding and crash reconciliation.
      // An adoption ACK is never a message-send ACK.
      await revalidate();
      const adopted = await dispatch(
        actor.guestProfileId ? "beam.owned.continue" : "sessions.catalog.continue",
        {
          catalogId: "beam",
          hostId: "gateway",
          threadId: view.row.beamId,
          ...(input.agent ? { agentId: input.agent } : {}),
        },
      );
      if (!adopted.ok && adopted.error?.code !== "UNAVAILABLE") {
        return "unavailable";
      }
      view = await current();
      if (!view) {
        return "unavailable";
      }
    }
    if (typeof view.destination === "string") {
      return view.destination;
    }
    const target = view.destination.state === "ready" ? view.destination : undefined;
    const lookup = {
      beamId: initial.beamId,
      publicationId,
      actor,
      requestKey: digest("continue", initial.beamId, publicationId, requestId),
      ...(target ? { target: { reference: target.reference, sessionKey: target.sessionKey } } : {}),
    };
    const operation = handoffs.createOperation?.<BeamSendOperations>(
      [handoffs, identities, receipts],
      { moduleName: "continuation-operation-api.js", exportName: "executeBeamSend" },
      { assertCurrent },
    );
    if (!operation) {
      throw new Error("Beam continuation requires worker-owned state operations");
    }
    const act = async (action: BeamSendOperations["request"]["input"]) => {
      const writes = !target || action.op === "status" ? [] : action.op === "claim" ? [1, 2] : [2];
      try {
        const receipt = await operation.execute(
          { type: "request", input: action },
          { writeStores: writes },
        );
        await revalidate();
        return receipt.value;
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "PLUGIN_STATE_LIMIT_EXCEEDED"
        ) {
          await revalidate();
          return "rate_limited" as const;
        }
        throw error;
      }
    };
    const expose = (
      state: BeamSendState | BeamSendRefusal,
      sentHere = false,
    ): BeamContinuationResult => {
      if (state === "accepted" && sentHere && target) {
        return { state, requestId, destination: { state: "ready", reference: target.reference } };
      }
      // On replay, an accepted native acknowledgement describes the original turn only.
      // The authorized logical destination may now point to a different native session.
      if (state === "pending" || state === "accepted" || state === "needs_reconciliation") {
        return { state, requestId };
      }
      return state;
    };
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
    if (decision !== "claimed") {
      return expose(decision);
    }
    if (!input || !target) {
      throw new Error("Beam claimed a send without an instruction or ready destination");
    }
    // From here a crash, timeout, or missing host ACK must never trigger another native turn.
    let delivery: Awaited<ReturnType<typeof send>> = "unconfirmed";
    await revalidate();
    try {
      delivery = await send({
        target: { sessionKey: target.sessionKey, sessionId: target.sessionId },
        message: input.instruction,
        idempotencyKey: claim,
      });
    } catch {
      // A transport failure leaves the outcome unknown; the durable claim prevents a second send.
    }
    const state = await act({
      op: "settle",
      lookup,
      claim,
      state: delivery === "accepted" ? "accepted" : "needs_reconciliation",
    });
    if (delivery === "forbidden") {
      return "unavailable";
    }
    if (state === "claimed") {
      throw new Error("invalid Beam send settlement");
    }
    return expose(state, true);
  }

  return {
    continue: (row: BeamHandoff, input: SendInput, auth: GatewayRequestAuthorityV1) =>
      run(row, input.requestId, auth, input),
    status: (row: BeamHandoff, requestId: string, auth: GatewayRequestAuthorityV1) =>
      run(row, requestId, auth),
  };
}

export type BeamContinueService = ReturnType<typeof createBeamContinuation>;
