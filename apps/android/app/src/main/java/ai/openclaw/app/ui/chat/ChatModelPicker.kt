package ai.openclaw.app.ui.chat

import ai.openclaw.app.GatewayModelSummary
import ai.openclaw.app.GatewayModelUnavailableReason
import ai.openclaw.app.i18n.NativeText
import ai.openclaw.app.i18n.nativeText
import ai.openclaw.app.providerDisplayName
import java.util.Locale

internal class ChatModelSearch(
  private val models: List<GatewayModelSummary>,
) {
  private class Entry(
    val model: GatewayModelSummary,
  ) {
    val ref = model.providerQualifiedRef()
    val fields = listOf(model.name, model.id, ref, model.provider, providerDisplayName(model.provider)).map(::normalizeModelSearch)
    val words = fields.flatMap { it.split(' ') }.filter { it.isNotEmpty() }.distinct()
  }

  private data class Match(
    val entry: Entry,
    val tier: Int,
    val cost: Int,
  )

  private val entries = models.map(::Entry)

  fun search(query: String): List<GatewayModelSummary> {
    if (query.isBlank()) return models
    val normalized = normalizeModelSearch(query)
    if (normalized.isEmpty()) return emptyList()
    val terms = normalized.split(' ').distinct()
    return entries
      .mapNotNull { entry ->
        if (normalized in entry.fields) return@mapNotNull Match(entry, 0, 0)
        var fuzzyTerms = 0
        var cost = 0
        for (term in terms) {
          when {
            term in entry.words -> Unit
            entry.words.any { it.startsWith(term) } -> cost += 1
            entry.words.any { it.contains(term) } -> cost += 2
            term.length >= 4 && term.all(Char::isLetter) && entry.words.any { oneModelSearchTypo(term, it) } -> fuzzyTerms += 1
            else -> return@mapNotNull null
          }
        }
        Match(entry, if (fuzzyTerms == 0) 1 else 2, fuzzyTerms * terms.size * 2 + cost)
      }.sortedWith(compareBy<Match>({ it.tier }, { it.cost }, { it.entry.fields.first() }, { it.entry.ref }))
      .map { it.entry.model }
  }
}

private val modelSearchSeparators = Regex("[^\\p{L}\\p{N}.]+")

private fun normalizeModelSearch(value: String): String = value.lowercase(Locale.ROOT).replace(modelSearchSeparators, " ").trim()

// One edit or adjacent transposition; short terms and version numbers stay literal.
private fun oneModelSearchTypo(
  query: String,
  word: String,
): Boolean {
  if (kotlin.math.abs(query.length - word.length) > 1 || !word.all(Char::isLetter)) return false
  val commonLength = minOf(query.length, word.length)
  var index = 0
  while (index < commonLength && query[index] == word[index]) index++
  if (index == commonLength) return true
  return when {
    query.length > word.length -> {
      query.regionMatches(index + 1, word, index, word.length - index)
    }

    query.length < word.length -> {
      query.regionMatches(index, word, index + 1, query.length - index)
    }

    query.regionMatches(index + 1, word, index + 1, query.length - index - 1) -> {
      true
    }

    else -> {
      index + 1 < commonLength && query[index] == word[index + 1] && query[index + 1] == word[index] &&
        query.regionMatches(index + 2, word, index + 2, query.length - index - 2)
    }
  }
}

internal enum class ChatModelPickerAction {
  Select,
  OpenProviders,
  Disabled,
}

internal fun GatewayModelSummary.providerQualifiedRef(): String {
  val trimmedProvider = provider.trim()
  if (trimmedProvider.isEmpty()) return id
  val providerPrefix = "$trimmedProvider/"
  return if (id.startsWith(providerPrefix)) id else "$providerPrefix$id"
}

internal fun thinkingSupportedForSelection(
  selectedModelRef: String?,
  catalog: List<GatewayModelSummary>,
): Boolean {
  val selected = selectedModelRef ?: return false
  return catalog.firstOrNull { it.providerQualifiedRef() == selected }?.thinkingLevels?.any { it.id != "off" } == true
}

internal fun fastModeRequestSupportedForSelection(
  selectedModelRef: String?,
  sessionModelProvider: String?,
  catalog: List<GatewayModelSummary>,
): Boolean {
  val selected = selectedModelRef?.trim() ?: return false
  val qualified = catalog.filter { it.providerQualifiedRef().equals(selected, ignoreCase = true) }
  val matches =
    qualified.ifEmpty {
      catalog.filter { it.id == selected && it.provider == sessionModelProvider }
    }
  return matches.isNotEmpty() && matches.all { it.supportsFastMode == true }
}

internal fun fastModeSupportedForSelection(
  requestSupported: Boolean,
  hasConfiguredFastModeOverride: Boolean,
): Boolean = requestSupported || hasConfiguredFastModeOverride

internal fun selectedChatModelUnavailableReason(
  selectedModelRef: String?,
  catalog: List<GatewayModelSummary>,
): GatewayModelUnavailableReason? {
  val selected = selectedModelRef?.trim()?.takeIf { it.isNotEmpty() } ?: return null
  val matches = catalog.filter { it.providerQualifiedRef().equals(selected, ignoreCase = true) }
  if (matches.isEmpty() || matches.any { it.available != false || it.unavailableReason == null }) return null
  if (matches.any { it.unavailableReason == GatewayModelUnavailableReason.Cooldown }) {
    return GatewayModelUnavailableReason.Cooldown
  }
  return if (matches.any { it.unavailableReason == GatewayModelUnavailableReason.AuthFailed }) {
    GatewayModelUnavailableReason.AuthFailed
  } else {
    GatewayModelUnavailableReason.MissingAuth
  }
}

internal fun selectedChatModelSendUnavailableReason(
  selectedModelRef: String?,
  catalog: List<GatewayModelSummary>,
): GatewayModelUnavailableReason? =
  selectedChatModelUnavailableReason(selectedModelRef, catalog).takeIf {
    it == GatewayModelUnavailableReason.MissingAuth || it == GatewayModelUnavailableReason.AuthFailed
  }

internal fun selectedChatModelSendBlockingReason(
  gatewayReady: Boolean,
  selectedModelRef: String?,
  catalog: List<GatewayModelSummary>,
): GatewayModelUnavailableReason? = if (gatewayReady) selectedChatModelSendUnavailableReason(selectedModelRef, catalog) else null

internal fun chatModelSendBlocked(
  gatewayReady: Boolean,
  selectedModelRef: String?,
  catalog: List<GatewayModelSummary>,
): Boolean = selectedChatModelSendBlockingReason(gatewayReady, selectedModelRef, catalog) != null

internal fun chatModelPickerAction(model: GatewayModelSummary): ChatModelPickerAction =
  when {
    model.manualSelectionAllowed == false -> ChatModelPickerAction.Disabled

    model.available != false -> ChatModelPickerAction.Select

    model.unavailableReason == GatewayModelUnavailableReason.MissingAuth ||
      model.unavailableReason == GatewayModelUnavailableReason.AuthFailed -> ChatModelPickerAction.OpenProviders

    else -> ChatModelPickerAction.Disabled
  }

internal fun chatModelUnavailableText(reason: GatewayModelUnavailableReason?): NativeText? =
  when (reason) {
    GatewayModelUnavailableReason.MissingAuth,
    GatewayModelUnavailableReason.AuthFailed,
    -> nativeText("Authentication needed")

    else -> null
  }

internal fun chatModelPickerChoices(
  catalog: List<GatewayModelSummary>,
  favorites: List<String>,
  recents: List<String>,
): List<GatewayModelSummary> {
  val choices = catalog.filter { it.manualSelectionAllowed != false }
  val modelsByRef = choices.associateBy { it.providerQualifiedRef() }
  val includedRefs = mutableSetOf<String>()
  return buildList {
    for (ref in favorites + recents) {
      val model = modelsByRef[ref] ?: continue
      if (includedRefs.add(ref)) add(model)
    }
    addAll(choices.filter { includedRefs.add(it.providerQualifiedRef()) })
  }
}
