package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.CHAT_ATTACHMENT_PLACEHOLDER_TEXT
import ai.openclaw.app.chat.ChatMessageContent
import ai.openclaw.app.chat.ChatOutboxAttachment

/**
 * One user message as rendered: attachments plus the author's own text, with any
 * transcription split out so it can sit under the voice row instead of inside the text.
 */
internal data class ChatAttachmentMessageParts(
  val content: List<ChatMessageContent>,
  val transcript: String?,
) {
  /**
   * Text the link preview scans: the author's text first, then the transcript, so a URL
   * spoken in the voice note still previews after the transcript moves out of the text.
   */
  val linkPreviewContent: List<ChatMessageContent>
    get() = if (transcript == null) content else content + ChatMessageContent(type = "text", text = transcript)
}

/**
 * The Gateway's default transcript echo, `📝 "{transcript}"` (`DEFAULT_ECHO_TRANSCRIPT_FORMAT`
 * in src/media-understanding/echo-transcript.ts), appended as the last line(s) of the user turn.
 */
private const val ECHO_TRANSCRIPT_PREFIX = "\uD83D\uDCDD \""
private const val ECHO_TRANSCRIPT_SUFFIX = "\""

/** Keeps authored text intact and projects the default echo only for transcribed voice notes. */
internal fun splitChatAttachmentMessage(content: List<ChatMessageContent>): ChatAttachmentMessageParts {
  val hasAttachment = content.any { it.type != "text" }
  val voiceNotes = content.filter { it.type == "audio" || it.mimeType?.startsWith("audio/") == true }
  // Only Gateway-recorded transcription makes a `📝 "…"` line a transcript; otherwise it is a caption.
  val hasTranscribedVoiceNote = voiceNotes.any { it.transcribed }
  val transcripts = mutableListOf<String>()
  val parts =
    content.mapNotNull { part ->
      if (part.type != "text") return@mapNotNull part
      val (body, transcript) = splitEchoTranscript(part.text.orEmpty().lines(), hasTranscribedVoiceNote) ?: (part.text.orEmpty() to null)
      transcript?.let(transcripts::add)
      val cleaned = if (hasAttachment || transcript != null) stripAttachmentPlaceholder(body) else body
      when {
        cleaned == part.text -> part
        cleaned.isBlank() -> null
        else -> part.copy(text = cleaned)
      }
    }
  return ChatAttachmentMessageParts(parts, transcripts.joinToString("\n\n").takeIf { it.isNotBlank() })
}

// The sender only synthesizes the placeholder for an entirely empty caption, so only an exact
// placeholder body is dropped; a caption that merely starts with it is the author's text.
private fun stripAttachmentPlaceholder(text: String): String = if (text.trim() == CHAT_ATTACHMENT_PLACEHOLDER_TEXT) "" else text

/**
 * Splits the default `📝 "{transcript}"` echo off the end of a voice-note turn. Only a turn whose
 * voice note the Gateway marked as transcribed qualifies, so an authored caption shaped like the
 * echo (for example when transcription is off or failed) stays the author's text.
 */
private fun splitEchoTranscript(
  lines: List<String>,
  hasTranscribedVoiceNote: Boolean,
): Pair<String, String>? {
  if (!hasTranscribedVoiceNote) return null
  val trimmed = lines.dropLastWhile { it.isBlank() }
  // The generated echo is appended after the author's caption. A caption can itself start
  // with the same marker, so use the last echo-shaped line rather than consuming it as speech.
  val start = trimmed.indexOfLast { it.trimStart().startsWith(ECHO_TRANSCRIPT_PREFIX) }
  if (start < 0) return null
  val echo = trimmed.drop(start).joinToString("\n").trim()
  if (!echo.endsWith(ECHO_TRANSCRIPT_SUFFIX) || echo.length <= ECHO_TRANSCRIPT_PREFIX.length) return null
  val transcript = echo.removePrefix(ECHO_TRANSCRIPT_PREFIX).removeSuffix(ECHO_TRANSCRIPT_SUFFIX).trim()
  if (transcript.isEmpty()) return null
  return authoredTextBeforeTranscript(trimmed, start) to transcript
}

// An empty line before an appended transcript is its separator. Keep the author's
// indentation and trailing spaces, which can be meaningful Markdown.
private fun authoredTextBeforeTranscript(
  lines: List<String>,
  markerIndex: Int,
): String = lines.take(markerIndex).joinToString("\n").removeSuffix("\n")

/** One row of a queued (outbox) user bubble; [attachment] is set for stored attachments. */
internal data class ChatOutboxBubblePart(
  val content: ChatMessageContent,
  val attachment: ChatOutboxAttachment? = null,
)

/**
 * Projects a queued send into the same shape the sent bubble uses: photos and files first,
 * then the author's text without the exact "See attached." placeholder, then voice/video rows.
 * File names are kept as metadata; the renderer hides only recorder `voice-note-<uuid>` names.
 */
internal fun chatOutboxBubbleParts(
  text: String,
  attachments: List<ChatOutboxAttachment>,
): List<ChatOutboxBubblePart> {
  val attachmentParts =
    attachments.map { attachment ->
      ChatOutboxBubblePart(
        content =
          ChatMessageContent(
            type = attachment.type,
            mimeType = attachment.mimeType,
            fileName = attachment.fileName,
            sizeBytes = attachment.byteLength,
            durationMs = attachment.durationMs,
          ),
        attachment = attachment,
      )
    }
  val caption = if (attachments.isNotEmpty()) stripAttachmentPlaceholder(text) else text
  val textPart = caption.takeIf { it.isNotBlank() }?.let { ChatOutboxBubblePart(ChatMessageContent(type = "text", text = it)) }
  val (detached, inline) = attachmentParts.partition { it.content.isDetachedChatAttachment() }
  return detached + listOfNotNull(textPart) + inline
}
