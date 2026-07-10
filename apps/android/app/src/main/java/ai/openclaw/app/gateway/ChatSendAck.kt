package ai.openclaw.app.gateway

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

internal sealed interface ChatSendAckStatus {
  data object Missing : ChatSendAckStatus

  data object Malformed : ChatSendAckStatus

  data class Value(
    val raw: String,
  ) : ChatSendAckStatus
}

internal data class ChatSendAck(
  val runId: String?,
  val status: ChatSendAckStatus,
) {
  constructor(runId: String?, status: String) : this(runId, ChatSendAckStatus.Value(status))

  val normalizedStatus: String
    get() = (status as? ChatSendAckStatus.Value)?.raw?.trim()?.lowercase().orEmpty()

  val isStatusMissing: Boolean
    get() = status == ChatSendAckStatus.Missing

  val isTerminalSuccess: Boolean
    get() = normalizedStatus == "ok"

  val isTerminalFailure: Boolean
    get() = normalizedStatus == "timeout" || normalizedStatus == "error"

  val isTerminal: Boolean
    get() = isTerminalSuccess || isTerminalFailure
}

internal fun chatSendAckHistorySinceSeconds(
  ack: ChatSendAck,
  startedAtSeconds: Double,
): Double? = if (ack.isTerminalSuccess) null else startedAtSeconds

internal fun parseChatSendAck(
  json: Json,
  responseJson: String,
): ChatSendAck =
  try {
    val obj = json.parseToJsonElement(responseJson).asObjectOrNull()
    if (obj == null) {
      ChatSendAck(runId = null, status = ChatSendAckStatus.Malformed)
    } else {
      ChatSendAck(
        runId = obj["runId"].asStringOrNull(),
        status = obj.parseStatus(),
      )
    }
  } catch (_: Throwable) {
    ChatSendAck(runId = null, status = ChatSendAckStatus.Malformed)
  }

private fun JsonObject.parseStatus(): ChatSendAckStatus {
  if (!containsKey("status")) return ChatSendAckStatus.Missing
  val value = get("status")
  return value.asStringOrNull()?.let { ChatSendAckStatus.Value(it) } ?: ChatSendAckStatus.Malformed
}

private fun JsonElement?.asObjectOrNull(): JsonObject? = this as? JsonObject

private fun JsonElement?.asStringOrNull(): String? = (this as? JsonPrimitive)?.takeIf { it.isString }?.content
