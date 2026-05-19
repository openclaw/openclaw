package ai.openclaw.app.voice

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

internal object ChatEventText {
  private val json = Json { ignoreUnknownKeys = true }

  fun assistantTextFromPayload(payload: JsonObject): String? = assistantTextFromMessage(payload["message"])

  fun assistantTextFromMessage(messageEl: JsonElement?): String? {
    val message = messageEl.asObjectOrNull() ?: return null
    val role = message["role"].asStringOrNull()
    if (role != null && role != "assistant") return null
    return textFromContent(message["content"])
  }

  fun messageToolSourceReplyTextFromAgentPayload(payload: JsonObject): String? {
    val data = payload["data"].asObjectOrNull() ?: return null
    if (data["phase"].asStringOrNull() != "result") return null
    if (data["name"].asStringOrNull() != "message") return null
    if (data["isError"].asBooleanOrNull() == true) return null
    return sourceReplyTextFromToolResult(data["result"])
  }

  private fun textFromContent(content: JsonElement?): String? =
    when (content) {
      is JsonPrimitive -> content.asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() }
      is JsonArray ->
        content
          .mapNotNull(::textFromContentPart)
          .filter { it.isNotEmpty() }
          .joinToString("\n")
          .takeIf { it.isNotBlank() }
      else -> null
    }

  private fun textFromContentPart(part: JsonElement): String? {
    part
      .asStringOrNull()
      ?.trim()
      ?.takeIf { it.isNotEmpty() }
      ?.let { return it }
    val obj = part.asObjectOrNull() ?: return null
    val type = obj["type"].asStringOrNull()
    if (type != null && type != "text") return null
    return obj["text"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() }
  }

  private fun sourceReplyTextFromToolResult(result: JsonElement?): String? {
    val obj = result.asObjectOrNull()
    if (obj != null) {
      sourceReplyTextFromObject(obj)?.let { return it }
      sourceReplyTextFromToolResult(obj["details"])?.let { return it }
      sourceReplyTextFromToolResult(obj["result"])?.let { return it }
      sourceReplyTextFromToolResult(obj["content"])?.let { return it }
      sourceReplyTextFromJsonString(obj["text"].asStringOrNull())?.let { return it }
      sourceReplyTextFromJsonString(obj["message"].asStringOrNull())?.let { return it }
    }
    if (result is JsonArray) {
      for (part in result) {
        sourceReplyTextFromToolResult(part)?.let { return it }
      }
      return null
    }
    return sourceReplyTextFromJsonString(result.asStringOrNull())
  }

  private fun sourceReplyTextFromObject(obj: JsonObject): String? {
    val sourceReply = obj["sourceReply"].asObjectOrNull()
    val text = sourceReply?.get("text").asStringOrNull()?.trim()
    if (!text.isNullOrEmpty()) return text
    val directMessage = obj["message"].asStringOrNull()?.trim()
    return directMessage?.takeIf {
      it.isNotEmpty() && obj["sourceReplyDeliveryMode"].asStringOrNull() == "message_tool_only"
    }
  }

  private fun sourceReplyTextFromJsonString(raw: String?): String? {
    val text = raw?.trim() ?: return null
    if (!text.startsWith("{") && !text.startsWith("[")) return null
    val parsed =
      try {
        json.parseToJsonElement(text)
      } catch (_: Throwable) {
        return null
      }
    return sourceReplyTextFromToolResult(parsed)
  }
}

private fun JsonElement?.asObjectOrNull(): JsonObject? = this as? JsonObject

private fun JsonElement?.asStringOrNull(): String? = (this as? JsonPrimitive)?.takeIf { it.isString }?.content

private fun JsonElement?.asBooleanOrNull(): Boolean? =
  (this as? JsonPrimitive)?.let {
    when (it.content) {
      "true" -> true
      "false" -> false
      else -> null
    }
  }
