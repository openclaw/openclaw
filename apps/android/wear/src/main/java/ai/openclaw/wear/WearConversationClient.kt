package ai.openclaw.wear

import ai.openclaw.wear.shared.WearConversationErrorCode
import ai.openclaw.wear.shared.WearConversationPayloadCodec
import ai.openclaw.wear.shared.WearConversationSnapshot
import ai.openclaw.wear.shared.WearDecodeResult
import ai.openclaw.wear.shared.WearMessage
import ai.openclaw.wear.shared.WearProtocol
import ai.openclaw.wear.shared.WearProtocolCodec
import ai.openclaw.wear.shared.WearRpcMethod
import ai.openclaw.wear.shared.wearConversationErrorCode
import android.content.Context
import com.google.android.gms.tasks.Tasks
import com.google.android.gms.wearable.CapabilityClient
import com.google.android.gms.wearable.Wearable
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
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

  suspend fun loadSnapshot(): WearConversationClientResult = execute(method = WearRpcMethod.ProxyStatus)

  suspend fun sendMessage(
    message: String,
    sessionId: String?,
  ): WearConversationClientResult =
    execute(
      method = WearRpcMethod.ChatSend,
      params =
        buildJsonObject {
          put(MESSAGE_PARAM, message)
          sessionId?.let { selectedSessionId -> put(SESSION_ID_PARAM, selectedSessionId) }
        },
    )

  suspend fun selectSession(sessionId: String): WearConversationClientResult =
    execute(
      method = WearRpcMethod.ChatHistory,
      params = buildJsonObject { put(SESSION_ID_PARAM, sessionId) },
    )

  suspend fun abort(): WearConversationClientResult = execute(method = WearRpcMethod.ChatAbort)

  private suspend fun execute(
    method: WearRpcMethod,
    params: JsonObject = buildJsonObject {},
  ): WearConversationClientResult =
    withContext(Dispatchers.IO) {
      runCatching {
        val requestId = UUID.randomUUID().toString()
        val capability =
          Tasks.await(
            capabilityClient.getCapability(
              WearProtocol.PHONE_CAPABILITY,
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
              WearProtocol.REQUEST_PATH,
              WearProtocolCodec.encode(
                WearMessage.Request(
                  requestId = requestId,
                  method = method,
                  params = params,
                ),
              ),
            ),
            REQUEST_TIMEOUT_SECONDS,
            TimeUnit.SECONDS,
          )
        WearProtocolCodec
          .decode(responsePayload)
          .toClientResult(requestId)
      }.getOrElse {
        WearConversationClientResult(
          failure = WearConversationFailure.PHONE_UNAVAILABLE,
        )
      }
    }

  private companion object {
    const val MESSAGE_PARAM = "message"
    const val SESSION_ID_PARAM = "sessionId"
    const val REQUEST_TIMEOUT_SECONDS = 15L
  }
}

internal fun WearDecodeResult.toClientResult(
  expectedRequestId: String,
): WearConversationClientResult {
  val response =
    (this as? WearDecodeResult.Success)?.message as? WearMessage.Response
      ?: return WearConversationClientResult(
        failure = WearConversationFailure.INCOMPATIBLE,
      )
  if (response.requestId != expectedRequestId) {
    return WearConversationClientResult(
      failure = WearConversationFailure.INCOMPATIBLE,
    )
  }

  if (response.ok && response.error == null) {
    val result = response.result
    val snapshot =
      result?.let { payload ->
        runCatching { WearConversationPayloadCodec.decodeSnapshot(payload) }.getOrNull()
      }
    return if (snapshot != null) {
      WearConversationClientResult(snapshot = snapshot)
    } else {
      WearConversationClientResult(failure = WearConversationFailure.INCOMPATIBLE)
    }
  }

  val errorCode = response.error?.code?.let(::wearConversationErrorCode)
  return WearConversationClientResult(
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
