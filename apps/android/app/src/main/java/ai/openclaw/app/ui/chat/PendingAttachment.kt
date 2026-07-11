package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.OutgoingAttachment
import ai.openclaw.app.chat.VOICE_NOTE_MIME_TYPE
import ai.openclaw.app.chat.VoiceNoteRecording
import java.util.Base64

/** Attachment staged in a composer until the next chat.send call. */
data class PendingAttachment(
  val id: String,
  val fileName: String,
  val mimeType: String,
  val base64: String,
  val durationMs: Long? = null,
)

internal fun PendingAttachment.toOutgoingAttachment(): OutgoingAttachment =
  OutgoingAttachment(
    type = attachmentTypeForMimeType(mimeType),
    mimeType = mimeType,
    fileName = fileName,
    base64 = base64,
    durationMs = durationMs,
  )

internal fun attachmentTypeForMimeType(mimeType: String): String =
  when {
    mimeType.startsWith("audio/") -> "audio"
    mimeType.startsWith("image/") -> "image"
    else -> "file"
  }

internal fun stageVoiceNoteAttachment(recording: VoiceNoteRecording): PendingAttachment =
  try {
    PendingAttachment(
      id = recording.file.absolutePath + "#" + recording.durationMs,
      fileName = recording.file.name,
      mimeType = VOICE_NOTE_MIME_TYPE,
      base64 = Base64.getEncoder().encodeToString(recording.file.readBytes()),
      durationMs = recording.durationMs,
    )
  } finally {
    recording.file.delete()
  }

internal fun formatVoiceNoteDuration(durationMs: Long): String {
  val totalSeconds = durationMs.coerceAtLeast(0L) / 1_000L
  val minutes = totalSeconds / 60L
  val seconds = totalSeconds % 60L
  return "$minutes:${seconds.toString().padStart(2, '0')}"
}
