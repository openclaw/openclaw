package ai.openclaw.app.chat

import org.junit.Assert.assertEquals
import org.junit.Test

class ChatThinkingLevelClampTest {
  private fun options(vararg ids: String): List<ChatThinkingLevelOption> = ids.map { ChatThinkingLevelOption(id = it, label = it) }

  @Test
  fun membershipWins() {
    assertEquals("ultra", clampThinkingLevelToOptions("ultra", options("off", "ultra")))
    assertEquals("off", clampThinkingLevelToOptions("off", options("off", "ultra")))
  }

  @Test
  fun preservesUltraWhenOmittedFromAdvertisedOptions() {
    assertEquals(
      "ultra",
      clampThinkingLevelToOptions("ultra", options("off", "high", "xhigh", "max")),
    )
  }

  @Test
  fun preservesCanonicalEffectiveLevelOmittedFromIncompletePickerMetadata() {
    // Gateway missing/identity-only catalog keeps effective Medium while picker shows
    // Off/High/Low/Ultra (session-utils.metadata-perf). Do not reinterpret to Low.
    assertEquals(
      "medium",
      clampThinkingLevelToOptions("medium", options("off", "high", "low", "ultra")),
    )
    assertEquals(
      "adaptive",
      clampThinkingLevelToOptions("adaptive", options("off", "high", "low", "ultra")),
    )
    assertEquals(
      "xhigh",
      clampThinkingLevelToOptions("xhigh", options("off", "high", "ultra")),
    )
  }

  @Test
  fun offUltraPickerDoesNotReplaceCanonicalEffectiveLevel() {
    // An Off-only profile can have Ultra appended by the runtime. That picker shape is not
    // authoritative support, so a gateway-preserved Medium/High stays put and is not Ultra.
    assertEquals("medium", clampThinkingLevelToOptions("medium", options("off", "ultra")))
    assertEquals("adaptive", clampThinkingLevelToOptions("adaptive", options("off", "ultra")))
    assertEquals("high", clampThinkingLevelToOptions("high", options("off", "ultra")))
    assertEquals("max", clampThinkingLevelToOptions("max", options("off", "ultra")))
    assertEquals("xhigh", clampThinkingLevelToOptions("xhigh", options("off", "ultra")))
    assertEquals("medium", clampThinkingLevelToOptions("medium", options("ultra")))
  }

  @Test
  fun preservesCanonicalLevelWhenRicherLadderOmitsIt() {
    // Off/High/Ultra is not an Off/Ultra-only restricted profile; preserve omitted Medium.
    assertEquals("medium", clampThinkingLevelToOptions("medium", options("off", "high", "ultra")))
  }

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
