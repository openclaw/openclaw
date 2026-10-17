package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatMessageContent
import ai.openclaw.app.chat.ChatOutboxAttachment
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatAttachmentMessageTest {
  private val image = ChatMessageContent(type = "image", mimeType = "image/jpeg", fileName = "1000186721.jpg")
  private val voice = ChatMessageContent(type = "audio", mimeType = "audio/mp4", fileName = "voice-note-b9526ed8-69ef-44d1-ad36-0123456789ab.m4a", durationMs = 76_000)

  @Test
  fun placeholderTextIsDroppedWhenTheMessageCarriesAttachments() {
    val parts = splitChatAttachmentMessage(listOf(image, ChatMessageContent(type = "text", text = "See attached."), voice))
    assertEquals(listOf(image, voice), parts.content)
    assertNull(parts.transcript)
  }

  @Test
  fun placeholderTextStaysWhenItIsTheWholeTextOnlyMessage() {
    val text = ChatMessageContent(type = "text", text = "See attached.")
    assertEquals(listOf(text), splitChatAttachmentMessage(listOf(text)).content)
  }

  @Test
  fun transcriptionMarkerIsSplitOutOfTheTextAndUnquoted() {
    val text = ChatMessageContent(type = "text", text = "See attached.\n**[Transcription]**\n> First line.\n> Second line.")
    val parts = splitChatAttachmentMessage(listOf(image, text, voice))
    assertEquals(listOf(image, voice), parts.content)
    assertEquals("First line.\nSecond line.", parts.transcript)
  }

  @Test
  fun authorTextSurvivesNextToTheTranscript() {
    val text = ChatMessageContent(type = "text", text = "Check this\n**[Transcription]**\n> spoken")
    val parts = splitChatAttachmentMessage(listOf(text))
    assertEquals(listOf(ChatMessageContent(type = "text", text = "Check this")), parts.content)
    assertEquals("spoken", parts.transcript)
  }

  @Test
  fun ordinaryMarkdownIsUntouched() {
    val text = ChatMessageContent(type = "text", text = "**bold** and > not a transcript")
    val parts = splitChatAttachmentMessage(listOf(text))
    assertEquals(listOf(text), parts.content)
    assertNull(parts.transcript)
  }

  @Test
  fun bareTranscriptionMarkerKeepsTheOriginalText() {
    val text = ChatMessageContent(type = "text", text = "**[Transcription]**")
    val parts = splitChatAttachmentMessage(listOf(text))
    assertEquals(listOf(text), parts.content)
    assertNull(parts.transcript)
  }

  @Test
  fun authoredCaptionStartingWithThePlaceholderIsKept() {
    // Fails on base: the first authored line was deleted.
    val text = ChatMessageContent(type = "text", text = "See attached.\nDetails below.")
    val parts = splitChatAttachmentMessage(listOf(image, text))
    assertEquals(listOf(image, text), parts.content)
    assertNull(parts.transcript)
  }

  @Test
  fun authoredTranscriptionHeadingOverPlainTextStaysText() {
    // Fails on base: the heading was dropped and the text became a transcript block.
    val text = ChatMessageContent(type = "text", text = "[Transcription]\nPlease fill in this template")
    val parts = splitChatAttachmentMessage(listOf(text))
    assertEquals(listOf(text), parts.content)
    assertNull(parts.transcript)
  }

  @Test
  fun unquotedTranscriptIsSplitOnlyWhenTheTurnCarriesAVoiceNote() {
    val text = ChatMessageContent(type = "text", text = "**[Transcription]**\nspoken words")
    val parts = splitChatAttachmentMessage(listOf(image, text, voice))
    assertEquals(listOf(image, voice), parts.content)
    assertEquals("spoken words", parts.transcript)
  }

  @Test
  fun generatedVoiceNoteNamesAreHidden() {
    assertTrue(isGeneratedVoiceNoteName("voice-note-b9526ed8-69ef-44d1-ad36-0123456789ab.m4a"))
    assertFalse(isGeneratedVoiceNoteName("voice-note-for-mom.m4a"))
    assertFalse(isGeneratedVoiceNoteName("voice-note-b9526ed8-69ef-44d1-ad36-0123456789ab.mp3"))
    assertFalse(isGeneratedVoiceNoteName("meeting.m4a"))
  }

  @Test
  fun transcriptUrlStaysInTheLinkPreviewInput() {
    val text = ChatMessageContent(type = "text", text = "See attached.\n**[Transcription]**\n> look at https://example.com/page")
    val parts = splitChatAttachmentMessage(listOf(image, text, voice))
    assertEquals(listOf(image, voice), parts.content)
    assertEquals(
      listOf(ChatMessageContent(type = "text", text = "look at https://example.com/page")),
      parts.linkPreviewContent.filter { it.type == "text" },
    )
  }

  @Test
  fun linkPreviewInputIsTheDisplayedContentWithoutATranscript() {
    val text = ChatMessageContent(type = "text", text = "https://example.com")
    val parts = splitChatAttachmentMessage(listOf(image, text))
    assertEquals(parts.content, parts.linkPreviewContent)
  }

  @Test
  fun defaultGatewayEchoIsSplitOutOfAVoiceNoteTurn() {
    val text = ChatMessageContent(type = "text", text = "See attached.\n\uD83D\uDCDD \"Here is the photo from today. More details are at www.github.com\"")
    val parts = splitChatAttachmentMessage(listOf(image, text, voice))
    assertEquals(listOf(image, voice), parts.content)
    assertEquals("Here is the photo from today. More details are at www.github.com", parts.transcript)
    assertEquals(
      listOf(ChatMessageContent(type = "text", text = "Here is the photo from today. More details are at www.github.com")),
      parts.linkPreviewContent.filter { it.type == "text" },
    )
  }

  @Test
  fun defaultGatewayEchoKeepsAuthoredCaptionAndMultilineTranscript() {
    val text = ChatMessageContent(type = "text", text = "Look at this\n\uD83D\uDCDD \"line one\nline \"two\"\"\n")
    val parts = splitChatAttachmentMessage(listOf(image, text, voice))
    assertEquals(listOf(image, ChatMessageContent(type = "text", text = "Look at this"), voice), parts.content)
    assertEquals("line one\nline \"two\"", parts.transcript)
  }

  @Test
  fun echoShapedTextWithoutAVoiceNoteStaysText() {
    val text = ChatMessageContent(type = "text", text = "\uD83D\uDCDD \"note to self\"")
    val parts = splitChatAttachmentMessage(listOf(image, text))
    assertEquals(listOf(image, text), parts.content)
    assertNull(parts.transcript)
  }

  @Test
  fun unterminatedEchoStaysText() {
    val text = ChatMessageContent(type = "text", text = "See attached.\n\uD83D\uDCDD \"cut off")
    val parts = splitChatAttachmentMessage(listOf(image, text, voice))
    assertNull(parts.transcript)
    assertEquals(listOf(image, text, voice), parts.content)
  }

  private val queuedPhoto = ChatOutboxAttachment("photo-1", "image", "image/jpeg", "1000186721.jpg", null, 91_525L)
  private val queuedVoice =
    ChatOutboxAttachment("voice-1", "audio", "audio/mp4", "voice-note-b9526ed8-69ef-44d1-ad36-0123456789ab.m4a", 5_000L, 40_000L)

  @Test
  fun queuedPhotoAndVoiceNoteDropThePlaceholderAndKeepTheSentOrder() {
    // Even when the voice note was attached first, the bubble leads with the photo like the sent bubble.
    val parts = chatOutboxBubbleParts("See attached.", listOf(queuedVoice, queuedPhoto))
    assertEquals(listOf("image", "audio"), parts.map { it.content.type })
    assertEquals(listOf(queuedPhoto, queuedVoice), parts.map { it.attachment })
    assertEquals(5_000L, parts.last().content.durationMs)
    assertTrue(parts.none { it.content.text == "See attached." })
  }

  @Test
  fun queuedAuthoredCaptionSitsBetweenThePhotoAndTheVoiceRow() {
    val parts = chatOutboxBubbleParts("See attached. Look at the roof", listOf(queuedPhoto, queuedVoice))
    assertEquals(listOf("image", "text", "audio"), parts.map { it.content.type })
    assertEquals("See attached. Look at the roof", parts[1].content.text)
    assertNull(parts[1].attachment)
  }

  @Test
  fun queuedTextOnlyPlaceholderStaysText() {
    val parts = chatOutboxBubbleParts("See attached.", emptyList())
    assertEquals(listOf(ChatMessageContent(type = "text", text = "See attached.")), parts.map { it.content })
  }

  @Test
  fun queuedFileNamesAreKeptForTheRendererToDecide() {
    val named = ChatOutboxAttachment("voice-2", "audio", "audio/x-m4a", "site-visit.m4a", 7_000L, 100_000L)
    val parts = chatOutboxBubbleParts("", listOf(named, queuedVoice))
    assertEquals(listOf("site-visit.m4a", queuedVoice.fileName), parts.map { it.content.fileName })
    assertFalse(isGeneratedVoiceNoteName("site-visit.m4a"))
    assertTrue(isGeneratedVoiceNoteName(queuedVoice.fileName))
  }
}
