package ai.openclaw.wear

import ai.openclaw.wear.shared.WEAR_STATUS_PROTOCOL_VERSION
import ai.openclaw.wear.shared.WearGatewayState
import ai.openclaw.wear.shared.WearStatusErrorCode
import ai.openclaw.wear.shared.WearStatusResponse
import ai.openclaw.wear.shared.WearStatusResult
import ai.openclaw.wear.shared.WearStatusSnapshot
import org.junit.Assert.assertEquals
import org.junit.Test

class WearStatusClientTest {
  @Test
  fun mapsConnectedSnapshotToReadyState() {
    val response =
      WearStatusResponse(
        requestId = "request-1",
        result = WearStatusResult.OK,
        snapshot =
          WearStatusSnapshot(
            generatedAtEpochMillis = 1234L,
            gatewayState = WearGatewayState.CONNECTED,
          ),
      )

    assertEquals(
      WearStatusUiState.Ready(
        gatewayConnected = true,
      ),
      response.toUiState(expectedRequestId = "request-1"),
    )
  }

  @Test
  fun mapsColdPhoneToActionableState() {
    val response =
      WearStatusResponse(
        requestId = "request-2",
        result = WearStatusResult.ERROR,
        errorCode = WearStatusErrorCode.PHONE_NOT_READY,
      )

    assertEquals(
      WearStatusUiState.PhoneNotReady,
      response.toUiState(expectedRequestId = "request-2"),
    )
  }

  @Test
  fun rejectsMismatchedResponseRequestId() {
    val response =
      WearStatusResponse(
        protocolVersion = WEAR_STATUS_PROTOCOL_VERSION,
        requestId = "different-request",
        result = WearStatusResult.ERROR,
        errorCode = WearStatusErrorCode.PHONE_NOT_READY,
      )

    assertEquals(
      WearStatusUiState.Incompatible,
      response.toUiState(expectedRequestId = "request-3"),
    )
  }
}
