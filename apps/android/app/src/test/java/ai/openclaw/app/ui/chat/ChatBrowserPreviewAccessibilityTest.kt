package ai.openclaw.app.ui.chat

import ai.openclaw.app.NodeRuntime
import ai.openclaw.app.chat.ChatBrowserTab
import ai.openclaw.app.ui.OpenClawTheme
import android.app.Application
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertContentDescriptionEquals
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.click
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [31], qualifiers = "w1000dp-h1000dp-mdpi", application = Application::class)
class ChatBrowserPreviewAccessibilityTest {
  @get:Rule
  val composeRule = createComposeRule()

  private val previewAction =
    SemanticsMatcher("preview control action") { node ->
      node.config.getOrNull(SemanticsActions.OnClick)?.label == "Control browser"
    }

  private val tab =
    ChatBrowserTab("host", null, "openclaw", "travel", "https://example.test/travel", "Travel checklist")

  private val page =
    NodeRuntime.GatewayControlPage(
      baseUrl = "https://gateway.example.test",
      tlsFingerprintSha256 = null,
      browserFocusAvailable = true,
    )

  @Test
  fun previewHasItsOwnNameAndButtonRoleWithoutChangingHeaderOrPointerActions() {
    composeRule.setContent {
      OpenClawTheme {
        ChatBrowserCard(tab, "agent:main:travel", page, true, true, 600.dp, onClose = {})
      }
    }
    val preview = composeRule.onNode(previewAction)
    preview.assertContentDescriptionEquals("Agent browser")
    preview.assert(SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Button))
    preview.assertIsEnabled()
    val header = composeRule.onNodeWithContentDescription("Control browser")
    header.assertIsEnabled()
    preview.performClick()
    composeRule.waitForIdle()
    preview.assertDoesNotExist()
    val collapse = composeRule.onNodeWithContentDescription("Collapse browser")
    collapse.performClick()
    composeRule.waitForIdle()
    preview.assertContentDescriptionEquals("Agent browser")
    preview.performTouchInput { click() }
    composeRule.waitForIdle()
    preview.assertDoesNotExist()
    collapse.performClick()
    composeRule.waitForIdle()
    header.performClick()
    composeRule.waitForIdle()
    preview.assertDoesNotExist()
    collapse.assertIsEnabled()
  }

  @Test
  fun previewRetiresWhenControlIsUnavailableAndReturnsWhenAdmitted() {
    val connected = mutableStateOf(true)
    val canControl = mutableStateOf(true)
    val currentPage = mutableStateOf<NodeRuntime.GatewayControlPage?>(page)
    var closeCount = 0
    composeRule.setContent {
      OpenClawTheme {
        ChatBrowserCard(
          tab = tab,
          sessionKey = "agent:main:travel",
          page = currentPage.value,
          connected = connected.value,
          canControl = canControl.value,
          availableHeight = 600.dp,
          onClose = { closeCount += 1 },
        )
      }
    }
    val preview = composeRule.onNode(previewAction)
    val header = composeRule.onNodeWithContentDescription("Control browser")
    val close = composeRule.onNodeWithContentDescription("Close")
    for (unavailable in 0..3) {
      preview.assertContentDescriptionEquals("Agent browser")
      preview.assertIsEnabled()
      composeRule.runOnIdle {
        connected.value = unavailable != 0
        canControl.value = unavailable != 1
        currentPage.value =
          when (unavailable) {
            2 -> null
            3 -> page.copy(browserFocusAvailable = false)
            else -> page
          }
      }
      preview.assertDoesNotExist()
      header.assertIsNotEnabled()
      close.performClick()
      composeRule.waitForIdle()
      composeRule.runOnIdle {
        assertEquals(unavailable + 1, closeCount)
        connected.value = true
        canControl.value = true
        currentPage.value = page
      }
    }
    preview.assertContentDescriptionEquals("Agent browser")
    preview.assert(SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Button))
    preview.performClick()
    composeRule.waitForIdle()
    composeRule.onNodeWithContentDescription("Collapse browser").assertIsEnabled()
  }
}
