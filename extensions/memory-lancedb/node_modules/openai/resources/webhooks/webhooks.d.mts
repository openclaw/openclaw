import { APIResource } from "../../core/resource.mjs";
import { HeadersLike } from "../../internal/headers.mjs";
export declare class Webhooks extends APIResource {
    #private;
    /**
     * Validates that the given payload was sent by OpenAI and parses the payload.
     */
    unwrap(payload: string, headers: HeadersLike, secret?: string | undefined | null, tolerance?: number): Promise<UnwrapWebhookEvent>;
    /**
     * Validates whether or not the webhook payload was sent by OpenAI.
     *
     * An error will be raised if the webhook payload was not sent by OpenAI.
     *
     * @param payload - The webhook payload
     * @param headers - The webhook headers
     * @param secret - The webhook secret (optional, will use client secret if not provided)
     * @param tolerance - Maximum age of the webhook in seconds (default: 300 = 5 minutes)
     */
    verifySignature(payload: string, headers: HeadersLike, secret?: string | undefined | null, tolerance?: number): Promise<void>;
}
/**
 * Sent when a batch API request has been cancelled.
 */
export interface BatchCancelledWebhookEvent {
    /**
     * The unique ID of the event.
     */
    id: string;
    /**
     * The Unix timestamp (in seconds) of when the batch API request was cancelled.
     */
    created_at: number;
    /**
     * Event data payload.
     */
    data: BatchCancelledWebhookEvent.Data;
    /**
     * The type of the event. Always `batch.cancelled`.
     */
    type: 'batch.cancelled';
    /**
     * The object of the event. Always `event`.
     */
    object?: 'event';
}
export declare namespace BatchCancelledWebhookEvent {
    /**
     * Event data payload.
     */
    interface Data {
        /**
         * The unique ID of the batch API request.
         */
        id: string;
    }
}
/**
 * Sent when a batch API request has been completed.
 */
export interface BatchCompletedWebhookEvent {
    /**
     * The unique ID of the event.
     */
    id: string;
    /**
     * The Unix timestamp (in seconds) of when the batch API request was completed.
     */
    created_at: number;
    /**
     * Event data payload.
     */
    data: BatchCompletedWebhookEvent.Data;
    /**
     * The type of the event. Always `batch.completed`.
     */
    type: 'batch.completed';
    /**
     * The object of the event. Always `event`.
     */
    object?: 'event';
}
export declare namespace BatchCompletedWebhookEvent {
    /**
     * Event data payload.
     */
    interface Data {
        /**
         * The unique ID of the batch API request.
         */
        id: string;
    }
}
/**
 * Sent when a batch API request has expired.
 */
export interface BatchExpiredWebhookEvent {
    /**
     * The unique ID of the event.
     */
    id: string;
    /**
     * The Unix timestamp (in seconds) of when the batch API request expired.
     */
    created_at: number;
    /**
     * Event data payload.
     */
    data: BatchExpiredWebhookEvent.Data;
    /**
     * The type of the event. Always `batch.expired`.
     */
    type: 'batch.expired';
    /**
     * The object of the event. Always `event`.
     */
    object?: 'event';
}
export declare namespace BatchExpiredWebhookEvent {
    /**
     * Event data payload.
     */
    interface Data {
        /**
         * The unique ID of the batch API request.
         */
        id: string;
    }
}
/**
 * Sent when a batch API request has failed.
 */
export interface BatchFailedWebhookEvent {
    /**
     * The unique ID of the event.
     */
    id: string;
    /**
     * The Unix timestamp (in seconds) of when the batch API request failed.
     */
    created_at: number;
    /**
     * Event data payload.
     */
    data: BatchFailedWebhookEvent.Data;
    /**
     * The type of the event. Always `batch.failed`.
     */
    type: 'batch.failed';
    /**
     * The object of the event. Always `event`.
     */
    object?: 'event';
}
export declare namespace BatchFailedWebhookEvent {
    /**
     * Event data payload.
     */
    interface Data {
        /**
         * The unique ID of the batch API request.
         */
        id: string;
    }
}
/**
 * Sent when an eval run has been canceled.
 */
export interface EvalRunCanceledWebhookEvent {
    /**
     * The unique ID of the event.
     */
    id: string;
    /**
     * The Unix timestamp (in seconds) of when the eval run was canceled.
     */
    created_at: number;
    /**
     * Event data payload.
     */
    data: EvalRunCanceledWebhookEvent.Data;
    /**
     * The type of the event. Always `eval.run.canceled`.
     */
    type: 'eval.run.canceled';
    /**
     * The object of the event. Always `event`.
     */
    object?: 'event';
}
export declare namespace EvalRunCanceledWebhookEvent {
    /**
     * Event data payload.
     */
    interface Data {
        /**
         * The unique ID of the eval run.
         */
        id: string;
    }
}
/**
 * Sent when an eval run has failed.
 */
export interface EvalRunFailedWebhookEvent {
    /**
     * The unique ID of the event.
     */
    id: string;
    /**
     * The Unix timestamp (in seconds) of when the eval run failed.
     */
    created_at: number;
    /**
     * Event data payload.
     */
    data: EvalRunFailedWebhookEvent.Data;
    /**
     * The type of the event. Always `eval.run.failed`.
     */
    type: 'eval.run.failed';
    /**
     * The object of the event. Always `event`.
     */
    object?: 'event';
}
export declare namespace EvalRunFailedWebhookEvent {
    /**
     * Event data payload.
     */
    interface Data {
        /**
         * The unique ID of the eval run.
         */
        id: string;
    }
}
/**
 * Sent when an eval run has succeeded.
 */
export interface EvalRunSucceededWebhookEvent {
    /**
     * The unique ID of the event.
     */
    id: string;
    /**
     * The Unix timestamp (in seconds) of when the eval run succeeded.
     */
    created_at: number;
    /**
     * Event data payload.
     */
    data: EvalRunSucceededWebhookEvent.Data;
    /**
     * The type of the event. Always `eval.run.succeeded`.
     */
    type: 'eval.run.succeeded';
    /**
     * The object of the event. Always `event`.
     */
    object?: 'event';
}
export declare namespace EvalRunSucceededWebhookEvent {
    /**
     * Event data payload.
     */
    interface Data {
        /**
         * The unique ID of the eval run.
         */
        id: string;
    }
}
/**
 * Sent when a fine-tuning job has been cancelled.
 */
export interface FineTuningJobCancelledWebhookEvent {
    /**
     * The unique ID of the event.
     */
    id: string;
    /**
     * The Unix timestamp (in seconds) of when the fine-tuning job was cancelled.
     */
    created_at: number;
    /**
     * Event data payload.
     */
    data: FineTuningJobCancelledWebhookEvent.Data;
    /**
     * The type of the event. Always `fine_tuning.job.cancelled`.
     */
    type: 'fine_tuning.job.cancelled';
    /**
     * The object of the event. Always `event`.
     */
    object?: 'event';
}
export declare namespace FineTuningJobCancelledWebhookEvent {
    /**
     * Event data payload.
     */
    interface Data {
        /**
         * The unique ID of the fine-tuning job.
         */
        id: string;
    }
}
/**
 * Sent when a fine-tuning job has failed.
 */
export interface FineTuningJobFailedWebhookEvent {
    /**
     * The unique ID of the event.
     */
    id: string;
    /**
     * The Unix timestamp (in seconds) of when the fine-tuning job failed.
     */
    created_at: number;
    /**
     * Event data payload.
     */
    data: FineTuningJobFailedWebhookEvent.Data;
    /**
     * The type of the event. Always `fine_tuning.job.failed`.
     */
    type: 'fine_tuning.job.failed';
    /**
     * The object of the event. Always `event`.
     */
    object?: 'event';
}
export declare namespace FineTuningJobFailedWebhookEvent {
    /**
     * Event data payload.
     */
    interface Data {
        /**
         * The unique ID of the fine-tuning job.
         */
        id: string;
    }
}
/**
 * Sent when a fine-tuning job has succeeded.
 */
export interface FineTuningJobSucceededWebhookEvent {
    /**
     * The unique ID of the event.
     */
    id: string;
    /**
     * The Unix timestamp (in seconds) of when the fine-tuning job succeeded.
     */
    created_at: number;
    /**
     * Event data payload.
     */
    data: FineTuningJobSucceededWebhookEvent.Data;
    /**
     * The type of the event. Always `fine_tuning.job.succeeded`.
     */
    type: 'fine_tuning.job.succeeded';
    /**
     * The object of the event. Always `event`.
     */
    object?: 'event';
}
export declare namespace FineTuningJobSucceededWebhookEvent {
    /**
     * Event data payload.
     */
    interface Data {
        /**
         * The unique ID of the fine-tuning job.
         */
        id: string;
    }
}
/**
 * Sent when Realtime API Receives a incoming SIP call.
 */
export interface RealtimeCallIncomingWebhookEvent {
    /**
     * The unique ID of the event.
     */
    id: string;
    /**
     * The Unix timestamp (in seconds) of when the model response was completed.
     */
    created_at: number;
    /**
     * Event data payload.
     */
    data: RealtimeCallIncomingWebhookEvent.Data;
    /**
     * The type of the event. Always `realtime.call.incoming`.
     */
    type: 'realtime.call.incoming';
    /**
     * The object of the event. Always `event`.
     */
    object?: 'event';
}
export declare namespace RealtimeCallIncomingWebhookEvent {
    /**
     * Event data payload.
     */
    interface Data {
        /**
         * The unique ID of this call.
         */
        call_id: string;
        /**
         * Headers from the SIP Invite.
         */
        sip_headers: Array<Data.SipHeader>;
    }
    namespace Data {
        /**
         * A header from the SIP Invite.
         */
        interface SipHeader {
            /**
             * Name of the SIP Header.
             */
            name: string;
            /**
             * Value of the SIP Header.
             */
            value: string;
        }
    }
}
/**
 * Sent when a background response has been cancelled.
 */
export interface ResponseCancelledWebhookEvent {
    /**
     * The unique ID of the event.
     */
    id: string;
    /**
     * The Unix timestamp (in seconds) of when the model response was cancelled.
     */
    created_at: number;
    /**
     * Event data payload.
     */
    data: ResponseCancelledWebhookEvent.Data;
    /**
     * The type of the event. Always `response.cancelled`.
     */
    type: 'response.cancelled';
    /**
     * The object of the event. Always `event`.
     */
    object?: 'event';
}
export declare namespace ResponseCancelledWebhookEvent {
    /**
     * Event data payload.
     */
    interface Data {
        /**
         * The unique ID of the model response.
         */
        id: string;
    }
}
/**
 * Sent when a background response has been completed.
 */
export interface ResponseCompletedWebhookEvent {
    /**
     * The unique ID of the event.
     */
    id: string;
    /**
     * The Unix timestamp (in seconds) of when the model response was completed.
     */
    created_at: number;
    /**
     * Event data payload.
     */
    data: ResponseCompletedWebhookEvent.Data;
    /**
     * The type of the event. Always `response.completed`.
     */
    type: 'response.completed';
    /**
     * The object of the event. Always `event`.
     */
    object?: 'event';
}
export declare namespace ResponseCompletedWebhookEvent {
    /**
     * Event data payload.
     */
    interface Data {
        /**
         * The unique ID of the model response.
         */
        id: string;
    }
}
/**
 * Sent when a background response has failed.
 */
export interface ResponseFailedWebhookEvent {
    /**
     * The unique ID of the event.
     */
    id: string;
    /**
     * The Unix timestamp (in seconds) of when the model response failed.
     */
    created_at: number;
    /**
     * Event data payload.
     */
    data: ResponseFailedWebhookEvent.Data;
    /**
     * The type of the event. Always `response.failed`.
     */
    type: 'response.failed';
    /**
     * The object of the event. Always `event`.
     */
    object?: 'event';
}
export declare namespace ResponseFailedWebhookEvent {
    /**
     * Event data payload.
     */
    interface Data {
        /**
         * The unique ID of the model response.
         */
        id: string;
    }
}
/**
 * Sent when a background response has been interrupted.
 */
export interface ResponseIncompleteWebhookEvent {
    /**
     * The unique ID of the event.
     */
    id: string;
    /**
     * The Unix timestamp (in seconds) of when the model response was interrupted.
     */
    created_at: number;
    /**
     * Event data payload.
     */
    data: ResponseIncompleteWebhookEvent.Data;
    /**
     * The type of the event. Always `response.incomplete`.
     */
    type: 'response.incomplete';
    /**
     * The object of the event. Always `event`.
     */
    object?: 'event';
}
export declare namespace ResponseIncompleteWebhookEvent {
    /**
     * Event data payload.
     */
    interface Data {
        /**
         * The unique ID of the model response.
         */
        id: string;
    }
}
/**
 * Sent when a batch API request has been cancelled.
 */
export type UnwrapWebhookEvent = BatchCancelledWebhookEvent | BatchCompletedWebhookEvent | BatchExpiredWebhookEvent | BatchFailedWebhookEvent | EvalRunCanceledWebhookEvent | EvalRunFailedWebhookEvent | EvalRunSucceededWebhookEvent | FineTuningJobCancelledWebhookEvent | FineTuningJobFailedWebhookEvent | FineTuningJobSucceededWebhookEvent | RealtimeCallIncomingWebhookEvent | ResponseCancelledWebhookEvent | ResponseCompletedWebhookEvent | ResponseFailedWebhookEvent | ResponseIncompleteWebhookEvent;
export declare namespace Webhooks {
    export { type BatchCancelledWebhookEvent as BatchCancelledWebhookEvent, type BatchCompletedWebhookEvent as BatchCompletedWebhookEvent, type BatchExpiredWebhookEvent as BatchExpiredWebhookEvent, type BatchFailedWebhookEvent as BatchFailedWebhookEvent, type EvalRunCanceledWebhookEvent as EvalRunCanceledWebhookEvent, type EvalRunFailedWebhookEvent as EvalRunFailedWebhookEvent, type EvalRunSucceededWebhookEvent as EvalRunSucceededWebhookEvent, type FineTuningJobCancelledWebhookEvent as FineTuningJobCancelledWebhookEvent, type FineTuningJobFailedWebhookEvent as FineTuningJobFailedWebhookEvent, type FineTuningJobSucceededWebhookEvent as FineTuningJobSucceededWebhookEvent, type RealtimeCallIncomingWebhookEvent as RealtimeCallIncomingWebhookEvent, type ResponseCancelledWebhookEvent as ResponseCancelledWebhookEvent, type ResponseCompletedWebhookEvent as ResponseCompletedWebhookEvent, type ResponseFailedWebhookEvent as ResponseFailedWebhookEvent, type ResponseIncompleteWebhookEvent as ResponseIncompleteWebhookEvent, type UnwrapWebhookEvent as UnwrapWebhookEvent, };
}
//# sourceMappingURL=webhooks.d.mts.map