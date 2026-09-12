package ai.openclaw.app

import ai.openclaw.app.chat.ChatFastMode
import ai.openclaw.app.chat.ChatThinkingLevelOption
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull

data class GatewayModelSummary(
  val id: String,
  val name: String,
  val provider: String,
  val available: Boolean?,
  val unavailableReason: GatewayModelUnavailableReason? = null,
  val supportsVision: Boolean,
  val supportsAudio: Boolean,
  val supportsVideo: Boolean,
  val supportsDocuments: Boolean,
  val supportsReasoning: Boolean,
  val contextTokens: Long?,
  val supportsFastMode: Boolean? = null,
  val effectiveFastMode: ChatFastMode? = null,
  val thinkingLevels: List<ChatThinkingLevelOption>? = null,
  val thinkingDefault: String? = null,
  val supportsTools: Boolean? = null,
  val agentRuntime: JsonObject? = null,
  val unavailableUntil: Long? = null,
  val tags: List<String> = emptyList(),
) {
  val runtimeName: String?
    get() =
      if (agentRuntime?.get("source")?.jsonPrimitive?.content in setOf("model", "provider")) {
        when (agentRuntime?.get("id")?.jsonPrimitive?.content) {
          "codex", "codex-cli" -> "Codex"
          "claude-cli" -> "Claude CLI"
          "google-gemini-cli" -> "Gemini CLI"
          "openclaw" -> "OpenClaw"
          else -> null
        }
      } else {
        null
      }
}

enum class GatewayModelUnavailableReason {
  MissingAuth,
  AuthFailed,
  Cooldown,
}

data class GatewayModelAllowList(
  val hiddenCount: Int,
  val settingsPath: String,
  val selectedModelBlocked: Boolean?,
)

internal data class GatewayModelCatalogResult(
  val models: List<GatewayModelSummary>,
  val refreshFailed: Boolean,
  val allowList: GatewayModelAllowList?,
)

internal fun parseGatewayModelCatalog(root: JsonObject?): GatewayModelCatalogResult =
  GatewayModelCatalogResult(
    models = parseGatewayModels(root?.get("models") as? JsonArray),
    refreshFailed = root?.get("refreshFailed")?.jsonPrimitive?.booleanOrNull == true,
    allowList =
      root?.get("allowList")?.jsonObject?.let { notice ->
        GatewayModelAllowList(
          hiddenCount = notice.getValue("hiddenCount").jsonPrimitive.int,
          settingsPath = notice.getValue("settingsPath").jsonPrimitive.content,
          selectedModelBlocked = notice["selectedModelBlocked"]?.jsonPrimitive?.booleanOrNull,
        )
      },
  )

internal fun parseGatewayModels(models: JsonArray?): List<GatewayModelSummary> =
  models.orEmpty().map { item ->
    val row = item.jsonObject
    val input = (row["input"] as? JsonArray).orEmpty().map { it.jsonPrimitive.content }.toSet()
    GatewayModelSummary(
      id = row.getValue("id").jsonPrimitive.content,
      name = row.getValue("name").jsonPrimitive.content,
      provider = row.getValue("provider").jsonPrimitive.content,
      available = row["available"]?.jsonPrimitive?.booleanOrNull,
      tags = (row["tags"] as? JsonArray).orEmpty().map { it.jsonPrimitive.content },
      unavailableReason =
        when (row["unavailableReason"]?.jsonPrimitive?.content) {
          "missing-auth" -> GatewayModelUnavailableReason.MissingAuth
          "auth-failed" -> GatewayModelUnavailableReason.AuthFailed
          "cooldown" -> GatewayModelUnavailableReason.Cooldown
          else -> null
        },
      supportsVision = "image" in input,
      supportsAudio = "audio" in input,
      supportsVideo = "video" in input,
      supportsDocuments = "document" in input,
      supportsReasoning = row["reasoning"]?.jsonPrimitive?.booleanOrNull == true,
      contextTokens = row["contextTokens"]?.jsonPrimitive?.longOrNull ?: row["contextWindow"]?.jsonPrimitive?.longOrNull,
      supportsFastMode = row["supportsFastMode"]?.jsonPrimitive?.booleanOrNull,
      effectiveFastMode = ChatFastMode.fromWireValue(row["effectiveFastMode"]?.jsonPrimitive?.content),
      thinkingLevels =
        (row["thinkingLevels"] as? JsonArray)?.map {
          val option = it.jsonObject
          ChatThinkingLevelOption(option.getValue("id").jsonPrimitive.content, option.getValue("label").jsonPrimitive.content)
        },
      thinkingDefault = row["thinkingDefault"]?.jsonPrimitive?.content,
      supportsTools = row["supportsTools"]?.jsonPrimitive?.booleanOrNull,
      agentRuntime = row["agentRuntime"]?.jsonObject,
      unavailableUntil = row["unavailableUntil"]?.jsonPrimitive?.longOrNull,
    )
  }
