package ai.openclaw.app

import ai.openclaw.app.node.asObjectOrNull
import ai.openclaw.app.node.asStringOrNull
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull

data class GatewayTalkSetupReadiness(
  val realtimeTalk: GatewayTalkSetupState,
  val dictation: GatewayTalkSetupState,
) {
  companion object {
    fun unverified(reason: String = "Gateway talk catalog not loaded"): GatewayTalkSetupReadiness =
      GatewayTalkSetupReadiness(
        realtimeTalk = GatewayTalkSetupState.Unverified(reason),
        dictation = GatewayTalkSetupState.Unverified(reason),
      )
  }
}

sealed interface GatewayTalkSetupState {
  data class Ready(
    val provider: GatewayTalkProvider,
  ) : GatewayTalkSetupState

  data class NeedsSetup(
    val reason: String,
    val provider: GatewayTalkProvider? = null,
  ) : GatewayTalkSetupState

  /** Catalog failures must not disable a startup path that the Gateway still validates. */
  data class Unverified(
    val reason: String,
  ) : GatewayTalkSetupState
}

data class GatewayTalkProvider(
  val id: String,
  val label: String,
)

val GatewayTalkSetupState.isReady: Boolean
  get() = this is GatewayTalkSetupState.Ready

val GatewayTalkSetupState.requiresSetup: Boolean
  get() = this is GatewayTalkSetupState.NeedsSetup

fun GatewayTalkSetupState.statusText(): String =
  when (this) {
    is GatewayTalkSetupState.Ready -> "Ready"
    is GatewayTalkSetupState.NeedsSetup -> "Needs setup"
    is GatewayTalkSetupState.Unverified -> "Unverified"
  }

fun GatewayTalkSetupState.description(): String =
  when (this) {
    is GatewayTalkSetupState.Ready -> "${provider.label} via Gateway relay"
    is GatewayTalkSetupState.NeedsSetup -> reason
    is GatewayTalkSetupState.Unverified -> reason
  }

internal fun parseGatewayTalkSetupReadiness(catalog: JsonObject?): GatewayTalkSetupReadiness {
  if (catalog == null) return GatewayTalkSetupReadiness.unverified()
  return GatewayTalkSetupReadiness(
    realtimeTalk = parseTalkCatalogGroup(catalog = catalog, key = "realtime", title = "Realtime Talk"),
    dictation = parseTalkCatalogGroup(catalog = catalog, key = "transcription", title = "Dictation"),
  )
}

private fun parseTalkCatalogGroup(
  catalog: JsonObject,
  key: String,
  title: String,
): GatewayTalkSetupState {
  val group =
    catalog[key].asObjectOrNull()
      ?: return GatewayTalkSetupState.Unverified("Gateway did not return $title setup")
  val providers =
    (group["providers"] as? JsonArray)
      ?.mapNotNull(::parseTalkCatalogProvider)
      .orEmpty()
  val activeProviderId = group["activeProvider"].asStringOrNull()?.trim()?.takeIf(String::isNotEmpty)
  if (providers.isEmpty()) {
    return if (activeProviderId == null) {
      GatewayTalkSetupState.NeedsSetup("No $title provider is registered on the Gateway")
    } else {
      GatewayTalkSetupState.Unverified("Gateway selected unknown provider $activeProviderId")
    }
  }

  if (activeProviderId == null) {
    // Older Gateways can omit the selected provider and report alias-backed rows as unconfigured
    // even though session startup resolves them. Only an explicit selection is authoritative.
    return GatewayTalkSetupState.Unverified("Gateway did not identify the active $title provider")
  }
  val selected =
    // Match Gateway registry precedence: canonical ids win before alias fallback.
    providers.firstOrNull { it.matchesId(activeProviderId) }
      ?: providers.firstOrNull { it.matchesAlias(activeProviderId) }
      ?: return GatewayTalkSetupState.Unverified("Gateway selected unknown provider $activeProviderId")
  val provider = GatewayTalkProvider(id = selected.id, label = selected.label)
  return if (selected.configured) {
    GatewayTalkSetupState.Ready(provider)
  } else {
    GatewayTalkSetupState.NeedsSetup(
      reason = "Configure ${selected.label} on the Gateway",
      provider = provider,
    )
  }
}

private data class TalkCatalogProvider(
  val id: String,
  val label: String,
  val configured: Boolean,
  val aliases: List<String>,
) {
  fun matchesId(candidate: String): Boolean = id.equals(candidate, ignoreCase = true)

  fun matchesAlias(candidate: String): Boolean = aliases.any { it.equals(candidate, ignoreCase = true) }
}

private fun parseTalkCatalogProvider(item: JsonElement): TalkCatalogProvider? {
  val value = item.asObjectOrNull() ?: return null
  val id = value["id"].asStringOrNull()?.trim()?.takeIf(String::isNotEmpty) ?: return null
  val label = value["label"].asStringOrNull()?.trim()?.takeIf(String::isNotEmpty) ?: id
  val aliases =
    (value["aliases"] as? JsonArray)
      ?.mapNotNull { it.asStringOrNull()?.trim()?.takeIf(String::isNotEmpty) }
      .orEmpty()
  return TalkCatalogProvider(
    id = id,
    label = label,
    configured = (value["configured"] as? JsonPrimitive)?.booleanOrNull == true,
    aliases = aliases,
  )
}
