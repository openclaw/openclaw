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
  fun parseChatSendAckMarksOkAsTerminalSuccess() {
    val ack = parseChatSendAck(json, """{"runId":"run-ok","status":" ok "}""")

    assertEquals("run-ok", ack.runId)
    assertEquals("ok", ack.normalizedStatus)
    assertTrue(ack.isTerminal)
    assertTrue(ack.isTerminalSuccess)
    assertFalse(ack.isTerminalFailure)
  }

  @Test
  fun parseChatSendAckMarksTimeoutAndErrorAsTerminalFailures() {
    val timeout = parseChatSendAck(json, """{"runId":"run-timeout","status":"timeout"}""")
    val error = parseChatSendAck(json, """{"runId":"run-error","status":" error "}""")

    assertEquals("run-timeout", timeout.runId)
    assertTrue(timeout.isTerminal)
    assertFalse(timeout.isTerminalSuccess)
    assertTrue(timeout.isTerminalFailure)
    assertEquals("run-error", error.runId)
    assertTrue(error.isTerminal)
    assertFalse(error.isTerminalSuccess)
    assertTrue(error.isTerminalFailure)
  }

  @Test
  fun cachedOkAckUsesUnfilteredHistoryFallback() {
    val startedAt = 123.0
    val ok = parseChatSendAck(json, """{"runId":"run-ok","status":"ok"}""")
    val started = parseChatSendAck(json, """{"runId":"run-started","status":"started"}""")

    assertNull(chatSendAckHistorySinceSeconds(ok, startedAt))
    assertEquals(startedAt, chatSendAckHistorySinceSeconds(started, startedAt) ?: -1.0, 0.0)
  }

  @Test
  fun parseChatSendAckToleratesMalformedPayloads() {
    val ack = parseChatSendAck(json, "not-json")

    assertNull(ack.runId)
    assertEquals("", ack.normalizedStatus)
    assertFalse(ack.isTerminal)
    assertFalse(ack.isTerminalSuccess)
    assertFalse(ack.isTerminalFailure)
  }
}
