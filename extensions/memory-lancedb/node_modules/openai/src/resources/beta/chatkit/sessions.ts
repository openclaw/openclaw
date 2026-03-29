// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../../../core/resource';
import * as ThreadsAPI from './threads';
import { APIPromise } from '../../../core/api-promise';
import { buildHeaders } from '../../../internal/headers';
import { RequestOptions } from '../../../internal/request-options';
import { path } from '../../../internal/utils/path';

export class Sessions extends APIResource {
  /**
   * Create a ChatKit session.
   *
   * @example
   * ```ts
   * const chatSession =
   *   await client.beta.chatkit.sessions.create({
   *     user: 'x',
   *     workflow: { id: 'id' },
   *   });
   * ```
   */
  create(body: SessionCreateParams, options?: RequestOptions): APIPromise<ThreadsAPI.ChatSession> {
    return this._client.post('/chatkit/sessions', {
      body,
      ...options,
      headers: buildHeaders([{ 'OpenAI-Beta': 'chatkit_beta=v1' }, options?.headers]),
    });
  }

  /**
   * Cancel an active ChatKit session and return its most recent metadata.
   *
   * Cancelling prevents new requests from using the issued client secret.
   *
   * @example
   * ```ts
   * const chatSession =
   *   await client.beta.chatkit.sessions.cancel('cksess_123');
   * ```
   */
  cancel(sessionID: string, options?: RequestOptions): APIPromise<ThreadsAPI.ChatSession> {
    return this._client.post(path`/chatkit/sessions/${sessionID}/cancel`, {
      ...options,
      headers: buildHeaders([{ 'OpenAI-Beta': 'chatkit_beta=v1' }, options?.headers]),
    });
  }
}

export interface SessionCreateParams {
  /**
   * A free-form string that identifies your end user; ensures this Session can
   * access other objects that have the same `user` scope.
   */
  user: string;

  /**
   * Workflow that powers the session.
   */
  workflow: ThreadsAPI.ChatSessionWorkflowParam;

  /**
   * Optional overrides for ChatKit runtime configuration features
   */
  chatkit_configuration?: ThreadsAPI.ChatSessionChatKitConfigurationParam;

  /**
   * Optional override for session expiration timing in seconds from creation.
   * Defaults to 10 minutes.
   */
  expires_after?: ThreadsAPI.ChatSessionExpiresAfterParam;

  /**
   * Optional override for per-minute request limits. When omitted, defaults to 10.
   */
  rate_limits?: ThreadsAPI.ChatSessionRateLimitsParam;
}

export declare namespace Sessions {
  export { type SessionCreateParams as SessionCreateParams };
}
