package ai.openclaw.app.chat

import ai.openclaw.app.node.asArrayOrNull
import ai.openclaw.app.node.asObjectOrNull
import ai.openclaw.app.node.asStringOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlin.math.sign

/** One gateway session-group catalog entry (`sessions.groups.*`). */
internal data class GatewaySessionGroup(
  val name: String,
  val position: Int,
)

private val sessionGroupsJson = Json { ignoreUnknownKeys = true }

/**
 * Parses a `sessions.groups.list` / mutation payload.
 * Null when `groups` is absent so a partial error body cannot wipe the catalog cache.
 */
internal data class SessionGroupCatalogSnapshot(
  val groups: List<GatewaySessionGroup>,
  val sectionOrder: List<String>,
)

internal fun parseSessionGroupCatalog(payload: String): SessionGroupCatalogSnapshot? {
  val groups = parseSessionGroupsPayload(payload) ?: return null
  return SessionGroupCatalogSnapshot(groups = groups, sectionOrder = parseSessionSectionOrder(payload))
}

internal fun parseSessionGroupsPayload(payload: String): List<GatewaySessionGroup>? {
  val root =
    runCatching { sessionGroupsJson.parseToJsonElement(payload).asObjectOrNull() }.getOrNull()
      ?: return null
  val groups = root["groups"].asArrayOrNull() ?: return null
  return groups
    .mapIndexedNotNull { index, element ->
      val record = element.asObjectOrNull() ?: return@mapIndexedNotNull null
      val name = record["name"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() } ?: return@mapIndexedNotNull null
      val position = (record["position"] as? JsonPrimitive)?.contentOrNull?.toIntOrNull() ?: index
      GatewaySessionGroup(name = name, position = position)
    }.sortedWith(compareBy<GatewaySessionGroup> { it.position }.thenBy { it.name })
}

/**
 * One-shot move of device-local folder names into an empty gateway catalog.
 * A live catalog cached from another gateway is not legacy input.
 * `canPut` is false when the gateway advertises methods and omits `sessions.groups.put`.
 */
internal data class SessionGroupMigrationDecision(
  val putLegacy: Boolean,
  val consumeLegacy: Boolean,
  val markMigrated: Boolean,
)

internal fun decideSessionGroupMigration(
  listedNames: List<String>,
  legacyNames: List<String>,
  alreadyMigrated: Boolean,
  canPut: Boolean,
): SessionGroupMigrationDecision {
  val listedCount = listedNames.count { it.isNotBlank() }
  val legacyCount = legacyNames.count { it.isNotBlank() }
  val putLegacy = canPut && !alreadyMigrated && listedCount == 0 && legacyCount > 0
  val consumeLegacy = canPut && legacyCount > 0 && (putLegacy || listedCount > 0)
  val markMigrated = alreadyMigrated || listedCount > 0 || legacyCount == 0 || putLegacy
  return SessionGroupMigrationDecision(
    putLegacy = putLegacy,
    consumeLegacy = consumeLegacy,
    markMigrated = markMigrated,
  )
}

/** Catalog order, then names not already present. Blank names are dropped. */
internal fun unionSessionGroupNames(
  existing: List<String>,
  extra: List<String>,
): List<String> {
  val names = mutableListOf<String>()
  for (name in existing + extra) {
    val trimmed = name.trim()
    if (trimmed.isNotEmpty() && trimmed !in names) names.add(trimmed)
  }
  return names
}

private val sidebarBuiltInSections = listOf("ungrouped", "groups", "work")

/** Tokens from a groups payload. Missing or invalid entries are dropped, not invented. */
internal fun parseSessionSectionOrder(payload: String): List<String> {
  val root = runCatching { sessionGroupsJson.parseToJsonElement(payload).asObjectOrNull() }.getOrNull() ?: return emptyList()
  val raw = root["sectionOrder"].asArrayOrNull() ?: return emptyList()
  val tokens = mutableListOf<String>()
  for (element in raw) {
    val token = sidebarSectionToken(element.asStringOrNull() ?: continue) ?: continue
    if (token !in tokens) tokens.add(token)
  }
  return tokens
}

/**
 * Same section order as web `normalizeSessionSectionOrder` / Mac `orderedSections`.
 * Custom folders keep gateway order. Missing folders are inserted before the first
 * built-in. Unseen provider catalogs are inserted after `work`. Empty `work` is a
 * token only; the sidebar hides it when there are no coding rows.
 */
internal fun normalizeSidebarSectionOrder(
  stored: List<String>,
  knownGroups: List<String>,
  catalogIds: List<String>,
): List<String> {
  val groups = knownGroups.map { it.trim() }.filter { it.isNotEmpty() }.distinct()
  val groupSet = groups.toSet()
  val catalogs = catalogIds.map { it.trim() }.filter { it.isNotEmpty() }.distinct()
  val catalogSet = catalogs.toSet()
  val order = mutableListOf<String>()
  for (entry in stored) {
    val token = sidebarSectionToken(entry) ?: continue
    if (token.startsWith("category:") && token.removePrefix("category:") !in groupSet) continue
    if (token.startsWith("catalog:") && token.removePrefix("catalog:") !in catalogSet) continue
    if (token !in order) order.add(token)
  }
  for (group in groups) {
    val token = "category:$group"
    if (token in order) continue
    val firstBuiltIn = order.indexOfFirst { it in sidebarBuiltInSections }
    order.add(if (firstBuiltIn < 0) order.size else firstBuiltIn, token)
  }
  sidebarBuiltInSections.forEachIndexed { index, sectionId ->
    if (sectionId in order) return@forEachIndexed
    if (index == 0) {
      order.add(sectionId)
    } else {
      order.add(order.indexOf(sidebarBuiltInSections[index - 1]) + 1, sectionId)
    }
  }
  val unseen = catalogs.map { "catalog:$it" }.filter { it !in order }
  val workIndex = order.indexOf("work")
  order.addAll(if (workIndex < 0) order.size else workIndex + 1, unseen)
  return order
}

private fun sidebarSectionToken(raw: String): String? {
  val trimmed = raw.trim()
  if (trimmed.isEmpty()) return null
  for (prefix in listOf("catalog:", "category:")) {
    if (!trimmed.startsWith(prefix)) continue
    val name = trimmed.removePrefix(prefix).trim()
    return if (name.isEmpty()) null else prefix + name
  }
  return trimmed.takeIf { it in sidebarBuiltInSections }
}

/**
 * Web `moveArrayEntry`: move [source] before or after [target] and keep every
 * other token, including hidden `work`, so the phone writes the same
 * `sectionOrder` the computer already displays.
 */
internal fun moveSidebarSection(
  order: List<String>,
  source: String,
  target: String,
  after: Boolean,
): List<String> {
  if (source == target) return order
  val ordered = order.toMutableList()
  val sourceIndex = ordered.indexOf(source)
  val targetIndex = ordered.indexOf(target)
  if (sourceIndex < 0 || targetIndex < 0) return order
  val moved = ordered.removeAt(sourceIndex)
  val insertion = ordered.indexOf(target) + if (after) 1 else 0
  ordered.add(insertion, moved)
  return ordered
}

/**
 * One step along the sections the sidebar actually shows. Hidden tokens stay
 * put, so a folder moves onto its visible neighbor instead of landing inside
 * Groups or under a provider catalog by skipping a row the phone does not draw.
 */
internal fun moveSidebarSectionByDirection(
  order: List<String>,
  visibleTokens: List<String>,
  source: String,
  direction: Int,
): List<String>? {
  if (direction == 0) return null
  val visible = visibleTokens.filter { it in order }.distinct()
  val index = visible.indexOf(source)
  if (index < 0) return null
  val target = visible.getOrNull(index + direction.sign) ?: return null
  val next = moveSidebarSection(order, source, target, after = direction > 0)
  return next.takeIf { it != order }
}

/** Category names in shared section order. Built-ins and catalogs are not names. */
internal fun sidebarCategoryNames(order: List<String>): List<String> {
  val names = mutableListOf<String>()
  for (token in order) {
    if (!token.startsWith("category:")) continue
    val name = token.removePrefix("category:").trim()
    if (name.isNotEmpty() && name !in names) names.add(name)
  }
  return names
}
