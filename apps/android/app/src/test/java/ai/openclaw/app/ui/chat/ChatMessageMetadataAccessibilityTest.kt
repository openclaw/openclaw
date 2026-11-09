package ai.openclaw.app.ui.chat

import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.ui.design.ClawDesignTheme
import android.view.KeyEvent
import android.view.WindowManager
import android.view.inspector.WindowInspector
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w1000dp-h1000dp-mdpi")
class ChatMessageMetadataAccessibilityTest {
  @get:Rule
  val composeRule = createComposeRule()

  @Test
  fun timestampAnnouncesMenuStateAcrossOpeningDismissalAndReopening() {
    composeRule.setContent {
      ClawDesignTheme {
        ChatMessageTimestamp(1_789_776_060_000, listOf("Model" to "example-model"))
      }
    }
    val timestamp = composeRule.onNode(hasClickAction())
    timestamp.assert(SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Button))
    timestamp.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, nativeString("Collapsed")))
    composeRule.onNodeWithText("Model: example-model").assertDoesNotExist()

    timestamp.performClick()
    composeRule.waitForIdle()
    timestamp.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, nativeString("Expanded")))
    composeRule.onNodeWithText("Model: example-model").assertIsDisplayed()

    composeRule.runOnIdle {
      val popup =
        WindowInspector.getGlobalWindowViews().single { view ->
          val params = view.layoutParams as? WindowManager.LayoutParams
          view.isAttachedToWindow && params?.type == WindowManager.LayoutParams.TYPE_APPLICATION_SUB_PANEL
        }
      assertTrue(popup.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_ESCAPE)))
      assertTrue(popup.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_ESCAPE)))
    }
    composeRule.waitForIdle()
    timestamp.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, nativeString("Collapsed")))
    composeRule.onNodeWithText("Model: example-model").assertDoesNotExist()

    timestamp.performClick()
    composeRule.waitForIdle()
    timestamp.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, nativeString("Expanded")))
    composeRule.onNodeWithText("Model: example-model").assertIsDisplayed()
  }

  @Test
  fun removingMetadataRetiresMenuStateAndRestoringMetadataStartsCollapsed() {
    val metadata = mutableStateOf(listOf("Model" to "example-model"))
    composeRule.setContent {
      ClawDesignTheme {
        ChatMessageTimestamp(1_789_776_060_000, metadata.value)
      }
    }
    composeRule.onNode(hasClickAction()).performClick()
    composeRule.waitForIdle()
    composeRule.onNodeWithText("Model: example-model").assertIsDisplayed()
    val stateful = SemanticsMatcher.keyIsDefined(SemanticsProperties.StateDescription)
    composeRule.onNode(stateful).assert(
      SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, nativeString("Expanded")),
    )

    composeRule.runOnIdle { metadata.value = emptyList() }
    composeRule.onNodeWithText("Model: example-model").assertDoesNotExist()
    composeRule.onNode(hasClickAction()).assertDoesNotExist()
    composeRule.onNode(stateful).assertDoesNotExist()

    composeRule.runOnIdle { metadata.value = listOf("Model" to "replacement-model") }
    composeRule.onNode(hasClickAction()).assert(
      SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, nativeString("Collapsed")),
    )
    composeRule.onNodeWithText("Model: replacement-model").assertDoesNotExist()
    composeRule.onNode(hasClickAction()).performClick()
    composeRule.waitForIdle()
    composeRule.onNodeWithText("Model: replacement-model").assertIsDisplayed()
  }
}
