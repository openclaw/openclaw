package ai.openclaw.app.ui.chat

import ai.openclaw.app.ui.design.ClawDesignTheme
import ai.openclaw.app.ui.design.ClawTheme
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.text.TextLayoutResult
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36], qualifiers = "en-rUS-w800dp-h600dp-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ChatMarkdownTableLayoutTest {
  @get:Rule
  val composeRule = createComposeRule()

  @Test
  fun headerAndBodyTextFollowColumnAlignment() {
    composeRule.setContent {
      ClawDesignTheme(dark = true) {
        ChatMarkdown(
          text =
            """
            | Fruit | Color | Count | Price |
            | ----- | :---- | :---: | ----: |
            | Pear  | Green | 7     | 15    |
            """.trimIndent(),
          textColor = ClawTheme.colors.text,
        )
      }
    }

    assertLeadingSpace(0f, "Fruit", "Pear")
    assertLeadingSpace(0f, "Color", "Green")
    assertLeadingSpace(0.5f, "Count", "7")
    assertLeadingSpace(1f, "Price", "15")
  }

  private fun assertLeadingSpace(
    fraction: Float,
    vararg labels: String,
  ) {
    for (label in labels) {
      val results = mutableListOf<TextLayoutResult>()
      composeRule.onNodeWithText(label, useUnmergedTree = true).performSemanticsAction(SemanticsActions.GetTextLayoutResult) {
        assertTrue(it(results))
      }
      val layout = results.single()
      val left = layout.getLineLeft(0)
      val textWidth = layout.getLineRight(0) - left
      val freeSpace = layout.size.width - textWidth
      assertTrue("$label must have room for alignment", freeSpace > 2f)
      assertEquals("$label leading space", fraction * freeSpace, left, 1f)
    }
  }
}
