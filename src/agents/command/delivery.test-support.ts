import { createMessageReceiptFromOutboundResults } from "../../channels/message/receipt.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import { deliverOutboundPayloads } from "../../infra/outbound/deliver.js";
import { drainPendingDeliveriesCore } from "../../infra/outbound/delivery-queue-recovery.js";
import { createRecoveryLog } from "../../infra/outbound/delivery-queue.test-helpers.js";
import { createOutboundTestPlugin } from "../../test-utils/channel-plugins.js";
import { persistPendingFinalDeliveryMarker } from "../pending-final-delivery-marker.js";
import { capturePendingFinalRecoverySource } from "../pending-final-recovery-source.js";
import { deliverAgentCommandResult } from "./delivery.js";

type MarkerParams = Parameters<typeof persistPendingFinalDeliveryMarker>[0];
type SessionTarget = Pick<MarkerParams, "agentId" | "storePath"> & { sessionKey: string };
export const deliveryContext = { channel: "matrix", to: "!owner:example", accountId: "default" };
export const runtime = { log: () => {}, error: () => {}, exit: () => {} };

export function persistMarker(
  target: SessionTarget,
  entry: NonNullable<MarkerParams["sessionEntry"]>,
  payloads: MarkerParams["payloads"],
  overrides: Partial<MarkerParams> = {},
) {
  return persistPendingFinalDeliveryMarker({
    ...target,
    admittedRecoverySource: capturePendingFinalRecoverySource(entry),
    deliver: true,
    sessionStore: { [target.sessionKey]: entry },
    sessionEntry: entry,
    suppressVisibleSessionEffects: false,
    sessionReboundDuringRun: false,
    payloads,
    deliveryContext,
    runOwnedSessionId: entry.sessionId,
    ...overrides,
  });
}

export function recoveryFor(
  cfg: Parameters<typeof drainPendingDeliveriesCore>[0]["cfg"],
  stateDir: string,
  name: string,
) {
  return () =>
    drainPendingDeliveriesCore({
      cfg,
      stateDir,
      drainKey: name,
      logLabel: name,
      log: createRecoveryLog(),
      deliver: deliverOutboundPayloads,
      selectEntry: () => ({ match: true, bypassBackoff: true }),
    });
}

type MessageSend = NonNullable<NonNullable<ChannelPlugin["message"]>["send"]>;
export function matrixPlugin(text: MessageSend["text"], lifecycle?: MessageSend["lifecycle"]) {
  return {
    ...createOutboundTestPlugin({
      id: "matrix",
      outbound: {
        deliveryMode: "direct",
        sendText: async () => {
          throw new Error("message adapter must own the send");
        },
      },
    }),
    message: {
      id: "matrix",
      durableFinal: { capabilities: { text: true } },
      send: { text, lifecycle },
    },
  } satisfies ChannelPlugin;
}

export function textReceipt(messageId: string) {
  return {
    messageId,
    receipt: createMessageReceiptFromOutboundResults({
      results: [{ channel: "matrix", messageId }],
      kind: "text",
    }),
  };
}

type DeliveryParams = Parameters<typeof deliverAgentCommandResult>[0];
export function deliverFinal(
  target: SessionTarget,
  params: Pick<
    DeliveryParams,
    "cfg" | "opts" | "sessionEntry" | "result" | "payloads" | "assertDeliveryCurrent"
  >,
) {
  return deliverAgentCommandResult({
    deps: {},
    runtime,
    outboundSession: { agentId: target.agentId, key: target.sessionKey },
    ...params,
  });
}
