package ai.openclaw.app.ui.chat

import ai.openclaw.app.NodeRuntime
import ai.openclaw.app.chat.ChatBrowserTab
import ai.openclaw.app.ui.OpenClawTheme
import android.app.Application
import androidx.compose.foundation.layout.height
import androidx.compose.material3.Text
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.click
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.unit.dp
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [31], qualifiers = "w360dp-h800dp", application = Application::class)
class ChatBrowserCardLayoutTest {
  @get:Rule
  val composeRule = createComposeRule()

  @Test
  fun collapseReturnsTranscriptSpaceAndCloseWorksWithoutBrowserControl() {
    val height = mutableStateOf(600.dp)
    val connected = mutableStateOf(true)
    val canControl = mutableStateOf(true)
    val visible = mutableStateOf(true)
    composeRule.setContent {
      OpenClawTheme {
        ChatBrowserLayout(
          modifier = Modifier.height(height.value),
          browser = { availableHeight ->
            if (visible.value) {
              ChatBrowserCard(
                tab = ChatBrowserTab("host", null, "openclaw", "travel", "https://example.test/travel", "Travel checklist"),
                sessionKey = "agent:main:travel",
                page = NodeRuntime.GatewayControlPage(baseUrl = "https://gateway.example.test", tlsFingerprintSha256 = null, browserFocusAvailable = true),
                connected = connected.value,
                canControl = canControl.value,
                availableHeight = availableHeight,
                onClose = { visible.value = false },
              )
            }
          },
        ) {
          Text("Conversation stays here")
        }
      }
    }
    for (availableHeight in listOf(600.dp, 240.dp)) {
      composeRule.runOnIdle { height.value = availableHeight }
      composeRule.onNodeWithContentDescription("Control browser").performTouchInput { click() }
      val expandedTop = composeRule.onNodeWithText("Agent browser").getUnclippedBoundsInRoot().top
      composeRule.onNodeWithContentDescription("Collapse browser").performTouchInput { click() }
      val collapsedTop = composeRule.onNodeWithText("Agent browser").getUnclippedBoundsInRoot().top
      assertTrue("Collapse must return transcript space at $availableHeight", collapsedTop > expandedTop)
    }
    for ((online, authorized) in listOf(false to true, true to false)) {
      composeRule.runOnIdle {
        connected.value = online
        canControl.value = authorized
        visible.value = true
      }
      composeRule.onNodeWithText("Agent browser").assertIsDisplayed()
      composeRule.onNodeWithContentDescription("Control browser").assertIsNotEnabled()
      composeRule.onNodeWithContentDescription("Close").performTouchInput { click() }
      composeRule.onNodeWithText("Agent browser").assertDoesNotExist()
      composeRule.onNodeWithText("Conversation stays here").assertIsDisplayed()
    }
  }
}
