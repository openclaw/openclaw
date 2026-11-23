package ai.openclaw.app.ui

import ai.openclaw.app.chat.ChatSessionEntry
import org.junit.Assert.assertEquals
import org.junit.Test

class PersonalSessionPinOrderTest {
  // Wire order is the person's choice, deliberately different from both activity and key order.
  private val rows =
    listOf(
      ChatSessionEntry("z-first", 1, pinned = true),
      ChatSessionEntry("a-second", 20, pinned = true),
      ChatSessionEntry("sleeping", 100, pinned = true, snoozedUntil = 200),
      ChatSessionEntry("old", 2),
      ChatSessionEntry("new", 30),
      ChatSessionEntry("child", 80, parentSessionKey = "a-second"),
    )

  @Test
  fun sidebarKeepsPersonalOrderEvenWhenAnotherPinnedThreadHasNewerWork() {
    val modern = sidebarSessionPresentation(rows, emptyList(), nowMs = 100, personalPins = true)
    assertEquals(listOf("z-first", "a-second"), modern.pinned.map { it.key })
    assertEquals(listOf("new", "old"), modern.recent.map { it.key })
    assertEquals(listOf("child"), modern.childrenByParent["a-second"]?.map { it.key })

    val legacy = sidebarSessionPresentation(rows, emptyList(), nowMs = 100, personalPins = false)
    assertEquals(listOf("a-second", "z-first"), legacy.pinned.map { it.key })
  }

  @Test
  fun browserSortChangesOrdinaryRowsWithoutReversingThePersonsPins() {
    fun sections(
      recentFirst: Boolean,
      personalPins: Boolean,
    ): List<List<String>> {
      val entries = resolveSessionBrowserEntries(rows, "", SessionFilter.Recent, recentFirst, nowMs = 100, personalPins = personalPins)
      return buildSessionTreeSections(entries, collapsedSessionKeys = setOf("a-second"), nowMs = 100)
        .map { section -> section.entries.map { it.session.key } }
    }
    val pins = listOf("z-first", "a-second")
    assertEquals(listOf(pins, listOf("new", "old")), sections(recentFirst = true, personalPins = true))
    assertEquals(listOf(pins, listOf("old", "new")), sections(recentFirst = false, personalPins = true))
    assertEquals(listOf(listOf("a-second", "z-first"), listOf("new", "old")), sections(recentFirst = true, personalPins = false))
  }
}
