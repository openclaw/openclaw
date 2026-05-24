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
  fun reconcileMessageIdsPreservesDuplicateMatchOrderAcrossHistoryReload() {
    val previous =
      listOf(
        ChatMessage(
          id = "msg-1",
          role = "assistant",
          content = listOf(ChatMessageContent(type = "text", text = "same")),
          timestampMs = 1000L,
        ),
        ChatMessage(
          id = "msg-2",
          role = "assistant",
          content = listOf(ChatMessageContent(type = "text", text = "same")),
          timestampMs = 1000L,
        ),
      )

    val incoming =
      listOf(
        ChatMessage(
          id = "new-1",
          role = "assistant",
          content = listOf(ChatMessageContent(type = "text", text = "same")),
          timestampMs = 1000L,
        ),
        ChatMessage(
          id = "new-2",
          role = "assistant",
          content = listOf(ChatMessageContent(type = "text", text = "same")),
          timestampMs = 1000L,
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

  @Test
  fun messageIdentityKeyNormalizesRoleAndTextWhitespace() {
    val a =
      ChatMessage(
        id = "a",
        role = " Assistant ",
        content = listOf(ChatMessageContent(type = "text", text = " hello ")),
        timestampMs = 1234L,
      )
    val b =
      ChatMessage(
        id = "b",
        role = "assistant",
        content = listOf(ChatMessageContent(type = "text", text = "hello")),
        timestampMs = 1234L,
      )

    assertEquals(messageIdentityKey(a), messageIdentityKey(b))
  }

  @Test
  fun messageIdentityKeyDiffersForDistinctAttachmentMetadata() {
    val imageA =
      ChatMessage(
        id = "img-a",
        role = "assistant",
        content =
          listOf(
            ChatMessageContent(
              type = "image",
              mimeType = "image/png",
              fileName = "a.png",
              base64 = "abc",
            ),
          ),
        timestampMs = 2000L,
      )
    val imageB =
      ChatMessage(
        id = "img-b",
        role = "assistant",
        content =
          listOf(
            ChatMessageContent(
              type = "image",
              mimeType = "image/jpeg",
              fileName = "b.jpg",
              base64 = "abc",
            ),
          ),
        timestampMs = 2000L,
      )

    assertNotEquals(messageIdentityKey(imageA), messageIdentityKey(imageB))
  }

  @Test
  fun messageIdentityKeyIncludesSourceIdAndToolCallId() {
    val a =
      ChatMessage(
        id = "a",
        role = "toolResult",
        sourceId = "server-1",
        toolCallId = "call-1",
        content = listOf(ChatMessageContent(type = "toolresult", text = "ok")),
        timestampMs = 1234L,
      )
    val b =
      ChatMessage(
        id = "b",
        role = "toolResult",
        sourceId = "server-2",
        toolCallId = "call-1",
        content = listOf(ChatMessageContent(type = "toolresult", text = "ok")),
        timestampMs = 1234L,
      )

    assertNotEquals(messageIdentityKey(a), messageIdentityKey(b))
  }
}
