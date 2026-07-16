package ai.openclaw.wear.shared

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement

const val WEAR_REQUEST_MAX_ID_LENGTH = 128
const val WEAR_CHAT_MAX_MESSAGE_LENGTH = 4_000
const val WEAR_SELECTION_MAX_ID_LENGTH = 256

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

@Serializable
enum class WearGatewayState {
  CONNECTED,
  DISCONNECTED,
}

object WearConversationPayloadCodec {
  private val json =
    Json {
      encodeDefaults = true
      explicitNulls = false
      ignoreUnknownKeys = true
    }

  fun encodeSnapshot(snapshot: WearConversationSnapshot): JsonElement = json.encodeToJsonElement(WearConversationSnapshot.serializer(), snapshot)

  fun decodeSnapshot(payload: JsonElement): WearConversationSnapshot = json.decodeFromJsonElement(WearConversationSnapshot.serializer(), payload)
}

fun WearConversationErrorCode.toWireCode(): String = name.lowercase()

fun wearConversationErrorCode(value: String): WearConversationErrorCode? =
  WearConversationErrorCode.entries.firstOrNull { errorCode ->
    errorCode.toWireCode() == value
  }
