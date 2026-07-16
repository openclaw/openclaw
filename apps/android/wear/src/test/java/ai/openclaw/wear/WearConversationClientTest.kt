package ai.openclaw.wear

import ai.openclaw.wear.shared.WEAR_CONVERSATION_PROTOCOL_VERSION
import ai.openclaw.wear.shared.WearConversationErrorCode
import ai.openclaw.wear.shared.WearConversationResponse
import ai.openclaw.wear.shared.WearConversationResult
import ai.openclaw.wear.shared.WearConversationSnapshot
import ai.openclaw.wear.shared.WearGatewayState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class WearConversationClientTest {
  @Test
  fun mapsSnapshotToReadyClientResult() {
    val snapshot =
      WearConversationSnapshot(
        generatedAtEpochMillis = 1234L,
        gatewayState = WearGatewayState.CONNECTED,
      )
    val response =
      WearConversationResponse(
        requestId = "request-1",
        result = WearConversationResult.OK,
        snapshot = snapshot,
      )

    val result = response.toClientResult(expectedRequestId = "request-1")

    assertEquals(snapshot, result.snapshot)
    assertNull(result.failure)
  }

  @Test
  fun mapsGatewayOfflineToActionableFailure() {
    val response =
      WearConversationResponse(
        requestId = "request-2",
        result = WearConversationResult.ERROR,
        errorCode = WearConversationErrorCode.GATEWAY_OFFLINE,
      )

    val result = response.toClientResult(expectedRequestId = "request-2")

    assertEquals(WearConversationFailure.GATEWAY_OFFLINE, result.failure)
    assertNull(result.snapshot)
  }

  @Test
  fun rejectsMismatchedRequestIdentity() {
    val response =
      WearConversationResponse(
        protocolVersion = WEAR_CONVERSATION_PROTOCOL_VERSION,
        requestId = "different-request",
        result = WearConversationResult.ERROR,
        errorCode = WearConversationErrorCode.PHONE_NOT_READY,
      )

    val result = response.toClientResult(expectedRequestId = "request-3")

    assertEquals(WearConversationFailure.INCOMPATIBLE, result.failure)
  }
}
