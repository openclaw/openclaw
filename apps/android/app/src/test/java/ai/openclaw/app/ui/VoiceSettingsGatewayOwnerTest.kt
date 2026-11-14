package ai.openclaw.app.ui

import ai.openclaw.app.MainViewModel
import ai.openclaw.app.NodeApp
import ai.openclaw.app.NodeRuntime
import ai.openclaw.app.NodeRuntimeMode
import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.closeNodeRuntimeTestFixture
import ai.openclaw.app.drainWithMainLooper
import ai.openclaw.app.gateway.GatewayEndpoint
import ai.openclaw.app.gateway.GatewayRegistryEntry
import ai.openclaw.app.gateway.GatewayRegistryEntryKind
import ai.openclaw.app.ui.design.ClawDesignTheme
import android.content.Context
import android.speech.SpeechRecognizer
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextReplacement
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModelStore
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowSpeechRecognizer
import org.robolectric.util.ReflectionHelpers
import java.util.UUID
import java.util.concurrent.ConcurrentLinkedQueue

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w1000dp-h1000dp-mdpi")
class VoiceSettingsGatewayOwnerTest {
  @get:Rule val composeRule = createComposeRule()

  @Test
  fun equalGatewayWordsRetireOldDraftButSameGatewayReconnectPreservesIt() {
    val app = RuntimeEnvironment.getApplication() as NodeApp
    val prefs =
      SecurePrefs(
        app,
        app.getSharedPreferences("wake-owner-${UUID.randomUUID()}", Context.MODE_PRIVATE),
      )
    val gatewayA = "wake-owner-a"
    val gatewayB = "wake-owner-b"
    for (gateway in listOf(gatewayA, gatewayB)) {
      prefs.gatewayRegistry.upsert(
        GatewayRegistryEntry(gateway, GatewayRegistryEntryKind.MANUAL, gateway),
      )
    }
    prefs.gatewayRegistry.setActive(gatewayA)
    val wasAvailable = SpeechRecognizer.isOnDeviceRecognitionAvailable(app)
    ShadowSpeechRecognizer.setIsOnDeviceRecognitionAvailable(true)
    val runtime =
      NodeRuntime(
        app,
        prefs,
        NodeRuntimeMode.Live,
        initialForeground = false,
        initialReconnectSuppressed = true,
      )
    val models = ViewModelStore()
    val mounted = mutableStateOf(true)
    val writes = ConcurrentLinkedQueue<Pair<String, List<String>>>()
    runtime.gatewayDataRequestOverrideForTests = { gateway, method, params ->
      when (method) {
        "voicewake.set" -> {
          val payload = requireNotNull(params)
          val root = Json.parseToJsonElement(payload).jsonObject
          val triggers = root.getValue("triggers").jsonArray
          val words = triggers.map { it.jsonPrimitive.content }
          writes.add(gateway to words)
          payload
        }

        "talk.catalog", "talk.config" -> {
          "{}"
        }

        else -> {
          error("Unexpected request: $method")
        }
      }
    }

    fun setConnected(connected: Boolean) {
      ReflectionHelpers.setField(runtime, "operatorConnected", connected)
      ReflectionHelpers.getField<MutableStateFlow<Boolean>>(runtime, "_isConnected").value =
        connected
    }

    fun receiveGatewayWords(gateway: String) {
      ReflectionHelpers.setField(
        runtime,
        "connectedEndpoint",
        GatewayEndpoint(gateway, gateway, "127.0.0.1", 18789),
      )
      prefs.gatewayRegistry.setActive(gateway)
      runtime.applyNodeVoiceWakeWords(
        endpointStableId = gateway,
        payloadJson = """{"triggers":["openclaw","claude","computer"]}""",
        isCurrentConnection = { true },
      )
    }

    fun editor(text: String) = composeRule.onNode(hasSetTextAction() and hasText(text))

    try {
      receiveGatewayWords(gatewayA)
      setConnected(true)
      val model = MainViewModel(app, prefs, SavedStateHandle())
      models.put("wake-owner", model)
      ReflectionHelpers.getField<MutableStateFlow<NodeRuntime?>>(model, "runtimeRef").value =
        runtime
      awaitRuntime {
        model.voiceWakeAvailable.first { it }
        model.isConnected.first { it }
      }
      composeRule.setContent {
        if (mounted.value) {
          ClawDesignTheme(dark = true) {
            SettingsDetailScreen(model, SettingsRoute.Voice, onBack = {})
          }
        }
      }
      editor("openclaw").performScrollTo().performTextReplacement("Unsent gateway A phrase")
      composeRule.waitForIdle()

      // Connectivity and equal authoritative refreshes must not discard this owner's edits.
      composeRule.runOnIdle { setConnected(false) }
      composeRule.waitForIdle()
      awaitRuntime { model.isConnected.first { !it } }
      composeRule.runOnIdle {
        receiveGatewayWords(gatewayA)
        setConnected(true)
      }
      composeRule.waitForIdle()
      awaitRuntime { model.isConnected.first { it } }
      composeRule.waitForIdle()
      editor("Unsent gateway A phrase").assertIsDisplayed()

      // Both Gateways use the defaults, including during the runtime's invalidation reset.
      composeRule.runOnIdle { setConnected(false) }
      composeRule.waitForIdle()
      awaitRuntime { model.isConnected.first { !it } }
      composeRule.runOnIdle {
        receiveGatewayWords(gatewayB)
        setConnected(true)
      }
      composeRule.waitForIdle()
      awaitRuntime { model.isConnected.first { it } }
      composeRule.waitForIdle()
      editor("Unsent gateway A phrase").assertDoesNotExist()
      editor("openclaw").performScrollTo().performTextReplacement("Gateway B phrase")
      composeRule.onNodeWithText("Save wake words").performScrollTo().performClick()
      composeRule.waitForIdle()
      awaitRuntime {
        while (
          runtime.voiceWakeWordsSaving.value || runtime.voiceWakeWordsNoticeText.value == null
        ) {
          delay(10)
        }
      }
      assertEquals(
        listOf(gatewayB to listOf("Gateway B phrase", "claude", "computer")),
        writes.toList(),
      )
      assertEquals("Wake words saved", runtime.voiceWakeWordsNoticeText.value)
    } finally {
      composeRule.runOnIdle { mounted.value = false }
      try {
        models.clear()
      } finally {
        try {
          closeNodeRuntimeTestFixture(runtime)
        } finally {
          ShadowSpeechRecognizer.setIsOnDeviceRecognitionAvailable(wasAvailable)
        }
      }
    }
  }

  private fun awaitRuntime(block: suspend () -> Unit) {
    drainWithMainLooper { withTimeout(5_000) { block() } }
  }
}
