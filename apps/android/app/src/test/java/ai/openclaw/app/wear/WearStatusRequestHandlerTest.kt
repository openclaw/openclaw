package ai.openclaw.app.wear

import ai.openclaw.wear.shared.WEAR_STATUS_MAX_REQUEST_BYTES
import ai.openclaw.wear.shared.WEAR_STATUS_PROTOCOL_VERSION
import ai.openclaw.wear.shared.WearGatewayState
import ai.openclaw.wear.shared.WearStatusCodec
import ai.openclaw.wear.shared.WearStatusErrorCode
import ai.openclaw.wear.shared.WearStatusRequest
import ai.openclaw.wear.shared.WearStatusResult
import ai.openclaw.wear.shared.WearStatusSnapshot
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class WearStatusRequestHandlerTest {
  @Test
  fun returnsCurrentRuntimeSnapshot() {
    val handler =
      WearStatusRequestHandler {
        WearStatusSnapshot(
          generatedAtEpochMillis = 1234L,
          gatewayState = WearGatewayState.CONNECTED,
        )
      }

    val response =
      WearStatusCodec.decodeResponse(
        handler.handle(WearStatusCodec.encodeRequest(WearStatusRequest(requestId = "request-1"))),
      )

    assertEquals(WearStatusResult.OK, response.result)
    assertEquals("request-1", response.requestId)
    assertEquals(WearGatewayState.CONNECTED, response.snapshot?.gatewayState)
    assertNull(response.errorCode)
  }

  @Test
  fun reportsPhoneNotReadyWithoutStartingRuntime() {
    val handler = WearStatusRequestHandler { null }

    val response =
      WearStatusCodec.decodeResponse(
        handler.handle(WearStatusCodec.encodeRequest(WearStatusRequest(requestId = "request-2"))),
      )

    assertEquals(WearStatusResult.ERROR, response.result)
    assertEquals(WearStatusErrorCode.PHONE_NOT_READY, response.errorCode)
  }

  @Test
  fun rejectsUnsupportedProtocolVersion() {
    val handler = WearStatusRequestHandler { error("source must not be called") }
    val request =
      WearStatusRequest(
        protocolVersion = WEAR_STATUS_PROTOCOL_VERSION + 1,
        requestId = "request-3",
      )

    val response = WearStatusCodec.decodeResponse(handler.handle(WearStatusCodec.encodeRequest(request)))

    assertEquals(WearStatusResult.ERROR, response.result)
    assertEquals(WearStatusErrorCode.UNSUPPORTED_VERSION, response.errorCode)
  }

  @Test
  fun rejectsOversizedPayload() {
    val handler = WearStatusRequestHandler { error("source must not be called") }

    val response =
      WearStatusCodec.decodeResponse(
        handler.handle(ByteArray(WEAR_STATUS_MAX_REQUEST_BYTES + 1)),
      )

    assertEquals(WearStatusResult.ERROR, response.result)
    assertEquals(WearStatusErrorCode.INVALID_REQUEST, response.errorCode)
  }
}
