package ai.openclaw.app.wear

import ai.openclaw.wear.shared.WEAR_CONVERSATION_MAX_MESSAGE_LENGTH
import ai.openclaw.wear.shared.WearConversationAction
import ai.openclaw.wear.shared.WearConversationCodec
import ai.openclaw.wear.shared.WearConversationErrorCode
import ai.openclaw.wear.shared.WearConversationRequest
import ai.openclaw.wear.shared.WearConversationResult
import ai.openclaw.wear.shared.WearConversationSnapshot
import ai.openclaw.wear.shared.WearGatewayState
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class WearConversationRequestHandlerTest {
  @Test
  fun returnsCurrentConversationSnapshot() =
    runTest {
      val source = FakeConversationSource()
      val response =
        execute(
          source = source,
          request =
            WearConversationRequest(
              requestId = "request-1",
              action = WearConversationAction.SNAPSHOT,
            ),
        )

      assertEquals(WearConversationResult.OK, response.result)
      assertEquals(WearGatewayState.CONNECTED, response.snapshot?.gatewayState)
      assertNull(response.errorCode)
    }

  @Test
  fun delegatesBoundedMessagesToThePhoneRuntime() =
    runTest {
      val source = FakeConversationSource()
      val response =
        execute(
          source = source,
          request =
            WearConversationRequest(
              requestId = "request-2",
              action = WearConversationAction.SEND_MESSAGE,
              message = "  Hello agent  ",
            ),
        )

      assertEquals(WearConversationResult.OK, response.result)
      assertEquals("Hello agent", source.sentMessage)
    }

  @Test
  fun rejectsOversizedMessagesBeforeCallingTheRuntime() =
    runTest {
      val source = FakeConversationSource()
      val response =
        execute(
          source = source,
          request =
            WearConversationRequest(
              requestId = "request-3",
              action = WearConversationAction.SEND_MESSAGE,
              message = "x".repeat(WEAR_CONVERSATION_MAX_MESSAGE_LENGTH + 1),
            ),
        )

      assertEquals(WearConversationResult.ERROR, response.result)
      assertEquals(WearConversationErrorCode.INVALID_REQUEST, response.errorCode)
      assertNull(source.sentMessage)
    }

  @Test
  fun selectsOnlyTheFieldOwnedByTheRequestedAction() =
    runTest {
      val source = FakeConversationSource()
      val response =
        execute(
          source = source,
          request =
            WearConversationRequest(
              requestId = "request-4",
              action = WearConversationAction.SELECT_SESSION,
              sessionId = "session-handle",
              agentId = "main",
            ),
        )

      assertEquals(WearConversationResult.ERROR, response.result)
      assertEquals(WearConversationErrorCode.INVALID_REQUEST, response.errorCode)
      assertNull(source.selectedSession)
    }

  private suspend fun execute(
    source: PhoneWearConversationSource,
    request: WearConversationRequest,
  ) = WearConversationCodec.decodeResponse(
    WearConversationRequestHandler(source)
      .handle(WearConversationCodec.encodeRequest(request)),
  )

  private class FakeConversationSource : PhoneWearConversationSource {
    var sentMessage: String? = null
    var selectedSession: String? = null

    override suspend fun snapshot(): PhoneWearConversationResult = PhoneWearConversationResult(snapshot = snapshotValue())

    override suspend fun sendMessage(message: String): PhoneWearConversationResult {
      sentMessage = message
      return PhoneWearConversationResult(snapshot = snapshotValue())
    }

    override suspend fun selectSession(sessionId: String): PhoneWearConversationResult {
      selectedSession = sessionId
      return PhoneWearConversationResult(snapshot = snapshotValue())
    }

    override suspend fun selectAgent(agentId: String): PhoneWearConversationResult = PhoneWearConversationResult(snapshot = snapshotValue())

    private fun snapshotValue(): WearConversationSnapshot =
      WearConversationSnapshot(
        generatedAtEpochMillis = 1234L,
        gatewayState = WearGatewayState.CONNECTED,
      )
  }
}
