package ai.openclaw.app.buddy

import org.junit.Assert.assertEquals
import org.junit.Test

class BuddyAgentActivityTrackerTest {
  @Test
  fun markSubmittedShowsThinkingImmediately() {
    val tracker = BuddyAgentActivityTracker()

    tracker.markSubmitted(sessionKey = "agent:nemo:android-buddy-device", runId = "run-1")

    assertEquals(BuddyAgentActivityPhase.Thinking, tracker.activity.value.phase)
    assertEquals("agent:nemo:android-buddy-device", tracker.activity.value.sessionKey)
    assertEquals("run-1", tracker.activity.value.runId)
  }

  @Test
  fun clearSubmittedRunReturnsToIdle() {
    val tracker = BuddyAgentActivityTracker()
    tracker.markSubmitted(sessionKey = "agent:nemo:android-buddy-device", runId = "run-1")

    tracker.clearSubmittedRun(runId = "run-1", sessionKey = "agent:nemo:android-buddy-device")

    assertEquals(BuddyAgentActivityPhase.Idle, tracker.activity.value.phase)
    assertEquals("agent:nemo:android-buddy-device", tracker.activity.value.sessionKey)
  }

  @Test
  fun timedOutSubmittedRunShowsFriendlyErrorWhenNoReplyArrived() {
    val tracker = BuddyAgentActivityTracker()
    tracker.markSubmitted(sessionKey = "agent:nemo:android-buddy-device", runId = "run-1")

    tracker.markSubmittedRunTimedOut(runId = "run-1", sessionKey = "agent:nemo:android-buddy-device")

    assertEquals(BuddyAgentActivityPhase.Error, tracker.activity.value.phase)
    assertEquals("Nemo 刚才没想好，可以再说一次", tracker.activity.value.message)
  }

  @Test
  fun timedOutSubmittedRunDoesNotReplaceVisibleAssistantReply() {
    val tracker = BuddyAgentActivityTracker()
    tracker.handleGatewayEvent(
      "agent",
      """
      {
        "sessionKey": "agent:nemo:android-buddy-device",
        "runId": "run-1",
        "stream": "assistant",
        "data": { "text": "我已经回答啦。" }
      }
      """.trimIndent(),
    )
    tracker.handleGatewayEvent("chat", """{"sessionKey":"agent:nemo:android-buddy-device","runId":"run-1","state":"final"}""")

    tracker.markSubmittedRunTimedOut(runId = "run-1", sessionKey = "agent:nemo:android-buddy-device")

    assertEquals(BuddyAgentActivityPhase.Speaking, tracker.activity.value.phase)
    assertEquals("我已经回答啦。", tracker.activity.value.message)
  }

  @Test
  fun chatDeltaAndFinalMapToThinkingLifecycle() {
    val tracker = BuddyAgentActivityTracker()

    tracker.handleGatewayEvent("chat", """{"sessionKey":"main","runId":"run-1","state":"delta"}""")

    assertEquals(BuddyAgentActivityPhase.Thinking, tracker.activity.value.phase)
    assertEquals("main", tracker.activity.value.sessionKey)

    tracker.handleGatewayEvent("chat", """{"sessionKey":"main","runId":"run-1","state":"final"}""")

    assertEquals(BuddyAgentActivityPhase.Idle, tracker.activity.value.phase)
  }

  @Test
  fun chatDeltaAssistantTextMapsToSpeaking() {
    val tracker = BuddyAgentActivityTracker()

    tracker.handleGatewayEvent(
      "chat",
      """
      {
        "sessionKey": "agent:nemo:android-buddy-device",
        "runId": "run-1",
        "state": "delta",
        "message": {
          "role": "assistant",
          "content": [
            { "type": "text", "text": "你好，我是 Nemo。" }
          ]
        }
      }
      """.trimIndent(),
    )

    assertEquals(BuddyAgentActivityPhase.Speaking, tracker.activity.value.phase)
    assertEquals("你好，我是 Nemo。", tracker.activity.value.message)
  }

  @Test
  fun configuredSessionFilterIgnoresOtherAgentAssistantText() {
    val tracker = BuddyAgentActivityTracker(acceptedSessionKey = { it == "agent:nemo:android-buddy-device" })

    tracker.handleGatewayEvent(
      "chat",
      """
      {
        "sessionKey": "agent:other:android-buddy-device",
        "runId": "run-other",
        "state": "delta",
        "message": {
          "role": "assistant",
          "content": [
            { "type": "text", "text": "这是另一个 Agent 的回复。" }
          ]
        }
      }
      """.trimIndent(),
    )

    assertEquals(BuddyAgentActivityPhase.Idle, tracker.activity.value.phase)
    assertEquals(null, tracker.activity.value.message)
  }

  @Test
  fun configuredSessionFilterAcceptsNemoAssistantText() {
    val tracker = BuddyAgentActivityTracker(acceptedSessionKey = { it == "agent:nemo:android-buddy-device" })

    tracker.handleGatewayEvent(
      "chat",
      """
      {
        "sessionKey": "agent:nemo:android-buddy-device",
        "runId": "run-nemo",
        "state": "delta",
        "message": {
          "role": "assistant",
          "content": [
            { "type": "text", "text": "这是 Nemo 的回复。" }
          ]
        }
      }
      """.trimIndent(),
    )

    assertEquals(BuddyAgentActivityPhase.Speaking, tracker.activity.value.phase)
    assertEquals("这是 Nemo 的回复。", tracker.activity.value.message)
  }

  @Test
  fun agentAssistantTextMapsToSpeaking() {
    val tracker = BuddyAgentActivityTracker()

    tracker.handleGatewayEvent(
      "agent",
      """
      {
        "sessionKey": "agent:nemo:android-buddy-device",
        "runId": "run-1",
        "stream": "assistant",
        "data": { "text": "我在这里。" }
      }
      """.trimIndent(),
    )

    assertEquals(BuddyAgentActivityPhase.Speaking, tracker.activity.value.phase)
    assertEquals("我在这里。", tracker.activity.value.message)
  }

  @Test
  fun finalKeepsLastAssistantTextVisible() {
    val tracker = BuddyAgentActivityTracker()

    tracker.handleGatewayEvent(
      "chat",
      """
      {
        "sessionKey": "agent:nemo:android-buddy-device",
        "runId": "run-1",
        "state": "delta",
        "message": {
          "role": "assistant",
          "content": [
            { "type": "text", "text": "可以，我陪你聊一会儿。" }
          ]
        }
      }
      """.trimIndent(),
    )
    tracker.handleGatewayEvent("chat", """{"sessionKey":"agent:nemo:android-buddy-device","runId":"run-1","state":"final"}""")

    assertEquals(BuddyAgentActivityPhase.Speaking, tracker.activity.value.phase)
    assertEquals("可以，我陪你聊一会儿。", tracker.activity.value.message)
  }

  @Test
  fun lateRunIdConfirmationAfterFinalDoesNotHideAssistantReply() {
    val tracker = BuddyAgentActivityTracker()
    tracker.markSubmitted(sessionKey = "agent:nemo:android-buddy-device", runId = "provisional-run")
    tracker.handleGatewayEvent(
      "agent",
      """
      {
        "sessionKey": "agent:nemo:android-buddy-device",
        "runId": "run-1",
        "stream": "assistant",
        "data": { "text": "我已经回来啦。" }
      }
      """.trimIndent(),
    )
    tracker.handleGatewayEvent("chat", """{"sessionKey":"agent:nemo:android-buddy-device","runId":"run-1","state":"final"}""")

    tracker.markSubmitted(sessionKey = "agent:nemo:android-buddy-device", runId = "run-1")

    assertEquals(BuddyAgentActivityPhase.Speaking, tracker.activity.value.phase)
    assertEquals("我已经回来啦。", tracker.activity.value.message)
  }

  @Test
  fun confirmedRunIdDropsProvisionalRunBeforeTimeoutCleanup() {
    val tracker = BuddyAgentActivityTracker()
    tracker.markSubmitted(sessionKey = "agent:nemo:android-buddy-device", runId = "provisional-run")
    tracker.handleGatewayEvent(
      "agent",
      """
      {
        "sessionKey": "agent:nemo:android-buddy-device",
        "runId": "run-1",
        "stream": "assistant",
        "data": { "text": "收到，我在这里。" }
      }
      """.trimIndent(),
    )
    tracker.handleGatewayEvent("chat", """{"sessionKey":"agent:nemo:android-buddy-device","runId":"run-1","state":"final"}""")
    tracker.confirmSubmittedRun(
      sessionKey = "agent:nemo:android-buddy-device",
      provisionalRunId = "provisional-run",
      runId = "run-1",
    )

    tracker.clearSubmittedRun(runId = "run-1", sessionKey = "agent:nemo:android-buddy-device")

    assertEquals(BuddyAgentActivityPhase.Idle, tracker.activity.value.phase)
    assertEquals("agent:nemo:android-buddy-device", tracker.activity.value.sessionKey)
  }

  @Test
  fun replayLastAssistantMessageRestoresSpeakingState() {
    val tracker = BuddyAgentActivityTracker()
    tracker.handleGatewayEvent(
      "agent",
      """
      {
        "sessionKey": "agent:nemo:android-buddy-device",
        "runId": "run-1",
        "stream": "assistant",
        "data": { "text": "我刚才说的话。" }
      }
      """.trimIndent(),
    )
    tracker.clearSubmittedRun(runId = "run-1", sessionKey = "agent:nemo:android-buddy-device")

    assertEquals("我刚才说的话。", tracker.replayLastAssistantMessage())
    assertEquals(BuddyAgentActivityPhase.Speaking, tracker.activity.value.phase)
    assertEquals("我刚才说的话。", tracker.activity.value.message)
  }

  @Test
  fun lateDeltaAfterFinalDoesNotReopenThinking() {
    val tracker = BuddyAgentActivityTracker()

    tracker.handleGatewayEvent("chat", """{"sessionKey":"main","runId":"run-1","state":"delta"}""")
    tracker.handleGatewayEvent("chat", """{"sessionKey":"main","runId":"run-1","state":"final"}""")
    tracker.handleGatewayEvent("chat", """{"sessionKey":"main","runId":"run-1","state":"delta"}""")

    assertEquals(BuddyAgentActivityPhase.Idle, tracker.activity.value.phase)
  }

  @Test
  fun agentToolEventsMapToWorkingLifecycle() {
    val tracker = BuddyAgentActivityTracker()

    tracker.handleGatewayEvent(
      "agent",
      """
      {
        "sessionKey": "main",
        "stream": "tool",
        "data": {
          "phase": "start",
          "name": "read",
          "toolCallId": "tool-1"
        }
      }
      """.trimIndent(),
    )

    assertEquals(BuddyAgentActivityPhase.Working, tracker.activity.value.phase)
    assertEquals("read", tracker.activity.value.toolName)

    tracker.handleGatewayEvent(
      "agent",
      """
      {
        "sessionKey": "main",
        "stream": "tool",
        "data": {
          "phase": "result",
          "name": "read",
          "toolCallId": "tool-1"
        }
      }
      """.trimIndent(),
    )

    assertEquals(BuddyAgentActivityPhase.Idle, tracker.activity.value.phase)
  }
}
