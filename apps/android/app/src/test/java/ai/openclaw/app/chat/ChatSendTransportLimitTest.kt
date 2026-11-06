package ai.openclaw.app.chat

import ai.openclaw.app.ui.chat.CHAT_COMPOSER_MAX_TOTAL_ATTACHMENTS
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A queued video that was admitted before transport sizing existed replays bytes OkHttp can never
 * enqueue, closing the connection and holding later sends in the same session (#193810).
 */
class ChatSendTransportLimitTest {
  private fun payload(
    mimeType: String,
    decodedBytes: Int,
  ): OutboxAttachmentPayload =
    OutboxAttachmentPayload(
      type = mimeType.substringBefore('/'),
      mimeType = mimeType,
      fileName = "media-${mimeType.replace('/', '-')}.bin",
      durationMs = null,
      bytes = ByteArray(decodedBytes),
    )

  @Test
  fun thirteenMebibyteVideoNoLongerFitsOneCommand() {
    // The issue's reproduction: 13,631,488 decoded bytes become 18,175,320 Base64 characters.
    assertEquals(18_175_320L, chatSendBase64Length(13_631_488L))
    assertFalse(chatSendAttachmentsFitWebSocketFrame(listOf(13_631_488L)))
    assertFalse(outboxCommandAttachmentsWithinByteLimits(listOf(payload("video/mp4", 13_631_488))))
  }

  @Test
  fun eightMebibyteVideoControlStillFits() {
    // 8,388,608 decoded bytes become 11,184,812 Base64 characters and stay under the 16 MiB frame.
    assertEquals(11_184_812L, chatSendBase64Length(8_388_608L))
    assertTrue(chatSendAttachmentsFitWebSocketFrame(listOf(8_388_608L)))
    assertTrue(outboxCommandAttachmentsWithinByteLimits(listOf(payload("video/mp4", 8 * 1024 * 1024))))
  }

  @Test
  fun videoSendCeilingIsOneTransportableFrame() {
    assertTrue(chatSendAttachmentFrameFits(CHAT_COMPOSER_MAX_VIDEO_SEND_DECODED_BYTES))
    assertFalse(chatSendAttachmentFrameFits(CHAT_COMPOSER_MAX_VIDEO_SEND_DECODED_BYTES + 1))
    assertTrue(CHAT_COMPOSER_MAX_VIDEO_SEND_DECODED_BYTES > 8L * 1024L * 1024L)
    assertTrue(CHAT_COMPOSER_MAX_VIDEO_SEND_DECODED_BYTES < 20L * 1024L * 1024L)
  }

  @Test
  fun nonVideoCeilingKeepsItsExistingDurableLimit() {
    assertEquals(OUTBOX_MAX_COMMAND_ATTACHMENT_BYTES, 8L * 1024L * 1024L)
    assertTrue(outboxCommandAttachmentsWithinByteLimits(listOf(payload("audio/mp4", 8 * 1024 * 1024))))
    assertFalse(outboxCommandAttachmentsWithinByteLimits(listOf(payload("audio/mp4", 8 * 1024 * 1024 + 1))))
  }

  @Test
  fun commandEnvelopeCountsEveryAttachment() {
    // Twenty-four 6 MiB images pass the per-image ceiling and stay under the 48 MiB aggregate, but
    // their 201,326,592 Base64 characters cannot travel in one WebSocket frame.
    val images = List(CHAT_COMPOSER_MAX_TOTAL_ATTACHMENTS) { payload("image/jpeg", 6 * 1024 * 1024) }

    assertFalse(outboxCommandAttachmentsWithinByteLimits(images))
    // Two 6 MiB images are 16,777,216 Base64 characters alone and exceed the bound as a pair.
    assertFalse(outboxCommandAttachmentsWithinByteLimits(images.take(2)))
    assertTrue(outboxCommandAttachmentsWithinByteLimits(images.take(1)))
  }
}
