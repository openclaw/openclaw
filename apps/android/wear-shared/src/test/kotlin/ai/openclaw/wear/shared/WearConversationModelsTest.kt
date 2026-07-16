package ai.openclaw.wear.shared

import org.junit.Assert.assertEquals
import org.junit.Test

class WearConversationModelsTest {
  @Test
  fun snapshotCarriesProjectedConversationState() {
    val snapshot =
      WearConversationSnapshot(
        generatedAtEpochMillis = 1234L,
        gatewayState = WearGatewayState.CONNECTED,
        activeAgentId = "main",
        agents =
          listOf(
            WearAgentSummary(
              id = "main",
              name = "Main",
              selected = true,
            ),
          ),
        activeSessionId = "session-handle",
        sessions =
          listOf(
            WearSessionSummary(
              id = "session-handle",
              title = "Main session",
              selected = true,
            ),
          ),
        messages =
          listOf(
            WearChatMessage(
              id = "message-1",
              role = WearChatRole.ASSISTANT,
              text = "Ready.",
            ),
          ),
      )

    assertEquals(WearGatewayState.CONNECTED, snapshot.gatewayState)
    assertEquals("session-handle", snapshot.activeSessionId)
    assertEquals("session-handle", snapshot.sessions.single().id)
    assertEquals(WearChatRole.ASSISTANT, snapshot.messages.single().role)
  }
}
