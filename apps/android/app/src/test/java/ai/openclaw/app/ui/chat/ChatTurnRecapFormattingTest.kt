package ai.openclaw.app.ui.chat

import org.junit.Assert.assertEquals
import org.junit.Test
import java.util.Locale

class ChatTurnRecapFormattingTest {
  @Test
  fun formatsZeroOneAndCompactTokenCounts() {
    assertEquals(TurnRecapTokenFormat(singular = false, count = "0"), turnRecapTokenFormat(0L))
    assertEquals(TurnRecapTokenFormat(singular = true, count = "1"), turnRecapTokenFormat(1L))
    assertEquals("1.2k", formatCompactTokenCount(1_234L, Locale.US))
    assertEquals("1.3k", formatCompactTokenCount(1_250L, Locale.US))
    assertEquals("1,2k", formatCompactTokenCount(1_234L, Locale.GERMANY))
    assertEquals("١M", formatCompactTokenCount(999_999L, Locale.forLanguageTag("ar")))
  }
}
