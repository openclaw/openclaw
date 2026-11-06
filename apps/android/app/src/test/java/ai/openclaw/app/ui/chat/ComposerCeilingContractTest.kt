package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.CHAT_COMPOSER_MAX_ATTACHMENTS
import ai.openclaw.app.chat.CHAT_COMPOSER_MAX_BASE64_CHARS
import ai.openclaw.app.chat.CHAT_COMPOSER_MAX_DECODED_ATTACHMENT_BYTES
import ai.openclaw.app.chat.CHAT_COMPOSER_MAX_TOTAL_ATTACHMENTS
import ai.openclaw.app.chat.CHAT_COMPOSER_MAX_VIDEO_DECODED_BYTES
import ai.openclaw.app.chat.CHAT_COMPOSER_MAX_VIDEO_SEND_DECODED_BYTES
import ai.openclaw.app.chat.OUTBOX_MAX_COMMAND_ATTACHMENT_BYTES
import ai.openclaw.app.chat.outboxCommandAttachmentsWithinByteLimits
import ai.openclaw.app.chat.OutboxAttachmentPayload
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The composer used to admit raw payload sizes; re-audit the literal numbers extracted from
 * ChatComposer.kt / ChatCommandOutbox.kt at the candidate revision to keep this audit honest.
 */
class ComposerCeilingContractTest {
  @Test
  fun candidateCeilingsStayBelowTheTransportBound() {
    assertEquals(6L * 1024L * 1024L, CHAT_COMPOSER_MAX_IMAGE_DECODED_BYTES)
    assertEquals(8L * 1024L * 1024L, CHAT_COMPOSER_MAX_AUDIO_DECODED_BYTES)
    assertEquals(8L * 1024L * 1024L, OUTBOX_MAX_COMMAND_ATTACHMENT_BYTES)
    assertEquals(20L * 1024L * 1024L, CHAT_COMPOSER_MAX_VIDEO_DECODED_BYTES)
    assertEquals(12_570_624L, CHAT_COMPOSER_MAX_VIDEO_SEND_DECODED_BYTES)
    assertEquals(8, CHAT_COMPOSER_MAX_ATTACHMENTS)
    assertEquals(24, CHAT_COMPOSER_MAX_TOTAL_ATTACHMENTS)
    assertTrue(CHAT_COMPOSER_MAX_VIDEO_SEND_DECODED_BYTES < CHAT_COMPOSER_MAX_VIDEO_DECODED_BYTES)
    assertTrue(CHAT_COMPOSER_MAX_BASE64_CHARS > 0 && CHAT_COMPOSER_MAX_DECODED_ATTACHMENT_BYTES > 0)
  }

  @Test
  fun replayedOutboxAttachmentSizesUseTheSameFrameGate() {
    fun payload(type: String, mime: String, decoded: Int) =
      OutboxAttachmentPayload(type, mime, "media.bin", null, ByteArray(decoded))

    assertFalse(outboxCommandAttachmentsWithinByteLimits(listOf(payload("video", "video/mp4", 13_631_488))))
    assertTrue(outboxCommandAttachmentsWithinByteLimits(listOf(payload("video", "video/mp4", 8 * 1024 * 1024))))
    assertTrue(outboxCommandAttachmentsWithinByteLimits(listOf(payload("audio", "audio/mp4", 8 * 1024 * 1024))))
  }
}
