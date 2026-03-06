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
};
export type StartSlackStreamParams = {
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
export type AppendSlackStreamParams = {
    session: SlackStreamSession;
    text: string;
};
export type StopSlackStreamParams = {
    session: SlackStreamSession;
    /** Optional final markdown text to append before stopping. */
    text?: string;
};
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
 */
export declare function stopSlackStream(params: StopSlackStreamParams): Promise<void>;
