package ai.openclaw.app.ui

import ai.openclaw.app.GatewayConnectionDisplay
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.NodeApp
import ai.openclaw.app.NodeRuntime
import ai.openclaw.app.NodeRuntimeMode
import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.bindNodeRuntimeTestFixture
import ai.openclaw.app.closeNodeRuntimeTestFixture
import ai.openclaw.app.drainWithMainLooper
import ai.openclaw.app.gateway.GatewayEndpoint
import ai.openclaw.app.gateway.GatewayRegistryEntry
import ai.openclaw.app.gateway.GatewayRegistryEntryKind
import ai.openclaw.app.ui.design.ClawDesignTheme
import android.content.Context
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModelStore
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.util.ReflectionHelpers
import java.util.UUID
import java.util.concurrent.atomic.AtomicReference

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w1000dp-h1000dp-mdpi")
class HealthLogsGatewayOwnerTest {
  @get:Rule val composeRule = createComposeRule()

  @Test
  fun logDetailSurvivesSameGatewayRefreshButClosesWhenGatewayChanges() {
    val app = RuntimeEnvironment.getApplication() as NodeApp
    val previousRuntime = app.peekRuntime()
    val prefs = SecurePrefs(app, app.getSharedPreferences("health-log-owner-${UUID.randomUUID()}", Context.MODE_PRIVATE))
    val first = GatewayEndpoint.manual("127.0.0.1", 18789)
    val second = GatewayEndpoint.manual("127.0.0.1", 18790)
    for (endpoint in listOf(first, second)) {
      prefs.gatewayRegistry.upsert(GatewayRegistryEntry(endpoint.stableId, GatewayRegistryEntryKind.MANUAL, endpoint.stableId))
    }
    prefs.gatewayRegistry.setActive(first.stableId)
    val runtime = NodeRuntime(app, prefs, NodeRuntimeMode.Live)
    val models = ViewModelStore()
    val mounted = mutableStateOf(true)
    var contentInstalled = false
    val message = AtomicReference("First gateway original entry")
    try {
      // Exercise the real summary parser and screen; substitute only the external RPC response.
      ReflectionHelpers.setField(runtime, "connectedEndpoint", first)
      ReflectionHelpers.setField(runtime, "operatorConnected", true)
      ReflectionHelpers.getField<MutableStateFlow<Boolean>>(runtime, "_isConnected").value = true
      ReflectionHelpers.getField<MutableStateFlow<List<String>>>(runtime, "_operatorScopes").value = listOf("operator.admin")
      ReflectionHelpers.getField<MutableStateFlow<GatewayConnectionDisplay>>(runtime, "_gatewayConnectionDisplay").value =
        GatewayConnectionDisplay(true, "Connected", null)
      runtime.gatewayDataRequestOverrideForTests = { _, method, _ ->
        check(method == "logs.tail")
        logResponse(message.get())
      }
      bindNodeRuntimeTestFixture(app, runtime)
      val model = MainViewModel(app, prefs, SavedStateHandle())
      models.put("health-log-owner", model)
      composeRule.setContent {
        if (mounted.value) {
          ClawDesignTheme { HealthLogsSettingsScreen(model, onBack = {}) }
        }
      }
      contentInstalled = true
      model.refreshHealthLogs()
      awaitLog(runtime, message.get())
      composeRule.onNodeWithText(message.get()).performScrollTo().performClick()
      composeRule.onNodeWithText("Log Entry").assertIsDisplayed()
      composeRule.onNodeWithText(message.get()).performScrollTo().assertIsDisplayed()

      // Log rotation or refresh on the same Gateway must not interrupt reading the selected entry.
      message.set("First gateway newer entry")
      runtime.refreshHealthLogs()
      awaitLog(runtime, message.get())
      composeRule.onNodeWithText("Log Entry").assertIsDisplayed()
      composeRule.onNodeWithText("First gateway original entry").performScrollTo().assertIsDisplayed()
      composeRule.onNodeWithText(message.get()).assertDoesNotExist()

      // Keep the screen mounted; a ready replacement Gateway must retire the prior detail.
      composeRule.runOnIdle {
        message.set("Second gateway entry")
        ReflectionHelpers.setField(runtime, "connectedEndpoint", second)
        prefs.gatewayRegistry.setActive(second.stableId)
        runtime.refreshHealthLogs()
      }
      awaitLog(runtime, message.get())
      composeRule.onNodeWithText("Log Entry").assertDoesNotExist()
      composeRule.onNodeWithText("First gateway original entry").assertDoesNotExist()
      composeRule
        .onNodeWithText(message.get())
        .performScrollTo()
        .assertIsDisplayed()
        .performClick()
      composeRule.onNodeWithText("Log Entry").assertIsDisplayed()
      composeRule.onNodeWithText(message.get()).performScrollTo().assertIsDisplayed()
    } finally {
      try {
        if (contentInstalled) {
          composeRule.runOnIdle { mounted.value = false }
          composeRule.waitForIdle()
        }
      } finally {
        try {
          try {
            models.clear()
          } finally {
            closeNodeRuntimeTestFixture(runtime)
          }
        } finally {
          bindNodeRuntimeTestFixture(app, previousRuntime)
        }
      }
    }
  }

  private fun awaitLog(
    runtime: NodeRuntime,
    message: String,
  ) {
    drainWithMainLooper {
      withTimeout(5_000) {
        runtime.healthLogsState.first {
          !it.refreshing &&
            it.summary
              ?.entries
              ?.singleOrNull()
              ?.message == message
        }
      }
    }
    composeRule.waitForIdle()
  }

  private fun logResponse(message: String): String {
    val entry = buildJsonObject { put("message", message) }
    return buildJsonObject {
      put("file", "synthetic-health.log")
      put("lines", JsonArray(listOf(JsonPrimitive(entry.toString()))))
    }.toString()
  }
}
