package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatSessionEntry
import ai.openclaw.app.chat.ChatSwarmGroup
import ai.openclaw.app.chat.buildChatSwarmGroups
import ai.openclaw.app.ui.design.ClawDesignTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "en-rUS-w360dp-h800dp-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ChatSwarmHeaderLayoutTest {
  @get:Rule val composeRule = createComposeRule()

  @Test
  fun uuidGroupKeepsAllCountsReadableAtPhoneWidthsAndLargerText() {
    val label = "11111111-2222-4333-8444-555555555555"
    val width = mutableStateOf(360)
    val scale = mutableStateOf(1f)
    val groups = groups(label)
    assertEquals(label, groups.single().label)
    composeRule.setContent {
      CompositionLocalProvider(LocalDensity provides Density(LocalDensity.current.density, scale.value)) {
        ClawDesignTheme {
          Box(Modifier.width(width.value.dp).padding(horizontal = 16.dp)) {
            ChatSwarmProgress(groups)
          }
        }
      }
    }

    for ((phoneWidth, fontScale) in listOf(360 to 1f, 320 to 1.4f, 320 to 2f)) {
      composeRule.runOnIdle {
        width.value = phoneWidth
        scale.value = fontScale
      }
      val counts = assertReadableCounts("1 Running · 1 Done · 1 Failed", fontScale)
      val title = composeRule.onNodeWithText(label, useUnmergedTree = true)
      title.assertIsDisplayed()
      val titleBounds = title.fetchSemanticsNode().boundsInRoot
      assertTrue("The group label must retain visible width", titleBounds.width > 0f)
      assertTrue("Counts must wrap below the long label", counts.top >= titleBounds.bottom)
    }
  }

  @Test
  fun shortGroupKeepsInlineCountsAndReflectsWorkerCompletion() {
    val rows = mutableStateOf(groups("qa"))
    composeRule.setContent {
      ClawDesignTheme {
        Box(Modifier.width(360.dp).padding(horizontal = 16.dp)) {
          ChatSwarmProgress(rows.value)
        }
      }
    }

    val states =
      listOf(
        false to "1 Running · 1 Done · 1 Failed",
        true to "1 Running · 2 Done · 0 Failed",
      )
    for ((completed, summary) in states) {
      composeRule.runOnIdle { rows.value = groups("qa", completed) }
      val counts = assertReadableCounts(summary, 1f)
      val title = composeRule.onNodeWithText("qa", useUnmergedTree = true)
      title.assertIsDisplayed()
      val titleBounds = title.fetchSemanticsNode().boundsInRoot
      assertTrue("Short labels and counts should remain inline", counts.left >= titleBounds.right)
      assertTrue("Inline header text must share a row", counts.top < titleBounds.bottom)
    }
  }

  private fun assertReadableCounts(
    summary: String,
    fontScale: Float,
  ): Rect {
    val node = composeRule.onNodeWithText(summary, useUnmergedTree = true)
    val layouts = mutableListOf<TextLayoutResult>()
    node.performSemanticsAction(SemanticsActions.GetTextLayoutResult) { assertTrue(it(layouts)) }
    val layout = layouts.single()
    assertFalse("All three worker counts must fit without clipping", layout.didOverflowHeight)
    node.assertIsDisplayed()
    assertEquals(fontScale, layout.layoutInput.density.fontScale, 0.001f)
    val bounds = node.fetchSemanticsNode().boundsInRoot
    assertTrue("Worker counts must have visible width", bounds.width > 0f)
    for (line in 0 until layout.lineCount) {
      assertFalse("Worker counts must not be ellipsized", layout.isLineEllipsized(line))
      assertTrue("The whole count line must be visible", layout.getLineRight(line) <= bounds.width + 0.5f)
      assertTrue("The whole count line must fit vertically", layout.getLineBottom(line) <= bounds.height + 0.5f)
    }
    return bounds
  }

  private fun groups(
    label: String,
    completed: Boolean = false,
  ): List<ChatSwarmGroup> {
    val parent = "agent:main:parent"
    val statuses = listOf("running", "done", if (completed) "done" else "failed")
    val sessions =
      statuses.mapIndexed { index, status ->
        ChatSessionEntry(
          key = "agent:main:subagent:worker-$index",
          updatedAtMs = 1,
          displayName = "Worker $index",
          parentSessionKey = parent,
          swarmGroupId = "swarm:$parent:$label",
          status = status,
        )
      }
    return buildChatSwarmGroups(sessions) { it == parent }
  }
}
