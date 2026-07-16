package ai.openclaw.wear.shared

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class WearConversationModelsTest {
  @Test
  fun snapshotPayloadRoundTripsWithoutPrivateSessionKeys() {
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

    val decoded =
      WearConversationPayloadCodec.decodeSnapshot(
        WearConversationPayloadCodec.encodeSnapshot(snapshot),
      )

    assertEquals(snapshot, decoded)
    assertEquals("session-handle", decoded.sessions.single().id)
  }

  @Test
  fun errorCodesUseStableWireNames() {
    assertEquals(
      "gateway_offline",
      WearConversationErrorCode.GATEWAY_OFFLINE.toWireCode(),
    )
    assertEquals(
      WearConversationErrorCode.PHONE_NOT_READY,
      wearConversationErrorCode("phone_not_ready"),
    )
    assertNull(wearConversationErrorCode("future_error"))
  }
}
