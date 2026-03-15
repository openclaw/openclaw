package ai.openclaw.android.gateway

/**
 * A chat session entry as returned by `sessions.list`.
 */
data class ChatSessionEntry(
  val key: String,
  val updatedAtMs: Long? = null,
  val displayName: String? = null,
) {
  companion object {
    /**
     * Parses session entries from a `sessions.list` JSON-RPC response.
     */
    fun parseList(resultJson: String): List<ChatSessionEntry> {
      val root = parseJsonOrNull(resultJson)?.asObjectOrNull() ?: return emptyList()
      val sessions = root["sessions"].asArrayOrNull() ?: return emptyList()
      return sessions.mapNotNull { item ->
        val obj = item.asObjectOrNull() ?: return@mapNotNull null
        val key = obj["key"].asStringOrNull()?.trim().orEmpty()
        if (key.isEmpty()) return@mapNotNull null
        ChatSessionEntry(
          key = key,
          updatedAtMs = obj["updatedAt"].asLongOrNull(),
          displayName = obj["displayName"].asStringOrNull()?.trim(),
        )
      }
    }
  }
}
