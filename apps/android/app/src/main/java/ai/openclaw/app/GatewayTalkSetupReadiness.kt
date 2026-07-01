package ai.openclaw.app

import ai.openclaw.app.node.asObjectOrNull
import ai.openclaw.app.node.asStringOrNull
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull

data class GatewayTalkSetupReadiness(
  val realtimeTalk: GatewayTalkSetupRow,
  val dictation: GatewayTalkSetupRow,
) {
  companion object {
    fun unavailable(reason: String = "Gateway talk catalog not loaded"): GatewayTalkSetupReadiness =
      GatewayTalkSetupReadiness(
        realtimeTalk = GatewayTalkSetupRow.unavailable(title = "Realtime Talk", reason = reason),
        dictation = GatewayTalkSetupRow.unavailable(title = "Dictation", reason = reason),
      )
  }
}

data class GatewayTalkSetupRow(
  val title: String,
  val subtitle: String,
  val statusText: String,
  val ready: Boolean,
  val setupKnown: Boolean = true,
  val providerId: String? = null,
  val providerLabel: String? = null,
) {
  companion object {
    fun unavailable(
      title: String,
      reason: String,
      setupKnown: Boolean = false,
    ): GatewayTalkSetupRow =
      GatewayTalkSetupRow(
        title = title,
        subtitle = reason,
        statusText = "Unavailable",
        ready = false,
        setupKnown = setupKnown,
      )
  }
}

internal fun parseGatewayTalkSetupReadiness(
  catalog: JsonObject?,
  config: JsonObject?,
): GatewayTalkSetupReadiness {
  if (catalog == null) {
    return GatewayTalkSetupReadiness.unavailable()
  }
  val talkConfig = config?.get("talk").asObjectOrNull()
  val realtimeConfig = talkConfig?.get("realtime").asObjectOrNull()
  return GatewayTalkSetupReadiness(
    realtimeTalk =
      parseTalkCatalogGroup(
        catalog = catalog,
        key = "realtime",
        title = "Realtime Talk",
        readySuffix = "via Gateway relay",
        fallbackProviderId = realtimeConfig?.get("provider").asStringOrNull(),
      ),
    dictation =
      parseTalkCatalogGroup(
        catalog = catalog,
        key = "transcription",
        title = "Dictation",
        readySuffix = "via Gateway relay",
      ),
  )
}

private fun parseTalkCatalogGroup(
  catalog: JsonObject,
  key: String,
  title: String,
  readySuffix: String,
  fallbackProviderId: String? = null,
): GatewayTalkSetupRow {
  val group = catalog[key].asObjectOrNull()
    ?: return GatewayTalkSetupRow.unavailable(title = title, reason = "Gateway did not return $title setup.")
  val providers = (group["providers"] as? JsonArray)?.mapNotNull { provider ->
    parseTalkCatalogProvider(groupKey = key, item = provider)
  }.orEmpty()
  if (providers.isEmpty()) {
    return GatewayTalkSetupRow.unavailable(title = title, reason = "No $title provider is registered on the Gateway.", setupKnown = true)
  }

  val preferredProviderId = group["activeProvider"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() }
    ?: fallbackProviderId?.trim()?.takeIf { it.isNotEmpty() }
  for (provider in providers) {
    when (provider.matchIdOrAlias(preferredProviderId)) {
      TalkCatalogProviderMatch.Direct ->
        return if (provider.configured) {
          readyTalkSetupRow(title = title, provider = provider, readySuffix = readySuffix)
        } else {
          needsTalkSetupRow(title = title, provider = provider)
        }
      TalkCatalogProviderMatch.Alias ->
        return if (provider.configured) {
          readyTalkSetupRow(title = title, provider = provider, readySuffix = readySuffix)
        } else {
          gatewayVerifiedTalkSetupRow(title = title, providerId = preferredProviderId ?: provider.id)
        }
      null -> Unit
    }
  }
  if (preferredProviderId != null) {
    // Gateway may report an active provider alias without exposing aliases in the
    // catalog. Do not block startup, but do not claim readiness we cannot prove.
    return gatewayVerifiedTalkSetupRow(title = title, providerId = preferredProviderId)
  }

  val configuredProvider = providers.firstOrNull { it.configured }
  val displayProvider = configuredProvider ?: providers.first()

  return if (configuredProvider != null) {
    readyTalkSetupRow(title = title, provider = configuredProvider, readySuffix = readySuffix)
  } else {
    needsTalkSetupRow(title = title, provider = displayProvider)
  }
}

private fun readyTalkSetupRow(
  title: String,
  provider: TalkCatalogProvider,
  readySuffix: String,
): GatewayTalkSetupRow =
  GatewayTalkSetupRow(
    title = title,
    subtitle = "${provider.label} $readySuffix",
    statusText = "Ready",
    ready = true,
    providerId = provider.id,
    providerLabel = provider.label,
  )

private fun needsTalkSetupRow(
  title: String,
  provider: TalkCatalogProvider,
): GatewayTalkSetupRow =
  GatewayTalkSetupRow(
    title = title,
    subtitle = "Configure ${provider.label} on the Gateway.",
    statusText = "Needs setup",
    ready = false,
    providerId = provider.id,
    providerLabel = provider.label,
  )

private fun gatewayVerifiedTalkSetupRow(
  title: String,
  providerId: String,
): GatewayTalkSetupRow =
  GatewayTalkSetupRow(
    title = title,
    subtitle = "Gateway will verify $providerId when you start.",
    statusText = "Gateway",
    ready = false,
    setupKnown = false,
    providerId = providerId,
  )

private data class TalkCatalogProvider(
  val id: String,
  val label: String,
  val configured: Boolean,
  val aliases: List<String>,
)

private enum class TalkCatalogProviderMatch {
  Direct,
  Alias,
}

private fun TalkCatalogProvider.matchIdOrAlias(providerId: String?): TalkCatalogProviderMatch? {
  val normalized = providerId?.trim()?.takeIf { it.isNotEmpty() } ?: return null
  if (id.equals(normalized, ignoreCase = true)) {
    return TalkCatalogProviderMatch.Direct
  }
  return if (aliases.any { it.equals(normalized, ignoreCase = true) }) {
    TalkCatalogProviderMatch.Alias
  } else {
    null
  }
}

private fun parseTalkCatalogProvider(
  groupKey: String,
  item: JsonElement,
): TalkCatalogProvider? {
  val obj = item.asObjectOrNull() ?: return null
  val id = obj["id"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() } ?: return null
  val label = obj["label"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() } ?: id
  val configured = (obj["configured"] as? JsonPrimitive)?.booleanOrNull == true
  val aliases =
    (obj["aliases"] as? JsonArray)
      ?.mapNotNull { alias -> alias.asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() } }
      .orEmpty()
  return TalkCatalogProvider(
    id = id,
    label = label,
    configured = configured,
    aliases = aliases + bundledCatalogAliases(groupKey = groupKey, providerId = id),
  )
}

private fun bundledCatalogAliases(
  groupKey: String,
  providerId: String,
): List<String> {
  if (groupKey != "transcription") return emptyList()
  // talk.catalog omits provider aliases today, but talk.session.create accepts
  // these bundled transcription ids. Mirror them so setup readiness matches startup.
  return when (providerId.lowercase()) {
    "openai" -> listOf("openai-realtime")
    "deepgram" -> listOf("deepgram-realtime", "nova-3-streaming")
    "mistral" -> listOf("mistral-realtime", "voxtral-realtime")
    "elevenlabs" -> listOf("elevenlabs-realtime", "scribe-v2-realtime")
    "xai" -> listOf("xai-realtime", "grok-stt-streaming")
    else -> emptyList()
  }
}
