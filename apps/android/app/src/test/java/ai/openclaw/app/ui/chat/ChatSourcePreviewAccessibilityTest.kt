package ai.openclaw.app.ui.chat

import ai.openclaw.app.ui.design.ClawDesignTheme
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotSelected
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w1000dp-h1000dp-mdpi")
class ChatSourcePreviewAccessibilityTest {
  @get:Rule
  val composeRule = createComposeRule()

  @Test
  fun sourceCardsExposeWhichRecordedExcerptIsOpenAndClearSelectionWhenCollapsed() {
    val sources =
      listOf(
        ChatSourcePreview(
          url = "https://example.com/harbor",
          title = "Harbor guide",
          domain = "example.com",
          excerpt = "The harbor path follows the water.",
          pageExcerpt = false,
          aliases = setOf("https://example.com/harbor"),
        ),
        ChatSourcePreview(
          url = "https://example.org/park",
          title = "Park guide",
          domain = "example.org",
          excerpt = "The park path crosses the meadow.",
          pageExcerpt = true,
          aliases = setOf("https://example.org/park"),
        ),
      )
    composeRule.setContent {
      ClawDesignTheme {
        ChatSourcePreviews(sources, config = null, loadFavicon = { _, _ -> null })
      }
    }
    val harbor = composeRule.onNodeWithText("Harbor guide")
    val park = composeRule.onNodeWithText("Park guide")
    composeRule.onNodeWithText("The harbor path follows the water.").assertDoesNotExist()
    composeRule.onNodeWithText("The park path crosses the meadow.").assertDoesNotExist()

    harbor.performClick()
    composeRule.waitForIdle()
    composeRule.onNodeWithText("The harbor path follows the water.").assertIsDisplayed()
    composeRule.onNodeWithText("The park path crosses the meadow.").assertDoesNotExist()
    harbor.assertIsSelected()
    park.assertIsNotSelected()

    park.performClick()
    composeRule.waitForIdle()
    composeRule.onNodeWithText("The park path crosses the meadow.").assertIsDisplayed()
    composeRule.onNodeWithText("The harbor path follows the water.").assertDoesNotExist()
    park.assertIsSelected()
    harbor.assertIsNotSelected()

    park.performClick()
    composeRule.waitForIdle()
    composeRule.onNodeWithText("The park path crosses the meadow.").assertDoesNotExist()
    composeRule.onNodeWithText("The harbor path follows the water.").assertDoesNotExist()
    harbor.assertIsNotSelected()
    park.assertIsNotSelected()
  }
}
