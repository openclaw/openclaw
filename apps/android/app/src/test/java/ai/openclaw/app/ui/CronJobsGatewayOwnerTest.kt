package ai.openclaw.app.ui

import ai.openclaw.app.GatewayCronJobDetailState
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
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.util.ReflectionHelpers
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w1000dp-h1000dp-mdpi")
class CronJobsGatewayOwnerTest {
  @get:Rule val composeRule = createComposeRule()

  @Test
  fun gatewayChangeRetiresDetailAndDraftButSameGatewayReconnectKeepsThem() {
    val app = RuntimeEnvironment.getApplication() as NodeApp
    val prefs =
      SecurePrefs(
        app,
        app.getSharedPreferences("cron-owner-${UUID.randomUUID()}", Context.MODE_PRIVATE),
      )
    val original = "cron-owner-a"
    val replacement = "cron-owner-b"
    for (gateway in listOf(original, replacement)) {
      prefs.gatewayRegistry.upsert(
        GatewayRegistryEntry(gateway, GatewayRegistryEntryKind.MANUAL, gateway),
      )
    }
    prefs.gatewayRegistry.setActive(original)
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
    val detailRequests = CopyOnWriteArrayList<Pair<String, String>>()
    try {
      runtime.gatewayDataRequestOverrideForTests = { gateway, method, params ->
        val name = if (gateway == original) "Original automation" else "Replacement automation"
        when (method) {
          "cron.status" -> {
            """{"enabled":true,"jobs":1}"""
          }

          "cron.list" -> {
            """{"jobs":[${jobJson(name)}],"total":1,"hasMore":false}"""
          }

          "cron.get" -> {
            val id = Json.parseToJsonElement(requireNotNull(params)).jsonObject
            detailRequests += gateway to id.getValue("id").jsonPrimitive.content
            jobJson(name)
          }

          "cron.runs" -> {
            """{"entries":[]}"""
          }

          else -> {
            error("Unexpected Gateway operation: $method")
          }
        }
      }

      fun connected(value: Boolean) {
        ReflectionHelpers.getField<MutableStateFlow<Boolean>>(runtime, "_isConnected").value =
          value
        ReflectionHelpers.setField(runtime, "operatorConnected", value)
      }

      fun selectGateway(id: String) {
        ReflectionHelpers.setField(
          runtime,
          "connectedEndpoint",
          GatewayEndpoint(id, id, "127.0.0.1", 18789),
        )
        prefs.gatewayRegistry.setActive(id)
        ReflectionHelpers
          .getField<MutableStateFlow<List<String>>>(runtime, "_operatorScopes")
          .value = listOf("operator.admin")
      }
      selectGateway(original)
      connected(true)
      val model = MainViewModel(app, prefs, SavedStateHandle())
      models.put("cron-owner", model)
      ReflectionHelpers.getField<MutableStateFlow<NodeRuntime?>>(model, "runtimeRef").value =
        runtime
      awaitRuntime { model.operatorAdminScopeAvailable.first { it } }
      composeRule.setContent {
        if (mounted.value) {
          ClawDesignTheme(dark = true) {
            SettingsDetailScreen(model, SettingsRoute.CronJobs, onBack = {})
          }
        }
      }
      runtime.refreshCronJobs()
      awaitRuntime {
        model.cronJobs.first { it.singleOrNull()?.name == "Original automation" }
      }
      composeRule.waitForIdle()
      composeRule.onNodeWithText("Original automation").performScrollTo().performClick()
      composeRule.waitForIdle()
      awaitRuntime {
        model.cronJobDetailState.first { it is GatewayCronJobDetailState.Loaded }
      }
      composeRule.waitForIdle()
      composeRule
        .onNode(hasSetTextAction() and hasText("Original automation"))
        .performScrollTo()
        .performTextReplacement("Unsent original edit")

      // A transport reconnect is not a change of Gateway ownership.
      composeRule.runOnIdle { connected(false) }
      composeRule.onNodeWithText("Connect the gateway to inspect automations.").assertIsDisplayed()
      val beforeReconnect = detailRequests.size
      composeRule.runOnIdle { connected(true) }
      composeRule.waitForIdle()
      awaitRuntime {
        model.cronJobDetailState.first {
          it is GatewayCronJobDetailState.Loaded && detailRequests.size > beforeReconnect
        }
      }
      composeRule
        .onNode(hasSetTextAction() and hasText("Unsent original edit"))
        .performScrollTo()
        .assertIsDisplayed()
      assertEquals(original to JOB_ID, detailRequests.last())

      // Keep the real screen mounted through the handoff, as the sidebar picker does.
      composeRule.runOnIdle { connected(false) }
      composeRule.onNodeWithText("Connect the gateway to inspect automations.").assertIsDisplayed()
      composeRule.runOnIdle {
        runtime.clearCronJobDetail()
        selectGateway(replacement)
      }
      composeRule.runOnIdle { connected(true) }
      composeRule.waitForIdle()
      runtime.refreshCronJobs()
      awaitRuntime {
        model.cronJobs.first { it.singleOrNull()?.name == "Replacement automation" }
      }
      composeRule.waitForIdle()
      composeRule.onNodeWithText("Search automations").assertIsDisplayed()
      composeRule.onNodeWithText("Unsent original edit").assertDoesNotExist()
      composeRule.runOnIdle {
        assertNull(model.cronEditorDraftMemory.get(JOB_ID))
        assertFalse(detailRequests.any { it.first == replacement })
      }

      // Even when ids recur, only a fresh selection may load the replacement's job.
      composeRule.onNodeWithText("Replacement automation").performScrollTo().performClick()
      composeRule.waitForIdle()
      awaitRuntime {
        model.cronJobDetailState.first {
          it is GatewayCronJobDetailState.Loaded && it.job.name == "Replacement automation"
        }
      }
      composeRule.waitForIdle()
      composeRule
        .onNode(hasSetTextAction() and hasText("Replacement automation"))
        .performScrollTo()
        .assertIsDisplayed()
      composeRule.onNodeWithText("Unsent original edit").assertDoesNotExist()
      assertEquals(listOf(replacement to JOB_ID), detailRequests.filter { it.first == replacement })
    } finally {
      composeRule.runOnIdle { mounted.value = false }
      try {
        models.clear()
      } finally {
        closeNodeRuntimeTestFixture(runtime)
      }
    }
  }

  private fun awaitRuntime(block: suspend () -> Unit) {
    drainWithMainLooper { withTimeout(5_000) { block() } }
  }

  private fun jobJson(name: String): String =
    """
    {
      "id":"$JOB_ID","name":"$name","enabled":true,"description":"Synthetic automation",
      "createdAtMs":1000,"updatedAtMs":2000,"sessionTarget":"isolated","wakeMode":"now",
      "schedule":{"kind":"every","everyMs":60000},
      "payload":{"kind":"agentTurn","message":"Synthetic prompt"},"state":{}
    }
    """.trimIndent()

  private companion object {
    const val JOB_ID = "shared-job-id"
  }
}
