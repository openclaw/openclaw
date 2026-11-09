package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatMessageContent
import ai.openclaw.app.chat.ChatReactionSummary
import ai.openclaw.app.gateway.MessageReactionSummaryIdentitiesItem
import ai.openclaw.app.ui.design.ClawDesignTheme
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.click
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isDialog
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.unit.Density
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "en-rUS-w360dp-h800dp-mdpi")
class ChatReactionPickerViewportTest {
  @get:Rule val composeRule = createComposeRule()

  @Test
  @Config(qualifiers = "en-rUS-w640dp-h320dp-land-mdpi")
  fun customReactionActionsRemainReachableInAShortWindowWithLargeText() {
    val actions = showMessage(fontScale = 2f)
    composeRule.onNodeWithContentDescription("Add reaction").performClick()
    composeRule.onNodeWithText("More…").assertIsDisplayed()
    composeRule.onNodeWithText("More…").performTouchInput { click() }
    composeRule.onNode(hasSetTextAction()).performTextReplacement("not an emoji")

    val submit = composeRule.onNode(hasText("Add reaction") and hasClickAction())
    submit.performScrollTo()
    submit.assertIsDisplayed()
    submit.performTouchInput { click() }
    composeRule.onNodeWithText("Reactions are a single emoji.").assertIsDisplayed()
    assertTrue(actions.isEmpty())

    composeRule.onNode(hasSetTextAction()).performTextReplacement("👩🏽‍💻")
    assertEquals(listOf(Triple("saved-reply", "👩🏽‍💻", false)), actions)
    composeRule.onNode(isDialog()).assertDoesNotExist()
  }

  @Test
  fun roomyPickerStillTogglesAnExistingReactionAndReturnsFromCustomEntry() {
    val actions = showMessage(fontScale = 1f)
    composeRule.onNodeWithContentDescription("Add reaction").performClick()
    composeRule.onNodeWithText("More…").performTouchInput { click() }
    composeRule.onNodeWithText("Back to quick reactions").performTouchInput { click() }
    composeRule.onNodeWithText("Quick reactions").assertIsDisplayed()
    assertTrue(actions.isEmpty())
    composeRule.onNodeWithText("👍").performTouchInput { click() }
    assertEquals(listOf(Triple("saved-reply", "👍", true)), actions)
    composeRule.onNode(isDialog()).assertDoesNotExist()
  }

  private fun showMessage(fontScale: Float): MutableList<Triple<String, String, Boolean>> {
    val actions = mutableListOf<Triple<String, String, Boolean>>()
    composeRule.setContent {
      CompositionLocalProvider(LocalDensity provides Density(LocalDensity.current.density, fontScale)) {
        ClawDesignTheme {
          ChatBubble(
            messageId = "local-reply",
            entryId = "saved-reply",
            role = "assistant",
            live = false,
            content = listOf(ChatMessageContent(text = "Saved reply")),
            timestampMs = null,
            onReplyMessage = {},
            sessionActionsEnabled = false,
            onRewindMessage = {},
            onForkMessage = {},
            speechState = null,
            onToggleListen = { _, _ -> },
            inlineMediaPlaybackBlocked = false,
            inlineWidgetResolverReady = false,
            resolveInlineWidgetResource = { _, _ -> null },
            loadImageArtifact = { null },
            loadMediaArtifact = { _, _, _ -> null },
            reactions =
              listOf(
                ChatReactionSummary(
                  "👍",
                  1,
                  listOf(MessageReactionSummaryIdentitiesItem("viewer", "Viewer")),
                ),
              ),
            reactionViewerId = "viewer",
            onReact = { id, emoji, remove -> actions += Triple(id, emoji, remove) },
          )
        }
      }
    }
    return actions
  }
}
