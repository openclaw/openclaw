package ai.openclaw.app

import ai.openclaw.app.chat.ChatFastMode
import ai.openclaw.app.chat.ChatThinkingLevelOption
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
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
  val unavailableUntil: Long? = null,
  val tags: Set<String> = emptySet(),
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

internal data class GatewayModelCatalogResult(
  val models: List<GatewayModelSummary>,
  val refreshFailed: Boolean,
  val tagsDescribeDefaults: Boolean,
  val providerOutcomes: List<GatewayModelProviderOutcome>,
  val pendingProviders: Set<String>,
)

data class GatewayModelProviderOutcome(
  val provider: String,
  val profileId: String?,
  val status: String,
)

internal fun parseGatewayModelCatalog(root: JsonObject?): GatewayModelCatalogResult =
  GatewayModelCatalogResult(
    models = parseGatewayModels(root?.get("models") as? JsonArray),
    refreshFailed = root?.get("refreshFailed")?.jsonPrimitive?.booleanOrNull == true,
    tagsDescribeDefaults = root?.get("tagsScope")?.jsonPrimitive?.content == "defaults",
    providerOutcomes =
      (root?.get("providerOutcomes") as? JsonArray).orEmpty().map { item ->
        val row = item.jsonObject
        GatewayModelProviderOutcome(
          provider = row.getValue("provider").jsonPrimitive.content,
          profileId = row["profileId"]?.jsonPrimitive?.content,
          status = row.getValue("status").jsonPrimitive.content,
        )
      },
    pendingProviders = (root?.get("pendingProviders") as? JsonArray).orEmpty().map { it.jsonPrimitive.content }.toSet(),
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
      unavailableUntil = row["unavailableUntil"]?.jsonPrimitive?.longOrNull,
      tags = (row["tags"] as? JsonArray).orEmpty().map { it.jsonPrimitive.content }.toSet(),
    )
  }

data class GatewayModelProviderSummary(
  val id: String,
  val displayName: String,
  val status: String,
  val authType: String? = null,
  val renewalFailed: Boolean = false,
  val authProviderId: String = id,
  val profiles: List<GatewayModelProviderProfile> = emptyList(),
  val apiKeySource: String? = null,
  val apiKeyEnvVar: String? = null,
  val usage: GatewayUsageProviderSummary? = null,
) {
  val hasApiKey: Boolean
    get() = apiKeySource != null || profiles.any { it.eligible && it.type == "api_key" }

  val canRemoveApiKey: Boolean
    get() = apiKeySource == "config" || profiles.any { it.type == "api_key" && it.logoutSupported }
}

data class GatewayModelProviderProfile(
  val profileId: String,
  val type: String,
  val source: String? = null,
  val logoutSupported: Boolean = false,
  val eligible: Boolean = true,
)

data class GatewayUsageBilling(
  val type: String,
  val unit: String,
  val label: String? = null,
  val amount: Double? = null,
  val used: Double? = null,
  val limit: Double? = null,
  val period: String? = null,
  val resetAtMs: Long? = null,
)

data class GatewayProviderSessionSpend(
  val totalCost: Double,
  val totalTokens: Long,
  val messageCount: Long,
)

internal fun parseGatewayModelProviders(providers: JsonArray?): List<GatewayModelProviderSummary> =
  providers.orEmpty().mapNotNull { item ->
    val row = item as? JsonObject ?: return@mapNotNull null
    val id =
      row["provider"]
        ?.jsonPrimitive
        ?.content
        ?.trim()
        ?.takeIf(String::isNotEmpty) ?: return@mapNotNull null
    val profiles = (row["profiles"] as? JsonArray).orEmpty().map { it.jsonObject }
    val order = (row["profileOrder"] as? JsonArray)?.map { it.jsonPrimitive.content }?.toSet()
    val activeProfiles = profiles.filter { it["reasonCode"]?.jsonPrimitive?.content != "setup_inactive" && (order == null || it["profileId"]?.jsonPrimitive?.content in order) }
    val types = activeProfiles.mapNotNull { it["type"]?.jsonPrimitive?.content }
    val status =
      row["status"]
        ?.jsonPrimitive
        ?.content
        ?.trim()
        ?.takeIf(String::isNotEmpty) ?: "unknown"
    GatewayModelProviderSummary(
      id = id,
      displayName =
        row["displayName"]
          ?.jsonPrimitive
          ?.content
          ?.trim()
          ?.takeIf(String::isNotEmpty) ?: providerDisplayName(id),
      status = status,
      authType =
        if ("oauth" in types) {
          "oauth"
        } else if ("api_key" in types || row["apiKey"] is JsonObject) {
          "api_key"
        } else {
          types.firstOrNull()
        },
      renewalFailed = status == "expired" && activeProfiles.any { it["renewalFailed"]?.jsonPrimitive?.booleanOrNull == true },
      authProviderId = row["authProvider"]?.jsonPrimitive?.content ?: id,
      profiles =
        profiles.map { profile ->
          GatewayModelProviderProfile(
            profileId = profile.getValue("profileId").jsonPrimitive.content,
            type = profile.getValue("type").jsonPrimitive.content,
            source = profile["source"]?.jsonPrimitive?.content,
            logoutSupported = profile["logoutSupported"]?.jsonPrimitive?.booleanOrNull == true,
            eligible = profile in activeProfiles,
          )
        },
      apiKeySource = (row["apiKey"] as? JsonObject)?.get("source")?.jsonPrimitive?.content,
      apiKeyEnvVar = (row["apiKey"] as? JsonObject)?.get("envVar")?.jsonPrimitive?.content,
      usage =
        (row["usage"] as? JsonObject)?.let { usage ->
          parseGatewayProviderUsage(
            usage,
            providerId = usage["providerId"]?.jsonPrimitive?.content ?: id,
            displayName = row["displayName"]?.jsonPrimitive?.content ?: providerDisplayName(id),
          )
        },
    )
  }

internal fun parseGatewayProviderUsage(
  row: JsonObject,
  providerId: String = row["provider"]?.jsonPrimitive?.content.orEmpty(),
  displayName: String = row["displayName"]?.jsonPrimitive?.content ?: providerDisplayName(providerId),
): GatewayUsageProviderSummary =
  GatewayUsageProviderSummary(
    providerId = providerId,
    displayName = displayName,
    plan = row["plan"]?.jsonPrimitive?.content,
    summary = row["summary"]?.jsonPrimitive?.content,
    error = row["error"]?.jsonPrimitive?.content,
    windows =
      (row["windows"] as? JsonArray).orEmpty().map { item ->
        val window = item.jsonObject
        GatewayUsageWindowSummary(
          label = window.getValue("label").jsonPrimitive.content,
          usedPercent = window.getValue("usedPercent").jsonPrimitive.doubleOrNull ?: 0.0,
          resetAtMs = window["resetAt"]?.jsonPrimitive?.longOrNull,
          groupLabel = window["groupLabel"]?.jsonPrimitive?.content,
        )
      },
    billing =
      (row["billing"] as? JsonArray).orEmpty().map { item ->
        val billing = item.jsonObject
        GatewayUsageBilling(
          type = billing.getValue("type").jsonPrimitive.content,
          unit = billing.getValue("unit").jsonPrimitive.content,
          label = billing["label"]?.jsonPrimitive?.content,
          amount = billing["amount"]?.jsonPrimitive?.doubleOrNull,
          used = billing["used"]?.jsonPrimitive?.doubleOrNull,
          limit = billing["limit"]?.jsonPrimitive?.doubleOrNull,
          period = billing["period"]?.jsonPrimitive?.content,
          resetAtMs = billing["resetAt"]?.jsonPrimitive?.longOrNull,
        )
      },
  )

internal fun parseGatewayProviderSessionSpend(root: JsonObject): Map<String, GatewayProviderSessionSpend> =
  (root["aggregates"]?.jsonObject?.get("byProvider") as? JsonArray)
    .orEmpty()
    .mapNotNull { item ->
      val row = item.jsonObject
      val provider = row["provider"]?.jsonPrimitive?.content?.takeIf(String::isNotBlank) ?: return@mapNotNull null
      val totals = row.getValue("totals").jsonObject
      provider to
        GatewayProviderSessionSpend(
          totalCost = totals.getValue("totalCost").jsonPrimitive.doubleOrNull ?: 0.0,
          totalTokens = totals.getValue("totalTokens").jsonPrimitive.longOrNull ?: 0L,
          messageCount = row.getValue("count").jsonPrimitive.longOrNull ?: 0L,
        )
    }.toMap()
