package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatSessionEntry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ChatContextMeterTest {
  @Test
  fun contextMeterUsesActiveSessionTokenBudget() {
    val sessions =
      listOf(
        ChatSessionEntry(key = "main", updatedAtMs = 1L, displayName = "Main", totalTokens = 8_000L, totalTokensFresh = true, contextTokens = 10_000L),
        ChatSessionEntry(
          key = "agent:main:mobile:test-device",
          updatedAtMs = 2L,
          displayName = "Phone",
          totalTokens = 1_250L,
          totalTokensFresh = true,
          contextTokens = 5_000L,
        ),
      )

    val usage =
      resolveChatContextUsage(
        sessionKey = "agent:main:mobile:test-device",
        mainSessionKey = "main",
        sessions = sessions,
      )

    assertEquals(ChatContextUsage(totalTokens = 1_250L, totalTokensFresh = true, contextTokens = 5_000L), usage)
    assertEquals(0.25f, contextMeterWidth(usage))
    assertEquals("Context 25% · high", contextMeterLabel(usage, "high"))
  }

  @Test
  fun contextMeterResolvesCanonicalMainAlias() {
    val sessions =
      listOf(
        ChatSessionEntry(
          key = "agent:main:node-phone",
          updatedAtMs = 1L,
          displayName = "Main",
          totalTokens = 41_000L,
          totalTokensFresh = true,
          contextTokens = 100_000L,
        ),
      )

    val usage =
      resolveChatContextUsage(
        sessionKey = "main",
        mainSessionKey = "agent:main:node-phone",
        sessions = sessions,
      )

    assertEquals(ChatContextUsage(totalTokens = 41_000L, totalTokensFresh = true, contextTokens = 100_000L), usage)
    assertEquals("Context 41% · off", contextMeterLabel(usage, "off"))
  }

  @Test
  fun contextMeterDoesNotInventPercentWhenBudgetIsMissing() {
    val usage = ChatContextUsage(totalTokens = 8_200L, totalTokensFresh = true, contextTokens = null)

    assertNull(contextMeterWidth(usage))
    assertEquals("Context -- · medium", contextMeterLabel(usage, "medium"))
  }

  @Test
  fun contextMeterClampsOverfullSessions() {
    val usage = ChatContextUsage(totalTokens = 150_000L, totalTokensFresh = true, contextTokens = 100_000L)

    assertEquals(1.0f, contextMeterWidth(usage))
    assertEquals("Context 100% · low", contextMeterLabel(usage, "low"))
  }

  @Test
  fun contextMeterDoesNotDisplayStaleTokenUsage() {
    val usage = ChatContextUsage(totalTokens = 82_000L, totalTokensFresh = false, contextTokens = 100_000L)

    assertNull(contextMeterWidth(usage))
    assertEquals("Context -- · high", contextMeterLabel(usage, "high"))
  }

  @Test
  fun contextMeterHidesThinkingLabelWhenUnsupported() {
    val usage = ChatContextUsage(totalTokens = 2_500L, totalTokensFresh = true, contextTokens = 10_000L)

    assertEquals("Context 25%", contextMeterLabel(usage, "high", thinkingSupported = false))
  }
}
