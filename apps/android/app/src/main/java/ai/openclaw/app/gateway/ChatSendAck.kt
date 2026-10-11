package ai.openclaw.app.gateway

import ai.openclaw.app.asJsonStringOrNull
import ai.openclaw.app.node.asObjectOrNull
import kotlinx.serialization.json.Json

internal data class ChatSendAck(
  val runId: String?,
  val status: String?,
) {
  val normalizedStatus: String
    get() = status?.trim()?.lowercase().orEmpty()

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
    ChatSendAck(
      runId = obj?.get("runId").asJsonStringOrNull(),
      status = obj?.get("status").asJsonStringOrNull(),
    )
  } catch (_: Throwable) {
    ChatSendAck(runId = null, status = null)
  }
