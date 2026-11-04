package ai.openclaw.app.chat

import ai.openclaw.app.gateway.GatewayRequestRejected
import ai.openclaw.app.node.asArrayOrNull
import ai.openclaw.app.node.asObjectOrNull
import ai.openclaw.app.node.asStringOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

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

/** Reapply one relative move, never a stale replacement list, after a catalog conflict. */
internal fun reorderSessionSection(
  current: SessionGroupCatalogSnapshot,
  section: String,
  anchor: String,
  before: Boolean,
): SessionGroupCatalogSnapshot? {
  val catalogs = (current.sectionOrder + listOf(section, anchor)).filter { it.startsWith("catalog:") }.map { it.removePrefix("catalog:") }
  val order = normalizeSidebarSectionOrder(current.sectionOrder, current.names, catalogs).toMutableList()
  if (section == anchor || section !in order || anchor !in order) return null
  order.remove(section)
  order.add(order.indexOf(anchor) + if (before) 0 else 1, section)
  val names = order.filter { it.startsWith("category:") }.map { it.removePrefix("category:") }
  return SessionGroupCatalogSnapshot(if (section.startsWith("category:")) names else current.names, order)
}

/** Only a definitive catalog conflict may replay this intent; denial/unknown outcomes escape. */
internal suspend fun reorderSharedSessionSection(
  section: String,
  anchor: String,
  before: Boolean,
  request: suspend (String, String) -> String,
) {
  repeat(3) { attempt ->
    val current =
      parseSessionGroupCatalog(request("sessions.groups.list", "{}"))
        ?: error("Invalid Gateway folder catalog")
    val next =
      reorderSessionSection(current, section, anchor, before)
        ?: error("The section no longer exists. Reload and try again.")
    try {
      request(
        "sessions.groups.put",
        buildJsonObject {
          put("names", JsonArray(next.names.map(::JsonPrimitive)))
          put("sectionOrder", JsonArray(next.sectionOrder.map(::JsonPrimitive)))
          put(
            "expected",
            buildJsonObject {
              put("names", JsonArray(current.names.map(::JsonPrimitive)))
              put("sectionOrder", JsonArray(current.sectionOrder.map(::JsonPrimitive)))
            },
          )
        }.toString(),
      )
      return
    } catch (error: GatewayRequestRejected) {
      if (error.gatewayError.details?.code != "SESSION_GROUP_CATALOG_CHANGED") throw error
      if (attempt == 2) throw IllegalStateException("Folders changed repeatedly. Reload and try again.", error)
    }
  }
}
