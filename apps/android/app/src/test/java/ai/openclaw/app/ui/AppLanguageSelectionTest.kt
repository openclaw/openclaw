package ai.openclaw.app.ui

import ai.openclaw.app.AppLanguage
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.NodeApp
import ai.openclaw.app.NodeRuntime
import ai.openclaw.app.NodeRuntimeMode
import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.bindNodeRuntimeTestFixture
import ai.openclaw.app.closeNodeRuntimeTestFixture
import ai.openclaw.app.currentAppLanguage
import ai.openclaw.app.i18n.NativeStringResources
import ai.openclaw.app.setAppLanguage
import ai.openclaw.app.ui.design.ClawDesignTheme
import android.content.Context
import androidx.appcompat.app.AppCompatActivity
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsNotSelected
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasAnyDescendant
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModelStore
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.android.controller.ActivityController
import org.robolectric.annotation.Config
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w1000dp-h1000dp-mdpi")
class AppLanguageSelectionTest {
  @get:Rule
  val composeRule = createComposeRule()

  private val models = ViewModelStore()
  private val mounted = mutableStateOf(true)
  private lateinit var app: NodeApp
  private lateinit var runtime: NodeRuntime
  private lateinit var model: MainViewModel
  private lateinit var localeActivity: ActivityController<AppLanguageSelectionActivity>
  private var previousRuntime: NodeRuntime? = null
  private var previousLanguage = AppLanguage.System

  @Before
  fun setUp() {
    app = RuntimeEnvironment.getApplication() as NodeApp
    clearPlainPreferences()
    localeActivity = Robolectric.buildActivity(AppLanguageSelectionActivity::class.java).setup()
    previousLanguage = currentAppLanguage()
    NativeStringResources.install(app)
    setAppLanguage(AppLanguage.English)
    val storage = app.getSharedPreferences("language-selection-${UUID.randomUUID()}", Context.MODE_PRIVATE)
    val prefs = SecurePrefs(app, storage)
    previousRuntime = app.peekRuntime()
    runtime = NodeRuntime(app, prefs, NodeRuntimeMode.ScreenshotFixture)
    bindNodeRuntimeTestFixture(app, runtime)
    model = MainViewModel(app, prefs, SavedStateHandle())
    models.put("appearance", model)
  }

  @After
  fun tearDown() {
    try {
      composeRule.runOnIdle { mounted.value = false }
      try {
        models.clear()
      } finally {
        closeNodeRuntimeTestFixture(runtime)
      }
    } finally {
      bindNodeRuntimeTestFixture(app, previousRuntime)
      try {
        setAppLanguage(previousLanguage)
      } finally {
        localeActivity.destroy()
        clearPlainPreferences()
      }
    }
  }

  @Test
  fun languageChoicesExposeRadioSelectionWithinTheirOwnGroup() {
    showAppearance()
    assertEquals(AppLanguage.English, currentAppLanguage())
    val english = composeRule.onNodeWithText("English")
    english.assertIsSelected()
    english.assert(SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.RadioButton))
    val languageGroup =
      SemanticsMatcher.keyIsDefined(SemanticsProperties.SelectableGroup) and
        hasAnyDescendant(hasText("App language"))
    english.assert(hasAnyAncestor(languageGroup))
    for (language in AppLanguage.entries.filterNot { it == AppLanguage.English }) {
      val row =
        if (language == AppLanguage.System) {
          composeRule.onNode(hasText("System") and hasText("Follow Android", substring = true))
        } else {
          composeRule.onNodeWithText(language.displayName)
        }
      row.assertIsNotSelected()
      row.assert(SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.RadioButton))
      row.assert(hasAnyAncestor(languageGroup))
    }
  }

  @Test
  fun changingLanguageMovesSelectionAndKeepsTheRealLocaleAction() {
    showAppearance()
    val english = composeRule.onNodeWithText("English")
    val german = composeRule.onNodeWithText("Deutsch")
    german.performScrollTo()
    german.performClick()
    composeRule.waitForIdle()
    assertEquals(AppLanguage.German, currentAppLanguage())
    german.assertIsSelected()
    english.assertIsNotSelected()

    english.performScrollTo()
    english.performClick()
    composeRule.waitForIdle()
    assertEquals(AppLanguage.English, currentAppLanguage())
    english.assertIsSelected()
    german.assertIsNotSelected()

    val system = composeRule.onNode(hasText("System") and hasText("Follow Android", substring = true))
    system.performScrollTo()
    system.performClick()
    composeRule.waitForIdle()
    assertEquals(AppLanguage.System, currentAppLanguage())
    system.assertIsSelected()
    english.assertIsNotSelected()
    german.assertIsNotSelected()
  }

  private fun clearPlainPreferences() {
    val preferences = app.getSharedPreferences("openclaw.node", Context.MODE_PRIVATE)
    val editor = preferences.edit()
    editor.clear()
    editor.commit()
  }

  private fun showAppearance() {
    composeRule.setContent {
      if (mounted.value) {
        ClawDesignTheme {
          SettingsDetailScreen(viewModel = model, route = SettingsRoute.Appearance, onBack = {})
        }
      }
    }
  }
}

private class AppLanguageSelectionActivity : AppCompatActivity()
