package ai.openclaw.app.wear

import ai.openclaw.wear.shared.WEAR_CONVERSATION_MAX_MESSAGE_LENGTH
import ai.openclaw.wear.shared.WEAR_CONVERSATION_MAX_REQUEST_BYTES
import ai.openclaw.wear.shared.WEAR_CONVERSATION_MAX_REQUEST_ID_LENGTH
import ai.openclaw.wear.shared.WEAR_CONVERSATION_MAX_SELECTION_ID_LENGTH
import ai.openclaw.wear.shared.WEAR_CONVERSATION_PROTOCOL_VERSION
import ai.openclaw.wear.shared.WearConversationAction
import ai.openclaw.wear.shared.WearConversationCodec
import ai.openclaw.wear.shared.WearConversationErrorCode
import ai.openclaw.wear.shared.WearConversationRequest
import ai.openclaw.wear.shared.WearConversationResponse
import ai.openclaw.wear.shared.WearConversationResult
import ai.openclaw.wear.shared.WearConversationSnapshot

internal data class PhoneWearConversationResult(
  val snapshot: WearConversationSnapshot? = null,
  val errorCode: WearConversationErrorCode? = null,
)

internal interface PhoneWearConversationSource {
  suspend fun snapshot(): PhoneWearConversationResult

  suspend fun sendMessage(message: String): PhoneWearConversationResult

  suspend fun selectSession(sessionId: String): PhoneWearConversationResult

  suspend fun selectAgent(agentId: String): PhoneWearConversationResult
}

internal class WearConversationRequestHandler(
  private val source: PhoneWearConversationSource,
) {
  suspend fun handle(payload: ByteArray): ByteArray {
    if (payload.size > WEAR_CONVERSATION_MAX_REQUEST_BYTES) {
      return errorResponse(requestId = "", errorCode = WearConversationErrorCode.INVALID_REQUEST)
    }

    val request =
      runCatching { WearConversationCodec.decodeRequest(payload) }
        .getOrElse {
          return errorResponse(requestId = "", errorCode = WearConversationErrorCode.INVALID_REQUEST)
        }
    val requestId =
      request.validatedRequestId()
        ?: return errorResponse(requestId = "", errorCode = WearConversationErrorCode.INVALID_REQUEST)

    if (request.protocolVersion != WEAR_CONVERSATION_PROTOCOL_VERSION) {
      return errorResponse(
        requestId = requestId,
        errorCode = WearConversationErrorCode.UNSUPPORTED_VERSION,
      )
    }

    val result =
      runCatching { request.execute() }
        .getOrElse {
          PhoneWearConversationResult(errorCode = WearConversationErrorCode.INTERNAL_ERROR)
        }
    val snapshot = result.snapshot
    return if (snapshot != null && result.errorCode == null) {
      WearConversationCodec.encodeResponse(
        WearConversationResponse(
          requestId = requestId,
          result = WearConversationResult.OK,
          snapshot = snapshot,
        ),
      )
    } else {
      errorResponse(
        requestId = requestId,
        errorCode = result.errorCode ?: WearConversationErrorCode.INTERNAL_ERROR,
      )
    }
  }

  private suspend fun WearConversationRequest.execute(): PhoneWearConversationResult =
    when (action) {
      WearConversationAction.SNAPSHOT ->
        if (message == null && sessionId == null && agentId == null) {
          source.snapshot()
        } else {
          invalidRequest()
        }
      WearConversationAction.SEND_MESSAGE -> {
        val validatedMessage =
          message
            ?.trim()
            ?.takeIf { text ->
              text.isNotEmpty() &&
                text.length <= WEAR_CONVERSATION_MAX_MESSAGE_LENGTH &&
                sessionId == null &&
                agentId == null
            }
            ?: return invalidRequest()
        source.sendMessage(validatedMessage)
      }
      WearConversationAction.SELECT_SESSION -> {
        val validatedSessionId =
          sessionId
            .validatedSelectionId()
            ?.takeIf { message == null && agentId == null }
            ?: return invalidRequest()
        source.selectSession(validatedSessionId)
      }
      WearConversationAction.SELECT_AGENT -> {
        val validatedAgentId =
          agentId
            .validatedSelectionId()
            ?.takeIf { message == null && sessionId == null }
            ?: return invalidRequest()
        source.selectAgent(validatedAgentId)
      }
    }

  private fun WearConversationRequest.validatedRequestId(): String? =
    requestId
      .trim()
      .takeIf { id ->
        id.isNotEmpty() && id.length <= WEAR_CONVERSATION_MAX_REQUEST_ID_LENGTH
      }

  private fun String?.validatedSelectionId(): String? =
    this
      ?.trim()
      ?.takeIf { id ->
        id.isNotEmpty() && id.length <= WEAR_CONVERSATION_MAX_SELECTION_ID_LENGTH
      }

  private fun invalidRequest(): PhoneWearConversationResult =
    PhoneWearConversationResult(
      errorCode = WearConversationErrorCode.INVALID_REQUEST,
    )

  private fun errorResponse(
    requestId: String,
    errorCode: WearConversationErrorCode,
  ): ByteArray =
    WearConversationCodec.encodeResponse(
      WearConversationResponse(
        requestId = requestId,
        result = WearConversationResult.ERROR,
        errorCode = errorCode,
      ),
    )
}
