package ai.openclaw.app

import ai.openclaw.app.node.asObjectOrNull
import ai.openclaw.app.node.asStringOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

data class GatewayExecApprovalSummary(
  val id: String,
  val commandText: String,
  val commandPreview: String?,
  val allowedDecisions: List<String>,
  val host: String?,
  val nodeId: String?,
  val agentId: String?,
  val createdAtMs: Long?,
  val expiresAtMs: Long?,
  val resolvingDecision: String? = null,
  val errorText: String? = null,
)

internal fun parseGatewayExecApprovalListPayload(
  payloadJson: String,
  json: Json,
): List<GatewayExecApprovalSummary> =
  try {
    (json.parseToJsonElement(payloadJson) as? JsonArray)
      ?.mapNotNull(::parseGatewayExecApprovalListEntry)
      ?.sortedBy { it.createdAtMs ?: Long.MAX_VALUE }
      .orEmpty()
  } catch (_: Throwable) {
    emptyList()
  }

internal fun parseGatewayExecApprovalListEntry(item: JsonElement): GatewayExecApprovalSummary? {
  val obj = item.asObjectOrNull() ?: return null
  val id = obj["id"].asStringOrNull()?.trim().orEmpty()
  if (id.isEmpty()) return null
  val request = obj["request"].asObjectOrNull()
  return GatewayExecApprovalSummary(
    id = id,
    commandText = gatewayExecApprovalListCommandText(obj),
    commandPreview = gatewayExecApprovalListCommandPreview(obj),
    allowedDecisions = emptyList(),
    host =
      request
        ?.get("host")
        .asStringOrNull()
        ?.trim()
        ?.takeIf { it.isNotEmpty() },
    nodeId =
      request
        ?.get("nodeId")
        .asStringOrNull()
        ?.trim()
        ?.takeIf { it.isNotEmpty() },
    agentId =
      request
        ?.get("agentId")
        .asStringOrNull()
        ?.trim()
        ?.takeIf { it.isNotEmpty() },
    createdAtMs = obj.long("createdAtMs"),
    expiresAtMs = obj.long("expiresAtMs"),
  )
}

internal fun parseGatewayExecApprovalDetail(
  obj: JsonObject,
  createdAtMs: Long?,
): GatewayExecApprovalSummary? {
  val id = obj["id"].asStringOrNull()?.trim().orEmpty()
  if (id.isEmpty()) return null
  return GatewayExecApprovalSummary(
    id = id,
    commandText =
      obj["commandText"]
        .asStringOrNull()
        ?.trim()
        ?.takeIf { it.isNotEmpty() }
        ?: "Command request",
    commandPreview =
      obj["commandPreview"]
        .asStringOrNull()
        ?.trim()
        ?.takeIf { it.isNotEmpty() },
    allowedDecisions = gatewayExecApprovalAllowedDecisions(obj),
    host = obj["host"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() },
    nodeId = obj["nodeId"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() },
    agentId = obj["agentId"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() },
    createdAtMs = createdAtMs,
    expiresAtMs = obj.long("expiresAtMs"),
  )
}

private fun gatewayExecApprovalListCommandText(obj: JsonObject): String =
  obj["commandText"]
    .asStringOrNull()
    ?.trim()
    ?.takeIf { it.isNotEmpty() }
    ?: "Command request"

private fun gatewayExecApprovalListCommandPreview(obj: JsonObject): String? {
  val text = gatewayExecApprovalListCommandText(obj)
  val preview =
    obj["commandPreview"]
      .asStringOrNull()
      ?.trim()
      ?.takeIf { it.isNotEmpty() }
  return preview?.takeIf { it != text }
}

private fun gatewayExecApprovalAllowedDecisions(request: JsonObject?): List<String> {
  val explicit = parseGatewayExecApprovalDecisions(request?.get("allowedDecisions") as? JsonArray)
  if (explicit.isNotEmpty()) return explicit
  val allowed =
    if (request
        ?.get("ask")
        .asStringOrNull()
        ?.trim()
        ?.lowercase() == "always"
    ) {
      listOf("allow-once", "deny")
    } else {
      listOf("allow-once", "allow-always", "deny")
    }
  val unavailable = parseGatewayExecApprovalDecisions(request?.get("unavailableDecisions") as? JsonArray).toSet()
  return allowed.filterNot { it == "allow-always" && it in unavailable }
}

private fun parseGatewayExecApprovalDecisions(items: JsonArray?): List<String> =
  items
    ?.mapNotNull { item ->
      when (item.asStringOrNull()?.trim()) {
        "allow-once" -> "allow-once"
        "allow-always" -> "allow-always"
        "deny" -> "deny"
        else -> null
      }
    }?.distinct()
    .orEmpty()

private fun JsonObject?.long(key: String): Long? = (this?.get(key) as? JsonPrimitive)?.content?.trim()?.toLongOrNull()
