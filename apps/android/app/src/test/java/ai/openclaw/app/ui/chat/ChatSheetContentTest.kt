package ai.openclaw.app.ui.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatSheetContentTest {
  @Test
  fun resolvesPendingAssistantAutoSendOnlyWhenChatIsReady() {
    assertNull(
      resolvePendingAssistantAutoSend(
        pendingPrompt = "summarize mail",
        healthOk = false,
        pendingRunCount = 0,
      ),
    )
    assertNull(
      resolvePendingAssistantAutoSend(
        pendingPrompt = "summarize mail",
        healthOk = true,
        pendingRunCount = 1,
      ),
    )
    assertEquals(
      "summarize mail",
      resolvePendingAssistantAutoSend(
        pendingPrompt = "  summarize mail  ",
        healthOk = true,
        pendingRunCount = 0,
      ),
    )
  }

  @Test
  fun initialChatLoadUsesMainWhenNoSessionIsSelected() {
    assertEquals(
      "agent:ops:device",
      resolveInitialChatLoadSessionKey(
        sessionKey = "main",
        mainSessionKey = "agent:ops:device",
      ),
    )
  }

  @Test
  fun initialChatLoadPreservesSelectedSession() {
    assertNull(
      resolveInitialChatLoadSessionKey(
        sessionKey = "session:history",
        mainSessionKey = "agent:ops:device",
      ),
    )
  }

  @Test
  fun healthyEmptyChatShowsStarterStateInsteadOfLoadingPlaceholder() {
    assertFalse(
      showChatLoadingPlaceholder(
        historyLoading = true,
        healthOk = true,
        gatewayOffline = false,
      ),
    )
    assertTrue(
      showChatLoadingPlaceholder(
        historyLoading = true,
        healthOk = false,
        gatewayOffline = false,
      ),
    )
  }
}
