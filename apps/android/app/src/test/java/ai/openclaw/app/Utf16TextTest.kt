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
}
