package ai.openclaw.app.chat

import ai.openclaw.app.node.asArrayOrNull
import ai.openclaw.app.node.asObjectOrNull
import ai.openclaw.app.node.asStringOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject

internal data class SessionGroupCatalogSnapshot(
  val names: List<String> = emptyList(),
  val sectionOrder: List<String> = emptyList(),
)

internal fun parseSessionGroupCatalog(payload: String): SessionGroupCatalogSnapshot? {
  val root = Json.parseToJsonElement(payload).asObjectOrNull() ?: return null
  val groups = root["groups"].asArrayOrNull() ?: return null
  val names =
    groups
      .mapNotNull { it.asObjectOrNull() }
      .sortedBy { it["position"]?.asStringOrNull()?.toIntOrNull() ?: Int.MAX_VALUE }
      .mapNotNull { it["name"].asStringOrNull()?.trim()?.takeIf(String::isNotEmpty) }
      .distinct()
  return SessionGroupCatalogSnapshot(names, parseSessionSectionOrder(root))
}

private val sidebarBuiltInSections = listOf("ungrouped", "groups", "work")

private fun parseSessionSectionOrder(root: JsonObject): List<String> =
  root["sectionOrder"]
    .asArrayOrNull()
    .orEmpty()
    .mapNotNull { it.asStringOrNull()?.let(::sidebarSectionToken) }
    .distinct()

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
