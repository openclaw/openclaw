package ai.openclaw.app.ui

import ai.openclaw.app.i18n.NativeStringResources
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.ui.design.ClawDesignTheme
import ai.openclaw.app.ui.design.ClawTheme
import android.view.KeyEvent
import android.view.WindowManager
import android.view.inspector.WindowInspector
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.State
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusManager
import androidx.compose.ui.input.InputMode
import androidx.compose.ui.input.InputModeManager
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalInputModeManager
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.pressKey
import androidx.compose.ui.unit.dp
import androidx.core.os.LocaleListCompat
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w1000dp-h1000dp-mdpi")
class SidebarAttentionExpansionTest {
  @get:Rule
  val composeRule = createComposeRule()

  private lateinit var inputModeManager: InputModeManager
  private lateinit var focusManager: FocusManager

  @Before
  fun setUp() {
    NativeStringResources.install(RuntimeEnvironment.getApplication())
    NativeStringResources.setApplicationLocales(LocaleListCompat.forLanguageTags("fr"))
  }

  @After
  fun tearDown() {
    NativeStringResources.setApplicationLocales(LocaleListCompat.getEmptyLocaleList())
  }

  @Test
  fun clickDismissAndIdentityChangesAnnounceTheActualPreviewState() {
    val attention = mutableStateOf(questionAttention())
    var headerClicks = 0
    showHeader(attention) { headerClicks++ }
    val control = composeRule.onNodeWithContentDescription(attention.value.label)
    control.assertHasClickAction()
    assertPreviewState(attention.value, expanded = false)
    control.performClick()
    composeRule.waitForIdle()
    assertPreviewState(attention.value, expanded = true)
    composeRule.runOnIdle {
      val current = attention.value
      attention.value = current.copy(requests = listOf(current.first.copy(count = 2)))
    }
    assertPreviewState(attention.value, expanded = true)
    composeRule.runOnIdle {
      val popup =
        WindowInspector.getGlobalWindowViews().single {
          val params = it.layoutParams as? WindowManager.LayoutParams
          it.isAttachedToWindow && params?.type == WindowManager.LayoutParams.TYPE_APPLICATION_SUB_PANEL
        }
      assertTrue(popup.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_ESCAPE)))
      assertTrue(popup.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_ESCAPE)))
    }
    composeRule.waitForIdle()
    assertPreviewState(attention.value, expanded = false)
    composeRule.onNodeWithContentDescription(attention.value.label).performClick()
    composeRule.waitForIdle()
    assertPreviewState(attention.value, expanded = true)
    composeRule.runOnIdle { attention.value = attention.value.copy(gatewayStableId = "gateway-b") }
    assertPreviewState(attention.value, expanded = false)
    composeRule.onNodeWithContentDescription(attention.value.label).performClick()
    composeRule.waitForIdle()
    assertPreviewState(attention.value, expanded = true)
    composeRule.runOnIdle {
      val approval = attention.value.first.copy(kind = SidebarAttentionKind.Approval, id = "approval")
      attention.value = attention.value.copy(requests = listOf(approval))
    }
    assertPreviewState(attention.value, expanded = false)
    composeRule.onNodeWithContentDescription(attention.value.label).performClick()
    composeRule.waitForIdle()
    assertPreviewState(attention.value, expanded = true)
    composeRule.onNodeWithContentDescription(attention.value.label).performClick()
    composeRule.waitForIdle()
    assertPreviewState(attention.value, expanded = false)
    val header = composeRule.onNodeWithText("Recent")
    header.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, nativeString("Collapsed")))
    composeRule.runOnIdle { assertEquals(0, headerClicks) }
  }

  @Test
  fun keyboardFocusAndEscapeAnnouncePreviewWithoutClicking() {
    val attention = mutableStateOf(questionAttention())
    showHeader(attention) {}
    assertPreviewState(attention.value, expanded = false)
    composeRule.runOnIdle { assertTrue(inputModeManager.requestInputMode(InputMode.Keyboard)) }
    val control = composeRule.onNodeWithContentDescription(attention.value.label)
    control.performSemanticsAction(SemanticsActions.RequestFocus) { assertTrue(it()) }
    composeRule.waitForIdle()
    assertPreviewState(attention.value, expanded = true)
    control.performKeyInput { pressKey(Key.Escape) }
    composeRule.waitForIdle()
    assertPreviewState(attention.value, expanded = false)
    control.assert(SemanticsMatcher.expectValue(SemanticsProperties.Focused, true))
    composeRule.runOnIdle { focusManager.clearFocus(force = true) }
    composeRule.waitForIdle()
    assertPreviewState(attention.value, expanded = false)
    control.performSemanticsAction(SemanticsActions.RequestFocus) { assertTrue(it()) }
    composeRule.waitForIdle()
    assertPreviewState(attention.value, expanded = true)
  }

  private fun showHeader(
    attention: State<SidebarAttention>,
    onClick: () -> Unit,
  ) {
    composeRule.setContent {
      inputModeManager = LocalInputModeManager.current
      focusManager = LocalFocusManager.current
      ClawDesignTheme {
        Column(Modifier.width(280.dp)) {
          SidebarCollapsibleHeader(
            label = "Recent",
            expanded = false,
            palette = sidebarPalette(ClawTheme.colors),
            onClick = onClick,
            attention = attention.value,
          )
        }
      }
    }
  }

  private fun assertPreviewState(
    attention: SidebarAttention,
    expanded: Boolean,
  ) {
    val expected = if (expanded) nativeString("Expanded") else nativeString("Collapsed")
    val control = composeRule.onNodeWithContentDescription(attention.label)
    control.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, expected))
    val preview = composeRule.onNodeWithTag("sidebar-attention-detail")
    if (expanded) {
      preview.assertIsDisplayed()
    } else {
      preview.assertDoesNotExist()
    }
  }

  private fun questionAttention(): SidebarAttention =
    SidebarAttention(
      requests =
        listOf(
          SidebarAttentionRequest(
            kind = SidebarAttentionKind.Question,
            id = "question",
            sessionKey = "agent:main:test",
            preview = "Choose a test device",
            count = 1,
            createdAtMs = 1L,
          ),
        ),
      gatewayStableId = "gateway-a",
    )
}
