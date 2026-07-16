package ai.openclaw.wear.shared

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

const val WEAR_CONVERSATION_CAPABILITY = "openclaw_phone_conversation_v1"
const val WEAR_CONVERSATION_PATH = "/openclaw/v1/conversation"
const val WEAR_CONVERSATION_PROTOCOL_VERSION = 1
const val WEAR_CONVERSATION_MAX_REQUEST_BYTES = 16 * 1024
const val WEAR_CONVERSATION_MAX_RESPONSE_BYTES = 64 * 1024
const val WEAR_CONVERSATION_MAX_REQUEST_ID_LENGTH = 128
const val WEAR_CONVERSATION_MAX_MESSAGE_LENGTH = 4_000
const val WEAR_CONVERSATION_MAX_SELECTION_ID_LENGTH = 256

@Serializable
data class WearConversationRequest(
  val protocolVersion: Int = WEAR_CONVERSATION_PROTOCOL_VERSION,
  val requestId: String,
  val action: WearConversationAction,
  val message: String? = null,
  val sessionId: String? = null,
  val agentId: String? = null,
)

@Serializable
data class WearConversationResponse(
  val protocolVersion: Int = WEAR_CONVERSATION_PROTOCOL_VERSION,
  val requestId: String,
  val result: WearConversationResult,
  val snapshot: WearConversationSnapshot? = null,
  val errorCode: WearConversationErrorCode? = null,
)

@Serializable
data class WearConversationSnapshot(
  val generatedAtEpochMillis: Long,
  val gatewayState: WearGatewayState,
  val activeAgentId: String? = null,
  val agents: List<WearAgentSummary> = emptyList(),
  val activeSessionId: String? = null,
  val sessions: List<WearSessionSummary> = emptyList(),
  val messages: List<WearChatMessage> = emptyList(),
  val streamingAssistantText: String? = null,
  val pendingRunCount: Int = 0,
  val selectedModelRef: String? = null,
  val errorText: String? = null,
)

@Serializable
data class WearAgentSummary(
  val id: String,
  val name: String,
  val emoji: String? = null,
  val selected: Boolean = false,
)

@Serializable
data class WearSessionSummary(
  val id: String,
  val title: String,
  val updatedAtEpochMillis: Long? = null,
  val selected: Boolean = false,
)

@Serializable
data class WearChatMessage(
  val id: String,
  val role: WearChatRole,
  val text: String,
  val timestampEpochMillis: Long? = null,
)

@Serializable
enum class WearConversationAction {
  SNAPSHOT,
  SEND_MESSAGE,
  SELECT_SESSION,
  SELECT_AGENT,
}

@Serializable
enum class WearConversationResult {
  OK,
  ERROR,
}

@Serializable
enum class WearConversationErrorCode {
  INVALID_REQUEST,
  UNSUPPORTED_VERSION,
  PHONE_NOT_READY,
  GATEWAY_OFFLINE,
  NOT_FOUND,
  ACTION_REJECTED,
  INTERNAL_ERROR,
}

@Serializable
enum class WearChatRole {
  USER,
  ASSISTANT,
  SYSTEM,
}

object WearConversationCodec {
  private val json =
    Json {
      encodeDefaults = true
      explicitNulls = false
      ignoreUnknownKeys = true
    }

  fun encodeRequest(request: WearConversationRequest): ByteArray =
    json
      .encodeToString(WearConversationRequest.serializer(), request)
      .encodeToByteArray()

  fun decodeRequest(payload: ByteArray): WearConversationRequest =
    json.decodeFromString(
      WearConversationRequest.serializer(),
      payload.decodeToString(),
    )

  fun encodeResponse(response: WearConversationResponse): ByteArray =
    json
      .encodeToString(WearConversationResponse.serializer(), response)
      .encodeToByteArray()

  fun decodeResponse(payload: ByteArray): WearConversationResponse =
    json.decodeFromString(
      WearConversationResponse.serializer(),
      payload.decodeToString(),
    )
}
