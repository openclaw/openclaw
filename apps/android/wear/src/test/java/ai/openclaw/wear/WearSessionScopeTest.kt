package ai.openclaw.wear

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class WearSessionScopeTest {
  @Test
  fun discardsStatusSessionWhenLaterListReportsDifferentAgent() {
    assertNull(
      coherentWearActiveSessionKey(
        statusAgentId = "agent-a",
        statusSessionKey = "agent:agent-a:main",
        sessionListAgentId = "agent-b",
      ),
    )
  }

  @Test
  fun keepsStatusSessionForMatchingAndLegacyPhoneSnapshots() {
    val sessionKey = "agent:agent-a:main"

    assertEquals(sessionKey, coherentWearActiveSessionKey("agent-a", sessionKey, "agent-a"))
    assertEquals(sessionKey, coherentWearActiveSessionKey("agent-a", sessionKey, null))
  }

  @Test
  fun exposesModelOnlyForPhoneActiveSession() {
    assertEquals("openai/model", wearSelectedModelRef("agent:main", "agent:main", "openai/model"))
    assertNull(wearSelectedModelRef("agent:other", "agent:main", "openai/model"))
    assertNull(wearSelectedModelRef(null, "agent:main", "openai/model"))
  }

  @Test
  fun agentSwitchDropsThePreviousSessionModelAndStreamTogether() {
    val previousSession =
      WearSession(
        key = "agent:old:thread-1",
        title = "Old",
        updatedAt = null,
        hasActiveRun = true,
        phoneNodeId = "phone-a",
        modelRef = "openai/old",
      )
    val state =
      WearUiState(
        activeAgentId = "old",
        sessions = listOf(previousSession),
        selectedSession = previousSession,
        selectedModelRef = "openai/old",
        models = listOf(WearModel("openai/old", "Old")),
        messages = listOf(WearChatMessage("m1", "assistant", "old reply", 1)),
        streamText = "old stream",
        activeRunId = "run-old",
      )

    val switched = state.switchAgentContext("new")

    assertEquals("new", switched.activeAgentId)
    assertNull(switched.selectedSession)
    assertNull(switched.selectedModelRef)
    assertNull(switched.streamText)
    assertNull(switched.activeRunId)
    assertEquals(emptyList<WearSession>(), switched.sessions)
    assertEquals(emptyList<WearModel>(), switched.models)
    assertEquals(emptyList<WearChatMessage>(), switched.messages)
  }

  @Test
  fun sessionSwitchMovesModelAndClearsOnlyThePreviousTranscript() {
    val nextSession =
      WearSession(
        key = "agent:main:thread-2",
        title = "Next",
        updatedAt = null,
        hasActiveRun = false,
        phoneNodeId = "phone-a",
        modelRef = "openai/new",
      )
    val state =
      WearUiState(
        activeAgentId = "main",
        selectedModelRef = "openai/old",
        models = listOf(WearModel("openai/new", "New")),
        messages = listOf(WearChatMessage("m1", "assistant", "old reply", 1)),
        streamText = "old stream",
        activeRunId = "run-old",
      )

    val switched = state.switchSessionContext(nextSession)

    assertEquals(nextSession, switched.selectedSession)
    assertEquals("openai/new", switched.selectedModelRef)
    assertEquals("main", switched.activeAgentId)
    assertEquals(listOf(WearModel("openai/new", "New")), switched.models)
    assertEquals(emptyList<WearChatMessage>(), switched.messages)
    assertNull(switched.streamText)
    assertNull(switched.activeRunId)
  }
}
