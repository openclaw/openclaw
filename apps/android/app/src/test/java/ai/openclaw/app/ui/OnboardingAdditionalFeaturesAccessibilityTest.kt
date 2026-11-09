package ai.openclaw.app.ui

import ai.openclaw.app.LocationMode
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.NodeApp
import ai.openclaw.app.NodeRuntime
import ai.openclaw.app.NodeRuntimeMode
import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.bindNodeRuntimeTestFixture
import ai.openclaw.app.closeNodeRuntimeTestFixture
import android.content.Context
import android.provider.Settings
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.LocalSaveableStateRegistry
import androidx.compose.runtime.saveable.SaveableStateRegistry
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToNode
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModelStore
import com.google.mlkit.common.sdkinternal.MlKitContext
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.util.ReflectionHelpers
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "en-rUS-w1000dp-h1000dp-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class OnboardingAdditionalFeaturesAccessibilityTest {
  @get:Rule
  val composeRule = createComposeRule()

  @Test
  fun additionalFeaturesAnnounceStateAcrossToggleAndRestorationWithoutEnablingAccess() {
    val app = RuntimeEnvironment.getApplication() as NodeApp
    val previousRuntime = app.peekRuntime()
    val previousScale = Settings.Global.getString(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE)
    val preferences = app.getSharedPreferences("onboarding-disclosure-${UUID.randomUUID()}", Context.MODE_PRIVATE)
    val prefs = SecurePrefs(app, preferences)
    val runtime = NodeRuntime(app, prefs, NodeRuntimeMode.ScreenshotFixture)
    val models = ViewModelStore()
    val registry = mutableStateOf(SaveableStateRegistry(null) { true })
    val mounted = mutableStateOf(true)
    try {
      MlKitContext.initializeIfNeeded(app)
      Settings.Global.putFloat(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
      bindNodeRuntimeTestFixture(app, runtime)
      val model = MainViewModel(app, prefs, SavedStateHandle())
      models.put("onboarding-disclosure", model)
      ReflectionHelpers.getField<MutableStateFlow<NodeRuntime?>>(model, "runtimeRef").value = runtime
      composeRule.setContent {
        if (mounted.value) {
          CompositionLocalProvider(LocalSaveableStateRegistry provides registry.value) {
            OnboardingFlow(model)
          }
        }
      }
      val welcomeState = composeRule.runOnIdle { registry.value.performSave() }
      val savedValues = welcomeState.values.flatten()
      val savedStates = savedValues.filterIsInstance<MutableState<*>>()
      val step = savedStates.single { it.value == OnboardingStep.Welcome }
      composeRule.runOnIdle { mounted.value = false }
      composeRule.runOnIdle {
        registry.value =
          SaveableStateRegistry(
            welcomeState.mapValues { (_, values) ->
              values.map { if (it === step) mutableStateOf(OnboardingStep.Permissions) else it }
            },
          ) { true }
        mounted.value = true
      }
      val permissions = composeRule.onNode(hasScrollAction())
      permissions.performScrollToNode(hasText("Additional features"))
      val collapsed = composeRule.onNodeWithText("Additional features")
      collapsed.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Collapsed"))
      collapsed.assert(SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Button))
      collapsed.assertHasClickAction()
      composeRule.onNodeWithText("Contacts").assertDoesNotExist()
      collapsed.performClick()
      composeRule.waitForIdle()
      val expanded = composeRule.onNodeWithText("Hide additional features")
      expanded.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Expanded"))
      expanded.assert(SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Button))
      expanded.assertHasClickAction()
      permissions.performScrollToNode(hasText("Contacts"))
      composeRule.onNodeWithText("Contacts").assertIsDisplayed()
      permissions.performScrollToNode(hasText("Special access"))
      composeRule.onNodeWithText("Special access").assertIsDisplayed()
      composeRule.onNodeWithText("Continue").assertIsEnabled()

      val expandedState = composeRule.runOnIdle { registry.value.performSave() }
      composeRule.runOnIdle { mounted.value = false }
      composeRule.runOnIdle {
        registry.value = SaveableStateRegistry(expandedState) { true }
        mounted.value = true
      }
      permissions.performScrollToNode(hasText("Hide additional features"))
      val restored = composeRule.onNodeWithText("Hide additional features")
      restored.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Expanded"))
      restored.performClick()
      composeRule.waitForIdle()
      val closedAgain = composeRule.onNodeWithText("Additional features")
      closedAgain.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Collapsed"))
      composeRule.onNodeWithText("Contacts").assertDoesNotExist()
      composeRule.onNodeWithText("Continue").performClick()
      composeRule.waitForIdle()
      composeRule.runOnIdle {
        assertTrue(prefs.onboardingCompleted.value)
        assertFalse(prefs.cameraEnabled.value)
        assertEquals(LocationMode.Off, prefs.locationMode.value)
        assertFalse(prefs.notificationForwardingEnabled.value)
      }
    } finally {
      composeRule.runOnIdle { mounted.value = false }
      models.clear()
      try {
        closeNodeRuntimeTestFixture(runtime)
      } finally {
        bindNodeRuntimeTestFixture(app, previousRuntime)
        Settings.Global.putString(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, previousScale)
      }
    }
  }
}
