package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatMessageContent
import ai.openclaw.app.chat.ChatReactionSummary
import ai.openclaw.app.gateway.MessageReactionSummaryIdentitiesItem
import ai.openclaw.app.ui.design.ClawDesignTheme
import androidx.compose.foundation.layout.Column
import androidx.compose.runtime.Composable
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotSelected
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performImeAction
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTextReplacement
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "en-rUS-w360dp-h800dp-mdpi")
class ChatMessageReactionsTest {
  @get:Rule val composeRule = createComposeRule()

  @Test
  fun savedPromptsAndRepliesShowCountsNamesAndToggleOnlyTheViewersReaction() {
    val actions = mutableListOf<Triple<String, String, Boolean>>()
    composeRule.setContent {
      ClawDesignTheme {
        Column {
          Message(entryId = "saved-prompt", role = "user", reactions = listOf(ownReaction), onReact = { id, emoji, remove -> actions += Triple(id, emoji, remove) })
          Message(entryId = "saved-reply", reactions = listOf(otherReaction), onReact = { id, emoji, remove -> actions += Triple(id, emoji, remove) })
        }
      }
    }

    composeRule.onNodeWithText("👍 4").assertIsDisplayed().assertIsSelected()
    composeRule.onNodeWithContentDescription("👍 4. You, Alex, Blair and 1 others reacted with 👍").performClick()
    composeRule.onNodeWithText("🚀 1").assertIsDisplayed().assertIsNotSelected()
    composeRule.onNodeWithContentDescription("🚀 1. Alex reacted with 🚀").performClick()
    assertEquals(listOf(Triple("saved-prompt", "👍", true), Triple("saved-reply", "🚀", false)), actions)
  }

  @Test
  fun permissionLossRetainsChipsWithoutControlsAndRetiresTheOpenPicker() {
    val writable = mutableStateOf(true)
    composeRule.setContent {
      ClawDesignTheme {
        Message(
          reactions = listOf(ownReaction),
          onReact = if (writable.value) ({ _, _, _ -> }) else null,
        )
      }
    }
    composeRule.onNodeWithContentDescription("Add reaction").performClick()
    composeRule.onNodeWithText("Quick reactions").assertIsDisplayed()
    composeRule.runOnIdle { writable.value = false }
    composeRule.onNodeWithText("Quick reactions").assertDoesNotExist()
    composeRule.onNodeWithContentDescription("Add reaction").assertDoesNotExist()
    composeRule
      .onNodeWithContentDescription("👍 4. You, Alex, Blair and 1 others reacted with 👍", useUnmergedTree = true)
      .assertIsDisplayed()
      .assert(hasClickAction().not())
    composeRule.runOnIdle { writable.value = true }
    composeRule.onNodeWithText("Quick reactions").assertDoesNotExist()
  }

  @Test
  fun mediaOnlyRepliesOfferTheWebPaletteThroughMessageActions() {
    val actions = mutableListOf<Triple<String, String, Boolean>>()
    composeRule.setContent {
      ClawDesignTheme {
        Message(
          content = listOf(ChatMessageContent(type = "file", fileName = "diagram.png")),
          onReact = { id, emoji, remove -> actions += Triple(id, emoji, remove) },
        )
      }
    }
    composeRule
      .onNode(hasContentDescription("OpenClaw") and hasText("diagram.png"))
      .performSemanticsAction(SemanticsActions.OnLongClick) { it() }
    composeRule.onNodeWithText("Copy").assertDoesNotExist()
    composeRule.onNodeWithText("Add reaction").performClick()
    val positions =
      listOf("👍", "❤️", "🎉", "👀", "🚀", "😂").map { emoji ->
        composeRule
          .onNodeWithText(emoji)
          .assertIsDisplayed()
          .fetchSemanticsNode()
          .boundsInRoot.left
      }
    assertTrue(positions.zipWithNext().all { (first, second) -> first < second })
    composeRule.onNodeWithText("🎉").performClick()
    assertEquals(listOf(Triple("saved-reply", "🎉", false)), actions)
    composeRule.onNodeWithText("Quick reactions").assertDoesNotExist()
  }

  @Test
  fun moreRejectsMultipleGraphemesAndAcceptsOneJoinedEmoji() {
    val actions = mutableListOf<Triple<String, String, Boolean>>()
    composeRule.setContent {
      ClawDesignTheme {
        Message(onReact = { id, emoji, remove -> actions += Triple(id, emoji, remove) })
      }
    }
    composeRule
      .onNode(hasContentDescription("OpenClaw") and hasText("Saved reply"))
      .performSemanticsAction(SemanticsActions.OnLongClick) { it() }
    composeRule.onNodeWithText("Add reaction").performClick()
    composeRule.onNodeWithText("More…").performClick()
    composeRule.onNode(hasSetTextAction()).performTextReplacement("👍🎉")
    composeRule.onNode(hasSetTextAction()).performImeAction()
    composeRule.onNodeWithText("Reactions are a single emoji.").assertIsDisplayed()
    assertTrue(actions.isEmpty())
    composeRule.onNode(hasSetTextAction()).performTextReplacement("👩🏽‍💻")
    assertEquals(listOf(Triple("saved-reply", "👩🏽‍💻", false)), actions)
    composeRule.onNode(hasSetTextAction()).assertDoesNotExist()
  }

  @Test
  fun optimisticAndStreamingRowsNeverExposeReactions() {
    composeRule.setContent {
      ClawDesignTheme {
        Column {
          Message(entryId = null, role = "user", reactions = listOf(ownReaction), onReact = { _, _, _ -> })
          Message(live = true, reactions = listOf(otherReaction), onReact = { _, _, _ -> })
        }
      }
    }
    composeRule.onNodeWithText("👍 4").assertDoesNotExist()
    composeRule.onNodeWithText("🚀 1").assertDoesNotExist()
    composeRule.onNodeWithContentDescription("Add reaction").assertDoesNotExist()
    composeRule
      .onNode(hasContentDescription("You") and hasText("Saved reply"))
      .performSemanticsAction(SemanticsActions.OnLongClick) { it() }
    composeRule.onNodeWithText("Add reaction").assertDoesNotExist()
  }

  @Composable
  private fun Message(
    entryId: String? = "saved-reply",
    role: String = "assistant",
    live: Boolean = false,
    content: List<ChatMessageContent> = listOf(ChatMessageContent(text = "Saved reply")),
    reactions: List<ChatReactionSummary> = emptyList(),
    onReact: ((String, String, Boolean) -> Unit)? = null,
  ) {
    ChatBubble(
      messageId = "local-$entryId",
      entryId = entryId,
      role = role,
      live = live,
      content = content,
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
      reactions = reactions,
      reactionViewerId = "viewer",
      onReact = onReact,
    )
  }

  private val ownReaction =
    ChatReactionSummary(
      "👍",
      4,
      listOf(
        MessageReactionSummaryIdentitiesItem("alex", "Alex"),
        MessageReactionSummaryIdentitiesItem("blair", "Blair"),
        MessageReactionSummaryIdentitiesItem("viewer", "Viewer"),
        MessageReactionSummaryIdentitiesItem("casey", "Casey"),
      ),
    )
  private val otherReaction = ChatReactionSummary("🚀", 1, listOf(MessageReactionSummaryIdentitiesItem("alex", "Alex")))
}
