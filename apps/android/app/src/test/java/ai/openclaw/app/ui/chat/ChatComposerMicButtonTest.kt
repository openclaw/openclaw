package ai.openclaw.app.ui.chat

import ai.openclaw.app.ui.design.ClawDesignTheme
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class ChatComposerMicButtonTest {
  @get:Rule
  val composeRule = createComposeRule()

  @Test
  fun micButtonIsNamedForScreenReaders() {
    val state = mutableStateOf<ChatDictationState>(ChatDictationState.Idle)
    composeRule.setContent {
      ClawDesignTheme {
        ChatComposerMicButton(
          dictationState = state.value,
          dictationEnabled = true,
          voiceNoteEnabled = false,
          onToggleDictation = {},
          onStartVoiceNote = {},
        )
      }
    }

    composeRule.onNodeWithContentDescription("Dictation", useUnmergedTree = true).assertExists()
    state.value = ChatDictationState.Listening
    composeRule.onNodeWithContentDescription("Stop Dictation", useUnmergedTree = true).assertExists()
    composeRule.onNodeWithContentDescription("Stop Dictation").assertHasClickAction()
  }
}
