package ai.openclaw.app

import ai.openclaw.app.chat.ChatFastMode
import ai.openclaw.app.chat.ChatThinkingLevelOption
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
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
  val manualSelectionAllowed: Boolean? = null,
  val effectiveFastMode: ChatFastMode? = null,
  val thinkingLevels: List<ChatThinkingLevelOption>? = null,
  val thinkingDefault: String? = null,
  val supportsTools: Boolean? = null,
  val agentRuntime: JsonObject? = null,
) {
  val runtimeName: String?
    get() {
      if (agentRuntime?.get("source")?.jsonPrimitive?.content !in setOf("model", "provider")) return null
      return when (agentRuntime?.get("id")?.jsonPrimitive?.content) {
        "codex", "codex-cli" -> "Codex"
        "claude-cli" -> "Claude CLI"
        "google-gemini-cli" -> "Gemini CLI"
        "openclaw" -> "OpenClaw"
        else -> null
      }
    }
}

enum class GatewayModelUnavailableReason {
  MissingAuth,
  AuthFailed,
  Cooldown,
}

internal data class GatewayModelCatalogResult(
  val models: List<GatewayModelSummary>,
  val refreshFailed: Boolean,
  val hasPendingProviders: Boolean,
  val failedProviders: List<String> = emptyList(),
  val nativeRefreshFailed: Boolean = false,
)

private val catalogProviderIdentifier = Regex("[A-Za-z0-9][A-Za-z0-9._-]{0,63}")

internal fun parseGatewayModelCatalog(root: JsonObject?): GatewayModelCatalogResult {
  val models = parseGatewayModels(root?.get("models") as? JsonArray)
  val refreshFailures = (root?.get("refreshFailures") as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }
  val unavailableProviders =
    (root?.get("providerOutcomes") as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }.filter {
      (it["status"] as? JsonPrimitive)?.contentOrNull == "unavailable"
    }
  // New diagnostics already enforce the requested catalog scope. Do not refill a
  // deliberately omitted provider from legacy, account-oriented outcomes.
  val failedScopes =
    if (root?.containsKey("refreshFailures") == true) {
      refreshFailures
    } else {
      unavailableProviders.filter { outcome ->
        models.any { it.provider == (outcome["provider"] as? JsonPrimitive)?.contentOrNull }
      }
    }
  return GatewayModelCatalogResult(
    models = models,
    refreshFailed = root?.get("refreshFailed")?.jsonPrimitive?.booleanOrNull == true,
    hasPendingProviders = (root?.get("pendingProviders") as? JsonArray)?.isNotEmpty() == true,
    // Only display provider identifiers, never profile ids, errors, or endpoint-shaped values.
    failedProviders =
      failedScopes
        .mapNotNull {
          (it["provider"] as? JsonPrimitive)?.takeIf { value -> value.isString }?.contentOrNull?.takeIf { provider ->
            catalogProviderIdentifier.matches(provider)
          }
        }.distinct(),
    nativeRefreshFailed = refreshFailures.any { (it["acquisition"] as? JsonPrimitive)?.contentOrNull == "native" },
  )
}

internal fun parseGatewayModels(models: JsonArray?): List<GatewayModelSummary> =
  models.orEmpty().map { item ->
    val row = item.jsonObject
    val input = (row["input"] as? JsonArray).orEmpty().map { it.jsonPrimitive.content }.toSet()
    GatewayModelSummary(
      id = row.getValue("id").jsonPrimitive.content,
      name = row.getValue("name").jsonPrimitive.content,
      provider = row.getValue("provider").jsonPrimitive.content,
      available = row["available"]?.jsonPrimitive?.booleanOrNull,
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
      manualSelectionAllowed = row["manualSelectionAllowed"]?.jsonPrimitive?.booleanOrNull,
      effectiveFastMode = ChatFastMode.fromWireValue(row["effectiveFastMode"]?.jsonPrimitive?.content),
      thinkingLevels =
        (row["thinkingLevels"] as? JsonArray)?.map {
          val option = it.jsonObject
          ChatThinkingLevelOption(option.getValue("id").jsonPrimitive.content, option.getValue("label").jsonPrimitive.content)
        },
      thinkingDefault = row["thinkingDefault"]?.jsonPrimitive?.content,
      supportsTools = row["supportsTools"]?.jsonPrimitive?.booleanOrNull,
      agentRuntime = row["agentRuntime"]?.jsonObject,
    )
  }
