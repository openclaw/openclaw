package ai.openclaw.app.wear

import ai.openclaw.wear.shared.WEAR_STATUS_MAX_REQUEST_BYTES
import ai.openclaw.wear.shared.WEAR_STATUS_MAX_REQUEST_ID_LENGTH
import ai.openclaw.wear.shared.WEAR_STATUS_PROTOCOL_VERSION
import ai.openclaw.wear.shared.WearStatusCodec
import ai.openclaw.wear.shared.WearStatusErrorCode
import ai.openclaw.wear.shared.WearStatusRequest
import ai.openclaw.wear.shared.WearStatusResponse
import ai.openclaw.wear.shared.WearStatusResult
import ai.openclaw.wear.shared.WearStatusSnapshot

internal fun interface PhoneWearStatusSource {
  fun snapshot(): WearStatusSnapshot?
}

internal class WearStatusRequestHandler(
  private val source: PhoneWearStatusSource,
) {
  fun handle(payload: ByteArray): ByteArray {
    if (payload.size > WEAR_STATUS_MAX_REQUEST_BYTES) {
      return errorResponse(requestId = "", errorCode = WearStatusErrorCode.INVALID_REQUEST)
    }

    val request =
      runCatching { WearStatusCodec.decodeRequest(payload) }
        .getOrElse {
          return errorResponse(requestId = "", errorCode = WearStatusErrorCode.INVALID_REQUEST)
        }
    val requestId =
      request.validatedRequestId()
        ?: return errorResponse(requestId = "", errorCode = WearStatusErrorCode.INVALID_REQUEST)

    if (request.protocolVersion != WEAR_STATUS_PROTOCOL_VERSION) {
      return errorResponse(requestId = requestId, errorCode = WearStatusErrorCode.UNSUPPORTED_VERSION)
    }

    val snapshot =
      source.snapshot()
        ?: return errorResponse(requestId = requestId, errorCode = WearStatusErrorCode.PHONE_NOT_READY)

    return WearStatusCodec.encodeResponse(
      WearStatusResponse(
        requestId = requestId,
        result = WearStatusResult.OK,
        snapshot = snapshot,
      ),
    )
  }

  private fun WearStatusRequest.validatedRequestId(): String? =
    requestId
      .trim()
      .takeIf { id -> id.isNotEmpty() && id.length <= WEAR_STATUS_MAX_REQUEST_ID_LENGTH }

  private fun errorResponse(
    requestId: String,
    errorCode: WearStatusErrorCode,
  ): ByteArray =
    WearStatusCodec.encodeResponse(
      WearStatusResponse(
        requestId = requestId,
        result = WearStatusResult.ERROR,
        errorCode = errorCode,
      ),
    )
}
