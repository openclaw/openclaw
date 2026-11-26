package ai.openclaw.app.chat

internal const val SIDEBAR_SESSION_ROSTER_LIMIT = 200
internal const val SIDEBAR_SESSION_PAGE_SIZE = 10
internal const val SIDEBAR_SESSION_SEE_LESS_THRESHOLD = 30

/** Only ranked rows keep their slot. A row retained solely for navigation gets its position from the Gateway. */
internal fun mergeSessionRosterPages(
  existing: List<ChatSessionEntry>,
  page: List<ChatSessionEntry>,
  navigationOnlyKey: String?,
): List<ChatSessionEntry> {
  val merged = existing.associateByTo(linkedMapOf(), ChatSessionEntry::key)
  if (navigationOnlyKey != null) merged.remove(navigationOnlyKey)
  page.forEach { merged[it.key] = it }
  return merged.values.toList()
}
