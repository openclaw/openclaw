// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { InvalidWebhookSignatureError } from '../../error';
import { APIResource } from '../../core/resource';
import { buildHeaders, HeadersLike } from '../../internal/headers';

export class Webhooks extends APIResource {
  /**
   * Validates that the given payload was sent by OpenAI and parses the payload.
   */
  async unwrap(
    payload: string,
    headers: HeadersLike,
    secret: string | undefined | null = this._client.webhookSecret,
    tolerance: number = 300,
  ): Promise<UnwrapWebhookEvent> {
    await this.verifySignature(payload, headers, secret, tolerance);

    return JSON.parse(payload) as UnwrapWebhookEvent;
  }

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
  async verifySignature(
    payload: string,
    headers: HeadersLike,
    secret: string | undefined | null = this._client.webhookSecret,
    tolerance: number = 300,
  ): Promise<void> {
    if (
      typeof crypto === 'undefined' ||
      typeof crypto.subtle.importKey !== 'function' ||
      typeof crypto.subtle.verify !== 'function'
    ) {
      throw new Error('Webhook signature verification is only supported when the `crypto` global is defined');
    }

    this.#validateSecret(secret);

    const headersObj = buildHeaders([headers]).values;
    const signatureHeader = this.#getRequiredHeader(headersObj, 'webhook-signature');
    const timestamp = this.#getRequiredHeader(headersObj, 'webhook-timestamp');
    const webhookId = this.#getRequiredHeader(headersObj, 'webhook-id');

    // Validate timestamp to prevent replay attacks
    const timestampSeconds = parseInt(timestamp, 10);
    if (isNaN(timestampSeconds)) {
      throw new InvalidWebhookSignatureError('Invalid webhook timestamp format');
    }

    const nowSeconds = Math.floor(Date.now() / 1000);

    if (nowSeconds - timestampSeconds > tolerance) {
      throw new InvalidWebhookSignatureError('Webhook timestamp is too old');
    }

    if (timestampSeconds > nowSeconds + tolerance) {
      throw new InvalidWebhookSignatureError('Webhook timestamp is too new');
    }

    // Extract signatures from v1,<base64> format
    // The signature header can have multiple values, separated by spaces.
    // Each value is in the format v1,<base64>. We should accept if any match.
    const signatures = signatureHeader
      .split(' ')
      .map((part) => (part.startsWith('v1,') ? part.substring(3) : part));

    // Decode the secret if it starts with whsec_
    const decodedSecret =
      secret.startsWith('whsec_') ?
        Buffer.from(secret.replace('whsec_', ''), 'base64')
      : Buffer.from(secret, 'utf-8');

    // Create the signed payload: {webhook_id}.{timestamp}.{payload}
    const signedPayload = webhookId ? `${webhookId}.${timestamp}.${payload}` : `${timestamp}.${payload}`;

    // Import the secret as a cryptographic key for HMAC
    const key = await crypto.subtle.importKey(
      'raw',
      decodedSecret,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    );

    // Check if any signature matches using timing-safe WebCrypto verify
    for (const signature of signatures) {
      try {
        const signatureBytes = Buffer.from(signature, 'base64');
        const isValid = await crypto.subtle.verify(
          'HMAC',
          key,
          signatureBytes,
          new TextEncoder().encode(signedPayload),
        );

        if (isValid) {
          return; // Valid signature found
        }
      } catch {
        // Invalid base64 or signature format, continue to next signature
        continue;
      }
    }

    throw new InvalidWebhookSignatureError(
      'The given webhook signature does not match the expected signature',
    );
  }

  #validateSecret(secret: string | null | undefined): asserts secret is string {
    if (typeof secret !== 'string' || secret.length === 0) {
      throw new Error(
        `The webhook secret must either be set using the env var, OPENAI_WEBHOOK_SECRET, on the client class, OpenAI({ webhookSecret: '123' }), or passed to this function`,
      );
    }
  }

  #getRequiredHeader(headers: Headers, name: string): string {
    if (!headers) {
      throw new Error(`Headers are required`);
    }

    const value = headers.get(name);

    if (value === null || value === undefined) {
      throw new Error(`Missing required header: ${name}`);
    }

    return value;
  }
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

export namespace BatchCancelledWebhookEvent {
  /**
   * Event data payload.
   */
  export interface Data {
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

export namespace BatchCompletedWebhookEvent {
  /**
   * Event data payload.
   */
  export interface Data {
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

export namespace BatchExpiredWebhookEvent {
  /**
   * Event data payload.
   */
  export interface Data {
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

export namespace BatchFailedWebhookEvent {
  /**
   * Event data payload.
   */
  export interface Data {
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

export namespace EvalRunCanceledWebhookEvent {
  /**
   * Event data payload.
   */
  export interface Data {
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

export namespace EvalRunFailedWebhookEvent {
  /**
   * Event data payload.
   */
  export interface Data {
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

export namespace EvalRunSucceededWebhookEvent {
  /**
   * Event data payload.
   */
  export interface Data {
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

export namespace FineTuningJobCancelledWebhookEvent {
  /**
   * Event data payload.
   */
  export interface Data {
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

export namespace FineTuningJobFailedWebhookEvent {
  /**
   * Event data payload.
   */
  export interface Data {
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

export namespace FineTuningJobSucceededWebhookEvent {
  /**
   * Event data payload.
   */
  export interface Data {
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

export namespace RealtimeCallIncomingWebhookEvent {
  /**
   * Event data payload.
   */
  export interface Data {
    /**
     * The unique ID of this call.
     */
    call_id: string;

    /**
     * Headers from the SIP Invite.
     */
    sip_headers: Array<Data.SipHeader>;
  }

  export namespace Data {
    /**
     * A header from the SIP Invite.
     */
    export interface SipHeader {
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

export namespace ResponseCancelledWebhookEvent {
  /**
   * Event data payload.
   */
  export interface Data {
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

export namespace ResponseCompletedWebhookEvent {
  /**
   * Event data payload.
   */
  export interface Data {
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

export namespace ResponseFailedWebhookEvent {
  /**
   * Event data payload.
   */
  export interface Data {
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

export namespace ResponseIncompleteWebhookEvent {
  /**
   * Event data payload.
   */
  export interface Data {
    /**
     * The unique ID of the model response.
     */
    id: string;
  }
}

/**
 * Sent when a batch API request has been cancelled.
 */
export type UnwrapWebhookEvent =
  | BatchCancelledWebhookEvent
  | BatchCompletedWebhookEvent
  | BatchExpiredWebhookEvent
  | BatchFailedWebhookEvent
  | EvalRunCanceledWebhookEvent
  | EvalRunFailedWebhookEvent
  | EvalRunSucceededWebhookEvent
  | FineTuningJobCancelledWebhookEvent
  | FineTuningJobFailedWebhookEvent
  | FineTuningJobSucceededWebhookEvent
  | RealtimeCallIncomingWebhookEvent
  | ResponseCancelledWebhookEvent
  | ResponseCompletedWebhookEvent
  | ResponseFailedWebhookEvent
  | ResponseIncompleteWebhookEvent;

export declare namespace Webhooks {
  export {
    type BatchCancelledWebhookEvent as BatchCancelledWebhookEvent,
    type BatchCompletedWebhookEvent as BatchCompletedWebhookEvent,
    type BatchExpiredWebhookEvent as BatchExpiredWebhookEvent,
    type BatchFailedWebhookEvent as BatchFailedWebhookEvent,
    type EvalRunCanceledWebhookEvent as EvalRunCanceledWebhookEvent,
    type EvalRunFailedWebhookEvent as EvalRunFailedWebhookEvent,
    type EvalRunSucceededWebhookEvent as EvalRunSucceededWebhookEvent,
    type FineTuningJobCancelledWebhookEvent as FineTuningJobCancelledWebhookEvent,
    type FineTuningJobFailedWebhookEvent as FineTuningJobFailedWebhookEvent,
    type FineTuningJobSucceededWebhookEvent as FineTuningJobSucceededWebhookEvent,
    type RealtimeCallIncomingWebhookEvent as RealtimeCallIncomingWebhookEvent,
    type ResponseCancelledWebhookEvent as ResponseCancelledWebhookEvent,
    type ResponseCompletedWebhookEvent as ResponseCompletedWebhookEvent,
    type ResponseFailedWebhookEvent as ResponseFailedWebhookEvent,
    type ResponseIncompleteWebhookEvent as ResponseIncompleteWebhookEvent,
    type UnwrapWebhookEvent as UnwrapWebhookEvent,
  };
}
