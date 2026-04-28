package ai.openclaw.android.gateway

import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

data class MainSessionState(
  val currentSessionKey: String,
  val appliedMainSessionKey: String,
)

fun applyMainSessionKey(
  currentSessionKey: String,
  appliedMainSessionKey: String,
  nextMainSessionKey: String,
): MainSessionState {
  if (currentSessionKey == appliedMainSessionKey) {
    return MainSessionState(
      currentSessionKey = nextMainSessionKey,
      appliedMainSessionKey = nextMainSessionKey,
    )
  }
  return MainSessionState(
    currentSessionKey = currentSessionKey,
    appliedMainSessionKey = nextMainSessionKey,
  )
}

fun buildChatHistoryParams(sessionKey: String) =
  buildJsonObject {
    put("sessionKey", JsonPrimitive(sessionKey))
  }

fun buildSessionsListParams(limit: Int? = null) =
  buildJsonObject {
    put("includeGlobal", JsonPrimitive(true))
    put("includeUnknown", JsonPrimitive(false))
    if (limit != null && limit > 0) {
      put("limit", JsonPrimitive(limit))
    }
  }

fun parseChatRunId(resultJson: String): String? {
  return parseJsonOrNull(resultJson)
    ?.asObjectOrNull()
    ?.get("runId")
    .asStringOrNull()
    ?.trim()
    ?.ifEmpty { null }
}
