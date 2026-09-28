package ai.openclaw.app.voice

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

internal object ChatEventText {
  private val visibleAssistantTextTypes = setOf("", "text", "input_text", "output_text")

  /** Extracts assistant reply text from a gateway chat event payload. */
  fun assistantTextFromPayload(payload: JsonObject): String? = assistantTextFromMessage(payload["message"])

  /** Local stream snapshots preserve whitespace and distinguish an empty rewrite from no text. */
  fun assistantStreamTextFromPayload(payload: JsonObject): String? = assistantTextParts(payload["message"])?.takeIf { it.isNotEmpty() }?.joinToString("\n")

  /** Extracts text from assistant messages while ignoring non-assistant roles. */
  fun assistantTextFromMessage(messageEl: JsonElement?): String? =
    assistantTextParts(messageEl)
      ?.map(String::trim)
      ?.filter { it.isNotEmpty() }
      ?.joinToString("\n")
      ?.takeIf { it.isNotBlank() }

  private fun assistantTextParts(messageEl: JsonElement?): List<String>? {
    val message = messageEl.asObjectOrNull() ?: return null
    val role = message["role"].asStringOrNull()
    if (role != "assistant") return null
    return when (val content = message["content"]) {
      is JsonPrimitive -> {
        content.asStringOrNull()?.let(::listOf)
      }

      is JsonArray -> {
        // Gateway content can be either bare strings or text-part objects;
        // preserve part ordering when composing the spoken reply.
        content.mapNotNull(::textFromContentPart)
      }

      else -> {
        null
      }
    }
  }

  private fun textFromContentPart(part: JsonElement): String? {
    part.asStringOrNull()?.let { return it }
    val obj = part.asObjectOrNull() ?: return null
    val type =
      obj["type"]
        .asStringOrNull()
        ?.trim()
        ?.lowercase()
        .orEmpty()
    if (type !in visibleAssistantTextTypes) return null
    return obj["text"].asStringOrNull()
  }
}

private fun JsonElement?.asObjectOrNull(): JsonObject? = this as? JsonObject

private fun JsonElement?.asStringOrNull(): String? = (this as? JsonPrimitive)?.takeIf { it.isString }?.content
