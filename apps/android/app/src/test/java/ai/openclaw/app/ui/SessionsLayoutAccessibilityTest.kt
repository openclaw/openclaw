package ai.openclaw.app.ui

import ai.openclaw.app.AndroidScreenshotFixture
import ai.openclaw.app.AndroidScreenshotScene
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.NodeApp
import ai.openclaw.app.NodeRuntime
import ai.openclaw.app.NodeRuntimeMode
import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.bindNodeRuntimeTestFixture
import ai.openclaw.app.closeNodeRuntimeTestFixture
import ai.openclaw.app.i18n.NativeStringResources
import ai.openclaw.app.ui.design.ClawDesignTheme
import android.content.Context
import android.provider.Settings
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.core.os.LocaleListCompat
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModelStore
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w1000dp-h1000dp-mdpi")
class SessionsLayoutAccessibilityTest {
  @get:Rule
  val composeRule = createComposeRule()

  @Test
  fun layoutControlAnnouncesCurrentLayoutAcrossClicksAndRestoration() {
    val app = RuntimeEnvironment.getApplication() as NodeApp
    val previousRuntime = app.peekRuntime()
    val previousScale = Settings.Global.getString(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE)
    val prefs = SecurePrefs(app, app.getSharedPreferences("layout-state-${UUID.randomUUID()}", Context.MODE_PRIVATE))
    AndroidScreenshotFixture.configure(AndroidScreenshotScene.Home)
    val runtime = NodeRuntime(app, prefs, NodeRuntimeMode.ScreenshotFixture)
    val models = ViewModelStore()
    val mounted = mutableStateOf(true)
    NativeStringResources.install(app)
    NativeStringResources.setApplicationLocales(LocaleListCompat.forLanguageTags("en"))
    try {
      Settings.Global.putFloat(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
      bindNodeRuntimeTestFixture(app, runtime)
      val model = MainViewModel(app, prefs, SavedStateHandle())
      models.put("layout-state", model)
      model.enterScreenshotFixtureMode(AndroidScreenshotScene.Home)
      val restoration = StateRestorationTester(composeRule)
      restoration.setContent {
        if (mounted.value) {
          ClawDesignTheme {
            SessionsScreen(model, showSidebarButton = false, onOpenSidebar = {}, onOpenChat = {})
          }
        }
      }
      val toggle = composeRule.onNodeWithContentDescription("Toggle thread layout")
      val detailed = SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Layout: Detailed")
      val compact = SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Layout: Compact")
      toggle.performScrollTo()
      toggle.assertHasClickAction()
      composeRule.onNodeWithText("Layout: Detailed").assertIsDisplayed()
      toggle.assert(detailed)

      toggle.performClick()
      composeRule.waitForIdle()
      toggle.assert(compact)
      composeRule.onNodeWithText("Layout: Compact").assertIsDisplayed()
      composeRule.onNodeWithText("Layout: Detailed").assertDoesNotExist()

      restoration.emulateSavedInstanceStateRestore()
      composeRule.waitForIdle()
      toggle.assert(compact)
      composeRule.onNodeWithText("Layout: Compact").assertIsDisplayed()

      // An unrelated control must not change the layout announcement.
      composeRule.onNodeWithText("Sort: Newest first").performClick()
      composeRule.waitForIdle()
      composeRule.onNodeWithText("Oldest first").performClick()
      composeRule.waitForIdle()
      toggle.assert(compact)
      composeRule.onNodeWithText("Sort: Oldest first").assertIsDisplayed()

      toggle.performClick()
      composeRule.waitForIdle()
      toggle.assert(detailed)
      composeRule.onNodeWithText("Layout: Detailed").assertIsDisplayed()
      composeRule.onNodeWithText("Layout: Compact").assertDoesNotExist()
      restoration.emulateSavedInstanceStateRestore()
      composeRule.waitForIdle()
      toggle.assert(detailed)
    } finally {
      try {
        composeRule.runOnIdle { mounted.value = false }
      } finally {
        models.clear()
        try {
          closeNodeRuntimeTestFixture(runtime)
        } finally {
          bindNodeRuntimeTestFixture(app, previousRuntime)
          Settings.Global.putString(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, previousScale)
          NativeStringResources.setApplicationLocales(LocaleListCompat.getEmptyLocaleList())
          AndroidScreenshotFixture.configure(AndroidScreenshotScene.Home)
        }
      }
    }
  }
}
