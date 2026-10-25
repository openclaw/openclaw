package ai.openclaw.app.chat

internal const val SIDEBAR_SESSION_ROSTER_LIMIT = 200
internal const val SIDEBAR_SESSION_PAGE_SIZE = 10
internal const val SIDEBAR_SESSION_SEE_LESS_THRESHOLD = 30

/** Updating an existing key keeps its slot; new rows follow in Gateway order. */
internal fun mergeSessionRosterPages(
  existing: List<ChatSessionEntry>,
  page: List<ChatSessionEntry>,
): List<ChatSessionEntry> {
  val merged = existing.associateByTo(linkedMapOf(), ChatSessionEntry::key)
  page.forEach { merged[it.key] = it }
  return merged.values.toList()
}
