package ai.openclaw.app.ui.chat

import ai.openclaw.app.ui.design.ClawDesignTheme
import android.content.Context
import android.provider.Settings
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertHeightIsEqualTo
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertWidthIsEqualTo
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(qualifiers = "w360dp-h720dp-420dpi")
class ChatComposerLayoutTest {
  @get:Rule
  val composeRule = createComposeRule()

  @Before
  fun disableAnimations() {
    val context = ApplicationProvider.getApplicationContext<Context>()
    Settings.Global.putFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
  }

  @Test
  fun compactComposerPreservesEditorWidthAndEveryUtilityAction() {
    var imagePicks = 0
    var documentPicks = 0
    var videoPicks = 0
    var dictationToggles = 0
    var voiceNotes = 0
    setComposer(
      onPickImages = { imagePicks += 1 },
      onPickAudioOrDocument = { documentPicks += 1 },
      onPickVideo = { videoPicks += 1 },
      onToggleDictation = { dictationToggles += 1 },
      onStartVoiceNote = { voiceNotes += 1 },
    )

    val editorBounds =
      composeRule
        .onNodeWithTag("chat-composer-editor")
        .assertIsDisplayed()
        .getUnclippedBoundsInRoot()
    val attachImage = composeRule.onNodeWithContentDescription("Attach image").assertIsDisplayed()
    val attachDocument = composeRule.onNodeWithContentDescription("Attachment").assertIsDisplayed()
    val attachVideo = composeRule.onNodeWithContentDescription("Attach video").assertIsDisplayed()
    val voiceAction = composeRule.onNodeWithTag("chat-composer-voice-action").assertIsDisplayed()

    assertTrue("compact editor should remain at least 240dp wide", editorBounds.right - editorBounds.left >= 240.dp)
    assertTrue(
      "utility actions should stack below the editor row",
      attachImage.getUnclippedBoundsInRoot().top >= editorBounds.bottom,
    )
    listOf(attachImage, attachDocument, attachVideo, voiceAction).forEach { action ->
      action.assertWidthIsEqualTo(48.dp).assertHeightIsEqualTo(48.dp)
    }

    attachImage.performClick()
    attachDocument.performClick()
    attachVideo.performClick()
    voiceAction.performClick()
    voiceAction.performTouchInput { longClick() }

    assertEquals(1, imagePicks)
    assertEquals(1, documentPicks)
    assertEquals(1, videoPicks)
    assertEquals(1, dictationToggles)
    assertEquals(1, voiceNotes)
  }

  @Test
  fun compactComposerKeepsTalkAndSendActionsAvailable() {
    val value = mutableStateOf("")
    val sendEnabled = mutableStateOf(false)
    val talkActive = mutableStateOf(false)
    var sends = 0
    var talkToggles = 0
    setComposer(
      value = value,
      sendEnabled = sendEnabled,
      talkActive = talkActive,
      onSend = { sends += 1 },
      onToggleTalk = { talkToggles += 1 },
    )

    composeRule
      .onNodeWithContentDescription("Start Talk")
      .assertIsDisplayed()
      .assertWidthIsEqualTo(48.dp)
      .assertHeightIsEqualTo(48.dp)
      .performClick()
    composeRule.runOnIdle {
      value.value = "A draft with enough text to confirm the editor remains readable"
      sendEnabled.value = true
    }
    composeRule
      .onNodeWithContentDescription("Send")
      .assertIsDisplayed()
      .assertWidthIsEqualTo(48.dp)
      .assertHeightIsEqualTo(48.dp)
      .performClick()
    composeRule.runOnIdle { talkActive.value = true }
    composeRule
      .onNodeWithContentDescription("End Talk")
      .assertIsDisplayed()
      .assertWidthIsEqualTo(48.dp)
      .assertHeightIsEqualTo(48.dp)
      .performClick()

    assertEquals(1, sends)
    assertEquals(2, talkToggles)
  }

  private fun setComposer(
    value: MutableState<String> = mutableStateOf(""),
    sendEnabled: MutableState<Boolean> = mutableStateOf(false),
    talkActive: MutableState<Boolean> = mutableStateOf(false),
    onPickImages: () -> Unit = {},
    onPickAudioOrDocument: () -> Unit = {},
    onPickVideo: () -> Unit = {},
    onToggleDictation: () -> Unit = {},
    onStartVoiceNote: () -> Unit = {},
    onToggleTalk: () -> Unit = {},
    onSend: () -> Unit = {},
  ) {
    composeRule.setContent {
      ClawDesignTheme {
        Box(modifier = Modifier.width(328.dp)) {
          ChatInputPill(
            value = value.value,
            onValueChange = { value.value = it },
            onPickImages = onPickImages,
            onPickAudioOrDocument = onPickAudioOrDocument,
            onPickVideo = onPickVideo,
            onStartVoiceNote = onStartVoiceNote,
            recordVoiceNoteEnabled = true,
            dictationActive = false,
            dictationEnabled = true,
            onToggleDictation = onToggleDictation,
            talkActive = talkActive.value,
            onToggleTalk = onToggleTalk,
            sendEnabled = sendEnabled.value,
            onSend = onSend,
          )
        }
      }
    }
  }
}
