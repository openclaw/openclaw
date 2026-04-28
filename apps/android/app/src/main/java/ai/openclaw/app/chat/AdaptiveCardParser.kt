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

private val dataMarkerRegex =
  Regex("<!--adaptive-card-data-->(.*?)<!--/adaptive-card-data-->", RegexOption.DOT_MATCHES_ALL)

/**
 * Extract the first adaptive card JSON from marker-delimited text.
 * Template data is extracted from separate `<!--adaptive-card-data-->` markers.
 * Returns null when no card markers are present.
 */
fun parseAdaptiveCardMarkers(text: String): ParsedAdaptiveCard? {
  val match = cardMarkerRegex.find(text) ?: return null
  val jsonStr = match.groupValues[1].trim()

  // Extract template data from separate data markers
  val dataMatch = dataMarkerRegex.find(text)
  val templateData = dataMatch?.let {
    try {
      val dataJson = JSONObject(it.groupValues[1].trim())
      jsonObjectToMap(dataJson)
    } catch (_: Exception) {
      null
    }
  }

  // Strip both card and data markers to get fallback text
  val fallback = stripCardMarkers(stripDataMarkers(text))

  return try {
    val json = JSONObject(jsonStr)
    val card = jsonObjectToMap(json)
    ParsedAdaptiveCard(card = card, fallbackText = fallback, templateData = templateData)
  } catch (_: Exception) {
    null
  }
}

/** Remove adaptive card marker blocks, leaving only surrounding text. */
fun stripCardMarkers(text: String): String {
  return cardMarkerRegex.replace(text, "").trim()
}

/** Remove adaptive card data marker blocks, leaving only surrounding text. */
fun stripDataMarkers(text: String): String {
  return dataMarkerRegex.replace(text, "").trim()
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
