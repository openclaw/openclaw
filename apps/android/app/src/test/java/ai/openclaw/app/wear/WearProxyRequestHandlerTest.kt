package ai.openclaw.app.wear

import ai.openclaw.wear.shared.WEAR_CHAT_MAX_MESSAGE_LENGTH
import ai.openclaw.wear.shared.WearConversationErrorCode
import ai.openclaw.wear.shared.WearConversationPayloadCodec
import ai.openclaw.wear.shared.WearConversationSnapshot
import ai.openclaw.wear.shared.WearDecodeResult
import ai.openclaw.wear.shared.WearGatewayState
import ai.openclaw.wear.shared.WearMessage
import ai.openclaw.wear.shared.WearProtocolCodec
import ai.openclaw.wear.shared.WearRpcMethod
import ai.openclaw.wear.shared.toWireCode
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class WearProxyRequestHandlerTest {
  @Test
  fun returnsCurrentConversationSnapshotThroughTheSharedEnvelope() =
    runTest {
      val response =
        execute(
          source = FakeConversationSource(),
          method = WearRpcMethod.ProxyStatus,
        )

      assertEquals(true, response.ok)
      assertEquals(
        WearGatewayState.CONNECTED,
        response.result
          ?.let(WearConversationPayloadCodec::decodeSnapshot)
          ?.gatewayState,
      )
      assertNull(response.error)
    }

  @Test
  fun delegatesBoundedMessagesToThePhoneRuntime() =
    runTest {
      val source = FakeConversationSource()
      val response =
        execute(
          source = source,
          method = WearRpcMethod.ChatSend,
          params = buildJsonObject { put("message", "  Hello agent  ") },
        )

      assertEquals(true, response.ok)
      assertEquals("Hello agent", source.sentMessage)
    }

  @Test
  fun rejectsOversizedMessagesBeforeCallingTheRuntime() =
    runTest {
      val source = FakeConversationSource()
      val response =
        execute(
          source = source,
          method = WearRpcMethod.ChatSend,
          params =
            buildJsonObject {
              put("message", "x".repeat(WEAR_CHAT_MAX_MESSAGE_LENGTH + 1))
            },
        )

      assertEquals(false, response.ok)
      assertEquals(
        WearConversationErrorCode.INVALID_REQUEST.toWireCode(),
        response.error?.code,
      )
      assertNull(source.sentMessage)
    }

  @Test
  fun chatHistorySelectsOnlyTheRequestedOpaqueSessionHandle() =
    runTest {
      val source = FakeConversationSource()
      val response =
        execute(
          source = source,
          method = WearRpcMethod.ChatHistory,
          params = buildJsonObject { put("sessionId", "session-handle") },
        )

      assertEquals(true, response.ok)
      assertEquals("session-handle", source.selectedSession)
    }

  private suspend fun execute(
    source: PhoneWearProxySource,
    method: WearRpcMethod,
    params: kotlinx.serialization.json.JsonObject = buildJsonObject {},
  ): WearMessage.Response {
    val decoded =
      WearProtocolCodec.decode(
        WearProxyRequestHandler(source)
          .handle(
            WearProtocolCodec.encode(
              WearMessage.Request(
                requestId = "request-1",
                method = method,
                params = params,
              ),
            ),
          ),
      )
    return (decoded as WearDecodeResult.Success).message as WearMessage.Response
  }

  private class FakeConversationSource : PhoneWearProxySource {
    var sentMessage: String? = null
    var selectedSession: String? = null

    override suspend fun snapshot(): PhoneWearProxyResult = PhoneWearProxyResult(snapshot = snapshotValue())

    override suspend fun sendMessage(message: String): PhoneWearProxyResult {
      sentMessage = message
      return PhoneWearProxyResult(snapshot = snapshotValue())
    }

    override suspend fun selectSession(sessionId: String): PhoneWearProxyResult {
      selectedSession = sessionId
      return PhoneWearProxyResult(snapshot = snapshotValue())
    }

    override suspend fun abort(): PhoneWearProxyResult = PhoneWearProxyResult(snapshot = snapshotValue())

    private fun snapshotValue(): WearConversationSnapshot =
      WearConversationSnapshot(
        generatedAtEpochMillis = 1234L,
        gatewayState = WearGatewayState.CONNECTED,
      )
  }
}
