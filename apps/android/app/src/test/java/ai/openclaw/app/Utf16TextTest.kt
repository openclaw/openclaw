package ai.openclaw.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class Utf16TextTest {
  @Test
  fun firstCodePointOrNullPreservesSupplementaryCharacters() {
    assertEquals("🧭", "🧭 Scout".firstCodePointOrNull())
    assertEquals("S", "Scout".firstCodePointOrNull())
    assertNull("".firstCodePointOrNull())
  }

  @Test
  fun takeUtf16SafePreservesCodeUnitLimitWithoutSplittingSurrogatePairs() {
    assertEquals("ab", "ab".takeUtf16Safe(2))
    assertEquals("ab", "abc".takeUtf16Safe(2))
    assertEquals("", "\uD83D\uDE00tail".takeUtf16Safe(1))
    assertEquals("\uD83D\uDE00", "\uD83D\uDE00tail".takeUtf16Safe(2))
  }
}
