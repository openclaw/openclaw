package ai.openclaw.app.ui

import ai.openclaw.app.AppearanceThemeFamily
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.NodeApp
import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.ui.design.ClawDesignTheme
import android.content.Context
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsNotSelected
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModelStore
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w1000dp-h1000dp-mdpi")
class AppearanceThemeSelectionTest {
  @get:Rule
  val composeRule = createComposeRule()

  @Test
  fun themeCardsExposeExclusiveSelectionAndFollowSavedPreference() {
    val app = RuntimeEnvironment.getApplication() as NodeApp
    val storage =
      app.getSharedPreferences("theme-selection-${UUID.randomUUID()}", Context.MODE_PRIVATE)
    val prefs = SecurePrefs(app, storage)
    prefs.setAppearanceThemeFamily(AppearanceThemeFamily.Claw)
    val viewModel = MainViewModel(app, prefs, SavedStateHandle())
    val models = ViewModelStore()
    models.put("appearance", viewModel)
    try {
      composeRule.setContent {
        ClawDesignTheme {
          SettingsDetailScreen(viewModel, SettingsRoute.Appearance, onBack = {})
        }
      }
      val claw = composeRule.onNode(hasText("Claw") and hasClickAction())
      val tide = composeRule.onNode(hasText("Tide") and hasClickAction())
      val radio = SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.RadioButton)
      val noDecorativeLabel = SemanticsMatcher.keyNotDefined(SemanticsProperties.ContentDescription)

      claw.performScrollTo()
      claw.assertIsSelected()
      claw.assert(radio)
      claw.assert(noDecorativeLabel)
      tide.performScrollTo()
      tide.assertIsNotSelected()
      tide.assert(radio)
      tide.performClick()
      composeRule.waitForIdle()
      assertEquals(AppearanceThemeFamily.Tide, prefs.appearanceThemeFamily.value)
      tide.assertIsSelected().assert(noDecorativeLabel)
      claw.performScrollTo().assertIsNotSelected().performClick()
      composeRule.waitForIdle()
      assertEquals(AppearanceThemeFamily.Claw, prefs.appearanceThemeFamily.value)
      claw.assertIsSelected().assert(noDecorativeLabel)
      tide.assertIsNotSelected()
    } finally {
      models.clear()
    }
  }
}
