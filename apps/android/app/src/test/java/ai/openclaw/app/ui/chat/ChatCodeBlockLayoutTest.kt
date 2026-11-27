package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatComposerOwner
import ai.openclaw.app.chat.ChatController
import ai.openclaw.app.chat.ChatMessage
import ai.openclaw.app.chat.ChatMessageContent
import ai.openclaw.app.ui.design.ClawDesignTheme
import ai.openclaw.app.ui.design.ClawTheme
import android.content.ClipData
import android.content.ClipboardManager
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasScrollToIndexAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.config.ConfigurationRegistry

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36], qualifiers = "w360dp-h800dp-420dpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ChatCodeBlockLayoutTest {
  @get:Rule
  val composeRule = createComposeRule()

  private lateinit var clipboard: ClipboardManager
  private var previousClip: ClipData? = null

  @Before
  fun setUp() {
    assertEquals(GraphicsMode.Mode.NATIVE, ConfigurationRegistry.get(GraphicsMode.Mode::class.java))
    clipboard = RuntimeEnvironment.getApplication().getSystemService(ClipboardManager::class.java)
    previousClip = clipboard.primaryClip
  }

  @After
  fun restoreClipboard() {
    previousClip?.let(clipboard::setPrimaryClip) ?: clipboard.clearPrimaryClip()
  }

  @Test
  fun publicEndAndStartRevealTheActualCodeEndpointsAndCopyKeepsTheEntireSource() {
    val code = "  FIRST_CODE\r\n" + "middle\r\n".repeat(700) + "LAST_CODE\r\n  "
    show { ChatCodeBlock(code = code, language = "kotlin") }

    visibleGlyph("FIRST_CODE")
    click("End of code")
    visibleGlyph("LAST_CODE")
    assertCopiedSource(code)
    click("Start of code")
    visibleGlyph("FIRST_CODE")
  }

  @Test
  @Config(qualifiers = "w360dp-h2400dp-mdpi")
  fun settlingAndRefreshingKeepEachFencesOwnReadingPosition() {
    val code = (0..260).joinToString("\n") { "line $it" }
    val fence = "```text\n$code\n```"
    val twoFences = "$fence\n\n$fence"
    val text = "Live result.\n\n$twoFences"

    fun message(
      id: String,
      body: String = text,
    ) = ChatMessage(id, "assistant", listOf(ChatMessageContent(text = body)), null, runId = "run", entryId = id)
    val older = message("older")
    val commentary = message("commentary", "Separate commentary.\n\n$twoFences")
    val note = message("note", "Finished the calculation.")
    val final = message("final", "$text\n\n$fence")
    val live = ChatTimelineItem.StreamingAssistant(text)
    val session = mutableStateOf("session")
    val run = mutableStateOf("run")
    val history = mutableStateOf(listOf(older))
    val row = mutableStateOf<ChatTimelineItem?>(live)
    val concurrentHistory = mutableStateOf<ChatTimelineItem.Message?>(null)
    show(height = 2400.dp) {
      val rows = listOfNotNull(row.value, concurrentHistory.value)
      val owner = ChatComposerOwner("gateway", "main", session.value)
      val stream = if (live in rows) ChatController.StreamingAssistant(ChatController.ChatRunOwner(owner, run.value), text) else null
      val forRow = key(session.value) { rememberChatCodeReaderForRow(history.value, stream, owner, if (stream == null) 0 else 2, ChatMessage::content) }
      LazyColumn {
        rows.forEach { item ->
          item(key = chatTimelineItemKey(item)) {
            val markdown =
              when (item) {
                is ChatTimelineItem.StreamingAssistant -> {
                  item.text
                }

                is ChatTimelineItem.Message -> {
                  item.message.content
                    .single()
                    .text
                    .orEmpty()
                }

                else -> {
                  error("Expected an assistant row")
                }
              }
            CompositionLocalProvider(LocalChatCodeReaderHandoff provides forRow(item)) {
              ChatMarkdown(markdown, ClawTheme.colors.text, isStreaming = item === live)
            }
          }
        }
      }
    }

    val lists = hasScrollToIndexAction()
    val fences = composeRule.onAllNodes(lists and hasAnyAncestor(lists), useUnmergedTree = true)

    fun offsets() = fences.fetchSemanticsNodes().map { it.config[SemanticsProperties.VerticalScrollAxisRange].value() }

    fun read(
      index: Int,
      distance: Float,
    ) {
      fences[index].performSemanticsAction(SemanticsActions.ScrollBy) { scroll -> assertTrue(scroll(0f, distance)) }
      composeRule.waitForIdle()
    }

    read(0, 160f)
    read(1, 420f)
    val positions = listOf(160f, 420f)
    val start = listOf(0f, 0f)
    assertEquals(positions, offsets())
    // A terminal event clears the stream before the refreshed history may arrive.
    composeRule.runOnIdle { row.value = null }
    composeRule.waitForIdle()
    composeRule.runOnIdle {
      history.value = listOf(older, commentary)
      row.value = ChatTimelineItem.Message(commentary)
    }
    assertEquals("Separate commentary must start at the top of both fences", start, offsets())
    composeRule.runOnIdle {
      history.value = listOf(older, commentary, note)
      row.value = ChatTimelineItem.Message(note)
    }
    composeRule.waitForIdle()
    composeRule.runOnIdle {
      history.value = listOf(older, commentary, note, final)
      row.value = ChatTimelineItem.Message(final)
    }
    assertEquals(positions + 0f, offsets())
    composeRule.runOnIdle {
      val refreshed = final.copy(timestampMs = 2L)
      history.value = listOf(older, commentary, note, refreshed)
      row.value = ChatTimelineItem.Message(refreshed)
    }
    assertEquals(positions + 0f, offsets())

    composeRule.runOnIdle { row.value = ChatTimelineItem.Message(older) }
    assertEquals(start, offsets())
    composeRule.runOnIdle {
      val sibling = message("another")
      history.value = listOf(older, sibling)
      row.value = ChatTimelineItem.Message(sibling)
    }
    assertEquals(start, offsets())
    composeRule.runOnIdle {
      row.value = live
      run.value = "next-run"
    }
    assertEquals(start, offsets())
    read(0, 120f)
    composeRule.runOnIdle { run.value = "third-run" }
    assertEquals(start, offsets())
    read(1, 100f)
    composeRule.runOnIdle { run.value = "next-run" }
    assertTrue(offsets()[0] > 0f)
    assertEquals(0f, offsets()[1], 0f)
    composeRule.runOnIdle { session.value = "another-session" }
    assertEquals(start, offsets())

    // A transcript refresh can mount the history row while the stream is still visible.
    read(0, 160f)
    read(1, 420f)
    val delivered = message("early-history").copy(runId = run.value)
    composeRule.runOnIdle {
      history.value += delivered
      concurrentHistory.value = ChatTimelineItem.Message(delivered)
    }
    assertEquals(positions + start, offsets())
    read(2, 96f)
    assertEquals(positions + listOf(96f, 0f), offsets())
    composeRule.runOnIdle {
      row.value = concurrentHistory.value
      concurrentHistory.value = null
    }
    assertEquals("Only the untouched history fence inherits its live position", listOf(96f, 420f), offsets())
    read(1, 80f)
    val afterReading = listOf(96f, 500f)
    assertEquals(afterReading, offsets())
    composeRule.runOnIdle {
      val refreshed = delivered.copy(timestampMs = 3L)
      history.value = history.value.dropLast(1) + refreshed
      row.value = ChatTimelineItem.Message(refreshed)
    }
    assertEquals("Refreshing must keep the user's newer position", afterReading, offsets())
  }

  @Test
  fun standaloneEndAndStartRevealEndpointsInsideAShortScrollingParent() {
    val code = (0 until 700).joinToString("\n") { "R$it" }
    show {
      Box(
        Modifier
          .height(198.dp)
          .clipToBounds()
          .verticalScroll(rememberScrollState()),
      ) {
        ChatCodeBlock(code = code, language = null)
      }
    }

    visibleGlyph("R0")
    click("End of code")
    composeRule.waitForIdle()
    visibleGlyph("R699")
    composeRule.onNode(hasText("Start of code") and hasClickAction()).performScrollTo()
    click("Start of code")
    visibleGlyph("R0")
  }

  @Test
  fun quotedFencedCodeUsesTheSameNavigableRenderer() {
    val code = "QUOTED_FIRST\n" + "middle\n".repeat(300) + "QUOTED_LAST\n"
    val markdown = "> ```text\n" + code.trimEnd('\n').lineSequence().joinToString("\n") { "> $it" } + "\n> ```"
    show { ChatMarkdown(text = markdown, textColor = ClawTheme.colors.text) }

    visibleGlyph("QUOTED_FIRST")
    click("End of code")
    visibleGlyph("QUOTED_LAST")
    assertCopiedSource(code)
    click("Start of code")
    visibleGlyph("QUOTED_FIRST")
  }

  @Test
  fun layoutBoundariesPreserveLineSpacingGraphemesAndCopiedSource() {
    val cases =
      listOf(
        BoundaryCase("LF before cap", "x".repeat(16_383) + "\nY", lineBreaks = 1),
        BoundaryCase("LF after cap", "x".repeat(16_384) + "\nY", lineBreaks = 1),
        BoundaryCase("CRLF before cap", "x".repeat(16_382) + "\r\nY", lineBreaks = 1),
        BoundaryCase("CRLF across cap", "x".repeat(16_383) + "\r\nY", lineBreaks = 1),
        BoundaryCase("blank LF line", "x".repeat(16_384) + "\n\nY", lineBreaks = 2),
        BoundaryCase("blank CRLF line", "x".repeat(16_383) + "\r\n\r\nY", lineBreaks = 2),
        BoundaryCase("combining at cap", "x".repeat(16_383) + "e\u0301Y", intactTail = "e\u0301Y"),
        BoundaryCase("joined emoji at cap", "x".repeat(16_383) + "👩\u200D💻Y", intactTail = "👩\u200D💻Y"),
        BoundaryCase("LF before over-budget grapheme", "x".repeat(16_384) + "\na" + "\u0301".repeat(20_000) + "Y"),
        BoundaryCase("CRLF before over-budget grapheme", "x".repeat(16_384) + "\r\na" + "\u0301".repeat(20_000) + "Y"),
      )
    val current = mutableStateOf(cases.first())
    show {
      key(current.value.label) {
        ChatCodeBlock(code = current.value.code, language = null)
      }
    }

    cases.forEach { case ->
      val controlSpacing =
        case.lineBreaks?.let { breaks ->
          val separator = case.code.substringAfterLast('x').substringBefore('Y')
          val control = case.copy(label = "${case.label}: unsplit control", code = "x${separator}Y")
          composeRule.runOnIdle { current.value = control }
          composeRule.onNodeWithText("End of code").assertDoesNotExist()
          val (_, controlLayout) = renderedText("Y")
          assertEquals("${case.label}: the short control must retain its explicit lines", breaks + 1, controlLayout.lineCount)
          visibleGlyph("Y").top - visibleGlyph("x").top
        }
      composeRule.runOnIdle { current.value = case }
      click("End of code")
      val ending = visibleGlyph("Y")
      val (_, endingLayout) = renderedText("Y")
      controlSpacing?.let { expected ->
        val previous = visibleGlyph("x")
        // Final-line extents include edge metrics, not a repeatable baseline advance.
        // Compare with the same separator rendered without a layout boundary.
        assertEquals("${case.label}: a layout boundary must match unsplit code spacing", expected, ending.top - previous.top, 2f)
      }
      case.intactTail?.let { tail ->
        assertTrue(
          "${case.label}: the displayed tail must contain the complete grapheme",
          endingLayout.layoutInput.text.text
            .endsWith(tail),
        )
      }
      assertCopiedSource(case.code)
    }
  }

  @Test
  fun shortCodeKeepsItsCompleteHighlightedMonospaceLayoutWithoutNavigation() {
    val code = "val answer = \"short\"\n  "
    show { ChatCodeBlock(code = code, language = "kotlin") }

    composeRule.onNodeWithText("KOTLIN").assertIsDisplayed()
    visibleGlyph("short")
    val (_, layout) = renderedText("short")
    assertEquals(code.trimEnd(), layout.layoutInput.text.text)
    assertEquals(FontFamily.Monospace, layout.layoutInput.style.fontFamily)
    assertTrue(
      "Short completed code must retain syntax highlighting",
      layout.layoutInput.text.spanStyles
        .isNotEmpty(),
    )
    listOf("Start of code", "End of code", "Copy code").forEach { label ->
      composeRule.onNodeWithText(label).assertDoesNotExist()
    }
  }

  private fun show(
    height: Dp = 800.dp,
    content: @Composable () -> Unit,
  ) {
    composeRule.setContent {
      ClawDesignTheme {
        Box(Modifier.size(360.dp, height).clipToBounds()) { content() }
      }
    }
  }

  private fun click(label: String) {
    composeRule
      .onNode(hasText(label) and hasClickAction())
      .assertIsDisplayed()
      .assertIsEnabled()
      .performClick()
  }

  private fun assertCopiedSource(expected: String) {
    clipboard.setPrimaryClip(ClipData.newPlainText("before copy", "not the code"))
    click("Copy code")
    composeRule.runOnIdle {
      assertEquals(
        "Copy code must retain the full source, not just the visible layout or trimmed display",
        expected,
        clipboard.primaryClip
          ?.getItemAt(0)
          ?.text
          ?.toString(),
      )
    }
  }

  private fun renderedText(marker: String): Pair<SemanticsNode, TextLayoutResult> {
    val target = composeRule.onNode(hasText(marker, substring = true), useUnmergedTree = true).assertIsDisplayed()
    val layouts = mutableListOf<TextLayoutResult>()
    target.performSemanticsAction(SemanticsActions.GetTextLayoutResult) { action -> assertTrue(action(layouts)) }
    return target.fetchSemanticsNode() to layouts.single()
  }

  private fun visibleGlyph(marker: String): Rect {
    val (node, layout) = renderedText(marker)
    val start =
      layout.layoutInput.text.text
        .lastIndexOf(marker)
    assertTrue("The rendered layout must contain $marker", start >= 0)
    var lastGlyph = Rect.Zero
    marker.indices.forEach { index ->
      val glyph = layout.getBoundingBox(start + index).translate(node.positionInRoot)
      assertTrue("$marker glyph $index needs finite positive geometry", glyph.left.isFinite() && glyph.top.isFinite() && glyph.width > 0 && glyph.height > 0)
      assertTrue(
        "$marker glyph $index must be inside the clipped code viewport: $glyph vs ${node.boundsInRoot}",
        node.boundsInRoot.contains(glyph.topLeft) && node.boundsInRoot.contains(glyph.bottomRight - Offset(0.01f, 0.01f)),
      )
      lastGlyph = glyph
    }
    return lastGlyph
  }

  private data class BoundaryCase(
    val label: String,
    val code: String,
    val lineBreaks: Int? = null,
    val intactTail: String? = null,
  )
}
