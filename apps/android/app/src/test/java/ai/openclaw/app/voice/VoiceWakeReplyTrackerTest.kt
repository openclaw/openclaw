package ai.openclaw.app.voice

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class VoiceWakeReplyTrackerTest {
  @Test
  fun speaksFinalAssistantTextOfTheFirstRunSeenAfterArming() {
    val tracker = VoiceWakeReplyTracker()
    tracker.arm(sessionKey = "agent:main:main", nowMs = 1_000)

    assertNull(tracker.onChatEvent(chatEvent(runId = "run-1", state = "delta", text = "Hel"), nowMs = 1_100))
    assertEquals(
      "Hello there",
      tracker.onChatEvent(chatEvent(runId = "run-1", state = "final", text = "Hello there"), nowMs = 1_200),
    )
    // The reply was consumed; a later run on the same session stays silent.
    assertNull(tracker.onChatEvent(chatEvent(runId = "run-2", state = "final", text = "Again"), nowMs = 1_300))
  }

  @Test
  fun ignoresOtherSessionsAndOtherRunsWhileTracking() {
    val tracker = VoiceWakeReplyTracker()
    tracker.arm(sessionKey = "agent:main:main", nowMs = 0)

    assertNull(
      tracker.onChatEvent(chatEvent(runId = "other", state = "final", text = "Other", sessionKey = "agent:main:side"), nowMs = 10),
    )
    assertNull(tracker.onChatEvent(chatEvent(runId = "run-1", state = "delta", text = "H"), nowMs = 20))
    assertNull(tracker.onChatEvent(chatEvent(runId = "run-2", state = "final", text = "Concurrent"), nowMs = 30))
    assertEquals("Done", tracker.onChatEvent(chatEvent(runId = "run-1", state = "final", text = "Done"), nowMs = 40))
  }

  @Test
  fun abortedRunAndTimeoutStopTracking() {
    val tracker = VoiceWakeReplyTracker(timeoutMs = 1_000)
    tracker.arm(sessionKey = "agent:main:main", nowMs = 0)
    assertNull(tracker.onChatEvent(chatEvent(runId = "run-1", state = "aborted", text = null), nowMs = 10))
    assertNull(tracker.onChatEvent(chatEvent(runId = "run-1", state = "final", text = "Late"), nowMs = 20))

    tracker.arm(sessionKey = "agent:main:main", nowMs = 0)
    assertNull(tracker.onChatEvent(chatEvent(runId = "run-3", state = "final", text = "Too late"), nowMs = 5_000))
  }

  @Test
  fun disarmedTrackerNeverSpeaks() {
    val tracker = VoiceWakeReplyTracker()
    assertNull(tracker.onChatEvent(chatEvent(runId = "run-1", state = "final", text = "Hello"), nowMs = 0))
    tracker.arm(sessionKey = "agent:main:main", nowMs = 0)
    tracker.clear()
    assertNull(tracker.onChatEvent(chatEvent(runId = "run-1", state = "final", text = "Hello"), nowMs = 1))
  }

  private fun chatEvent(
    runId: String,
    state: String,
    text: String?,
    sessionKey: String = "agent:main:main",
  ): JsonObject {
    val message =
      if (text == null) {
        "null"
      } else {
        """{"role":"assistant","content":[{"type":"text","text":"$text"}]}"""
      }
    return Json.parseToJsonElement(
      """{"runId":"$runId","sessionKey":"$sessionKey","state":"$state","message":$message}""",
    ) as JsonObject
  }
}
