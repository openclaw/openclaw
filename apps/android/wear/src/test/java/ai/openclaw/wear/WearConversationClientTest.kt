package ai.openclaw.wear

import ai.openclaw.wear.shared.WearConversationErrorCode
import ai.openclaw.wear.shared.WearConversationPayloadCodec
import ai.openclaw.wear.shared.WearConversationSnapshot
import ai.openclaw.wear.shared.WearDecodeResult
import ai.openclaw.wear.shared.WearGatewayState
import ai.openclaw.wear.shared.WearMessage
import ai.openclaw.wear.shared.WearRpcError
import ai.openclaw.wear.shared.toWireCode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class WearConversationClientTest {
  @Test
  fun mapsSharedEnvelopeSnapshotToReadyClientResult() {
    val snapshot =
      WearConversationSnapshot(
        generatedAtEpochMillis = 1234L,
        gatewayState = WearGatewayState.CONNECTED,
      )
    val response =
      WearDecodeResult.Success(
        WearMessage.Response(
          requestId = "request-1",
          ok = true,
          result = WearConversationPayloadCodec.encodeSnapshot(snapshot),
        ),
      )

    val result = response.toClientResult(expectedRequestId = "request-1")

    assertEquals(snapshot, result.snapshot)
    assertNull(result.failure)
  }

  @Test
  fun mapsGatewayOfflineToActionableFailure() {
    val response =
      WearDecodeResult.Success(
        WearMessage.Response(
          requestId = "request-2",
          ok = false,
          error =
            WearRpcError(
              code = WearConversationErrorCode.GATEWAY_OFFLINE.toWireCode(),
              message = "Gateway is offline",
            ),
        ),
      )

    val result = response.toClientResult(expectedRequestId = "request-2")

    assertEquals(WearConversationFailure.GATEWAY_OFFLINE, result.failure)
    assertNull(result.snapshot)
  }

  @Test
  fun rejectsMismatchedRequestIdentity() {
    val response =
      WearDecodeResult.Success(
        WearMessage.Response(
          requestId = "different-request",
          ok = false,
          error =
            WearRpcError(
              code = WearConversationErrorCode.PHONE_NOT_READY.toWireCode(),
              message = "Phone runtime is not ready",
            ),
        ),
      )

    val result = response.toClientResult(expectedRequestId = "request-3")

    assertEquals(WearConversationFailure.INCOMPATIBLE, result.failure)
  }
}
