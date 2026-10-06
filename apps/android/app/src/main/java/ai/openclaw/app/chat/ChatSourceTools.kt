package ai.openclaw.app.chat

import ai.openclaw.app.takeUtf16Safe
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull

/** In-memory web evidence from canonical history, before the tool display truncates its output. */
data class ChatSourceTool(
  val callId: String?,
  val name: String?,
  val envelopeName: String?,
  val runId: String?,
  val isResult: Boolean,
  val isError: Boolean,
  val completed: Boolean = isResult,
  val sources: List<ChatRecordedSource> = emptyList(),
)

data class ChatRecordedSource(
  val url: String,
  val requestedUrl: String = url,
  val toolName: String,
  val title: String?,
  val prose: String?,
)

private val sourceFrame = Regex("(?:^|\\n)<<<EXTERNAL_UNTRUSTED_CONTENT id=\"([a-f0-9]{16})\">>>\\r?\\nSource: ([^\\r\\n]+)\\r?\\n---\\r?\\n([\\s\\S]*?)\\r?\\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id=\"\\1\">>>")

internal fun parseChatSourceTools(
  message: JsonObject,
  role: String,
): List<ChatSourceTool> {
  val envelopeName = (message.sourceString("toolName") ?: message.sourceString("tool_name"))?.trim()
  val blocks =
    if (role == "toolresult") {
      listOf(message)
    } else {
      (message["content"] as? JsonArray)
        .orEmpty()
        .mapNotNull { it as? JsonObject }
        .filter { normalizeChatToolContentType(it.sourceString("type")) != null }
    }
  return blocks.map { block ->
    val isResult = block === message || normalizeChatToolContentType(block.sourceString("type")) == "toolResult"
    val name = (block.sourceString("name") ?: block.sourceString("toolName") ?: block.sourceString("tool_name"))?.trim()
    val isError = isChatToolError(block) || isChatToolError(message)
    val completed = isResult && (message["__openclawToolStreamLive"] != JsonPrimitive(true) || message["__openclawToolStreamResultReceived"] == JsonPrimitive(true))
    ChatSourceTool(
      callId =
        listOf("toolCallId", "tool_call_id", "toolUseId", "tool_use_id", "callId", "id").firstNotNullOfOrNull(block::sourceString)
          ?: message.sourceString("toolCallId"),
      name = name,
      envelopeName = envelopeName,
      runId = block.sourceString("runId")?.trim(),
      isResult = isResult,
      isError = isError,
      completed = completed,
      sources = if (completed && !isError) parseRecordedSources(block, message) else emptyList(),
    )
  }
}

private fun parseRecordedSources(
  block: JsonObject,
  message: JsonObject,
): List<ChatRecordedSource> {
  val payload =
    if (block.containsKey("details") || message.containsKey("details")) {
      (if (block.containsKey("details")) block["details"] else message["details"]) as? JsonObject
    } else {
      val raw = block["content"] ?: block["result"] ?: block["text"]
      val text =
        when (raw) {
          is JsonPrimitive -> {
            raw.takeIf { it.isString }?.content
          }

          is JsonArray -> {
            buildString {
              for (item in raw) {
                val part = (item as? JsonObject)?.sourceString("text") ?: continue
                if (length + part.length + 1 > 100_000) return emptyList()
                if (isNotEmpty()) append('\n')
                append(part)
              }
            }
          }

          else -> {
            null
          }
        }
      text?.takeIf { it.length <= 100_000 }?.let { runCatching { Json.parseToJsonElement(it) as? JsonObject }.getOrNull() }
    } ?: return emptyList()
  val external = payload["externalContent"] as? JsonObject ?: return emptyList()
  val tool = external.sourceString("source")
  if (external["untrusted"] != JsonPrimitive(true) || external["wrapped"] != JsonPrimitive(true)) return emptyList()

  fun source(
    row: JsonObject,
    url: String,
    requestedUrl: String = url,
    proseField: String?,
  ) = ChatRecordedSource(
    url = url,
    requestedUrl = requestedUrl,
    toolName = checkNotNull(tool),
    title = sourceProse(row.sourceString("title"), tool),
    prose = proseField?.let { sourceProse(row.sourceString(it), tool) },
  )
  return when (tool) {
    "web_search" -> {
      val kind = payload.sourceString("kind")
      val rows =
        payload[
          if (kind == "results") {
            "results"
          } else if (kind == "answer") {
            "citations"
          } else {
            return emptyList()
          },
        ] as? JsonArray
      rows.orEmpty().take(20).mapNotNull { item ->
        val row = item as? JsonObject ?: return@mapNotNull null
        val url = row.sourceString("url")?.takeIf { it.length <= 2_048 } ?: return@mapNotNull null
        source(row, url, proseField = if (kind == "results") "snippet" else null)
      }
    }

    "web_fetch" -> {
      val status = (payload["status"] as? JsonPrimitive)?.takeUnless { it.isString }?.intOrNull
      if (status == null || status !in 200..299) return emptyList()
      val requested = payload.sourceString("url")?.takeIf { it.length <= 2_048 } ?: return emptyList()
      val final = payload.sourceString("finalUrl")?.takeIf { it.length <= 2_048 } ?: return emptyList()
      listOf(source(payload, final, requested, "text"))
    }

    else -> {
      emptyList()
    }
  }
}

private fun sourceProse(
  value: String?,
  tool: String,
): String? {
  if (value == null || value.length > 100_000) return null
  val frame = sourceFrame.find(value) ?: return null
  val expected = if (tool == "web_search") "Web Search" else "Web Fetch"
  return frame.groupValues[3]
    .trim()
    .takeUtf16Safe(30_000)
    .takeIf { frame.groupValues[2] == expected && it.isNotBlank() }
}

private fun JsonObject.sourceString(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf { it.isNotBlank() }
