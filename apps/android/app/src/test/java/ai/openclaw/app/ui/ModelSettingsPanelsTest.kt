package ai.openclaw.app.ui

import ai.openclaw.app.GatewayModelSettingsController
import ai.openclaw.app.gateway.GatewaySession
import ai.openclaw.app.parseGatewayInstalledAgents
import ai.openclaw.app.parseGatewayModelCatalog
import ai.openclaw.app.ui.design.ClawDesignTheme
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isDialog
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w390dp-h844dp-mdpi")
class ModelSettingsPanelsTest {
  @get:Rule val composeRule = createComposeRule()
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
  private var config = sourceConfig(defaults("utilityModel" to JsonPrimitive("provider/utility")))
  private var revision = 1
  private var nextConfig: JsonObject? = null
  private val requests = mutableListOf<Pair<String, JsonObject>>()
  private val catalog = parseGatewayModelCatalog(objectJson(CATALOG))
  private val installed = parseGatewayInstalledAgents(objectJson("""{"agents":[{"id":"fixture","name":"Fixture Agent","runtimeId":"fixture-cli","installation":"installed","enabled":false}]}"""))
  private val lease =
    GatewaySession.RequestLease("gateway", { true }, null) { method, params, _, enqueue ->
      val input = Json.parseToJsonElement(requireNotNull(params)).jsonObject
      enqueue { requests += method to input }
      when (method) {
        "config.get" -> {
          buildJsonObject {
            put("valid", true)
            put("hash", "revision-$revision")
            put("sourceConfig", config)
          }.toString()
        }

        "config.patch" -> {
          config = checkNotNull(nextConfig) { "Unexpected settings write" }
          nextConfig = null
          revision += 1
          buildJsonObject {
            put("ok", true)
            put("hash", "revision-$revision")
            put("config", config)
          }.toString()
        }

        else -> {
          error("A settings selection must not start another Gateway operation: $method")
        }
      }
    }
  private val controller = GatewayModelSettingsController(scope, lease, Json, { true }, { true }) {}

  @After
  fun tearDown() {
    controller.close()
    scope.cancel()
  }

  @Test
  fun modelAndFallbackPickersWriteGlobalDefaultsUsingFreshConfig() {
    show()
    composeRule.onNodeWithText("Defaults for all agents").assertIsDisplayed()
    composeRule.runOnIdle {
      revision = 41
      nextConfig = sourceConfig(objectJson("""{"model":{"primary":"provider/new","fallbacks":["provider/fallback","provider/tail"]},"utilityModel":"provider/utility"}"""))
    }
    choose("Model", "New chat model")
    assertLastPatch("""{"agents":{"defaults":{"model":{"primary":"provider/new","fallbacks":["provider/fallback","provider/tail"]}}}}""")
    composeRule.runOnIdle {
      val submission = requests.single { it.first == "config.patch" }.second
      assertEquals("revision-41", submission.getValue("baseHash").jsonPrimitive.content)
      assertEquals(Json.parseToJsonElement("""["agents.defaults.model.fallbacks"]"""), submission["replacePaths"])
      assertEquals(listOf("config.get", "config.get", "config.patch", "config.get"), requests.map { it.first })
      nextConfig = sourceConfig(objectJson("""{"model":{"primary":"provider/new","fallbacks":["provider/backup","provider/tail"]},"utilityModel":"provider/utility"}"""))
    }
    composeRule.onNodeWithContentDescription("Choose Model").assert(hasText("New chat model"))
    choose("Fallback Model", "Backup chat model")
    assertLastPatch("""{"agents":{"defaults":{"model":{"primary":"provider/new","fallbacks":["provider/backup","provider/tail"]}}}}""")
    composeRule.onNodeWithContentDescription("Choose Fallback Model").assert(hasText("Backup chat model"))
  }

  @Test
  fun utilityDecisionAndBehaviorControlsSendTheirDistinctSelections() {
    show()
    prepare(defaults("utilityModel" to JsonPrimitive("")))
    choose("Utility Model", "Disabled")
    assertLastPatch("""{"agents":{"defaults":{"utilityModel":""}}}""")

    prepare(defaults())
    choose("Utility Model", "Auto · Utility chat model")
    assertLastPatch("""{"agents":{"defaults":{"utilityModel":null}}}""")

    prepare(defaults("decisionModel" to JsonPrimitive("judge/score")))
    composeRule.onNodeWithContentDescription("Choose Decision Model").performScrollTo().performClick()
    composeRule.onNode(hasText("Chat-only model") and hasAnyAncestor(isDialog())).assertDoesNotExist()
    composeRule.onNode(hasText("Decision engine") and hasAnyAncestor(isDialog())).performScrollTo().performClick()
    assertLastPatch("""{"agents":{"defaults":{"decisionModel":"judge/score"}}}""")

    prepare(defaults("decisionModel" to JsonPrimitive("judge/score"), "thinkingDefault" to JsonPrimitive("high")))
    chooseBehavior("Thinking", "High")
    assertLastPatch("""{"agents":{"defaults":{"thinkingDefault":"high"}}}""")

    prepare(defaults("decisionModel" to JsonPrimitive("judge/score"), "thinkingDefault" to JsonPrimitive("high"), "fastModeDefault" to JsonPrimitive("auto")))
    chooseBehavior("Fast Mode", "Auto")
    assertLastPatch("""{"agents":{"defaults":{"fastModeDefault":"auto"}}}""")
  }

  @Test
  fun installedAgentToggleUsesSharedConfigWriterWithoutClaimingSignIn() {
    show()
    composeRule.onNodeWithText("Installed agents").performScrollTo().assertIsDisplayed()
    composeRule.onNodeWithText("Disabled in model settings.").performScrollTo().assertIsDisplayed()
    composeRule.runOnIdle { nextConfig = sourceConfig(defaults("utilityModel" to JsonPrimitive("provider/utility")), objectJson("""{"fixture":true}""")) }
    composeRule.onNodeWithContentDescription("Use Fixture Agent").performScrollTo().performClick()

    assertLastPatch("""{"plugins":{"entries":{"acpx":{"config":{"nativeAgents":{"fixture":true}}}}}}""")
    composeRule.onNodeWithContentDescription("Use Fixture Agent").assertIsOn()
    composeRule.onNodeWithText("Installed").assertIsDisplayed()
    composeRule.onNodeWithText("Sign in to Fixture Agent on the computer running your Gateway to load its models.").performScrollTo().assertIsDisplayed()
    composeRule.onNodeWithText("Models available").assertDoesNotExist()
  }

  private fun show() {
    composeRule.setContent {
      val state by controller.state.collectAsState()
      LaunchedEffect(controller) { controller.refresh() }
      ClawDesignTheme {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp)) {
          ModelDefaultsPanel(
            controller = controller,
            state = state,
            models = catalog.models,
            decisionModels = catalog.decisionModels,
            automaticUtilityModel = catalog.automaticUtilityModel,
            authProviders = emptyList(),
            selectionRestricted = catalog.selectionRestricted,
            policyDefaultModel = catalog.policyDefaultModel,
            canEdit = true,
            connected = true,
          )
          InstalledAgentsPanel(
            agents = installed,
            loading = false,
            errorText = state.errorText,
            canRefresh = true,
            canEdit = true,
            saving = state.busy,
            nativeAgentFlags = state.nativeAgentFlags,
            models = catalog.models,
            outcomes = catalog.providerOutcomes,
            pendingProviders = catalog.pendingProviders,
            readOnlyReason = null,
            onRefresh = {},
            onEnabledChange = controller::setInstalledAgentEnabled,
          )
        }
      }
    }
  }

  private fun choose(
    setting: String,
    label: String,
  ) {
    composeRule.onNodeWithContentDescription("Choose $setting").performScrollTo().performClick()
    composeRule.onNode(hasText(label) and hasAnyAncestor(isDialog())).performScrollTo().performClick()
  }

  private fun chooseBehavior(
    group: String,
    label: String,
  ) {
    composeRule.onNode(hasText(label) and hasAnyAncestor(hasContentDescription(group)), useUnmergedTree = true).performScrollTo().performClick()
  }

  private fun prepare(defaults: JsonObject) {
    composeRule.runOnIdle { nextConfig = sourceConfig(defaults) }
  }

  private fun assertLastPatch(expected: String) {
    composeRule.runOnIdle {
      val params = requests.last { it.first == "config.patch" }.second
      assertEquals(objectJson(expected), objectJson(params.getValue("raw").jsonPrimitive.content))
    }
  }

  companion object {
    private fun objectJson(value: String): JsonObject = Json.parseToJsonElement(value).jsonObject

    private fun defaults(vararg fields: Pair<String, JsonElement>): JsonObject =
      buildJsonObject {
        put("model", objectJson("""{"primary":"provider/old","fallbacks":["provider/fallback","provider/tail"]}"""))
        fields.forEach { (key, value) -> put(key, value) }
      }

    private fun sourceConfig(
      defaults: JsonObject,
      flags: JsonObject = JsonObject(emptyMap()),
    ): JsonObject =
      buildJsonObject {
        put(
          "agents",
          buildJsonObject {
            put("defaults", defaults)
            put("entries", objectJson("""{"writer":{"model":"other/override"}}"""))
          },
        )
        put("plugins", objectJson("""{"entries":{"acpx":{"config":{"nativeAgents":$flags}}}}"""))
      }

    private const val CATALOG = """{
      "models":[
        {"id":"old","name":"Existing chat model","provider":"provider","available":true},
        {"id":"new","name":"New chat model","provider":"provider","available":true},
        {"id":"fallback","name":"Existing fallback","provider":"provider","available":true},
        {"id":"tail","name":"Tail chat model","provider":"provider","available":true},
        {"id":"backup","name":"Backup chat model","provider":"provider","available":true},
        {"id":"utility","name":"Utility chat model","provider":"provider","available":true},
        {"id":"chat-only","name":"Chat-only model","provider":"provider","available":true}
      ],
      "decisionModels":[{"id":"score","provider":"judge","name":"Decision engine"}],
      "defaultModels":{"automaticUtilityModel":"provider/utility"},
      "modelSelectionPolicy":{"restricted":false,"defaultModel":"provider/old"}
    }"""
  }
}
