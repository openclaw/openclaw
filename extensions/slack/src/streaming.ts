import type { AnyChunk, MessageMetadata } from "@slack/types";
import type { WebClient, WebClientOptions } from "@slack/web-api";
import type { ChatStreamer } from "@slack/web-api/dist/chat-stream.js";
import { pruneMapToMaxSize } from "openclaw/plugin-sdk/collection-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { getSlackListenerWriteClient } from "./client.js";
import { buildSlackMessageIdentityPayload } from "./post-message-identity.js";
import type { SlackSendIdentity } from "./send.js";

export type SlackStreamSession = {
  streamer: ChatStreamer;
  channel: string;
  threadTs: string;
  /** True once stopped locally, by Slack, or after an ambiguous delivery failure. */
  stopped: boolean;
  /** Slack's native Stop event cancelled this stream, including any buffered tail. */
  stoppedBySlack?: boolean;
  /**
   * True once Slack acknowledges a start, append, or stop. Short appends can
   * remain buffered locally; a lost response also leaves delivery unconfirmed.
   */
  delivered: boolean;
  /** Text accepted by the SDK but not yet acknowledged by Slack. */
  pendingText: string;
};

type StartSlackStreamParams = {
  client: WebClient;
  clientOptions?: WebClientOptions;
  channel: string;
  threadTs: string;
  text?: string;
  chunks?: AnyChunk[];
  taskDisplayMode?: "plan" | "timeline";
  /** Optional custom authorship supported by chat.startStream. */
  identity?: SlackSendIdentity;
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
  text?: string;
  chunks?: AnyChunk[];
};

type StopSlackStreamParams = {
  session: SlackStreamSession;
  chunks?: AnyChunk[];
  metadata?: MessageMetadata;
};

/**
 * Thrown when Slack definitively rejects a stream flush/finalize while text
 * remains buffered locally by the Slack SDK. Carries the pending text so the
 * caller can deliver it via the normal Slack reply path.
 */
export class SlackStreamNotDeliveredError extends Error {
  readonly pendingText: string;
  readonly slackCode: string;
  constructor(pendingText: string, slackCode: string) {
    super(
      `slack-stream: finalize failed with ${slackCode} before buffered text reached Slack ` +
        `(${pendingText.length} chars pending)`,
    );
    this.name = "SlackStreamNotDeliveredError";
    this.pendingText = pendingText;
    this.slackCode = slackCode;
  }
}

type SlackClientStreams = {
  sessions: Set<SlackStreamSession>;
  stopped: Map<string, true>;
};
const streamsByClient = new WeakMap<WebClient, SlackClientStreams>();
const stateBySession = new WeakMap<SlackStreamSession, SlackClientStreams>();
const SLACK_STOPPED_STREAMS_MAX = 1024;

function getSlackClientStreams(client: WebClient): SlackClientStreams {
  let state = streamsByClient.get(client);
  if (!state) {
    state = { sessions: new Set(), stopped: new Map() };
    streamsByClient.set(client, state);
  }
  return state;
}

function releaseSlackStream(session: SlackStreamSession): void {
  stateBySession.get(session)?.sessions.delete(session);
}

function applySlackStreamStop(session: SlackStreamSession): boolean {
  if (session.stoppedBySlack) {
    return true;
  }
  const state = stateBySession.get(session);
  const ts = session.streamer.ts;
  if (!ts || !state?.stopped.delete(`${session.channel}:${ts}`)) {
    return false;
  }
  session.stopped = true;
  session.stoppedBySlack = true;
  // Retain the unacknowledged tail for delivery bookkeeping; stopped state
  // prevents it from ever being flushed or used for fallback.
  releaseSlackStream(session);
  return true;
}

/** Record streams Slack already halted; never flush their locally buffered tail. */
export function markSlackStreamsStopped(
  client: WebClient,
  channelId: string,
  streamingMessageTs: string[],
): void {
  const state = getSlackClientStreams(client);
  for (const ts of streamingMessageTs) {
    state.stopped.set(`${channelId}:${ts}`, true);
  }
  // The SDK learns ts only after startStream returns. Keep bounded unmatched
  // events so a Stop arriving before that response still cancels the stream.
  for (const session of state.sessions) {
    applySlackStreamStop(session);
  }
  pruneMapToMaxSize(state.stopped, SLACK_STOPPED_STREAMS_MAX);
}

export async function startSlackStream(
  params: StartSlackStreamParams,
): Promise<SlackStreamSession> {
  const { client, channel, threadTs, text, chunks, taskDisplayMode, teamId, userId, identity } =
    params;
  logVerbose(
    `slack-stream: starting stream in ${channel} thread=${threadTs}${teamId ? ` team=${teamId}` : ""}${userId ? ` user=${userId}` : ""}`,
  );

  const writeClient = getSlackListenerWriteClient({
    listenerClient: client,
    clientOptions: params.clientOptions,
    teamId: params.clientOptions?.teamId,
  });
  if (!writeClient) {
    throw new Error(
      "Slack streaming requires an authenticated client with matching workspace scope",
    );
  }
  const streamer = writeClient.chatStream({
    channel,
    thread_ts: threadTs,
    ...(taskDisplayMode ? { task_display_mode: taskDisplayMode } : {}),
    ...(teamId ? { recipient_team_id: teamId } : {}),
    ...(userId ? { recipient_user_id: userId } : {}),
    ...buildSlackMessageIdentityPayload(identity),
  });

  const session: SlackStreamSession = {
    streamer,
    channel,
    threadTs,
    stopped: false,
    delivered: false,
    pendingText: "",
  };
  // Stop events carry the listener identity; the derived writer only owns I/O.
  const state = getSlackClientStreams(client);
  state.sessions.add(session);
  stateBySession.set(session, state);

  await appendSlackStream({ session, text, chunks });
  return session;
}

export async function appendSlackStream(params: AppendSlackStreamParams): Promise<void> {
  const { session, text, chunks } = params;

  if (applySlackStreamStop(session) || session.stopped) {
    logVerbose("slack-stream: attempted to append to a stopped stream, ignoring");
    return;
  }

  if (!text && !chunks?.length) {
    return;
  }

  if (text) {
    session.pendingText += text;
  }
  try {
    // Short markdown chunks stay buffered in the SDK until buffer_size is reached;
    // structured chunks force a flush. Only a non-null response acknowledges delivery.
    const result = await session.streamer.append({
      ...(text ? { markdown_text: text } : {}),
      ...(chunks ? { chunks } : {}),
    });
    if (result) {
      session.delivered = true;
      session.pendingText = "";
    }
    applySlackStreamStop(session);
    logVerbose(
      `slack-stream: appended ${text?.length ?? 0} chars, ${chunks?.length ?? 0} chunks (${
        result ? "flushed" : "buffered"
      })`,
    );
  } catch (err) {
    if (applySlackStreamStop(session)) {
      return;
    }
    releaseSlackStream(session);
    throwSlackStreamFailure(session, err);
  }
}

type StopSlackStreamResult = {
  messageId?: string;
};

export async function stopSlackStream(
  params: StopSlackStreamParams,
): Promise<StopSlackStreamResult> {
  const { session, chunks, metadata } = params;

  if (applySlackStreamStop(session) || session.stopped) {
    logVerbose("slack-stream: stream already stopped, ignoring duplicate stop");
    return {};
  }

  session.stopped = true;
  logVerbose(`slack-stream: stopping stream in ${session.channel} thread=${session.threadTs}`);

  try {
    const stopResponse = await session.streamer.stop(
      chunks?.length || metadata
        ? {
            ...(chunks?.length ? { chunks } : {}),
            ...(metadata ? { metadata } : {}),
          }
        : undefined,
    );
    // Accept a Stop racing the SDK's internal start/finalize when ts was unknown.
    if (applySlackStreamStop(session)) {
      return {};
    }
    session.delivered = true;
    session.pendingText = "";
    logVerbose("slack-stream: stream stopped");
    // `chat.stopStream` reports the finalized message `ts` at the top level
    // (and on `message.ts`); prefer the former and fall back to the latter.
    const messageId = stopResponse?.ts ?? stopResponse?.message?.ts;
    return messageId ? { messageId } : {};
  } catch (err) {
    if (applySlackStreamStop(session)) {
      return {};
    }
    const code = extractSlackErrorCode(err) ?? "unknown";
    if (!session.pendingText && session.delivered && BENIGN_SLACK_FINALIZE_ERROR_CODES.has(code)) {
      logVerbose(
        `slack-stream: finalize rejected by Slack (${code}); prior appends delivered, treating stream as stopped`,
      );
      return {};
    }
    return throwSlackStreamFailure(session, err);
  } finally {
    releaseSlackStream(session);
  }
}

// Definitive rejections permit buffered-text fallback; already-delivered streams
// can treat these finalize failures as stopped. Ambiguous errors must propagate.
const BENIGN_SLACK_FINALIZE_ERROR_CODES = new Set<string>([
  // Slack Connect recipients: finalize fails because the external user id
  // is not resolvable in the host workspace (#70295).
  "user_not_found",
  // Slack Connect team mismatch in shared channels.
  "team_not_found",
  // DMs that closed between stream start and stop.
  "missing_recipient_user_id",
  "missing_recipient_team_id",
  // Slack expires established streams server-side; rejected tails can still post normally.
  "message_not_in_streaming_state",
  // Channels where Slack accepts ordinary messages but not native streaming.
  "method_not_supported_for_channel_type",
  "channel_type_not_supported",
  "enterprise_is_restricted",
]);

function throwSlackStreamFailure(session: SlackStreamSession, err: unknown): never {
  const code = extractSlackErrorCode(err) ?? "unknown";
  if (
    session.pendingText &&
    (BENIGN_SLACK_FINALIZE_ERROR_CODES.has(code) || code === "missing_scope")
  ) {
    throw new SlackStreamNotDeliveredError(session.pendingText, code);
  }
  // Slack may have accepted the request despite a lost response. The SDK
  // retains that buffer; retire it so later append/stop cannot replay it.
  session.stopped = true;
  throw err;
}

function extractSlackErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== "object") {
    return undefined;
  }
  const record = err as Record<string, unknown>;
  // @slack/web-api errors expose `data.error` with the Slack error code.
  if (record.data && typeof record.data === "object") {
    const inner = (record.data as Record<string, unknown>).error;
    if (typeof inner === "string") {
      return inner;
    }
  }
  // Fallback: parse from message string ("An API error occurred: user_not_found").
  const message = typeof record.message === "string" ? record.message : "";
  const match = message.match(/An API error occurred:\s*([a-z_][a-z0-9_]*)/i);
  return match?.[1];
}

export function markSlackStreamFallbackDelivered(session: SlackStreamSession): void {
  if (applySlackStreamStop(session)) {
    return;
  }
  const nativeStreamWasStarted = session.delivered || Boolean(session.streamer.ts);
  session.pendingText = "";
  // @slack/web-api 7.16.0 retains its private buffer after a failed flush.
  // Clear fallback-owned text before retrying stop(), or the SDK resends it.
  (session.streamer as unknown as { buffer: string }).buffer = "";
  // A visible native stream still needs stop() to leave streaming state. If no
  // native call succeeded, there is no Slack stream to finalize.
  session.stopped = !nativeStreamWasStarted;
  if (session.stopped) {
    releaseSlackStream(session);
  } else {
    stateBySession.get(session)?.sessions.add(session);
  }
}
