package ai.openclaw.app.wear

import ai.openclaw.wear.shared.WearRealtimeTalkCodec
import ai.openclaw.wear.shared.WearRealtimeTalkRole
import ai.openclaw.wear.shared.WearRealtimeTalkSnapshot
import ai.openclaw.wear.shared.WearReplyText
import ai.openclaw.wear.shared.WearReplyTextStatus
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class WearRealtimeTranscriptTest {
  @Test
  fun `relay deltas retain whitespace and separate roles until authoritative final text`() {
    runTest {
      var wire = WearRealtimeTalkSnapshot()
      val controller = transcriptController { wire = it }
      val owner = WearRealtimeAttemptOwner("watch-a", "attempt-a", 1L)
      assertTrue(controller.start(owner, "session-a", "en"))
      try {
        controller.transcript("assistant", "Hello")
        controller.transcript("assistant", " ")
        val spaced = wire.conversation.single()
        assertEquals("Hello ", spaced.text)
        assertEquals(2L, spaced.textRevision)
        assertTrue(spaced.streaming)

        controller.transcript("user", "Turn")
        controller.transcript("assistant", "world")
        controller.transcript("assistant", " world")
        controller.transcript("user", " left")
        val assistant = wire.conversation.single { it.role == WearRealtimeTalkRole.ASSISTANT }
        val user = wire.conversation.single { it.role == WearRealtimeTalkRole.USER }
        assertEquals("Hello world world", assistant.text)
        assertEquals("Turn left", user.text)
        assertEquals(spaced.id, assistant.id)

        controller.transcript("assistant", "Hello, world!", final = true)
        val final = wire.conversation.single { it.role == WearRealtimeTalkRole.ASSISTANT }
        assertEquals("Hello, world!", final.text)
        assertEquals(assistant.id, final.id)
        assertFalse(final.streaming)
        assertEquals(5L, final.textRevision)

        controller.transcript("assistant", "Next")
        assertEquals(3, wire.conversation.size)
        val next = wire.conversation.last()
        assertEquals("Next", next.text)
        assertNotEquals(final.id, next.id)
      } finally {
        controller.stop(owner)
      }
    }
  }

  @Test
  fun `snapshot corrections replace deltas and retention limits never advertise partial full text`() {
    runTest {
      var wire = WearRealtimeTalkSnapshot()
      val controller = transcriptController { wire = it }
      val owner = WearRealtimeAttemptOwner("watch-a", "attempt-a", 1L)
      assertTrue(controller.start(owner, "session-a", "en"))
      try {
        controller.transcript("user", "draft")
        controller.transcript("user", "correct", snapshot = true)
        controller.transcript("user", "ed")
        val corrected = wire.conversation.single()
        assertEquals("corrected", corrected.text)
        controller.transcript("user", "Corrected.", final = true, snapshot = true)
        val final = wire.conversation.single()
        assertEquals("Corrected.", final.text)
        assertFalse(final.streaming)

        val prefix = "x".repeat(1_600)
        controller.transcript("assistant", prefix)
        controller.transcript("assistant", " tail")
        val preview = wire.conversation.last()
        assertEquals(WearReplyText.preview(prefix + " tail"), preview.text)
        assertTrue(preview.textTruncated)
        assertTrue(preview.fullTextAvailable)
        val page = controller.readReply("watch-a", "session-a", "attempt-a", preview.id, 0, null)
        assertEquals(WearReplyTextStatus.Ready, page.status)
        assertEquals(prefix + " tail", page.text)

        controller.transcript("assistant", "y".repeat(WearReplyText.MAX_TEXT_LENGTH))
        controller.transcript("assistant", "z")
        val tooLarge = wire.conversation.last()
        assertFalse(tooLarge.fullTextAvailable)
        val unavailable = controller.readReply("watch-a", "session-a", "attempt-a", tooLarge.id, 0, null)
        assertEquals(WearReplyTextStatus.TooLarge, unavailable.status)

        controller.transcript("assistant", "Recovered", final = true)
        val recovered = wire.conversation.last()
        assertEquals("Recovered", recovered.text)
        assertTrue(recovered.fullTextAvailable)
        assertFalse(recovered.textTruncated)
      } finally {
        controller.stop(owner)
      }
    }
  }
}

private fun CoroutineScope.transcriptController(
  onSnapshot: (WearRealtimeTalkSnapshot) -> Unit,
): WearRealtimeTalkController =
  WearRealtimeTalkController(
    scope = this,
    isConnected = { true },
    requestGateway = { method, _, _ ->
      if (method == "talk.session.create") """{"relaySessionId":"relay-1"}""" else """{"ok":true}"""
    },
    sendGatewayFrame = { _, _, _, _ -> },
    sendWatchFrame = { _, _, _ -> },
    onSnapshot = { snapshot ->
      val payload = WearRealtimeTalkCodec.encode(snapshot)
      onSnapshot(WearRealtimeTalkCodec.decode(payload))
    },
  )

private fun WearRealtimeTalkController.transcript(
  role: String,
  text: String,
  final: Boolean = false,
  snapshot: Boolean = false,
) {
  val payload =
    buildJsonObject {
      put("relaySessionId", "relay-1")
      put("type", "transcript")
      put("role", role)
      put("text", text)
      put("final", final)
      if (snapshot) put("textMode", "snapshot")
    }
  handleGatewayEvent("talk.event", payload.toString())
}
