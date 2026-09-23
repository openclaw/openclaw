package ai.openclaw.app.ui.chat

import org.commonmark.node.FencedCodeBlock
import org.commonmark.node.Link
import org.commonmark.node.Node
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatMarkdownParsingTest {
  @Test
  fun ordinaryParsingRetainsLargeCodeAndLateLinkWithoutSourceSpans() {
    val code = "x\n".repeat(400_000) + "UPPER_BOUND_TAIL\n"
    val url = "https://example.test/tail"
    val source = "Introduction\n\n```\n$code```\n\n[tail]($url)"
    val document = parseChatMarkdown(source)
    val paragraph = document.firstChild
    val fence = paragraph.next as FencedCodeBlock
    val tail = fence.next
    val link = tail.firstChild as Link

    assertEquals(code, fence.literal)
    assertEquals(url, link.destination)
    for (node in listOf(paragraph, paragraph.firstChild, fence, tail, link, link.firstChild)) {
      assertTrue(node.sourceSpans.isEmpty())
    }
    assertEquals(url, extractFirstBareUrl(source))
  }

  @Test
  fun spanModesPreserveExtensionAndReferenceLinkSemantics() {
    val source =
      """
      - [x] ~~done~~ https://example.test/first

      | Heading | Link |
      | --- | --- |
      | value | [reference][ref] |

      ![image][ref]

      [ref]: https://example.test/reference
      """.trimIndent()
    val ordinary = parseChatMarkdown(source)
    val mapped = parseChatMarkdownWithSourceSpans(source)
    assertEquals(semanticTree(mapped), semanticTree(ordinary))
    assertTrue(mapped.firstChild.sourceSpans.isNotEmpty())
    val kinds = semanticTree(ordinary)
    for (kind in listOf("TaskListItemMarker", "Strikethrough", "TableBlock", "Link", "Image")) {
      assertTrue(kinds.any { it.startsWith("$kind{") })
    }
    assertEquals("https://example.test/first", extractFirstBareUrl(source))
  }

  @Test
  fun mathSegmentationKeepsItsSourceBoundaries() {
    assertEquals(
      listOf(ChatMarkdownSourceBlock.Math("x + y")),
      segmentChatMarkdown("$$ x + y $$", isStreaming = false),
    )
    for (inline in listOf("`$$ x + y $$`", "*before\n$$ x + y $$\nafter*", "before\\\n$$ x + y $$")) {
      assertEquals(listOf(ChatMarkdownSourceBlock.Markdown(inline)), segmentChatMarkdown(inline, isStreaming = false))
    }
    for (label in listOf("[reference]", "![image]")) {
      val source = "$label[ref]\n\n$$ x + y $$\n\n[ref]: https://example.test/reference"
      assertEquals(listOf(ChatMarkdownSourceBlock.Markdown(source)), segmentChatMarkdown(source, isStreaming = false))
    }
  }

  private fun semanticTree(node: Node): List<String> =
    buildList {
      add(node.toString())
      var child = node.firstChild
      while (child != null) {
        addAll(semanticTree(child))
        child = child.next
      }
      add("end")
    }
}
