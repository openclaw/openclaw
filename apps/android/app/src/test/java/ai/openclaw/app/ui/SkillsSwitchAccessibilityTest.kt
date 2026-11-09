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
import android.os.Looper
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModelStore
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "en-rUS-w1000dp-h1000dp-mdpi")
class SkillsSwitchAccessibilityTest {
  @get:Rule
  val composeRule = createComposeRule()

  private val mounted = mutableStateOf(true)
  private val viewModels = ViewModelStore()
  private val alphaEnabled = AtomicBoolean(true)
  private val betaEnabled = AtomicBoolean(false)
  private val updates = CopyOnWriteArrayList<Pair<String, Boolean>>()
  private lateinit var app: NodeApp
  private lateinit var runtime: NodeRuntime
  private lateinit var viewModel: MainViewModel
  private lateinit var scopes: MutableStateFlow<List<String>>
  private var originalRuntime: NodeRuntime? = null

  @Before
  fun setUp() {
    app = RuntimeEnvironment.getApplication() as NodeApp
    originalRuntime = app.peekRuntime()
    val preferences = app.getSharedPreferences("skill-switches-${UUID.randomUUID()}", Context.MODE_PRIVATE)
    val prefs = SecurePrefs(app, preferences)
    val gateway = GatewayEndpoint.manual("127.0.0.1", 18789)
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
    prefs.gatewayRegistry.setActive(gateway.stableId)
    runtime =
      NodeRuntime(
        app,
        prefs,
        NodeRuntimeMode.Live,
        initialForeground = false,
        initialReconnectSuppressed = true,
      )
    bindNodeRuntimeTestFixture(app, runtime)
    findTestField(runtime, "connectedEndpoint").set(runtime, gateway)
    findTestField(runtime, "operatorConnected").set(runtime, true)

    @Suppress("UNCHECKED_CAST")
    val connected = findTestField(runtime, "_isConnected").get(runtime) as MutableStateFlow<Boolean>
    connected.value = true

    @Suppress("UNCHECKED_CAST")
    val operatorScopes = findTestField(runtime, "_operatorScopes").get(runtime) as MutableStateFlow<List<String>>
    scopes = operatorScopes
    scopes.value = listOf("operator.admin")
    runtime.gatewayDataRequestOverrideForTests = { gatewayId, method, params ->
      assertEquals(gateway.stableId, gatewayId)
      when (method) {
        "skills.status" -> {
          """
          {"skills":[
            {"skillKey":"alpha","name":"Alpha skill","source":"openclaw-managed",
             "disabled":${!alphaEnabled.get()},"eligible":true},
            {"skillKey":"beta","name":"Beta skill","source":"openclaw-managed",
             "disabled":${!betaEnabled.get()},"eligible":true}
          ]}
          """.trimIndent()
        }

        "skills.update" -> {
          val payload = Json.parseToJsonElement(requireNotNull(params)).jsonObject
          val key = payload.getValue("skillKey").jsonPrimitive.content
          val enabled = payload.getValue("enabled").jsonPrimitive.boolean
          when (key) {
            "alpha" -> alphaEnabled.set(enabled)
            "beta" -> betaEnabled.set(enabled)
            else -> error("Unexpected skill: $key")
          }
          updates.add(key to enabled)
          "{}"
        }

        else -> {
          error("Unexpected request: $method")
        }
      }
    }
    viewModel = MainViewModel(app, prefs, SavedStateHandle())
    viewModels.put("skills", viewModel)
    viewModel.refreshSkills()
    composeRule.setContent {
      if (mounted.value) {
        ClawDesignTheme { SkillsSettingsScreen(viewModel = viewModel, onBack = {}) }
      }
    }
    awaitSkills(alpha = true, beta = false)
    awaitAdmin(true)
  }

  @After
  fun tearDown() {
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

  @Test
  fun installedSwitchesNameTheirTargetsAndOnlyToggleTheChosenSkill() {
    val alpha = skillSwitch("Alpha skill")
    alpha.assertExists()
    alpha.performScrollTo()
    alpha.assertIsOn()
    alpha.assertIsEnabled()
    skillSwitch("Beta skill").assertIsOff()
    alpha.performClick()
    composeRule.waitForIdle()
    awaitSkills(alpha = false, beta = false)
    alpha.assertIsOff()
    skillSwitch("Beta skill").assertIsOff()
    composeRule.onNodeWithText("Inspect and manage installed skill state.").assertDoesNotExist()
    assertEquals(listOf("alpha" to false), updates.toList())

    val beta = skillSwitch("Beta skill")
    beta.performScrollTo()
    beta.performClick()
    composeRule.waitForIdle()
    awaitSkills(alpha = false, beta = true)
    beta.assertIsOn()
    alpha.assertIsOff()
    assertEquals(listOf("alpha" to false, "beta" to true), updates.toList())
  }

  @Test
  fun detailSwitchKeepsItsTargetAndCheckedStateWhenManagementIsDisabled() {
    val row = composeRule.onNodeWithText("Beta skill")
    row.performScrollTo()
    row.performClick()
    composeRule.waitForIdle()
    val beta = skillSwitch("Beta skill")
    beta.assertExists()
    beta.performScrollTo()
    beta.assertIsOff()
    beta.assertIsEnabled()
    beta.performClick()
    composeRule.waitForIdle()
    awaitSkills(alpha = true, beta = true)
    beta.assertIsOn()
    assertEquals(listOf("beta" to true), updates.toList())

    composeRule.runOnIdle { scopes.value = emptyList() }
    awaitAdmin(false)
    beta.assertIsOn()
    beta.assertIsNotEnabled()
    assertEquals(listOf("beta" to true), updates.toList())

    composeRule.runOnIdle { scopes.value = listOf("operator.admin") }
    awaitAdmin(true)
    beta.assertIsEnabled()
    beta.performClick()
    composeRule.waitForIdle()
    awaitSkills(alpha = true, beta = false)
    beta.assertIsOff()
    assertEquals(listOf("beta" to true, "beta" to false), updates.toList())
  }

  private fun skillSwitch(name: String) =
    composeRule.onNode(
      hasContentDescription(name) and SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Switch),
    )

  private fun awaitSkills(
    alpha: Boolean,
    beta: Boolean,
  ) {
    composeRule.waitUntil(timeoutMillis = 5_000) {
      shadowOf(Looper.getMainLooper()).idle()
      val state = runtime.skillsState.value
      val skills = state.summary?.skills.orEmpty()
      val actual = skills.associate { it.skillKey to !it.disabled }
      !state.refreshing && runtime.skillMutationKeys.value.isEmpty() &&
        actual == mapOf("alpha" to alpha, "beta" to beta)
    }
    composeRule.waitForIdle()
  }

  private fun awaitAdmin(expected: Boolean) {
    composeRule.waitUntil(timeoutMillis = 5_000) {
      shadowOf(Looper.getMainLooper()).idle()
      viewModel.operatorAdminScopeAvailable.value == expected
    }
    composeRule.waitForIdle()
  }
}
