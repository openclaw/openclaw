package ai.openclaw.app.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

class ChatControllerMessageIdentityTest {
  @Test
  fun reconcileMessageIdsReusesMatchingIdsAcrossHistoryReload() {
    val previous =
      listOf(
        ChatMessage(
          id = "msg-1",
          role = "assistant",
          content = listOf(ChatMessageContent(type = "text", text = "hello")),
          timestampMs = 1000L,
        ),
        ChatMessage(
          id = "msg-2",
          role = "user",
          content = listOf(ChatMessageContent(type = "text", text = "hi")),
          timestampMs = 2000L,
        ),
      )

    val incoming =
      listOf(
        ChatMessage(
          id = "new-1",
          role = "assistant",
          content = listOf(ChatMessageContent(type = "text", text = "hello")),
          timestampMs = 1000L,
        ),
        ChatMessage(
          id = "new-2",
          role = "user",
          content = listOf(ChatMessageContent(type = "text", text = "hi")),
          timestampMs = 2000L,
        ),
      )

    val reconciled = reconcileMessageIds(previous = previous, incoming = incoming)

    assertEquals(listOf("msg-1", "msg-2"), reconciled.map { it.id })
  }

  @Test
  fun reconcileMessageIdsLeavesNewMessagesUntouched() {
    val previous =
      listOf(
        ChatMessage(
          id = "msg-1",
          role = "assistant",
          content = listOf(ChatMessageContent(type = "text", text = "hello")),
          timestampMs = 1000L,
        ),
      )

    val incoming =
      listOf(
        ChatMessage(
          id = "new-1",
          role = "assistant",
          content = listOf(ChatMessageContent(type = "text", text = "hello")),
          timestampMs = 1000L,
        ),
        ChatMessage(
          id = "new-2",
          role = "assistant",
          content = listOf(ChatMessageContent(type = "text", text = "new reply")),
          timestampMs = 3000L,
        ),
      )

    val reconciled = reconcileMessageIds(previous = previous, incoming = incoming)

    assertEquals("msg-1", reconciled[0].id)
    assertEquals("new-2", reconciled[1].id)
    assertNotEquals(reconciled[0].id, reconciled[1].id)
  }
}
