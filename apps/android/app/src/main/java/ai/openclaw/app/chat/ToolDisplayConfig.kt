package ai.openclaw.app.chat

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

@Serializable
internal data class ToolDisplayConfig(
  val tools: Map<String, ToolDisplaySpec>,
  val fallback: ToolDisplaySpec,
) {
  companion object {
    private val json = Json { ignoreUnknownKeys = true }

    fun parse(source: String): ToolDisplayConfig = json.decodeFromString(source)
  }
}

@Serializable
internal data class ToolDisplaySpec(
  val icon: String,
)
