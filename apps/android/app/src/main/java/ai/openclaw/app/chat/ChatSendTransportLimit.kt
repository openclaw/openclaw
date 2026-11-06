package ai.openclaw.app.chat

import kotlin.math.ceil

/**
 * The pinned OkHttp WebSocket ([RealWebSocket]) refuses to enqueue one outbound frame larger than
 * its 16 MiB outgoing queue (`MAX_QUEUE_SIZE`), even when the queue is empty: it closes with 1001
 * and returns false, which [ai.openclaw.app.gateway.GatewaySession] reports as
 * `GatewayRequestNotEnqueued`. That is a permanent size condition, not transient backpressure, so
 * admission and retry handling must compare the whole serialized `chat.send` frame with this bound
 * instead of the decoded attachment bytes alone.
 */
internal const val CHAT_SEND_MAX_WEBSOCKET_FRAME_BYTES = 16L * 1024L * 1024L

/** Base64 expansion of [decodedBytes], matching [android.util.Base64] and `java.util.Base64`. */
internal fun chatSendBase64Length(decodedBytes: Long): Long = ((decodedBytes + 2L) / 3L) * 4L

/** Conservative per-attachment JSON envelope: type, MIME type, file name, and field names. */
internal const val CHAT_SEND_ATTACHMENT_ENVELOPE_BYTES = 512L

/** Conservative per-command JSON envelope: session key, agent, message text, idempotency key. */
internal const val CHAT_SEND_COMMAND_ENVELOPE_BYTES = 8L * 1024L

/**
 * Largest decoded attachment payload whose complete `chat.send` frame still fits one WebSocket
 * message. Video uses the full envelope budget; other kinds stay under the durable 8 MiB ceiling,
 * which is below the transport bound and therefore keeps their existing limits.
 */
internal const val CHAT_COMPOSER_MAX_VIDEO_SEND_DECODED_BYTES = 12_570_624L

/** True when one decoded attachment at [decodedBytes] is transportable as part of a send. */
internal fun chatSendAttachmentFrameFits(decodedBytes: Long): Boolean =
  decodedBytes <= CHAT_COMPOSER_MAX_VIDEO_SEND_DECODED_BYTES

/**
 * True when the attachments of one command fit one `chat.send` WebSocket frame. Mirrors
 * [buildChatSendParams]: attachment content is inline Base64, separated by JSON field overhead.
 */
internal fun chatSendAttachmentsFitWebSocketFrame(decodedAttachmentBytes: List<Long>): Boolean {
  val base64Chars = decodedAttachmentBytes.sumOf { ceil(it * 4.0 / 3.0).toLong() }
  return base64Chars +
    CHAT_SEND_COMMAND_ENVELOPE_BYTES +
    CHAT_SEND_ATTACHMENT_ENVELOPE_BYTES * decodedAttachmentBytes.size <=
    CHAT_SEND_MAX_WEBSOCKET_FRAME_BYTES
}

/**
 * True when a durably queued command can never be enqueued as one frame; replaying it only
 * closes the connection again, so the outbox settles it as an actionable permanent failure.
 */
internal fun outboxCommandAttachmentsFitWebSocketFrame(attachments: List<OutboxAttachmentPayload>): Boolean =
  chatSendAttachmentsFitWebSocketFrame(attachments.map { it.bytes.size.toLong() })
