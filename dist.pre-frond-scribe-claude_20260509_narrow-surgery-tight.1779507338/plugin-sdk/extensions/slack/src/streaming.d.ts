/**
 * Slack native text streaming helpers.
 *
 * Uses the Slack SDK's `ChatStreamer` (via `client.chatStream()`) to stream
 * text responses word-by-word in a single updating message, matching Slack's
 * "Agents & AI Apps" streaming UX.
 *
 * @see https://docs.slack.dev/ai/developing-ai-apps#streaming
 * @see https://docs.slack.dev/reference/methods/chat.startStream
 * @see https://docs.slack.dev/reference/methods/chat.appendStream
 * @see https://docs.slack.dev/reference/methods/chat.stopStream
 */
import type { MessageMetadata } from "@slack/types";
import type { WebClient } from "@slack/web-api";
import type { ChatStreamer } from "@slack/web-api/dist/chat-stream.js";
export type SlackStreamSession = {
    /** The SDK ChatStreamer instance managing this stream. */
    streamer: ChatStreamer;
    /** Channel this stream lives in. */
    channel: string;
    /** Thread timestamp (required for streaming). */
    threadTs: string;
    /** True once stop() has been called. */
    stopped: boolean;
    /**
     * True once any Slack API call (startStream / appendStream) has succeeded.
     * The SDK buffers appended text locally until the buffer exceeds
     * `buffer_size` (default 256 chars); only then does it issue a network
     * call. Until `delivered` flips, nothing has actually reached Slack.
     */
    delivered: boolean;
    /** Text accepted by the SDK but not yet acknowledged by Slack. */
    pendingText: string;
};
type StartSlackStreamParams = {
    client: WebClient;
    channel: string;
    threadTs: string;
    /** Optional initial markdown text to include in the stream start. */
    text?: string;
    /**
     * The team ID of the workspace this stream belongs to.
     * Required by the Slack API for `chat.startStream` / `chat.stopStream`.
     * Obtain from `auth.test` response (`team_id`).
     */
    teamId?: string;
    /**
     * The user ID of the message recipient (required for DM streaming).
     * Without this, `chat.stopStream` fails with `missing_recipient_user_id`
     * in direct message conversations.
     */
    userId?: string;
};
type AppendSlackStreamParams = {
    session: SlackStreamSession;
    text: string;
};
type StopSlackStreamParams = {
    session: SlackStreamSession;
    /** Optional final markdown text to append before stopping. */
    text?: string;
    metadata?: MessageMetadata;
};
/**
 * Thrown when Slack rejects a stream flush/finalize with a recipient-resolution
 * error (see {@link BENIGN_SLACK_FINALIZE_ERROR_CODES}) while text is still
 * only buffered locally by the Slack SDK. Carries the pending text so the
 * caller can deliver it via the normal Slack reply path.
 */
export declare class SlackStreamNotDeliveredError extends Error {
    readonly pendingText: string;
    readonly slackCode: string;
    constructor(pendingText: string, slackCode: string);
}
/**
 * Start a new Slack text stream.
 *
 * Returns a {@link SlackStreamSession} that should be passed to
 * {@link appendSlackStream} and {@link stopSlackStream}.
 *
 * The first chunk of text can optionally be included via `text`.
 */
export declare function startSlackStream(params: StartSlackStreamParams): Promise<SlackStreamSession>;
/**
 * Append markdown text to an active Slack stream.
 */
export declare function appendSlackStream(params: AppendSlackStreamParams): Promise<void>;
/**
 * Stop (finalize) a Slack stream.
 *
 * After calling this the stream message becomes a normal Slack message.
 * Optionally include final text to append before stopping.
 *
 * If Slack's `chat.stopStream` responds with a known benign finalize error
 * (see {@link BENIGN_SLACK_FINALIZE_ERROR_CODES}) AND any prior `append`
 * has already landed on Slack, the error is swallowed and the session is
 * marked stopped - the already-delivered text stays visible.
 *
 * If the same benign error fires while text is still only buffered locally
 * (e.g. short replies that never exceeded the SDK's buffer_size), this
 * function throws a {@link SlackStreamNotDeliveredError} carrying that pending
 * text so the caller can deliver it through the normal Slack reply path.
 *
 * All other errors propagate unchanged.
 */
export declare function stopSlackStream(params: StopSlackStreamParams): Promise<void>;
export declare function isBenignSlackFinalizeError(err: unknown): boolean;
export declare function extractSlackErrorCode(err: unknown): string | undefined;
export declare function markSlackStreamFallbackDelivered(session: SlackStreamSession): void;
export {};
