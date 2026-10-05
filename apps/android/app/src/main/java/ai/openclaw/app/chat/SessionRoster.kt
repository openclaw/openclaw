package ai.openclaw.app.chat

/**
 * Same page the Control UI sidebar requests (`SIDEBAR_SESSION_ROSTER_LIMIT`).
 * A shorter Android refresh was replacing the drawer, so folder and group
 * members past that window never arrived.
 */
internal const val SIDEBAR_SESSION_ROSTER_LIMIT = 200

/** Rows revealed per section before Show more, matching `SIDEBAR_SESSION_PAGE_SIZE`. */
internal const val SIDEBAR_SESSION_PAGE_SIZE = 10

/** Show less appears once a section is past this many revealed rows, matching web. */
internal const val SIDEBAR_SESSION_SEE_LESS_THRESHOLD = 30

internal data class SessionRosterPageInfo(
  val hasMore: Boolean,
  val nextOffset: Int?,
)

/**
 * Gateway `hasMore` wins. A missing flag falls back to `totalCount` so a page
 * that omitted the boolean still offers Load more instead of a silent cap.
 */
internal fun sessionRosterPageInfo(
  hasMore: Boolean?,
  totalCount: Long?,
  nextOffset: Int?,
  requestedOffset: Int,
  pageSize: Int,
): SessionRosterPageInfo {
  val loadedEnd = requestedOffset + pageSize
  val more = hasMore ?: (totalCount != null && totalCount > loadedEnd.toLong())
  if (!more || pageSize <= 0) return SessionRosterPageInfo(hasMore = false, nextOffset = null)
  val cursor = nextOffset ?: loadedEnd
  if (cursor <= requestedOffset) return SessionRosterPageInfo(hasMore = false, nextOffset = null)
  return SessionRosterPageInfo(hasMore = true, nextOffset = cursor)
}

/**
 * Appends a later `sessions.list` page onto the roster. Keys already on screen
 * take the newer row in place; new keys stay in gateway order after them.
 */
internal fun mergeSessionRosterPages(
  existing: List<ChatSessionEntry>,
  page: List<ChatSessionEntry>,
): List<ChatSessionEntry> {
  if (existing.isEmpty()) return page
  if (page.isEmpty()) return existing
  val pageByKey = page.associateBy(ChatSessionEntry::key)
  val seen = LinkedHashSet<String>()
  val merged = ArrayList<ChatSessionEntry>(existing.size + page.size)
  for (row in existing) {
    if (seen.add(row.key)) merged.add(pageByKey[row.key] ?: row)
  }
  for (row in page) {
    if (seen.add(row.key)) merged.add(row)
  }
  return merged
}
