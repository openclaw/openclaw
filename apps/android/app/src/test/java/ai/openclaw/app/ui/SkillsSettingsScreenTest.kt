package ai.openclaw.app.ui

import ai.openclaw.app.GatewayClawHubSkillSearchState
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.NodeApp
import ai.openclaw.app.NodeRuntime
import ai.openclaw.app.NodeRuntimeMode
import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.bindNodeRuntimeTestFixture
import ai.openclaw.app.closeNodeRuntimeTestFixture
import ai.openclaw.app.findTestField
import ai.openclaw.app.gateway.GatewayEndpoint
import ai.openclaw.app.ui.design.ClawDesignTheme
import android.content.Context
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.isToggleable
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModelStore
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.util.UUID
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicBoolean

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SkillsSettingsScreenTest {
  @get:Rule
  val composeRule = createComposeRule()

  @Test
  fun auditDetailsRemainReadableForSuccessAndRejection() {
    val app = RuntimeEnvironment.getApplication() as NodeApp
    val originalRuntime = app.peekRuntime()
    val prefs = SecurePrefs(app, app.getSharedPreferences("skills-settings-${UUID.randomUUID()}", Context.MODE_PRIVATE))
    val runtimeField = NodeApp::class.java.getDeclaredField("runtimeInstance").apply { isAccessible = true }
    val viewModels = ViewModelStore()
    val runtime = NodeRuntime(app, prefs, NodeRuntimeMode.ScreenshotFixture)
    try {
      runtimeField.set(app, runtime)
      val viewModel = MainViewModel(app, prefs, SavedStateHandle()).also { viewModels.put("skills", it) }

      @Suppress("UNCHECKED_CAST")
      val state =
        NodeRuntime::class.java
          .getDeclaredField("_clawHubSkillSearchState")
          .apply { isAccessible = true }
          .get(runtime) as MutableStateFlow<GatewayClawHubSkillSearchState>

      viewModel.refreshSkills()
      composeRule.setContent {
        ClawDesignTheme { SkillsSettingsScreen(viewModel = viewModel, onBack = {}) }
      }
      composeRule.onNodeWithText("Browse").performClick()

      for (isError in listOf(false, true)) {
        val message = if (isError) "Blocked by ClawHub." else "Installed @alice/alpha."
        composeRule.runOnIdle {
          state.value =
            GatewayClawHubSkillSearchState(
              errorText = "$message\n\nClawHub audit details.".takeIf { isError },
              messageText = "$message\n\nClawHub audit details.".takeUnless { isError },
            )
        }

        composeRule.onNodeWithText(message).performScrollTo().assertIsDisplayed()
        composeRule.onNodeWithText("ClawHub audit details.").assertDoesNotExist()
        composeRule.onNodeWithText("Review").performScrollTo().performClick()
        composeRule.onNodeWithText("ClawHub audit details.").performScrollTo().assertIsDisplayed()
        composeRule.onNodeWithText("Acknowledge Gateway warning and install").assertDoesNotExist()
        composeRule.onNodeWithText("Dismiss").performScrollTo().performClick()
        composeRule.onNodeWithText(message).assertDoesNotExist()
      }
    } finally {
      try {
        viewModels.clear()
      } finally {
        try {
          closeNodeRuntimeTestFixture(runtime)
        } finally {
          runtimeField.set(app, originalRuntime)
        }
      }
    }
  }

  @Test
  fun enableFailureIsVisibleInDetailAndSuccessfulRetryClearsIt() {
    assertDetailMutationFailure(initiallyEnabled = false)
  }

  @Test
  fun disableFailureIsVisibleInDetailAndSuccessfulRetryClearsIt() {
    assertDetailMutationFailure(initiallyEnabled = true)
  }

  private fun assertDetailMutationFailure(initiallyEnabled: Boolean) {
    val app = RuntimeEnvironment.getApplication() as NodeApp
    val originalRuntime = app.peekRuntime()
    val prefs = SecurePrefs(app, app.getSharedPreferences("skill-detail-${UUID.randomUUID()}", Context.MODE_PRIVATE))
    val viewModels = ViewModelStore()
    val runtime = NodeRuntime(app, prefs, NodeRuntimeMode.Live)
    val mounted = mutableStateOf(true)
    val enabled = AtomicBoolean(initiallyEnabled)
    val updates = ConcurrentLinkedQueue<String>()
    val rejectFirstUpdate = CompletableDeferred<Unit>()
    val errorText = if (initiallyEnabled) "Could not disable skill." else "Could not enable skill."
    try {
      bindNodeRuntimeTestFixture(app, runtime)
      findTestField(runtime, "connectedEndpoint").set(runtime, GatewayEndpoint.manual("127.0.0.1", 18789))
      findTestField(runtime, "operatorConnected").set(runtime, true)
      @Suppress("UNCHECKED_CAST")
      (findTestField(runtime, "_isConnected").get(runtime) as MutableStateFlow<Boolean>).value = true
      @Suppress("UNCHECKED_CAST")
      (findTestField(runtime, "_operatorScopes").get(runtime) as MutableStateFlow<List<String>>).value = listOf("operator.admin")
      runtime.gatewayDataRequestOverrideForTests = { _, method, params ->
        when (method) {
          "skills.status" -> {
            """{"skills":[{"skillKey":"fixture-skill","name":"Fixture skill","source":"openclaw-managed","disabled":${!enabled.get()},"eligible":true}]}"""
          }

          "skills.update" -> {
            val request = checkNotNull(params)
            updates.add(request)
            if (updates.size == 1) {
              rejectFirstUpdate.await()
              error("Synthetic rejected skill update")
            }
            enabled.set(
              Json
                .parseToJsonElement(request)
                .jsonObject
                .getValue("enabled")
                .jsonPrimitive.boolean,
            )
            "{}"
          }

          else -> {
            error("Unexpected method $method")
          }
        }
      }
      val viewModel = MainViewModel(app, prefs, SavedStateHandle()).also { viewModels.put("skills", it) }
      viewModel.refreshSkills()
      composeRule.setContent {
        if (mounted.value) {
          ClawDesignTheme { SkillsSettingsScreen(viewModel = viewModel, onBack = {}) }
        }
      }
      composeRule.waitUntil {
        runtime.skillsState.value.summary
          ?.skills
          ?.size == 1 && runtime.operatorAdminScopeAvailable.value
      }
      composeRule.onNodeWithText("Fixture skill").performScrollTo().performClick()
      val toggle = composeRule.onNode(isToggleable())
      toggle.performScrollTo().assertIsEnabled()
      if (initiallyEnabled) toggle.assertIsOn() else toggle.assertIsOff()
      composeRule.onNodeWithText(errorText).assertDoesNotExist()
      toggle.performClick()
      composeRule.waitUntil { updates.size == 1 && "fixture-skill" in runtime.skillMutationKeys.value }
      toggle.assertIsNotEnabled()
      composeRule.onNodeWithText(errorText).assertDoesNotExist()
      rejectFirstUpdate.complete(Unit)
      composeRule.waitUntil { runtime.skillsState.value.errorText != null && runtime.skillMutationKeys.value.isEmpty() }

      // Stay on the real detail screen: the list already renders this runtime-owned error.
      composeRule.onNodeWithText(errorText).performScrollTo().assertIsDisplayed()
      toggle.performScrollTo().assertIsEnabled()
      if (initiallyEnabled) toggle.assertIsOn() else toggle.assertIsOff()
      toggle.performClick()
      composeRule.waitUntil {
        updates.size == 2 &&
          runtime.skillMutationKeys.value.isEmpty() &&
          runtime.skillsState.value.summary
            ?.skills
            ?.singleOrNull()
            ?.disabled == initiallyEnabled
      }
      composeRule.onNodeWithText(errorText).assertDoesNotExist()
      if (initiallyEnabled) toggle.assertIsOff() else toggle.assertIsOn()
      val expected = Json.parseToJsonElement("""{"skillKey":"fixture-skill","enabled":${!initiallyEnabled}}""")
      assertEquals(listOf(expected, expected), updates.map { Json.parseToJsonElement(it) })
    } finally {
      rejectFirstUpdate.cancel()
      try {
        composeRule.runOnIdle { mounted.value = false }
        viewModels.clear()
      } finally {
        try {
          closeNodeRuntimeTestFixture(runtime)
        } finally {
          bindNodeRuntimeTestFixture(app, originalRuntime)
        }
      }
    }
  }

  @Test
  fun missingItemCopyHandlesZeroOneAndMany() {
    assertEquals("No missing items", skillMissingItemsText(0))
    assertEquals("1 missing item", skillMissingItemsText(1))
    assertEquals("2 missing items", skillMissingItemsText(2))
  }

  @Test
  fun missingSetupCopyUsesExplicitSingularAndPluralForms() {
    assertEquals(
      "This skill needs 1 setup item. Android shows what is installed; setup/config changes stay on desktop or CLI.",
      skillMissingConfigurationText(1),
    )
    assertEquals(
      "This skill needs 2 setup items. Android shows what is installed; setup/config changes stay on desktop or CLI.",
      skillMissingConfigurationText(2),
    )
  }
}
