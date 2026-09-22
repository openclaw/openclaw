package ai.openclaw.wear.shared

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WearReplyTextTest {
  @Test fun unicodeAndEscapedControlsRoundTripWithinRealFrameBudget() {
    for (text in listOf("a".repeat(4095) + "👩🏽‍🚀" + "é\n".repeat(3000), "\u0001\"\\".repeat(7000))) {
      var offset = 0
      var revision: String? = null
      val received = StringBuilder()
      do {
        val page = WearReplyText.page(text, "phone:agent:session:entry", offset, revision)
        val bytes = WearProtocolCodec.encode(WearMessage.Response(requestId = "request", ok = true, result = WearReplyText.encode(page), eventStreamId = "epoch", eventSequence = Long.MAX_VALUE))
        assertTrue(bytes.size < WearProtocol.MAX_MESSAGE_BYTES)
        val decoded = (WearProtocolCodec.decode(bytes) as WearDecodeResult.Success).message as WearMessage.Response
        val read = WearReplyText.decode(decoded.result!!)
        assertEquals(WearReplyTextStatus.Ready, read.status)
        assertEquals(offset, read.offset)
        assertFalse(read.text.firstOrNull()?.isLowSurrogate() == true)
        assertFalse(read.text.lastOrNull()?.isHighSurrogate() == true)
        received.append(read.text)
        revision = read.revision
        offset = read.nextOffset ?: break
      } while (true)
      assertEquals(text, received.toString())
    }
  }

  @Test fun twentyTalkPreviewsFitEvenWithJsonEscapingAndSurrogateEdges() {
    val text = "\u0001".repeat(1499) + "👩🏽‍🚀".repeat(3000)
    val preview = WearReplyText.preview(text)
    assertFalse(preview.last().isHighSurrogate())
    val snapshot =
      WearRealtimeTalkSnapshot(
        conversation =
          (1..20).map {
            WearRealtimeTalkEntry("id-$it", WearRealtimeTalkRole.ASSISTANT, preview, textTruncated = true, fullTextAvailable = true)
          },
      )
    val frame = WearMessage.Event(sequence = Long.MAX_VALUE, streamId = "epoch", event = WearEventType.Talk, payload = WearRealtimeTalkCodec.encode(snapshot))
    assertTrue(WearProtocolCodec.encode(frame).size < WearProtocol.MAX_MESSAGE_BYTES)
  }

  @Test fun revisionsOffsetsAndResourceLimitsCannotSilentlyProduceCompleteText() {
    val text = "x".repeat(5000)
    val first = WearReplyText.page(text, "owner", 0, null)
    assertEquals(WearReplyTextStatus.Changed, WearReplyText.page(text + "new", "owner", 4096, first.revision).status)
    assertEquals(WearReplyTextStatus.Changed, WearReplyText.page(text, "other-phone", 4096, first.revision).status)
    assertEquals(WearReplyTextStatus.Unavailable, WearReplyText.page(text, "owner", 4096, null).status)
    assertEquals(WearReplyTextStatus.Unavailable, WearReplyText.page(text, "owner", -1, null).status)
    assertEquals(WearReplyTextStatus.Unavailable, WearReplyText.page(text, "owner", 5001, first.revision).status)
    assertEquals(WearReplyTextStatus.TooLarge, WearReplyText.page("x".repeat(WearReplyText.MAX_TEXT_LENGTH + 1), "owner", 0, null).status)
    assertEquals("", WearReplyText.page("", "owner", 0, null).text)
  }
}
