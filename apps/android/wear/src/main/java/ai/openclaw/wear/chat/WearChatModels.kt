package ai.openclaw.wear.chat

data class WearChatMessage(
  val id: String,
  val role: String,
  val text: String,
  val timestampMs: Long?,
)

data class WearSessionEntry(
  val key: String,
  val updatedAtMs: Long?,
  val displayName: String?,
)
