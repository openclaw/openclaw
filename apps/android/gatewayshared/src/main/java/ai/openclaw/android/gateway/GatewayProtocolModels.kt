package ai.openclaw.android.gateway

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject

/**
 * Gateway event from the server, shared between direct WebSocket
 * and phone-proxied connections.
 */
data class GatewayEvent(val event: String, val payloadJson: String?)

/**
 * A chat session entry as returned by `sessions.list`.
 */
data class GatewaySessionEntry(
  val key: String,
  val updatedAtMs: Long?,
  val displayName: String?,
)

/**
 * Parses sessions from a `sessions.list` JSON-RPC response.
 */
fun parseSessionsList(resultJson: String): List<GatewaySessionEntry> {
  val root = parseJsonOrNull(resultJson)?.asObjectOrNull() ?: return emptyList()
  val sessions = root["sessions"].asArrayOrNull() ?: return emptyList()
  return sessions.mapNotNull { item ->
    val obj = item.asObjectOrNull() ?: return@mapNotNull null
    val key = obj["key"].asStringOrNull()?.trim().orEmpty()
    if (key.isEmpty()) return@mapNotNull null
    GatewaySessionEntry(
      key = key,
      updatedAtMs = obj["updatedAt"].asLongOrNull(),
      displayName = obj["displayName"].asStringOrNull()?.trim(),
    )
  }
}
