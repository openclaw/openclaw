package ai.openclaw.wear

import ai.openclaw.wear.shared.WEAR_STATUS_CAPABILITY
import ai.openclaw.wear.shared.WEAR_STATUS_PATH
import ai.openclaw.wear.shared.WEAR_STATUS_PROTOCOL_VERSION
import ai.openclaw.wear.shared.WearGatewayState
import ai.openclaw.wear.shared.WearStatusCodec
import ai.openclaw.wear.shared.WearStatusErrorCode
import ai.openclaw.wear.shared.WearStatusRequest
import ai.openclaw.wear.shared.WearStatusResponse
import ai.openclaw.wear.shared.WearStatusResult
import android.content.Context
import com.google.android.gms.tasks.Tasks
import com.google.android.gms.wearable.CapabilityClient
import com.google.android.gms.wearable.Wearable
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.util.UUID
import java.util.concurrent.TimeUnit

internal sealed interface WearStatusUiState {
  data object Loading : WearStatusUiState

  data class Ready(
    val gatewayConnected: Boolean,
  ) : WearStatusUiState

  data object PhoneNotReady : WearStatusUiState

  data object PhoneUnavailable : WearStatusUiState

  data object Incompatible : WearStatusUiState
}

internal class WearStatusClient(
  context: Context,
) {
  private val capabilityClient = Wearable.getCapabilityClient(context)
  private val messageClient = Wearable.getMessageClient(context)

  suspend fun loadStatus(): WearStatusUiState =
    withContext(Dispatchers.IO) {
      runCatching {
        val capability =
          Tasks.await(
            capabilityClient.getCapability(
              WEAR_STATUS_CAPABILITY,
              CapabilityClient.FILTER_REACHABLE,
            ),
            REQUEST_TIMEOUT_SECONDS,
            TimeUnit.SECONDS,
          )
        val node =
          capability.nodes
            .sortedByDescending { candidate -> candidate.isNearby }
            .firstOrNull()
            ?: return@withContext WearStatusUiState.PhoneUnavailable
        val requestId = UUID.randomUUID().toString()
        val payload =
          WearStatusCodec.encodeRequest(
            WearStatusRequest(requestId = requestId),
          )
        val responsePayload =
          Tasks.await(
            messageClient.sendRequest(node.id, WEAR_STATUS_PATH, payload),
            REQUEST_TIMEOUT_SECONDS,
            TimeUnit.SECONDS,
          )
        WearStatusCodec.decodeResponse(responsePayload).toUiState(requestId)
      }.getOrElse {
        WearStatusUiState.PhoneUnavailable
      }
    }

  private companion object {
    const val REQUEST_TIMEOUT_SECONDS = 10L
  }
}

internal fun WearStatusResponse.toUiState(expectedRequestId: String): WearStatusUiState {
  if (protocolVersion != WEAR_STATUS_PROTOCOL_VERSION || requestId != expectedRequestId) {
    return WearStatusUiState.Incompatible
  }
  val currentSnapshot = snapshot

  return when {
    result == WearStatusResult.OK && currentSnapshot != null && errorCode == null ->
      WearStatusUiState.Ready(
        gatewayConnected = currentSnapshot.gatewayState == WearGatewayState.CONNECTED,
      )
    result == WearStatusResult.ERROR && errorCode == WearStatusErrorCode.PHONE_NOT_READY ->
      WearStatusUiState.PhoneNotReady
    else -> WearStatusUiState.Incompatible
  }
}
