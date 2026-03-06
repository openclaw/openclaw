import type { ReplyPayload } from "../../auto-reply/types.js";
import type { OutboundDeliveryJson } from "./format.js";
import { type OutboundPayloadJson } from "./payloads.js";
export type OutboundResultEnvelope = {
    payloads?: OutboundPayloadJson[];
    meta?: unknown;
    delivery?: OutboundDeliveryJson;
};
type BuildEnvelopeParams = {
    payloads?: readonly ReplyPayload[] | readonly OutboundPayloadJson[];
    meta?: unknown;
    delivery?: OutboundDeliveryJson;
    flattenDelivery?: boolean;
};
export declare function buildOutboundResultEnvelope(params: BuildEnvelopeParams): OutboundResultEnvelope | OutboundDeliveryJson;
export {};
