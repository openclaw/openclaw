package ai.openclaw.app.calls

import ai.openclaw.app.ui.OpenClawTheme
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.assertIsSelected
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
@Config(sdk = [34], qualifiers = "w412dp-h915dp")
class IncomingCallScreenTest {
  @get:Rule val compose = createComposeRule()

  @Test
  fun ringingRequiresAnswerAndDoesNotExposePrivateTopic() {
    var answers = 0
    var ends = 0
    compose.setContent {
      OpenClawTheme {
        IncomingCallScreen(call(), false, emptyList(), "Earpiece", { answers++ }, { ends++ }, {}, {})
      }
    }
    assertEquals(0, answers)
    compose.onNodeWithText("Private test dossier").assertDoesNotExist()
    compose.onNodeWithText("Mute microphone").assertDoesNotExist()
    compose.onNodeWithText("Answer").performClick()
    assertEquals(1, answers)
    compose.onNodeWithText("Decline").performClick()
    assertEquals(1, ends)
  }

  @Test
  fun activeMuteRouteAndEndReflectControllerState() {
    val muted = mutableStateOf(false)
    val status = mutableStateOf(IncomingCallStatus.Active)
    var route: String? = null
    compose.setContent {
      OpenClawTheme {
        IncomingCallScreen(
          call(status.value),
          muted.value,
          listOf("earpiece" to "Earpiece", "speaker" to "Speaker"),
          "Earpiece",
          {},
          { status.value = IncomingCallStatus.Ended },
          { muted.value = !muted.value },
          { route = it },
        )
      }
    }
    compose.onNodeWithText("Answer").assertDoesNotExist()
    compose.onNodeWithText("Mute microphone").performClick()
    compose.onNodeWithText("Unmute microphone").assertIsSelected()
    compose.onNodeWithText("Connected · microphone muted").assertExists()
    compose.onNodeWithText("Audio output").performClick()
    compose.onNodeWithText("Speaker").performClick()
    assertEquals("speaker", route)
    compose.onNodeWithText("End call").performClick()
    compose.onNodeWithText("Call ended").assertExists()
    compose.onNodeWithText("Unmute microphone").assertDoesNotExist()
    compose.onNodeWithText("End call").assertDoesNotExist()
    compose.onNodeWithText("Close").assertExists()
  }

  private fun call(status: IncomingCallStatus = IncomingCallStatus.Ringing) =
    IncomingCallState(
      IncomingCallInvite("fixture", "agent:assistant:fixture", "Assistant", "Private test dossier", Long.MAX_VALUE),
      "fixture-gateway",
      status,
    )
}
