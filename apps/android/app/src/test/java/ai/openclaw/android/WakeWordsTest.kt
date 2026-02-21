package ai.openclaw.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class WakeWordsTest {
  @Test
  fun parseCommaSeparatedSplitsOnlyOnCommas() {
    assertEquals(
      listOf("openclaw", "claude; omi\nfriend"),
      WakeWords.parseCommaSeparated(" openclaw, claude; omi\nfriend "),
    )
  }

  @Test
  fun sanitizeTrimsDedupesCapsAndFallsBack() {
    val defaults = listOf("openclaw", "claude")
    val long = "x".repeat(WakeWords.maxWordLength + 10)
    val words = listOf(" ", "  hello  ", "HELLO", long)

    val sanitized = WakeWords.sanitize(words, defaults)
    assertEquals(2, sanitized.size)
    assertEquals("hello", sanitized[0])
    assertEquals("x".repeat(WakeWords.maxWordLength), sanitized[1])

    assertEquals(defaults, WakeWords.sanitize(listOf(" ", ""), defaults))
  }

  @Test
  fun sanitizeLimitsWordCount() {
    val defaults = listOf("openclaw")
    val words = (1..(WakeWords.maxWords + 5)).map { "w$it" }
    val sanitized = WakeWords.sanitize(words, defaults)
    assertEquals(WakeWords.maxWords, sanitized.size)
    assertEquals("w1", sanitized.first())
    assertEquals("w${WakeWords.maxWords}", sanitized.last())
  }

  @Test
  fun parseIfChangedSkipsWhenUnchanged() {
    val current = listOf("openclaw", "claude")
    val parsed = WakeWords.parseIfChanged(" openclaw , claude ", current)
    assertNull(parsed)
  }

  @Test
  fun parseIfChangedReturnsUpdatedList() {
    val current = listOf("openclaw")
    val parsed = WakeWords.parseIfChanged(" openclaw , jarvis ", current)
    assertEquals(listOf("openclaw", "jarvis"), parsed)
  }

  @Test
  fun mergePresetsAddsPresetWordsWithoutDuplicates() {
    val current = listOf("openclaw", "omi")
    val merged = WakeWords.mergePresets(current, listOf(WakeWords.omiPresets.first()))

    assertEquals(listOf("openclaw", "omi", "hey omi"), merged)
  }

  @Test
  fun presetByIdFindsKnownPreset() {
    val preset = WakeWords.presetById("limitless")
    assertEquals("Limitless", preset?.label)
  }
}
