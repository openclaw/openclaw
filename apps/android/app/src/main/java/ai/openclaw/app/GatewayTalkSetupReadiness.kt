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
  val providers = (group["providers"] as? JsonArray)?.mapNotNull(::parseTalkCatalogProvider).orEmpty()
  if (providers.isEmpty()) {
    return GatewayTalkSetupRow.unavailable(title = title, reason = "No $title provider is registered on the Gateway.", setupKnown = true)
  }

  val preferredProviderId = group["activeProvider"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() }
    ?: fallbackProviderId?.trim()?.takeIf { it.isNotEmpty() }
  val preferredProvider = providers.firstOrNull { it.id.equals(preferredProviderId, ignoreCase = true) }
  if (preferredProvider != null) {
    return if (preferredProvider.configured) {
      readyTalkSetupRow(title = title, provider = preferredProvider, readySuffix = readySuffix)
    } else {
      needsTalkSetupRow(title = title, provider = preferredProvider)
    }
  }
  if (preferredProviderId != null) {
    // Gateway catalogs expose canonical provider rows but may report an active alias.
    // Keep unmatched ids unknown so the session API remains authoritative.
    return GatewayTalkSetupRow.unavailable(title = title, reason = "Gateway returned $preferredProviderId outside the $title catalog.")
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

private data class TalkCatalogProvider(
  val id: String,
  val label: String,
  val configured: Boolean,
)

private fun parseTalkCatalogProvider(item: JsonElement): TalkCatalogProvider? {
  val obj = item.asObjectOrNull() ?: return null
  val id = obj["id"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() } ?: return null
  val label = obj["label"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() } ?: id
  val configured = (obj["configured"] as? JsonPrimitive)?.booleanOrNull == true
  return TalkCatalogProvider(id = id, label = label, configured = configured)
}
