package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatQuestionPrompt
import ai.openclaw.app.gateway.Question
import ai.openclaw.app.gateway.QuestionOption
import ai.openclaw.app.gateway.QuestionRecord
import ai.openclaw.app.ui.design.ClawDesignTheme
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsNotSelected
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w1000dp-h1000dp-mdpi")
class ChatQuestionCardAccessibilityTest {
  @get:Rule
  val composeRule = createComposeRule()

  @Test
  fun singleChoiceAnnouncesSelectionThroughChangesAndSubmission() {
    var prompt by mutableStateOf(questionPrompt(multiSelect = false))
    var submitted: Map<String, List<String>>? = null
    composeRule.setContent {
      ClawDesignTheme {
        ChatQuestionCard(
          prompt = prompt,
          onDraftChanged = { _, update -> prompt = prompt.copy(draft = update(prompt.draft)) },
          onSubmit = { _, answers ->
            submitted = answers
            prompt = prompt.copy(submitting = true)
          },
          onSkip = {},
        )
      }
    }
    val pizza = composeRule.onNode(hasText("Pizza") and hasClickAction())
    val tacos = composeRule.onNode(hasText("Tacos") and hasClickAction())
    val radio = SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.RadioButton)
    pizza.assertIsEnabled()
    tacos.assertIsEnabled()
    pizza.assertIsSelected()
    tacos.assertIsNotSelected()
    pizza.assert(radio)
    tacos.assert(radio)

    tacos.performClick()
    composeRule.waitForIdle()
    pizza.assertIsNotSelected()
    tacos.assertIsSelected()
    tacos.performClick()
    composeRule.waitForIdle()
    tacos.assertIsNotSelected()
    composeRule.onNodeWithText("Submit").assertIsNotEnabled()

    pizza.performClick()
    composeRule.waitForIdle()
    pizza.assertIsSelected()
    composeRule.onNodeWithText("Submit").performClick()
    composeRule.waitForIdle()
    assertEquals(mapOf("meal" to listOf("meal:pizza")), submitted)
    pizza.assertIsNotEnabled()
    tacos.assertIsNotEnabled()
    pizza.assertIsSelected()
    tacos.assertIsNotSelected()
  }

  @Test
  fun multipleChoiceAnnouncesIndependentCheckedStatesThroughSubmission() {
    var prompt by mutableStateOf(questionPrompt(multiSelect = true))
    var submitted: Map<String, List<String>>? = null
    composeRule.setContent {
      ClawDesignTheme {
        ChatQuestionCard(
          prompt = prompt,
          onDraftChanged = { _, update -> prompt = prompt.copy(draft = update(prompt.draft)) },
          onSubmit = { _, answers ->
            submitted = answers
            prompt = prompt.copy(submitting = true)
          },
          onSkip = {},
        )
      }
    }
    val pizza = composeRule.onNode(hasText("Pizza") and hasClickAction())
    val tacos = composeRule.onNode(hasText("Tacos") and hasClickAction())
    val checkbox = SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Checkbox)
    pizza.assertIsEnabled()
    tacos.assertIsEnabled()
    pizza.assertIsOn()
    tacos.assertIsOff()
    pizza.assert(checkbox)
    tacos.assert(checkbox)

    tacos.performClick()
    composeRule.waitForIdle()
    pizza.assertIsOn()
    tacos.assertIsOn()
    pizza.performClick()
    composeRule.waitForIdle()
    pizza.assertIsOff()
    tacos.assertIsOn()
    pizza.performClick()
    composeRule.waitForIdle()
    pizza.assertIsOn()
    tacos.assertIsOn()

    composeRule.onNodeWithText("Submit").performClick()
    composeRule.waitForIdle()
    assertEquals(mapOf("meal" to listOf("meal:pizza", "Tacos")), submitted)
    pizza.assertIsNotEnabled()
    tacos.assertIsNotEnabled()
    pizza.assertIsOn()
    tacos.assertIsOn()
  }

  private fun questionPrompt(multiSelect: Boolean): ChatQuestionPrompt {
    val question =
      Question(
        questionId = "meal",
        header = "Dinner",
        question = "What would you like for dinner?",
        options = listOf(QuestionOption("Pizza", value = "meal:pizza"), QuestionOption("Tacos")),
        multiSelect = multiSelect,
        defaultAnswers = listOf("meal:pizza"),
      )
    val now = System.currentTimeMillis()
    val record =
      QuestionRecord(
        id = "dinner-question",
        questions = listOf(question),
        agentId = "main",
        sessionKey = "agent:main:main",
        createdAtMs = now,
        expiresAtMs = now + 600_000,
        status = "pending",
      )
    return ChatQuestionPrompt(record)
  }
}
