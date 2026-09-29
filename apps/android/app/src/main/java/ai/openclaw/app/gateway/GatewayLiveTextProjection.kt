package ai.openclaw.app.gateway

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull

/** Reconstructs wire deltas before local subscribers can attach late or drop an update. */
internal class GatewayLiveTextProjection {
  private data class RunKey(
    val runId: String,
    val sessionKey: String?,
    val agentId: String?,
  )

  private data class AssistantText(
    val itemId: String?,
    val text: String,
  )

  private val chatMessages = mutableMapOf<RunKey, JsonObject>()
  private val assistantTexts = mutableMapOf<RunKey, AssistantText>()

  // Null means the connection needs a new baseline; a suffix is never a complete local snapshot.
  fun project(
    event: String,
    payload: JsonObject,
  ): JsonObject? {
    val runId = payload["runId"].stringValue() ?: return payload
    val key = RunKey(runId, payload["sessionKey"].stringValue(), payload["agentId"].stringValue())
    when (event) {
      "chat" -> {
        when (payload["state"].stringValue()) {
          "delta" -> {
            val snapshot = payload["message"] as? JsonObject
            val message =
              snapshot ?: run {
                val delta = payload["deltaText"].stringValue() ?: return payload
                val previous = chatMessages[key]
                val replace = (payload["replace"] as? JsonPrimitive)?.booleanOrNull == true
                if (previous == null && !replace) return null
                mergeMessage(previous, delta, replace)
              }
            chatMessages[key] = message
            return JsonObject(payload + ("message" to message))
          }

          "final", "aborted", "error" -> {
            chatMessages.keys.removeAll { it.runId == runId }
            assistantTexts.keys.removeAll { it.runId == runId }
          }
        }
      }

      "agent" -> {
        val data = payload["data"] as? JsonObject ?: return payload
        when (payload["stream"].stringValue()) {
          "assistant" -> {
            val itemId = data["itemId"].stringValue()
            val text =
              data["text"].stringValue() ?: run {
                val delta = data["delta"].stringValue() ?: return payload
                if ((data["replace"] as? JsonPrimitive)?.booleanOrNull == true) {
                  delta
                } else {
                  val previous = assistantTexts[key]?.takeIf { it.itemId == itemId } ?: return null
                  previous.text + delta
                }
              }
            assistantTexts[key] = AssistantText(itemId, text)
            return JsonObject(payload + ("data" to JsonObject(data + ("text" to JsonPrimitive(text)))))
          }

          "lifecycle" -> {
            if (data["phase"].stringValue() in listOf("end", "error")) {
              assistantTexts.keys.removeAll { it.runId == runId }
            }
          }
        }
      }
    }
    return payload
  }

  private fun mergeMessage(
    previous: JsonObject?,
    delta: String,
    replace: Boolean,
  ): JsonObject {
    val message = previous ?: JsonObject(mapOf("role" to JsonPrimitive("assistant")))
    val content = message["content"]
    if (content is JsonPrimitive && content.isString) {
      return JsonObject(message + ("content" to JsonPrimitive(if (replace) delta else content.content + delta)))
    }
    val blocks = (content as? JsonArray)?.toMutableList() ?: mutableListOf()
    val textIndex = blocks.indexOfLast { (it as? JsonObject)?.get("type").stringValue() == "text" }
    if (replace) {
      blocks.removeAll { (it as? JsonObject)?.get("type").stringValue() == "text" }
      blocks.add(0, textBlock(delta))
    } else if (textIndex < 0) {
      blocks.add(0, textBlock(delta))
    } else {
      val block = blocks[textIndex] as JsonObject
      blocks[textIndex] = JsonObject(block + ("text" to JsonPrimitive(block["text"].stringValue().orEmpty() + delta)))
    }
    return JsonObject(message + ("content" to JsonArray(blocks)))
  }

  private fun textBlock(text: String): JsonObject = JsonObject(mapOf("type" to JsonPrimitive("text"), "text" to JsonPrimitive(text)))
}

private fun JsonElement?.stringValue(): String? = (this as? JsonPrimitive)?.takeIf { it.isString }?.content
