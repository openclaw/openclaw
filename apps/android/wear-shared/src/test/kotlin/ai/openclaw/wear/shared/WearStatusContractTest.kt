package ai.openclaw.wear.shared

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class WearStatusContractTest {
  @Test
  fun requestRoundTripsWithStableProtocolFields() {
    val request = WearStatusRequest(requestId = "request-1")

    val decoded = WearStatusCodec.decodeRequest(WearStatusCodec.encodeRequest(request))

    assertEquals(WEAR_STATUS_PROTOCOL_VERSION, decoded.protocolVersion)
    assertEquals("request-1", decoded.requestId)
  }

  @Test
  fun responseRoundTripsWithoutSerializingNullFields() {
    val response =
      WearStatusResponse(
        requestId = "request-2",
        result = WearStatusResult.OK,
        snapshot =
          WearStatusSnapshot(
            generatedAtEpochMillis = 1234L,
            gatewayState = WearGatewayState.CONNECTED,
          ),
      )

    val payload = WearStatusCodec.encodeResponse(response)
    val decoded = WearStatusCodec.decodeResponse(payload)

    assertEquals(response, decoded)
    assertNull(decoded.errorCode)
  }

  @Test
  fun decoderIgnoresFieldsAddedByNewerPeers() {
    val payload =
      """
      {
        "protocolVersion": 1,
        "requestId": "request-3",
        "result": "ERROR",
        "errorCode": "PHONE_NOT_READY",
        "futureField": true
      }
      """.trimIndent().encodeToByteArray()

    val decoded = WearStatusCodec.decodeResponse(payload)

    assertEquals(WearStatusErrorCode.PHONE_NOT_READY, decoded.errorCode)
  }

  @Test
  fun conversationRequestRoundTripsWithActionPayload() {
    val request =
      WearConversationRequest(
        requestId = "conversation-1",
        action = WearConversationAction.SEND_MESSAGE,
        message = "Hello from the watch",
      )

    val decoded =
      WearConversationCodec.decodeRequest(
        WearConversationCodec.encodeRequest(request),
      )

    assertEquals(request, decoded)
  }

  @Test
  fun conversationSnapshotRoundTripsWithoutPrivateSessionKeys() {
    val response =
      WearConversationResponse(
        requestId = "conversation-2",
        result = WearConversationResult.OK,
        snapshot =
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
          ),
      )

    val decoded =
      WearConversationCodec.decodeResponse(
        WearConversationCodec.encodeResponse(response),
      )

    assertEquals(response, decoded)
    assertEquals(
      "session-handle",
      decoded
        .snapshot
        ?.sessions
        ?.single()
        ?.id,
    )
  }
}
