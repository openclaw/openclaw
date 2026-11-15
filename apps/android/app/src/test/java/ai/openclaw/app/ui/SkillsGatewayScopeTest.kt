package ai.openclaw.app.ui

import ai.openclaw.app.MainViewModel
import ai.openclaw.app.NodeApp
import ai.openclaw.app.NodeRuntime
import ai.openclaw.app.NodeRuntimeMode
import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.bindNodeRuntimeTestFixture
import ai.openclaw.app.closeNodeRuntimeTestFixture
import ai.openclaw.app.findTestField
import ai.openclaw.app.gateway.GatewayEndpoint
import ai.openclaw.app.gateway.GatewayRegistryEntry
import ai.openclaw.app.gateway.GatewayRegistryEntryKind
import ai.openclaw.app.ui.design.ClawDesignTheme
import android.content.Context
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModelStore
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.util.UUID
import java.util.concurrent.atomic.AtomicReference

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w1000dp-h1000dp-mdpi")
class SkillsGatewayScopeTest {
  @get:Rule
  val composeRule = createComposeRule()

  @Test
  fun detailSurvivesSameGatewayRefreshButNotGatewaySwitch() {
    val app = RuntimeEnvironment.getApplication() as NodeApp
    val originalRuntime = app.peekRuntime()
    val preferences =
      app.getSharedPreferences("skills-gateway-scope-${UUID.randomUUID()}", Context.MODE_PRIVATE)
    val prefs = SecurePrefs(app, preferences)
    val gatewayA = GatewayEndpoint.manual("127.0.0.1", 18789)
    val gatewayB = GatewayEndpoint.manual("127.0.0.1", 18790)
    for (gateway in listOf(gatewayA, gatewayB)) {
      prefs.gatewayRegistry.upsert(
        GatewayRegistryEntry(
          stableId = gateway.stableId,
          kind = GatewayRegistryEntryKind.MANUAL,
          name = gateway.name,
          host = gateway.host,
          port = gateway.port,
          tls = false,
        ),
      )
    }
    prefs.gatewayRegistry.setActive(gatewayA.stableId)
    val runtime =
      NodeRuntime(
        app,
        prefs,
        NodeRuntimeMode.Live,
        initialForeground = false,
        initialReconnectSuppressed = true,
      )
    val viewModels = ViewModelStore()
    val mounted = mutableStateOf(true)
    val gatewayAName = AtomicReference("Gateway A skill")
    val detailSubtitle = "Inspect and manage installed skill state."

    fun awaitSkills(name: String) {
      composeRule.waitUntil(timeoutMillis = 5_000) {
        val state = runtime.skillsState.value
        val skill = state.summary?.skills?.singleOrNull()
        !state.refreshing && skill?.name == name
      }
      composeRule.waitForIdle()
    }

    try {
      bindNodeRuntimeTestFixture(app, runtime)
      findTestField(runtime, "connectedEndpoint").set(runtime, gatewayA)
      findTestField(runtime, "operatorConnected").set(runtime, true)
      @Suppress("UNCHECKED_CAST")
      val connected =
        findTestField(runtime, "_isConnected").get(runtime) as MutableStateFlow<Boolean>
      connected.value = true
      @Suppress("UNCHECKED_CAST")
      val scopes =
        findTestField(runtime, "_operatorScopes").get(runtime) as MutableStateFlow<List<String>>
      scopes.value = listOf("operator.admin")
      runtime.gatewayDataRequestOverrideForTests = { gatewayId, method, _ ->
        check(method == "skills.status")
        val name =
          when (gatewayId) {
            gatewayA.stableId -> gatewayAName.get()
            gatewayB.stableId -> "Gateway B skill"
            else -> error("Unexpected gateway: $gatewayId")
          }
        """
        {"skills":[{"skillKey":"shared-skill","name":"$name",
        "source":"openclaw-managed","disabled":false,"eligible":true}]}
        """.trimIndent()
      }
      val viewModel = MainViewModel(app, prefs, SavedStateHandle())
      viewModels.put("skills", viewModel)
      viewModel.refreshSkills()
      composeRule.setContent {
        if (mounted.value) {
          ClawDesignTheme { SkillsSettingsScreen(viewModel = viewModel, onBack = {}) }
        }
      }
      awaitSkills("Gateway A skill")
      composeRule.onNodeWithText("Gateway A skill").performScrollTo().performClick()
      composeRule.waitForIdle()
      composeRule.onNodeWithText(detailSubtitle).assertIsDisplayed()

      // A refreshed summary is not a new owner: keep the user's open detail.
      gatewayAName.set("Gateway A refreshed")
      viewModel.refreshSkills()
      awaitSkills("Gateway A refreshed")
      composeRule.onNodeWithText(detailSubtitle).assertIsDisplayed()
      composeRule.onAllNodesWithText("Gateway A refreshed").onFirst().assertIsDisplayed()

      // Drive the gateway identity and real summary owner without a service/network connection.
      composeRule.runOnIdle {
        findTestField(runtime, "connectedEndpoint").set(runtime, gatewayB)
        prefs.gatewayRegistry.setActive(gatewayB.stableId)
        viewModel.refreshSkills()
      }
      awaitSkills("Gateway B skill")
      composeRule.onNodeWithText(detailSubtitle).assertDoesNotExist()
      composeRule.onNodeWithText("Search installed skills").assertIsDisplayed()

      // The same skill key on B is still usable, but requires an explicit new selection.
      composeRule.onNodeWithText("Gateway B skill").performScrollTo().performClick()
      composeRule.waitForIdle()
      composeRule.onNodeWithText(detailSubtitle).assertIsDisplayed()
      composeRule.onAllNodesWithText("Gateway B skill").onFirst().assertIsDisplayed()
    } finally {
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
}
