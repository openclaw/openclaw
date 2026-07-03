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
    fun unverified(
      issue: GatewayTalkSetupIssue = GatewayTalkSetupIssue.CatalogNotLoaded,
    ): GatewayTalkSetupReadiness =
      GatewayTalkSetupReadiness(
        realtimeTalk = GatewayTalkSetupState.Unverified(issue),
        dictation = GatewayTalkSetupState.Unverified(issue),
      )
  }
}

sealed interface GatewayTalkSetupState {
  data class Ready(
    val provider: GatewayTalkProvider,
  ) : GatewayTalkSetupState

  data class NeedsSetup(
    val issue: GatewayTalkSetupIssue,
    val provider: GatewayTalkProvider? = null,
  ) : GatewayTalkSetupState

  /** Catalog failures must not disable a startup path that the Gateway still validates. */
  data class Unverified(
    val issue: GatewayTalkSetupIssue,
  ) : GatewayTalkSetupState
}

enum class GatewayTalkSetupTarget(
  val title: String,
) {
  REALTIME_TALK("Realtime Talk"),
  DICTATION("Dictation"),
}

sealed interface GatewayTalkSetupIssue {
  data object CatalogNotLoaded : GatewayTalkSetupIssue

  data object CatalogLoadFailed : GatewayTalkSetupIssue

  data class GroupMissing(
    val target: GatewayTalkSetupTarget,
  ) : GatewayTalkSetupIssue

  data class NoProvider(
    val target: GatewayTalkSetupTarget,
  ) : GatewayTalkSetupIssue

  data class UnknownProvider(
    val target: GatewayTalkSetupTarget,
    val providerId: String,
  ) : GatewayTalkSetupIssue

  data class MissingReadiness(
    val target: GatewayTalkSetupTarget,
  ) : GatewayTalkSetupIssue

  data class ConfigureProvider(
    val target: GatewayTalkSetupTarget,
  ) : GatewayTalkSetupIssue

  data class MissingActiveProvider(
    val target: GatewayTalkSetupTarget,
  ) : GatewayTalkSetupIssue

  data class UnsupportedProvider(
    val target: GatewayTalkSetupTarget,
  ) : GatewayTalkSetupIssue

  data class ConfigureSelectedProvider(
    val providerLabel: String,
  ) : GatewayTalkSetupIssue
}

data class GatewayTalkProvider(
  val id: String,
  val label: String,
)

val GatewayTalkSetupState.isReady: Boolean
  get() = this is GatewayTalkSetupState.Ready

val GatewayTalkSetupState.requiresSetup: Boolean
  get() = this is GatewayTalkSetupState.NeedsSetup

fun gatewayTalkSetupStatusText(state: GatewayTalkSetupState): String =
  when (state) {
    is GatewayTalkSetupState.Ready -> "Ready"
    is GatewayTalkSetupState.NeedsSetup -> "Needs setup"
    is GatewayTalkSetupState.Unverified -> "Unverified"
  }

fun gatewayTalkSetupDescription(state: GatewayTalkSetupState): String =
  when (state) {
    is GatewayTalkSetupState.Ready -> "${state.provider.label} via Gateway relay"
    is GatewayTalkSetupState.NeedsSetup -> gatewayTalkSetupIssueDescription(state.issue)
    is GatewayTalkSetupState.Unverified -> gatewayTalkSetupIssueDescription(state.issue)
  }

private fun gatewayTalkSetupIssueDescription(issue: GatewayTalkSetupIssue): String =
  when (issue) {
    GatewayTalkSetupIssue.CatalogNotLoaded -> "Gateway talk catalog not loaded"
    GatewayTalkSetupIssue.CatalogLoadFailed -> "Could not load Gateway talk catalog"
    is GatewayTalkSetupIssue.GroupMissing -> "Gateway did not return ${issue.target.title} setup"
    is GatewayTalkSetupIssue.NoProvider -> "No ${issue.target.title} provider is configured on the Gateway"
    is GatewayTalkSetupIssue.UnknownProvider -> "Gateway selected unknown provider ${issue.providerId}"
    is GatewayTalkSetupIssue.MissingReadiness -> "Gateway did not return ${issue.target.title} readiness"
    is GatewayTalkSetupIssue.ConfigureProvider -> "Configure a ${issue.target.title} provider on the Gateway"
    is GatewayTalkSetupIssue.MissingActiveProvider ->
      "Gateway did not identify the active ${issue.target.title} provider"
    is GatewayTalkSetupIssue.UnsupportedProvider ->
      "Choose a supported ${issue.target.title} provider on the Gateway"
    is GatewayTalkSetupIssue.ConfigureSelectedProvider -> "Configure ${issue.providerLabel} on the Gateway"
  }

internal fun parseGatewayTalkSetupReadiness(catalog: JsonObject?): GatewayTalkSetupReadiness {
  if (catalog == null) return GatewayTalkSetupReadiness.unverified()
  return GatewayTalkSetupReadiness(
    realtimeTalk =
      parseTalkCatalogGroup(catalog = catalog, key = "realtime", target = GatewayTalkSetupTarget.REALTIME_TALK),
    dictation =
      parseTalkCatalogGroup(catalog = catalog, key = "transcription", target = GatewayTalkSetupTarget.DICTATION),
  )
}

private fun parseTalkCatalogGroup(
  catalog: JsonObject,
  key: String,
  target: GatewayTalkSetupTarget,
): GatewayTalkSetupState {
  val group =
    catalog[key].asObjectOrNull()
      ?: return GatewayTalkSetupState.Unverified(GatewayTalkSetupIssue.GroupMissing(target))
  val providers =
    (group["providers"] as? JsonArray)
      ?.mapNotNull(::parseTalkCatalogProvider)
      .orEmpty()
  val ready = (group["ready"] as? JsonPrimitive)?.booleanOrNull
  val activeProviderId = group["activeProvider"].asStringOrNull()?.trim()?.takeIf(String::isNotEmpty)
  if (providers.isEmpty()) {
    return when {
      ready == false -> GatewayTalkSetupState.NeedsSetup(GatewayTalkSetupIssue.NoProvider(target))
      activeProviderId != null ->
        GatewayTalkSetupState.Unverified(GatewayTalkSetupIssue.UnknownProvider(target, activeProviderId))
      else -> GatewayTalkSetupState.Unverified(GatewayTalkSetupIssue.MissingReadiness(target))
    }
  }

  if (activeProviderId == null) {
    if (ready == false) {
      return GatewayTalkSetupState.NeedsSetup(GatewayTalkSetupIssue.ConfigureProvider(target))
    }
    // Older Gateways can omit the selected provider and report alias-backed rows as unconfigured
    // even though session startup resolves them. Only an explicit readiness result is authoritative.
    return GatewayTalkSetupState.Unverified(GatewayTalkSetupIssue.MissingActiveProvider(target))
  }
  val selected =
    // Match Gateway registry precedence: canonical ids win before alias fallback.
    providers.firstOrNull { it.matchesId(activeProviderId) }
      ?: providers.firstOrNull { it.matchesAlias(activeProviderId) }
      ?: return if (ready == false) {
        GatewayTalkSetupState.NeedsSetup(GatewayTalkSetupIssue.UnsupportedProvider(target))
      } else {
        GatewayTalkSetupState.Unverified(GatewayTalkSetupIssue.UnknownProvider(target, activeProviderId))
      }
  val provider = GatewayTalkProvider(id = selected.id, label = selected.label)
  return when (ready) {
    true -> GatewayTalkSetupState.Ready(provider)
    false ->
      GatewayTalkSetupState.NeedsSetup(
        issue = GatewayTalkSetupIssue.ConfigureSelectedProvider(selected.label),
        provider = provider,
      )
    null -> GatewayTalkSetupState.Unverified(GatewayTalkSetupIssue.MissingReadiness(target))
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
