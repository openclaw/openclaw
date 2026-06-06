package ai.openclaw.app.gateway

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatSendAckTest {
  private val json = Json { ignoreUnknownKeys = true }

  @Test
  fun parseChatSendAckPreservesNonTerminalStartedStatus() {
    val ack = parseChatSendAck(json, """{"runId":"run-1","status":"started"}""")

    assertEquals("run-1", ack.runId)
    assertEquals("started", ack.normalizedStatus)
    assertFalse(ack.isTerminal)
  }

  @Test
  fun parseChatSendAckMarksTimeoutAndErrorAsTerminal() {
    val timeout = parseChatSendAck(json, """{"runId":"run-timeout","status":"timeout"}""")
    val error = parseChatSendAck(json, """{"runId":"run-error","status":" error "}""")

    assertEquals("run-timeout", timeout.runId)
    assertTrue(timeout.isTerminal)
    assertEquals("run-error", error.runId)
    assertTrue(error.isTerminal)
  }

  @Test
  fun parseChatSendAckToleratesMalformedPayloads() {
    val ack = parseChatSendAck(json, "not-json")

    assertNull(ack.runId)
    assertEquals("", ack.normalizedStatus)
    assertFalse(ack.isTerminal)
  }
}
