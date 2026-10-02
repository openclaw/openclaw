package ai.openclaw.wear.shared

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

fun wearReplyText(
  source: JsonObject,
  maxChars: Int = WearReplyText.MAX_TEXT_LENGTH + 1,
): String {
  val parts =
    when (val content = source["content"]) {
      is JsonPrimitive -> {
        sequenceOf(content.contentOrNull.orEmpty())
      }

      is JsonArray -> {
        content.asSequence().mapNotNull { part ->
          when (part) {
            is JsonPrimitive -> part.contentOrNull
            is JsonObject -> if (part["type"] == null || part["type"] == JsonPrimitive("text")) (part["text"] as? JsonPrimitive)?.contentOrNull else null
            else -> null
          }
        }
      }

      else -> {
        emptySequence()
      }
    }
  // Keep one extra character at callers' limits to detect loss without joining an unbounded reply.
  return buildString {
    var first = true
    for (text in parts) {
      if (!first && length < maxChars) append('\n')
      append(text, 0, minOf(text.length, maxChars - length))
      if (length == maxChars) break
      first = false
    }
  }
}

fun wearReplyEntryId(source: JsonObject): String? = ((source["__openclaw"] as? JsonObject)?.get("id") as? JsonPrimitive)?.contentOrNull?.takeIf(String::isNotBlank)

fun wearReplyIsSynthetic(source: JsonObject): Boolean = source["openclawMessageToolMirror"] is JsonObject || source["openclawStreamFallback"] is JsonObject

fun wearReplyIsTruncated(
  source: JsonObject,
  maxChars: Int,
): Boolean {
  val marker = (source["__openclaw"] as? JsonObject)?.get("truncated")
  if (marker == JsonPrimitive(true)) return true
  val suffix = "\n...(truncated)..."
  val content = source["content"]
  val texts =
    if (content is JsonArray) {
      content.mapNotNull {
        when (it) {
          is JsonPrimitive -> it.contentOrNull
          is JsonObject -> (it["text"] as? JsonPrimitive)?.contentOrNull
          else -> null
        }
      }
    } else {
      listOf((content as? JsonPrimitive)?.contentOrNull.orEmpty())
    }
  // Shipped Gateways predate the structural display-cap marker.
  return marker == null && texts.any { it.length == maxChars + suffix.length && it.endsWith(suffix) }
}

fun projectWearFullReply(
  result: JsonElement,
  entryId: String,
  owner: String,
  offset: Int,
  revision: String?,
): WearReplyTextPage {
  val root = result as? JsonObject ?: return WearReplyTextPage(WearReplyTextStatus.Failed)
  if (root["ok"] == JsonPrimitive(false)) {
    return WearReplyTextPage(if (root["unavailableReason"] == JsonPrimitive("oversized")) WearReplyTextStatus.TooLarge else WearReplyTextStatus.Unavailable)
  }
  val message = root["message"] as? JsonObject ?: return WearReplyTextPage(WearReplyTextStatus.Failed)
  if (root["ok"] != JsonPrimitive(true) || wearReplyEntryId(message) != entryId ||
    message["role"] != JsonPrimitive("assistant") || wearReplyIsSynthetic(message)
  ) {
    return WearReplyTextPage(WearReplyTextStatus.Unavailable)
  }
  if (wearReplyIsTruncated(message, WearReplyText.MAX_TEXT_LENGTH)) return WearReplyTextPage(WearReplyTextStatus.TooLarge)
  val text = wearReplyText(message)
  if (text.isBlank()) return WearReplyTextPage(WearReplyTextStatus.Failed)
  return WearReplyText.page(text, owner, offset, revision)
}
