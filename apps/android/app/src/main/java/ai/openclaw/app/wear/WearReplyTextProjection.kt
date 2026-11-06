package ai.openclaw.app.wear

import ai.openclaw.wear.shared.WearReplyText
import ai.openclaw.wear.shared.WearReplyTextPage
import ai.openclaw.wear.shared.WearReplyTextStatus
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

internal fun wearReplyText(source: JsonObject): String =
  when (val content = source["content"]) {
    is JsonPrimitive -> content.contentOrNull.orEmpty()
    is JsonArray -> content.mapNotNull { it.replyPartText(includeNonText = false) }.joinToString("\n")
    else -> ""
  }

private fun JsonElement.replyPartText(includeNonText: Boolean): String? =
  when (this) {
    is JsonPrimitive -> {
      contentOrNull
    }

    is JsonObject -> {
      if (includeNonText || this["type"] == null || this["type"] == JsonPrimitive("text")) {
        (this["text"] as? JsonPrimitive)?.contentOrNull
      } else {
        null
      }
    }

    else -> {
      null
    }
  }

internal fun wearReplyEntryId(source: JsonObject): String? = ((source["__openclaw"] as? JsonObject)?.get("id") as? JsonPrimitive)?.contentOrNull?.takeIf(String::isNotBlank)

internal fun wearReplyIsSynthetic(source: JsonObject): Boolean = source["openclawMessageToolMirror"] is JsonObject || source["openclawStreamFallback"] is JsonObject

internal fun wearReplyIsTruncated(
  source: JsonObject,
  maxChars: Int,
): Boolean {
  val marker = (source["__openclaw"] as? JsonObject)?.get("truncated")
  if (marker == JsonPrimitive(true)) return true
  val suffix = "\n...(truncated)..."
  val content = source["content"]
  val texts =
    if (content is JsonArray) {
      content.mapNotNull { it.replyPartText(includeNonText = true) }
    } else {
      listOf(wearReplyText(source))
    }
  // Shipped Gateways predate the structural display-cap marker.
  return marker == null && texts.any { it.length == maxChars + suffix.length && it.endsWith(suffix) }
}

internal fun projectWearFullReply(
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
