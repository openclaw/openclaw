package ai.openclaw.app.ui.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatScreenLayoutTest {
  @Test
  fun activeChatBubblesUseReadableMobileWidth() {
    assertEquals(0.90f, CHAT_SCREEN_BUBBLE_WIDTH_FRACTION, 0.001f)
    assertTrue(CHAT_SCREEN_BUBBLE_WIDTH_FRACTION > 0.80f)
  }
}
