package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.SessionDiffFile
import ai.openclaw.app.chat.SessionDiffSnapshot
import ai.openclaw.app.ui.design.ClawDesignTheme
import android.content.ClipboardManager
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertHasNoClickAction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.click
import androidx.compose.ui.test.hasAnyDescendant
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isRoot
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToIndex
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeLeft
import androidx.compose.ui.test.swipeRight
import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.shadows.ShadowToast

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36], qualifiers = "en-rUS-w360dp-h800dp-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class SessionDiffContentTest {
  @get:Rule val composeRule = createComposeRule()

  @Test
  fun nativeReviewKeepsHunksAndIncompleteFileNoticesAcrossDisclosureInBothThemes() {
    val dark = mutableStateOf(false)
    val snapshot = snapshot()
    val files = prepareSessionDiffFiles(snapshot)
    composeRule.setContent {
      ClawDesignTheme(dark = dark.value) {
        SessionDiffContent(snapshot, files, false, null, {}, {}, Modifier.fillMaxSize(), {})
      }
    }
    for (isDark in listOf(false, true)) {
      composeRule.runOnIdle { dark.value = isDark }
      composeRule.onNodeWithText("Review changes").assertIsDisplayed()
      composeRule.onNodeWithText("+ const retries = 3;", substring = true).assertIsDisplayed()
      composeRule.onNodeWithText("− const retries = 1;", substring = true).assertIsDisplayed()
      composeRule.onNodeWithText("@@ -8,3 +8,3 @@", substring = true).assertIsDisplayed()
      composeRule.onNodeWithText("Binary file changed").assertIsDisplayed()
      composeRule.onNodeWithText("This file’s patch was truncated.").assertIsDisplayed()
      val addedLine = composeRule.onNodeWithText("+ const retries = 3;", substring = true)
      addedLine.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Line numbers hidden"))
      composeRule.onNodeWithText("+ const retries = 3;").assertIsDisplayed()
      composeRule.waitForIdle()
      addedLine.performTouchInput { click() }
      addedLine.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Line numbers hidden"))
      addedLine.performTouchInput { swipeRight() }
      addedLine.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Line numbers shown"))
      composeRule.onNodeWithText(" 8 + const retries = 3;").assertIsDisplayed()
      // A fresh rightward edge swipe reveals gutters throughout the viewer.
      composeRule.onNodeWithText(" 1 + export const ready = true;").assertIsDisplayed()
      composeRule.waitForIdle()
      addedLine.performTouchInput { click() }
      addedLine.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Line numbers shown"))
      addedLine.performTouchInput { swipeLeft() }
      addedLine.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Line numbers hidden"))
      composeRule.onNodeWithText("+ export const ready = true;").assertIsDisplayed()

      val header = composeRule.onNodeWithText("src/retry.ts")
      header.performClick()
      header.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Collapsed"))
      composeRule.onNodeWithText("+ const retries = 3;", substring = true).assertDoesNotExist()
      composeRule.onNodeWithText("Binary file changed").assertIsDisplayed()
      header.performClick()
      header.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Expanded"))
      composeRule.onNodeWithText("+ const retries = 3;", substring = true).assertIsDisplayed()
    }
  }

  @Test
  fun wideUnicodeLineExposesOverflowAndKeepsGutterGesturesSeparate() {
    // Wide Unicode glyphs overflow even with the numeric gutters hidden.
    val text = "你好世界".repeat(10) + "🙂"
    val snapshot =
      SessionDiffSnapshot(
        sessionKey = "unicode-review",
        additions = 1,
        deletions = 0,
        files = listOf(SessionDiffFile("unicode.txt", "added", 1, 0, patch = "@@ -0,0 +1 @@\n+$text\n")),
      )
    val files = prepareSessionDiffFiles(snapshot)
    composeRule.setContent {
      ClawDesignTheme {
        SessionDiffContent(snapshot, files, false, null, {}, {}, Modifier.fillMaxSize(), {})
      }
    }
    val codeLine = composeRule.onNodeWithText(text, substring = true)
    // Brief horizontal nudges must not open or close the gutters.
    codeLine.performTouchInput {
      down(center)
      moveTo(Offset(centerX + 40f, centerY), delayMillis = 100)
      up()
    }
    codeLine.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Line numbers hidden"))
    codeLine.performTouchInput { swipeRight() }
    codeLine.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Line numbers shown"))
    val scroller = composeRule.onNode(SemanticsMatcher.keyIsDefined(SemanticsProperties.HorizontalScrollAxisRange))
    composeRule.waitForIdle()
    val before = scroller.fetchSemanticsNode().config[SemanticsProperties.HorizontalScrollAxisRange]
    assertTrue("Wide glyphs must expose their overflow instead of clipping permanently", before.maxValue() > 0f)
    assertEquals(0f, before.value(), 0.01f)
    codeLine.performTouchInput {
      down(center)
      moveTo(Offset(centerX - 40f, centerY), delayMillis = 100)
      up()
    }
    codeLine.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Line numbers shown"))
    assertEquals("A short hide gesture must not pan content", 0f, before.value(), 0.01f)
    // Hiding owns the whole pointer sequence, including continued movement and reversal.
    codeLine.performTouchInput {
      down(Offset(centerX, centerY))
      moveTo(Offset(centerX - 60f, centerY), delayMillis = 100)
      moveTo(Offset(centerX - 100f, centerY), delayMillis = 100)
      moveTo(Offset(centerX + 60f, centerY), delayMillis = 100)
      moveTo(Offset(centerX - 120f, centerY), delayMillis = 100)
      up()
    }
    composeRule.waitForIdle()
    assertEquals("The hiding swipe must not pan content", 0f, before.value(), 0.01f)
    codeLine.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Line numbers hidden"))
    // A fresh pan remains responsive without the larger gutter threshold.
    codeLine.performTouchInput {
      down(center)
      moveTo(Offset(centerX - 40f, centerY), delayMillis = 100)
      up()
    }
    composeRule.waitForIdle()
    val after = scroller.fetchSemanticsNode().config[SemanticsProperties.HorizontalScrollAxisRange]
    assertTrue("A horizontal gesture must pan the Unicode line", after.value() > 0f)
    assertTrue(after.value() <= after.maxValue())
    codeLine.assertIsDisplayed()
    codeLine.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Line numbers hidden"))
    // Returning from a pan must not reveal numbers, even after reaching the edge.
    codeLine.performTouchInput { swipeRight(durationMillis = 600) }
    composeRule.waitForIdle()
    val returned = scroller.fetchSemanticsNode().config[SemanticsProperties.HorizontalScrollAxisRange]
    assertEquals(0f, returned.value(), 0.01f)
    codeLine.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Line numbers hidden"))
    // Reversing a leftward pan within the same pointer sequence cannot re-arm reveal.
    codeLine.performTouchInput {
      down(Offset(centerX, centerY))
      moveTo(Offset(centerX - 90f, centerY), delayMillis = 100)
      moveTo(Offset(centerX + 100f, centerY), delayMillis = 100)
      up()
    }
    composeRule.waitForIdle()
    assertEquals(0f, returned.value(), 0.01f)
    codeLine.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Line numbers hidden"))
    codeLine.performTouchInput { swipeRight() }
    codeLine.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Line numbers shown"))
  }

  @Test
  fun toolbarShowsUncommittedAndRoutesRefreshCopyAndClose() {
    var refreshes = 0
    var closes = 0
    val snapshot = snapshot()
    val files = prepareSessionDiffFiles(snapshot)
    composeRule.setContent {
      ClawDesignTheme {
        SessionDiffContent(
          snapshot,
          files,
          false,
          null,
          { refreshes++ },
          { closes++ },
          Modifier.fillMaxSize(),
          onReference = {},
        )
      }
    }
    composeRule.onNodeWithText("Uncommitted").assertIsDisplayed().assertHasNoClickAction()
    composeRule.onNodeWithText("All changes").assertDoesNotExist()
    composeRule.onNodeWithContentDescription("Refresh changes").performClick()
    val clipboard = requireNotNull(RuntimeEnvironment.getApplication().getSystemService(ClipboardManager::class.java))
    val previousClip = clipboard.primaryClip
    try {
      composeRule.onAllNodesWithContentDescription("Copy patch")[0].performClick()
      composeRule.onNodeWithContentDescription("Close review").performClick()
      composeRule.runOnIdle {
        assertEquals(1, refreshes)
        assertEquals(1, closes)
        assertEquals(
          snapshot.files.first().patch,
          clipboard.primaryClip
            ?.getItemAt(0)
            ?.text
            ?.toString(),
        )
      }
    } finally {
      if (previousClip == null) clipboard.clearPrimaryClip() else clipboard.setPrimaryClip(previousClip)
    }
  }

  @Test
  fun loadingAndFailureDoNotMasqueradeAsNoChanges() {
    val loading = mutableStateOf(true)
    val error = mutableStateOf<String?>(null)
    var retries = 0
    composeRule.setContent {
      ClawDesignTheme {
        SessionDiffContent(
          null,
          emptyList(),
          loading.value,
          error.value,
          { retries++ },
          {},
          Modifier.fillMaxSize(),
          onReference = {},
        )
      }
    }
    composeRule.onNodeWithContentDescription("Refresh changes").assertIsNotEnabled()
    composeRule.onNodeWithText("No changes in this snapshot.").assertDoesNotExist()
    composeRule.runOnIdle {
      loading.value = false
      error.value = "Connection changed. Reopen review."
    }
    composeRule.onNodeWithText("Connection changed. Reopen review.").assertIsDisplayed()
    composeRule.onNodeWithText("No changes in this snapshot.").assertDoesNotExist()
    composeRule.onNodeWithText("Try again").performClick()
    composeRule.runOnIdle { assertEquals(1, retries) }
  }

  @Test
  fun longPressDragSelectsCodeAndOffersCopyOrReferenceAfterRelease() {
    val dark = mutableStateOf(false)
    val snapshot = snapshot()
    val files = prepareSessionDiffFiles(snapshot)
    val references = mutableListOf<String>()
    composeRule.setContent {
      ClawDesignTheme(dark = dark.value) {
        SessionDiffContent(
          snapshot,
          files,
          false,
          null,
          {},
          {},
          Modifier.fillMaxSize(),
          onReference = { references += it },
        )
      }
    }
    val clipboard = RuntimeEnvironment.getApplication().getSystemService(ClipboardManager::class.java)
    val previousClip = clipboard.primaryClip

    fun assertHandles(
      active: String? = null,
      finalized: Boolean = false,
    ) {
      for (edge in listOf("start", "end")) {
        for (side in listOf("left", "right")) {
          val label = "Selection $edge, $side"
          val handle = composeRule.onNodeWithContentDescription(label)
          if (finalized || label == active) handle.assertIsDisplayed() else handle.assertDoesNotExist()
        }
      }
    }
    try {
      for (isDark in listOf(false, true)) {
        composeRule.runOnIdle { dark.value = isDark }
        // Disclosure replaces selection state; cancellation must target the new state.
        val header = composeRule.onNodeWithText("src/retry.ts")
        header.performClick()
        header.performClick()
        val line = composeRule.onNodeWithText("+ const retries = 3;", substring = true)
        line.performTouchInput {
          down(center)
          moveTo(center, delayMillis = 700)
          moveTo(center + Offset(0f, height.toFloat()), delayMillis = 100)
        }
        composeRule.onNodeWithText("To chat").assertDoesNotExist()
        line.assert(SemanticsMatcher.expectValue(SemanticsProperties.Selected, true))
        assertHandles()
        composeRule.waitForIdle()
        line.performTouchInput { up() }
        assertHandles(finalized = true)
        composeRule.onNodeWithText("To chat").assertIsDisplayed()
        composeRule.onNodeWithText("After · src/retry.ts:8-9").assertDoesNotExist()
        // Dismissing a selection must not also reveal hidden line numbers.
        val otherLine = composeRule.onNodeWithText("− const retries = 1;")
        otherLine.performTouchInput { click() }
        composeRule.onNodeWithText("To chat").assertDoesNotExist()
        line.assert(SemanticsMatcher.expectValue(SemanticsProperties.Selected, false))
        line.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Line numbers hidden"))
        line.performTouchInput {
          down(center)
          moveTo(center, delayMillis = 700)
          moveTo(center + Offset(0f, height.toFloat()), delayMillis = 100)
          up()
        }
        val side = if (isDark) "left" else "right"
        val startSide = if (isDark) "right" else "left"
        val endHandle = composeRule.onNodeWithContentDescription("Selection end, $side")
        endHandle.performTouchInput {
          down(center)
          moveTo(center + Offset(0f, 18f), delayMillis = 100)
        }
        composeRule.onNodeWithText("To chat").assertDoesNotExist()
        assertHandles(active = "Selection end, $side")
        composeRule.waitForIdle()
        endHandle.performTouchInput { up() }
        assertHandles(finalized = true)
        composeRule.onNodeWithText("export { retries };", substring = true).assert(SemanticsMatcher.expectValue(SemanticsProperties.Selected, true))
        val startHandle = composeRule.onNodeWithContentDescription("Selection start, $startSide")
        startHandle.performTouchInput {
          down(center)
          moveTo(center + Offset(0f, 36f), delayMillis = 100)
        }
        assertHandles(active = "Selection start, $startSide")
        composeRule.waitForIdle()
        startHandle.performTouchInput { up() }
        assertHandles(finalized = true)
        line.assert(SemanticsMatcher.expectValue(SemanticsProperties.Selected, false))
        composeRule.waitForIdle()
        composeRule.onNodeWithText("Copy").performTouchInput { click() }
        composeRule.runOnIdle {
          assertEquals(
            "export { retries };\n// 你好世界 · ready 🙂",
            clipboard.primaryClip
              ?.getItemAt(0)
              ?.text
              ?.toString(),
          )
          assertEquals("Text copied", ShadowToast.getTextOfLatestToast())
        }
        composeRule.onNodeWithText("Copy").assertDoesNotExist()
        line.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Line numbers hidden"))
        // Cancellation must leave neither a selection nor its actions behind.
        line.performTouchInput {
          down(center)
          moveTo(center, delayMillis = 700)
          cancel()
        }
        line.assert(SemanticsMatcher.expectValue(SemanticsProperties.Selected, false))
        composeRule.onNodeWithText("To chat").assertDoesNotExist()
        line.performTouchInput {
          down(center)
          moveTo(center, delayMillis = 700)
          up()
        }
        // Single-line selections keep all four full touch targets disjoint.
        for (edgeSide in listOf("left", "right")) {
          val startBounds = composeRule.onNodeWithContentDescription("Selection start, $edgeSide").fetchSemanticsNode().boundsInRoot
          val endBounds = composeRule.onNodeWithContentDescription("Selection end, $edgeSide").fetchSemanticsNode().boundsInRoot
          assertTrue(startBounds.height >= 48f && endBounds.height >= 48f)
          assertTrue(startBounds.bottom <= endBounds.top)
        }
        composeRule.onNodeWithContentDescription("Selection end, right").performTouchInput {
          down(center)
          moveTo(center + Offset(0f, 18f), delayMillis = 100)
          up()
        }
        composeRule.onNodeWithText("To chat").performClick()
      }
      composeRule.runOnIdle { assertEquals(List(2) { "src/retry.ts:8-9 (After | Uncommitted)\n```ts\nconst retries = 3;\nexport { retries };\n```" }, references) }
    } finally {
      if (previousClip == null) clipboard.clearPrimaryClip() else clipboard.setPrimaryClip(previousClip)
    }
  }

  @Test
  fun referencePreservesReplacementBeforeSide() {
    val snapshot = snapshot()
    val files = prepareSessionDiffFiles(snapshot)
    val references = mutableListOf<String>()
    composeRule.setContent {
      ClawDesignTheme {
        SessionDiffContent(
          snapshot,
          files,
          false,
          null,
          {},
          {},
          Modifier.fillMaxSize(),
          { references += it },
        )
      }
    }
    composeRule.onNodeWithText("− const retries = 1;").performTouchInput {
      down(center)
      moveTo(center, delayMillis = 700)
      up()
    }
    composeRule.onNodeWithText("To chat").performClick()
    composeRule.runOnIdle {
      assertEquals(
        listOf("src/retry.ts:8-8 (Before | Uncommitted)\n```ts\nconst retries = 1;\n```"),
        references,
      )
    }
  }

  @Test
  fun selectionActionsFollowSelectedEndWhenScrollingBothWays() {
    val snapshot =
      snapshot().copy(
        files =
          listOf(
            SessionDiffFile(
              "src/scroll.ts",
              "added",
              100,
              0,
              patch = "@@ -0,0 +1,100 @@\n" + (1..100).joinToString("\n") { "+line $it" },
            ),
          ),
      )
    val files = prepareSessionDiffFiles(snapshot)
    val dark = mutableStateOf(false)
    composeRule.setContent {
      ClawDesignTheme(dark = dark.value) {
        SessionDiffContent(snapshot, files, false, null, {}, {}, Modifier.fillMaxSize().padding(bottom = 200.dp), {})
      }
    }
    val scroller = composeRule.onNode(hasScrollAction())
    scroller.performScrollToIndex(15)
    val line = composeRule.onNodeWithText("+ line 30")
    line.performTouchInput {
      down(center)
      moveTo(center, delayMillis = 700)
      up()
    }
    composeRule.onNodeWithText("After · src/scroll.ts:30-30").assertDoesNotExist()

    fun popupTop(): Float {
      composeRule.waitForIdle()
      return composeRule
        .onNode(SemanticsMatcher.expectValue(SemanticsProperties.PaneTitle, "Selection actions"))
        .fetchSemanticsNode()
        .positionInWindow.y
    }

    fun anchorGap(): Float {
      val selected = line.fetchSemanticsNode()
      for (side in listOf("left", "right")) {
        val start = composeRule.onNodeWithContentDescription("Selection start, $side").fetchSemanticsNode()
        val end = composeRule.onNodeWithContentDescription("Selection end, $side").fetchSemanticsNode()
        assertEquals("Start handle must follow the row while scrolling", selected.positionInWindow.y, start.positionInWindow.y + start.size.height, 1f)
        assertEquals("End handle must follow the row while scrolling", selected.positionInWindow.y + selected.size.height, end.positionInWindow.y, 1f)
      }
      return popupTop() - (selected.positionInWindow.y + selected.size.height)
    }
    composeRule
      .onNode(isRoot() and hasAnyDescendant(hasText("Review changes")))
      .assert(hasAnyDescendant(hasText("To chat")))
    val initialTop = popupTop()
    val initialGap = anchorGap()
    assertEquals(8f, initialGap, 1f)
    scroller.performTouchInput {
      down(Offset(width - 60f, 200f))
      moveTo(Offset(width - 60f, 180f), delayMillis = 150)
      moveTo(Offset(width - 60f, 160f), delayMillis = 150)
      moveTo(Offset(width - 60f, 146f), delayMillis = 150)
      up()
    }
    assertTrue("Scrolling outside the inline actions must still move code", popupTop() < initialTop)
    assertEquals(initialGap, anchorGap(), 1f)
    scroller.performScrollToIndex(18)
    val scrolledUpTop = popupTop()
    assertTrue("Popup must follow the selection upward", scrolledUpTop < initialTop)
    assertEquals(initialGap, anchorGap(), 1f)
    scroller.performScrollToIndex(16)
    assertTrue("Popup must follow the selection downward", popupTop() > scrolledUpTop)
    assertEquals(initialGap, anchorGap(), 1f)
    // Refinement must start from the current row position, not its pre-scroll coordinates.
    val rowHeight =
      line
        .fetchSemanticsNode()
        .size.height
        .toFloat()
    composeRule.onNodeWithContentDescription("Selection end, right").performTouchInput {
      down(center)
      moveBy(Offset(0f, rowHeight), delayMillis = 100)
      up()
    }
    composeRule.onNodeWithText("+ line 31").assert(SemanticsMatcher.expectValue(SemanticsProperties.Selected, true))
    line.performTouchInput { click() }
    line.performTouchInput {
      down(center)
      moveTo(center, delayMillis = 700)
      up()
    }
    scroller.performScrollToIndex(7)
    val selectedTop = line.fetchSemanticsNode().positionInWindow.y
    val popupHeight =
      composeRule
        .onNode(SemanticsMatcher.expectValue(SemanticsProperties.PaneTitle, "Selection actions"))
        .fetchSemanticsNode()
        .size.height
    assertEquals("Bottom overflow must place actions above selection", selectedTop - 8f - popupHeight, popupTop(), 1f)
    val viewport = scroller.fetchSemanticsNode()
    assertTrue(popupTop() + popupHeight <= viewport.positionInWindow.y + viewport.size.height)
    scroller.performScrollToIndex(70)
    composeRule.onNodeWithText("To chat").assertDoesNotExist()
    scroller.performScrollToIndex(15)
    composeRule.onNodeWithText("To chat").assertIsDisplayed()
    assertEquals(initialGap, anchorGap(), 1f)

    // The selected end can be outside the lazy viewport, not just too low
    // to fit the popup. Keep actions above the remaining visible selection.
    line.performTouchInput { click() }
    val first = composeRule.onNodeWithText("+ line 20")
    val dragDistance = line.fetchSemanticsNode().positionInRoot.y - first.fetchSemanticsNode().positionInRoot.y
    first.performTouchInput {
      down(center)
      moveTo(center, delayMillis = 700)
      moveBy(Offset(0f, dragDistance))
      up()
    }
    scroller.performScrollToIndex(0)
    line.assertDoesNotExist()
    first.assertIsDisplayed()
    composeRule.onNodeWithText("To chat").assertIsDisplayed()
    for (isDark in listOf(false, true)) {
      composeRule.runOnIdle { dark.value = isDark }
      composeRule.onNodeWithText("To chat").assertIsDisplayed()
      assertEquals(first.fetchSemanticsNode().positionInWindow.y - 8f - popupHeight, popupTop(), 1f)
    }
    scroller.performScrollToIndex(15)
    val moveEndDown =
      composeRule
        .onNodeWithContentDescription("Selection end, right")
        .fetchSemanticsNode()
        .config[SemanticsActions.CustomActions]
        .single { it.label == "Move down" }
    composeRule.runOnIdle { repeat(40) { moveEndDown.action() } }
    scroller.performScrollToIndex(30)
    first.assertDoesNotExist()
    composeRule.onNodeWithText("+ line 70").assertDoesNotExist()
    composeRule.onNodeWithText("To chat").assertIsDisplayed()
    assertEquals("A selection spanning both viewport edges keeps its actions visible", scroller.fetchSemanticsNode().positionInWindow.y, popupTop(), 1f)
    scroller.performScrollToIndex(90)
    composeRule.onNodeWithText("To chat").assertDoesNotExist()
  }

  private fun snapshot() =
    SessionDiffSnapshot(
      sessionKey = "synthetic-review",
      branch = "feature/retries",
      additions = 2,
      deletions = 1,
      files =
        listOf(
          SessionDiffFile(
            "src/retry.ts",
            "modified",
            1,
            1,
            patch = "@@ -8,3 +8,3 @@\n-const retries = 1;\n+const retries = 3;\n export { retries };\n // 你好世界 · ready 🙂\n",
          ),
          SessionDiffFile("assets/logo.png", "renamed", 0, 0, oldPath = "assets/mark.png", binary = true),
          SessionDiffFile("generated/index.ts", "added", 1, 0, patch = "@@ -0,0 +1 @@\n+export const ready = true;\n", truncated = true),
        ),
    )
}
