package ai.openclaw.app.chat

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

internal data class ToolDisplayCall(
  val name: String,
  val args: JsonObject?,
)

private val catalogToolId = Regex("^(?:openclaw|mcp|client):[^:]+:(.+)$")
private val dispatcherNames = setOf("dispatch_action", "tool_call")

// Loopback MCP transport prefixes (Gemini uses single underscores). Other servers keep their bridged names.
private val openClawMcpToolPrefixes = listOf("mcp__openclaw__", "mcp_openclaw_")

internal fun unwrapToolCallForDisplay(
  rawName: String,
  args: JsonObject?,
): ToolDisplayCall {
  // CLI history keeps the bridged name; present the gateway tool the live events show.
  val name = openClawMcpToolPrefixes.firstOrNull(rawName::startsWith)?.let(rawName::removePrefix) ?: rawName
  val id = (args?.get("id") as? JsonPrimitive)?.takeIf { it.isString }?.content?.trim()
  if (name.trim().lowercase() !in dispatcherNames || id.isNullOrEmpty()) return ToolDisplayCall(name, args)
  return ToolDisplayCall(
    name = catalogToolId.matchEntire(id)?.groupValues?.get(1) ?: id,
    args = args["args"] as? JsonObject ?: JsonObject(emptyMap()),
  )
}
