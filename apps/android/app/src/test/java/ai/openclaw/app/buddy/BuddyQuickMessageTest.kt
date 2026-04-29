package ai.openclaw.app.buddy

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class BuddyQuickMessageTest {
  @Test
  fun normalizeTrimsText() {
    assertEquals("你好 Nemo", BuddyQuickMessage.normalize("  你好 Nemo  "))
  }

  @Test
  fun normalizeDropsBlankText() {
    assertNull(BuddyQuickMessage.normalize(" \n\t "))
  }

  @Test
  fun normalizeLimitsLongText() {
    val input = "a".repeat(BuddyQuickMessage.MAX_LENGTH + 20)

    assertEquals(BuddyQuickMessage.MAX_LENGTH, BuddyQuickMessage.normalize(input)?.length)
  }
}
