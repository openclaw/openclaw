import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import type { RenderedMessageBatch, RenderedMessageBatchPlan } from "./types.js";
export declare function createRenderedMessageBatchPlan(payloads: readonly ReplyPayload[]): RenderedMessageBatchPlan;
export declare function createRenderedMessageBatch(payloads: ReplyPayload[]): RenderedMessageBatch<ReplyPayload>;
