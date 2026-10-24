package ai.openclaw.app.chat

import org.junit.Assert.assertEquals
import org.junit.Test

class ChatThinkingLevelClampTest {
  private fun options(vararg ids: String): List<ChatThinkingLevelOption> = ids.map { ChatThinkingLevelOption(id = it, label = it) }

  @Test
  fun unknownLevelPrefersOff() {
    assertEquals("off", clampThinkingLevelToOptions("custom-level", options("off", "ultra")))
    assertEquals("off", clampThinkingLevelToOptions("custom-level", options("off", "high", "ultra")))
  }

  @Test
  fun emptyOptionsPassthrough() {
    assertEquals("medium", clampThinkingLevelToOptions("medium", emptyList()))
  }
}
