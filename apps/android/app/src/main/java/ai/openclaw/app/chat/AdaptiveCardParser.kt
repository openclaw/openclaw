package ai.openclaw.app.chat

import org.json.JSONArray
import org.json.JSONObject

data class ParsedAdaptiveCard(
  val card: Map<String, Any>,
  val fallbackText: String,
  val templateData: Map<String, Any>? = null,
)

private val cardMarkerRegex =
  Regex("<!--adaptive-card-->(.*?)<!--/adaptive-card-->", RegexOption.DOT_MATCHES_ALL)

/**
 * Extract the first adaptive card JSON from marker-delimited text.
 * Returns null when no markers are present.
 */
fun parseAdaptiveCardMarkers(text: String): ParsedAdaptiveCard? {
  val match = cardMarkerRegex.find(text) ?: return null
  val jsonStr = match.groupValues[1].trim()
  val prefix = text.substring(0, match.range.first).trim()
  val markerEnd = match.range.last + 1
  // Strip any adaptive-card-data blocks from the suffix
  val dataPattern =
    Regex("<!--adaptive-card-data-->.*?<!--/adaptive-card-data-->", RegexOption.DOT_MATCHES_ALL)
  val remaining = text.substring(markerEnd)
  val suffix = dataPattern.replace(remaining, "").trim()
  val fallback = listOf(prefix, suffix).filter { it.isNotBlank() }.joinToString("\n\n")

  return try {
    val json = JSONObject(jsonStr)
    val card = jsonObjectToMap(json)
    val templateData = (card["templateData"] as? Map<*, *>)
      ?.let { @Suppress("UNCHECKED_CAST") (it as Map<String, Any>) }
    ParsedAdaptiveCard(card = card, fallbackText = fallback, templateData = templateData)
  } catch (_: Exception) {
    null
  }
}

/** Remove adaptive card marker blocks, leaving only surrounding text. */
fun stripCardMarkers(text: String): String {
  return cardMarkerRegex.replace(text, "").trim()
}

// -- JSON-to-Map helpers using Android built-in org.json --

private fun jsonObjectToMap(obj: JSONObject): Map<String, Any> {
  val map = mutableMapOf<String, Any>()
  for (key in obj.keys()) {
    map[key] = unwrapJsonValue(obj.get(key))
  }
  return map
}

private fun jsonArrayToList(arr: JSONArray): List<Any> {
  return (0 until arr.length()).map { unwrapJsonValue(arr.get(it)) }
}

private fun unwrapJsonValue(value: Any): Any {
  return when (value) {
    is JSONObject -> jsonObjectToMap(value)
    is JSONArray -> jsonArrayToList(value)
    JSONObject.NULL -> ""
    else -> value
  }
}
