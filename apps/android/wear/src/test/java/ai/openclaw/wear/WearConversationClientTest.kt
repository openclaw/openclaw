package ai.openclaw.wear

import ai.openclaw.wear.shared.WearChatRole
import ai.openclaw.wear.shared.WearGatewayState
import ai.openclaw.wear.shared.WearMessage
import ai.openclaw.wear.shared.WearRpcError
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class WearConversationClientTest {
  private val json = Json

  @Test
  fun projectsCanonicalRpcResultsIntoConversationSnapshot() {
    val snapshot =
      buildConversationSnapshot(
        status = json.parseToJsonElement("""{"connected":true,"status":"Connected"}""").jsonObject,
        sessions =
          json
            .parseToJsonElement(
              """{"sessions":[{"key":"agent:main","displayName":"Main","updatedAt":7,"hasActiveRun":true}]}""",
            ).jsonObject,
        history =
          json
            .parseToJsonElement(
              """{"sessionKey":"agent:main","messages":[{"id":"m1","role":"assistant","content":[{"type":"text","text":"Ready."}],"timestamp":9}],"inFlightRun":{"runId":"run-1","text":"Working"}}""",
            ).jsonObject,
        activeSessionKey = "agent:main",
        generatedAtEpochMillis = 1234L,
      )

    assertEquals(1234L, snapshot.generatedAtEpochMillis)
    assertEquals(WearGatewayState.CONNECTED, snapshot.gatewayState)
    assertEquals("agent:main", snapshot.activeSessionId)
    assertEquals("Main", snapshot.sessions.single().title)
    assertEquals(WearChatRole.ASSISTANT, snapshot.messages.single().role)
    assertEquals("Ready.", snapshot.messages.single().text)
    assertEquals("Working", snapshot.streamingAssistantText)
    assertEquals(1, snapshot.pendingRunCount)
  }

  @Test
  fun mapsGatewayOfflineToActionableFailure() {
    val response =
      WearMessage.Response(
        requestId = "request-2",
        ok = false,
        error =
          WearRpcError(
            code = "unavailable",
            message = "Gateway is offline",
          ),
      )

    val result = response.toRpcResult(expectedRequestId = "request-2")

    assertEquals(WearConversationFailure.GATEWAY_OFFLINE, result.failure)
    assertNull(result.payload)
  }

  @Test
  fun successfulCanonicalResponseReturnsProjectedPayload() {
    val payload = json.parseToJsonElement("""{"sessions":[]}""")
    val response =
      WearMessage.Response(
        requestId = "request-2",
        ok = true,
        result = payload,
      )

    val result = response.toRpcResult(expectedRequestId = "request-2")

    assertEquals(payload, result.payload)
    assertNull(result.failure)
  }

  @Test
  fun rejectsMismatchedRequestIdentity() {
    val response =
      WearMessage.Response(
        requestId = "different-request",
        ok = false,
        error =
          WearRpcError(
            code = "phone_not_ready",
            message = "Phone runtime is not ready",
          ),
      )

    val result = response.toRpcResult(expectedRequestId = "request-3")

    assertEquals(WearConversationFailure.INCOMPATIBLE, result.failure)
  }
}
