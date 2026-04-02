package ai.openclaw.app.ui.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
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
}
