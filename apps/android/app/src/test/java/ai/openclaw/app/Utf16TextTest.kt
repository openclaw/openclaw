package ai.openclaw.app

import org.junit.Assert.assertEquals
import org.junit.Test

class Utf16TextTest {
  @Test
  fun takeUtf16SafePreservesCodeUnitLimitWithoutSplittingSurrogatePairs() {
    assertEquals("ab", "ab".takeUtf16Safe(2))
    assertEquals("ab", "abc".takeUtf16Safe(2))
    assertEquals("", "\uD83D\uDE00tail".takeUtf16Safe(1))
    assertEquals("\uD83D\uDE00", "\uD83D\uDE00tail".takeUtf16Safe(2))
  }
}
