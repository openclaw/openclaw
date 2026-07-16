package ai.openclaw.wear.shared

import kotlinx.serialization.Serializable

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
