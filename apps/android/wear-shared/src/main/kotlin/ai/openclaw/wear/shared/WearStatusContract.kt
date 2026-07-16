package ai.openclaw.wear.shared

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

const val WEAR_STATUS_CAPABILITY = "openclaw_phone_status_v1"
const val WEAR_STATUS_PATH = "/openclaw/v1/status"
const val WEAR_STATUS_PROTOCOL_VERSION = 1
const val WEAR_STATUS_MAX_REQUEST_BYTES = 16 * 1024
const val WEAR_STATUS_MAX_REQUEST_ID_LENGTH = 128

@Serializable
data class WearStatusRequest(
  val protocolVersion: Int = WEAR_STATUS_PROTOCOL_VERSION,
  val requestId: String,
)

@Serializable
data class WearStatusResponse(
  val protocolVersion: Int = WEAR_STATUS_PROTOCOL_VERSION,
  val requestId: String,
  val result: WearStatusResult,
  val snapshot: WearStatusSnapshot? = null,
  val errorCode: WearStatusErrorCode? = null,
)

@Serializable
data class WearStatusSnapshot(
  val generatedAtEpochMillis: Long,
  val gatewayState: WearGatewayState,
)

@Serializable
enum class WearStatusResult {
  OK,
  ERROR,
}

@Serializable
enum class WearGatewayState {
  CONNECTED,
  DISCONNECTED,
}

@Serializable
enum class WearStatusErrorCode {
  INVALID_REQUEST,
  UNSUPPORTED_VERSION,
  PHONE_NOT_READY,
}

object WearStatusCodec {
  private val json =
    Json {
      encodeDefaults = true
      explicitNulls = false
      ignoreUnknownKeys = true
    }

  fun encodeRequest(request: WearStatusRequest): ByteArray = json.encodeToString(WearStatusRequest.serializer(), request).encodeToByteArray()

  fun decodeRequest(payload: ByteArray): WearStatusRequest = json.decodeFromString(WearStatusRequest.serializer(), payload.decodeToString())

  fun encodeResponse(response: WearStatusResponse): ByteArray = json.encodeToString(WearStatusResponse.serializer(), response).encodeToByteArray()

  fun decodeResponse(payload: ByteArray): WearStatusResponse = json.decodeFromString(WearStatusResponse.serializer(), payload.decodeToString())
}
