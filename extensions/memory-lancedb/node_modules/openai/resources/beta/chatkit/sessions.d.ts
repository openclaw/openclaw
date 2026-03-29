import { APIResource } from "../../../core/resource.js";
import * as ThreadsAPI from "./threads.js";
import { APIPromise } from "../../../core/api-promise.js";
import { RequestOptions } from "../../../internal/request-options.js";
export declare class Sessions extends APIResource {
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
    create(body: SessionCreateParams, options?: RequestOptions): APIPromise<ThreadsAPI.ChatSession>;
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
    cancel(sessionID: string, options?: RequestOptions): APIPromise<ThreadsAPI.ChatSession>;
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
//# sourceMappingURL=sessions.d.ts.map