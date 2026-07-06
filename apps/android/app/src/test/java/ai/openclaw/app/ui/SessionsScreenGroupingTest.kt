package ai.openclaw.app.ui

import ai.openclaw.app.chat.ChatSessionEntry
import org.junit.Assert.assertEquals
import org.junit.Test

class SessionsScreenGroupingTest {
  @Test
  fun groupsPinnedThenAlphabeticalCategoriesThenUngrouped() {
    val sections =
      groupSessionEntries(
        listOf(
          session("loose"),
          session("zeta", category = "Zeta"),
          session("pinned-grouped", category = "Alpha", pinned = true),
          session("alpha", category = "Alpha"),
          session("pinned", pinned = true),
        ),
      )

    assertEquals(listOf("Pinned", "Alpha", "Zeta", "Ungrouped"), sections.map { it.title })
    assertEquals(listOf("pinned-grouped", "pinned"), sections[0].entries.map { it.key })
    assertEquals(listOf("alpha"), sections[1].entries.map { it.key })
    assertEquals(listOf("zeta"), sections[2].entries.map { it.key })
    assertEquals(listOf("loose"), sections[3].entries.map { it.key })
  }

  @Test
  fun omitsUngroupedHeaderWhenNoCategoriesExist() {
    val sections = groupSessionEntries(listOf(session("one"), session("two")))

    assertEquals(listOf<String?>(null), sections.map { it.title })
    assertEquals(listOf("one", "two"), sections.single().entries.map { it.key })
  }

  @Test
  fun pinnedSessionsAppearOnlyInPinnedSection() {
    val sections = groupSessionEntries(listOf(session("pinned", category = "Work", pinned = true)))

    assertEquals(listOf("Pinned"), sections.map { it.title })
    assertEquals(listOf("pinned"), sections.single().entries.map { it.key })
  }

  private fun session(
    key: String,
    category: String? = null,
    pinned: Boolean? = null,
  ): ChatSessionEntry =
    ChatSessionEntry(
      key = key,
      updatedAtMs = null,
      category = category,
      pinned = pinned,
    )
}
