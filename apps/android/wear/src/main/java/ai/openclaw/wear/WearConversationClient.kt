package ai.openclaw.wear

import ai.openclaw.wear.shared.WEAR_CONVERSATION_CAPABILITY
import ai.openclaw.wear.shared.WEAR_CONVERSATION_MAX_RESPONSE_BYTES
import ai.openclaw.wear.shared.WEAR_CONVERSATION_PATH
import ai.openclaw.wear.shared.WEAR_CONVERSATION_PROTOCOL_VERSION
import ai.openclaw.wear.shared.WearConversationAction
import ai.openclaw.wear.shared.WearConversationCodec
import ai.openclaw.wear.shared.WearConversationErrorCode
import ai.openclaw.wear.shared.WearConversationRequest
import ai.openclaw.wear.shared.WearConversationResponse
import ai.openclaw.wear.shared.WearConversationResult
import ai.openclaw.wear.shared.WearConversationSnapshot
import android.content.Context
import com.google.android.gms.tasks.Tasks
import com.google.android.gms.wearable.CapabilityClient
import com.google.android.gms.wearable.Wearable
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.util.UUID
import java.util.concurrent.TimeUnit

internal data class WearConversationClientResult(
  val snapshot: WearConversationSnapshot? = null,
  val failure: WearConversationFailure? = null,
)

internal enum class WearConversationFailure {
  PHONE_UNAVAILABLE,
  PHONE_NOT_READY,
  GATEWAY_OFFLINE,
  NOT_FOUND,
  ACTION_REJECTED,
  INCOMPATIBLE,
  INTERNAL_ERROR,
}

internal class WearConversationClient(
  context: Context,
) {
  private val capabilityClient = Wearable.getCapabilityClient(context)
  private val messageClient = Wearable.getMessageClient(context)

  suspend fun loadSnapshot(): WearConversationClientResult =
    execute(
      WearConversationRequest(
        requestId = UUID.randomUUID().toString(),
        action = WearConversationAction.SNAPSHOT,
      ),
    )

  suspend fun sendMessage(message: String): WearConversationClientResult =
    execute(
      WearConversationRequest(
        requestId = UUID.randomUUID().toString(),
        action = WearConversationAction.SEND_MESSAGE,
        message = message,
      ),
    )

  suspend fun selectSession(sessionId: String): WearConversationClientResult =
    execute(
      WearConversationRequest(
        requestId = UUID.randomUUID().toString(),
        action = WearConversationAction.SELECT_SESSION,
        sessionId = sessionId,
      ),
    )

  suspend fun selectAgent(agentId: String): WearConversationClientResult =
    execute(
      WearConversationRequest(
        requestId = UUID.randomUUID().toString(),
        action = WearConversationAction.SELECT_AGENT,
        agentId = agentId,
      ),
    )

  private suspend fun execute(request: WearConversationRequest): WearConversationClientResult =
    withContext(Dispatchers.IO) {
      runCatching {
        val capability =
          Tasks.await(
            capabilityClient.getCapability(
              WEAR_CONVERSATION_CAPABILITY,
              CapabilityClient.FILTER_REACHABLE,
            ),
            REQUEST_TIMEOUT_SECONDS,
            TimeUnit.SECONDS,
          )
        val node =
          capability.nodes
            .sortedByDescending { candidate -> candidate.isNearby }
            .firstOrNull()
            ?: return@withContext WearConversationClientResult(
              failure = WearConversationFailure.PHONE_UNAVAILABLE,
            )
        val responsePayload =
          Tasks.await(
            messageClient.sendRequest(
              node.id,
              WEAR_CONVERSATION_PATH,
              WearConversationCodec.encodeRequest(request),
            ),
            REQUEST_TIMEOUT_SECONDS,
            TimeUnit.SECONDS,
          )
        if (responsePayload.size > WEAR_CONVERSATION_MAX_RESPONSE_BYTES) {
          return@withContext WearConversationClientResult(
            failure = WearConversationFailure.INCOMPATIBLE,
          )
        }
        WearConversationCodec
          .decodeResponse(responsePayload)
          .toClientResult(request.requestId)
      }.getOrElse {
        WearConversationClientResult(
          failure = WearConversationFailure.PHONE_UNAVAILABLE,
        )
      }
    }

  private companion object {
    const val REQUEST_TIMEOUT_SECONDS = 15L
  }
}

internal fun WearConversationResponse.toClientResult(
  expectedRequestId: String,
): WearConversationClientResult {
  if (
    protocolVersion != WEAR_CONVERSATION_PROTOCOL_VERSION ||
    requestId != expectedRequestId
  ) {
    return WearConversationClientResult(
      failure = WearConversationFailure.INCOMPATIBLE,
    )
  }

  return if (
    result == WearConversationResult.OK &&
    snapshot != null &&
    errorCode == null
  ) {
    WearConversationClientResult(snapshot = snapshot)
  } else {
    WearConversationClientResult(
      failure =
        when (errorCode) {
          WearConversationErrorCode.PHONE_NOT_READY ->
            WearConversationFailure.PHONE_NOT_READY
          WearConversationErrorCode.GATEWAY_OFFLINE ->
            WearConversationFailure.GATEWAY_OFFLINE
          WearConversationErrorCode.NOT_FOUND ->
            WearConversationFailure.NOT_FOUND
          WearConversationErrorCode.ACTION_REJECTED ->
            WearConversationFailure.ACTION_REJECTED
          WearConversationErrorCode.INTERNAL_ERROR ->
            WearConversationFailure.INTERNAL_ERROR
          WearConversationErrorCode.INVALID_REQUEST,
          WearConversationErrorCode.UNSUPPORTED_VERSION,
          null,
          -> WearConversationFailure.INCOMPATIBLE
        },
    )
  }
}
