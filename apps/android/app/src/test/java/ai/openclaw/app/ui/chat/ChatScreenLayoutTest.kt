package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatMessageContent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatScreenLayoutTest {
  @Test
  fun activeChatBubblesUseReadableMobileWidth() {
    assertEquals(0.90f, CHAT_SCREEN_BUBBLE_WIDTH_FRACTION, 0.001f)
    assertTrue(CHAT_SCREEN_BUBBLE_WIDTH_FRACTION > 0.80f)
  }

  @Test
  fun activeChatPlainTextMessagePathKeepsLiteralTextThroughMarkdown() {
    val text = "Plain status: branch fix-chat, device Pixel 8a, and token openclaw_local remain text."
    val displayableContent = displayableChatBubbleContent(listOf(ChatMessageContent(text = text)))

    assertEquals(1, displayableContent.size)
    assertEquals(text, chatBubbleMarkdownText(displayableContent.single()))

    val annotated = buildChatInlineMarkdown(chatBubbleMarkdownText(displayableContent.single()))

    assertEquals(text, annotated.text)
    assertTrue(annotated.spanStyles.isEmpty())
    assertTrue(annotated.getLinkAnnotations(0, annotated.length).isEmpty())
  }
}
