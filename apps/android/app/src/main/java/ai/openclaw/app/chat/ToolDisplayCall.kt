package ai.openclaw.app.chat

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

internal data class ToolDisplayCall(
  val name: String,
  val args: JsonObject?,
)

private val catalogToolId = Regex("^(?:openclaw|mcp|client):[^:]+:(.+)$")
private val dispatcherNames = setOf("dispatch_action", "tool_call")

internal fun unwrapToolCallForDisplay(
  name: String,
  args: JsonObject?,
): ToolDisplayCall {
  val id = (args?.get("id") as? JsonPrimitive)?.takeIf { it.isString }?.content?.trim()
  if (name.trim().lowercase() !in dispatcherNames || id.isNullOrEmpty()) return ToolDisplayCall(name, args)
  return ToolDisplayCall(
    name = catalogToolId.matchEntire(id)?.groupValues?.get(1) ?: id,
    args = args["args"] as? JsonObject ?: JsonObject(emptyMap()),
  )
}
