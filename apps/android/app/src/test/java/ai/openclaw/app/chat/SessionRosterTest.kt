package ai.openclaw.app.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionRosterTest {
  @Test
  fun laterPageKeepsEarlierRowsAndRefreshesOverlaps() {
    val first = listOf(row("a", "One"), row("b", "Two"))
    val second = listOf(row("b", "Two renamed"), row("c", "Three"))

    val merged = mergeSessionRosterPages(first, second)

    assertEquals(listOf("a", "b", "c"), merged.map { it.key })
    assertEquals("Two renamed", merged[1].label)
  }

  @Test
  fun missingHasMoreUsesTotalCountInsteadOfStoppingEarly() {
    val page =
      sessionRosterPageInfo(
        hasMore = null,
        totalCount = 140,
        nextOffset = null,
        requestedOffset = 0,
        pageSize = 100,
      )

    assertTrue(page.hasMore)
    assertEquals(100, page.nextOffset)
  }

  @Test
  fun explicitEndClearsTheCursorEvenWhenTotalLooksLarger() {
    val page =
      sessionRosterPageInfo(
        hasMore = false,
        totalCount = 140,
        nextOffset = 100,
        requestedOffset = 0,
        pageSize = 100,
      )

    assertFalse(page.hasMore)
    assertNull(page.nextOffset)
  }

  @Test
  fun stalledCursorDoesNotLookLikeAnotherPage() {
    val page =
      sessionRosterPageInfo(
        hasMore = true,
        totalCount = 50,
        nextOffset = 20,
        requestedOffset = 20,
        pageSize = 20,
      )

    assertFalse(page.hasMore)
    assertNull(page.nextOffset)
  }

  private fun row(
    key: String,
    label: String,
  ) = ChatSessionEntry(key = key, updatedAtMs = 1, label = label)
}
