package ai.openclaw.app.wear

import ai.openclaw.wear.shared.WEAR_CHAT_MAX_MESSAGE_LENGTH
import ai.openclaw.wear.shared.WEAR_REQUEST_MAX_ID_LENGTH
import ai.openclaw.wear.shared.WEAR_SELECTION_MAX_ID_LENGTH
import ai.openclaw.wear.shared.WearConversationErrorCode
import ai.openclaw.wear.shared.WearConversationPayloadCodec
import ai.openclaw.wear.shared.WearConversationSnapshot
import ai.openclaw.wear.shared.WearDecodeFailureReason
import ai.openclaw.wear.shared.WearDecodeResult
import ai.openclaw.wear.shared.WearMessage
import ai.openclaw.wear.shared.WearProtocolCodec
import ai.openclaw.wear.shared.WearRpcError
import ai.openclaw.wear.shared.WearRpcMethod
import ai.openclaw.wear.shared.toWireCode
import kotlinx.serialization.json.JsonPrimitive

internal data class PhoneWearProxyResult(
  val snapshot: WearConversationSnapshot? = null,
  val errorCode: WearConversationErrorCode? = null,
)

internal interface PhoneWearProxySource {
  suspend fun snapshot(): PhoneWearProxyResult

  suspend fun sendMessage(message: String): PhoneWearProxyResult

  suspend fun selectSession(sessionId: String): PhoneWearProxyResult

  suspend fun abort(): PhoneWearProxyResult
}

internal class WearProxyRequestHandler(
  private val source: PhoneWearProxySource,
) {
  suspend fun handle(payload: ByteArray): ByteArray {
    val decoded = WearProtocolCodec.decode(payload)
    if (decoded is WearDecodeResult.Failure) {
      val errorCode =
        if (decoded.reason == WearDecodeFailureReason.UnsupportedVersion) {
          WearConversationErrorCode.UNSUPPORTED_VERSION
        } else {
          WearConversationErrorCode.INVALID_REQUEST
        }
      return errorResponse(requestId = INVALID_REQUEST_ID, errorCode = errorCode)
    }
    val request =
      (decoded as WearDecodeResult.Success).message as? WearMessage.Request
        ?: return errorResponse(
          requestId = INVALID_REQUEST_ID,
          errorCode = WearConversationErrorCode.INVALID_REQUEST,
        )
    val requestId =
      request.validatedRequestId()
        ?: return errorResponse(
          requestId = INVALID_REQUEST_ID,
          errorCode = WearConversationErrorCode.INVALID_REQUEST,
        )

    val result =
      runCatching { request.execute() }
        .getOrElse {
          PhoneWearProxyResult(errorCode = WearConversationErrorCode.INTERNAL_ERROR)
        }
    val snapshot = result.snapshot
    return if (snapshot != null && result.errorCode == null) {
      runCatching {
        WearProtocolCodec.encode(
          WearMessage.Response(
            requestId = requestId,
            ok = true,
            result = WearConversationPayloadCodec.encodeSnapshot(snapshot),
          ),
        )
      }.getOrElse {
        errorResponse(
          requestId = requestId,
          errorCode = WearConversationErrorCode.INTERNAL_ERROR,
        )
      }
    } else {
      errorResponse(
        requestId = requestId,
        errorCode = result.errorCode ?: WearConversationErrorCode.INTERNAL_ERROR,
      )
    }
  }

  private suspend fun WearMessage.Request.execute(): PhoneWearProxyResult =
    when (method) {
      WearRpcMethod.ProxyStatus,
      WearRpcMethod.SessionsList,
      ->
        if (params.isEmpty()) {
          source.snapshot()
        } else {
          invalidRequest()
        }
      WearRpcMethod.ChatHistory -> executeChatHistory()
      WearRpcMethod.ChatSend -> executeChatSend()
      WearRpcMethod.ChatAbort ->
        if (params.isEmpty()) {
          source.abort()
        } else {
          invalidRequest()
        }
    }

  private suspend fun WearMessage.Request.executeChatHistory(): PhoneWearProxyResult {
    if (params.keys.any { key -> key != SESSION_ID_PARAM }) return invalidRequest()
    val sessionIdValue = params[SESSION_ID_PARAM] ?: return source.snapshot()
    val sessionId =
      sessionIdValue
        .validatedString(WEAR_SELECTION_MAX_ID_LENGTH)
        ?: return invalidRequest()
    return source.selectSession(sessionId)
  }

  private suspend fun WearMessage.Request.executeChatSend(): PhoneWearProxyResult {
    if (params.keys.any { key -> key != MESSAGE_PARAM && key != SESSION_ID_PARAM }) {
      return invalidRequest()
    }
    val message =
      params[MESSAGE_PARAM]
        .validatedString(WEAR_CHAT_MAX_MESSAGE_LENGTH)
        ?: return invalidRequest()
    val sessionIdValue = params[SESSION_ID_PARAM]
    if (sessionIdValue != null) {
      val sessionId =
        sessionIdValue
          .validatedString(WEAR_SELECTION_MAX_ID_LENGTH)
          ?: return invalidRequest()
      val selection = source.selectSession(sessionId)
      if (selection.errorCode != null) return selection
    }
    return source.sendMessage(message)
  }

  private fun WearMessage.Request.validatedRequestId(): String? =
    requestId
      .trim()
      .takeIf { id ->
        id.isNotEmpty() && id.length <= WEAR_REQUEST_MAX_ID_LENGTH
      }

  private fun kotlinx.serialization.json.JsonElement?.validatedString(maxLength: Int): String? =
    (this as? JsonPrimitive)
      ?.takeIf(JsonPrimitive::isString)
      ?.content
      ?.trim()
      ?.takeIf { id ->
        id.isNotEmpty() && id.length <= maxLength
      }

  private fun invalidRequest(): PhoneWearProxyResult =
    PhoneWearProxyResult(
      errorCode = WearConversationErrorCode.INVALID_REQUEST,
    )

  private fun errorResponse(
    requestId: String,
    errorCode: WearConversationErrorCode,
  ): ByteArray =
    WearProtocolCodec.encode(
      WearMessage.Response(
        requestId = requestId,
        ok = false,
        error =
          WearRpcError(
            code = errorCode.toWireCode(),
            message = errorCode.message(),
          ),
      ),
    )

  private fun WearConversationErrorCode.message(): String =
    when (this) {
      WearConversationErrorCode.INVALID_REQUEST -> "Invalid Wear request"
      WearConversationErrorCode.UNSUPPORTED_VERSION -> "Unsupported Wear protocol version"
      WearConversationErrorCode.PHONE_NOT_READY -> "Phone runtime is not ready"
      WearConversationErrorCode.GATEWAY_OFFLINE -> "Gateway is offline"
      WearConversationErrorCode.NOT_FOUND -> "Requested session was not found"
      WearConversationErrorCode.ACTION_REJECTED -> "Requested action was rejected"
      WearConversationErrorCode.INTERNAL_ERROR -> "Wear proxy failed"
    }

  private companion object {
    const val INVALID_REQUEST_ID = "invalid-request"
    const val MESSAGE_PARAM = "message"
    const val SESSION_ID_PARAM = "sessionId"
  }
}
