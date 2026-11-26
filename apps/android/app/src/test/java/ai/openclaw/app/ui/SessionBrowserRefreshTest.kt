package ai.openclaw.app.ui

import ai.openclaw.app.AndroidScreenshotFixture
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.NodeApp
import ai.openclaw.app.NodeRuntime
import ai.openclaw.app.NodeRuntimeMode
import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.closeNodeRuntimeTestFixture
import ai.openclaw.app.drainWithMainLooper
import ai.openclaw.app.gateway.GatewayRegistryEntry
import ai.openclaw.app.gateway.GatewayRegistryEntryKind
import ai.openclaw.app.gateway.GatewayRequestOutcomeUnknown
import android.content.Context
import android.os.Looper
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModelStore
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.job
import kotlinx.coroutines.joinAll
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.util.ReflectionHelpers
import java.time.Duration
import java.util.UUID
import java.util.concurrent.atomic.AtomicInteger

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SessionBrowserRefreshTest {
  @get:Rule val compose = createComposeRule()

  // Reads settle off the UI thread; wait for the rendered state instead of racing it.
  private fun shows(text: String) {
    compose.waitUntil(5_000) { compose.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty() }
  }

  @Test
  fun archivedQueryRetainsOnlyItsOwnAcceptedPageAndReadsOncePerChange() {
    val app = RuntimeEnvironment.getApplication() as NodeApp
    val prefs = SecurePrefs(app, app.getSharedPreferences("archive-refresh-${UUID.randomUUID()}", Context.MODE_PRIVATE))
    val gateway = AndroidScreenshotFixture.gatewayId
    prefs.gatewayRegistry.upsert(GatewayRegistryEntry(gateway, GatewayRegistryEntryKind.MANUAL, gateway))
    prefs.gatewayRegistry.setActive(gateway)
    val runtime = NodeRuntime(app, prefs, NodeRuntimeMode.ScreenshotFixture)
    val models = ViewModelStore()
    val mounted = mutableStateOf(true)
    val query = mutableStateOf("")
    val activeResponse = CompletableDeferred<String>()
    val failedResponse = CompletableDeferred<String>()
    val supersededResponse = CompletableDeferred<String>()
    val emptyResponse = CompletableDeferred<String>()
    val scopedReads = AtomicInteger()
    val widenedRead = CompletableDeferred<Unit>()
    try {
      drainWithMainLooper {
        runtime.chat.sessions.first { it.isNotEmpty() }
        // The screenshot history bootstrap awaits a health-driven roster refresh after publishing its rows.
        val chatScope = ReflectionHelpers.getField<CoroutineScope>(runtime.chat, "scope")
        val startupReads =
          chatScope.coroutineContext.job.children
            .filterIsInstance<Deferred<*>>()
            .toList()
        withTimeout(5_000) { startupReads.joinAll() }
      }
      val original = ReflectionHelpers.getField<suspend (String, String?) -> String>(runtime.chat, "requestGateway")
      val request: suspend (String, String?) -> String = { method, params ->
        if (method != "sessions.list") {
          original(method, params)
        } else if (Json.parseToJsonElement(requireNotNull(params)).jsonObject["archived"] == JsonPrimitive(true)) {
          when (scopedReads.incrementAndGet()) {
            1, 5 -> """{"sessions":[{"key":"ledger","archived":true}]}"""
            2 -> failedResponse.await()
            3 -> supersededResponse.await()
            4 -> emptyResponse.await()
            else -> throw GatewayRequestOutcomeUnknown("request timeout")
          }
        } else {
          val page = Json.parseToJsonElement(requireNotNull(params)).jsonObject
          when {
            page["offset"] == JsonPrimitive(1) -> {
              """{"sessions":[{"key":"second"}],"totalCount":2}"""
            }

            page["limit"] == JsonPrimitive(2) -> {
              widenedRead.complete(Unit)
              activeResponse.await()
            }

            else -> {
              """{"sessions":[{"key":"first"}],"totalCount":2}"""
            }
          }
        }
      }
      val boundRequest: suspend (String, String, String?) -> String = { _, method, params -> request(method, params) }
      ReflectionHelpers.setField(runtime.chat, "requestGateway", request)
      ReflectionHelpers.setField(runtime.chat, "requestGatewayForGateway", boundRequest)
      val model = MainViewModel(app, prefs, SavedStateHandle())
      models.put("archive-refresh", model)
      ReflectionHelpers.getField<MutableStateFlow<NodeRuntime?>>(model, "runtimeRef").value = runtime
      // Bind the live runtime state before mounting; the test counts subsequent wire reads.
      runtime.chat.refreshSessions(limit = 1)
      drainWithMainLooper {
        model.chatSessions.first { rows -> rows.any { it.key == "first" } }
        withTimeout(5_000) {
          model.isConnected.first { it == runtime.gatewayConnectionDisplay.value.isConnected }
          model.gatewayCatalogRevision.first { it == runtime.gatewayCatalogRevision.value }
          model.sessionBrowserRevision.first { it == runtime.chat.sessionBrowserRevision.value }
          combine(model.chatSessionOwnerAgentId, model.gatewayDefaultAgentId) { owner, fallback -> owner ?: fallback }
            .first { it == (runtime.chat.sessionOwnerAgentId.value ?: runtime.gatewayDefaultAgentId.value) }
        }
      }
      compose.setContent {
        if (mounted.value) {
          val state = rememberSessionBrowserSearchState(model, model.chatSessions.collectAsState().value, query.value, archived = true)
          BasicText("${state.entries.joinToString { it.key }}:${state.loading}")
        }
      }
      shows("ledger:false")

      drainWithMainLooper { assertTrue(runtime.chat.loadMoreSessions()) }
      drainWithMainLooper { model.chatSessions.first { rows -> rows.any { it.key == "second" } } }
      compose.waitForIdle()
      assertEquals(1, scopedReads.get())

      fun event(
        name: String,
        payload: String,
      ) {
        val before = model.sessionBrowserRevision.value
        runtime.chat.handleGatewayEvent(name, payload)
        drainWithMainLooper { withTimeout(5_000) { model.sessionBrowserRevision.first { it > before } } }
        compose.waitForIdle()
      }

      fun preferenceChange() = event("users.prefs.changed", """{"keys":["ui.railShortcuts"]}""")
      preferenceChange()
      drainWithMainLooper { withTimeout(5_000) { widenedRead.await() } }
      assertEquals(2, scopedReads.get())
      shows("ledger:true")
      // Release only the changed ACTIVE page. A second archive request would overtake the first.
      activeResponse.complete("""{"sessions":[{"key":"new-pin","pinned":true}]}""")
      drainWithMainLooper { withTimeout(5_000) { model.chatSessions.first { rows -> rows.any { it.key == "new-pin" } } } }
      compose.waitForIdle()
      assertEquals(2, scopedReads.get())
      compose.runOnIdle { failedResponse.completeExceptionally(GatewayRequestOutcomeUnknown("request timeout")) }
      shows("ledger:false")
      // An ordinary row event starts a real read; an off-window delete supersedes it while held.
      event("sessions.changed", """{"agentId":"main","session":{"key":"new-pin","label":"Changed"}}""")
      assertEquals(3, scopedReads.get())
      event("sessions.changed", """{"agentId":"main","sessionKey":"ledger","reason":"delete"}""")
      assertEquals(4, scopedReads.get())
      compose.runOnIdle { supersededResponse.complete("""{"sessions":[{"key":"stale","archived":true}]}""") }
      shows("ledger:true")
      compose.runOnIdle { emptyResponse.complete("""{"sessions":[]}""") }
      shows(":false")
      preferenceChange()
      shows("ledger:false")
      compose.runOnIdle { query.value = "different scope" }
      shows(":true")
      shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(250))
      compose.mainClock.advanceTimeBy(250)
      shows(":false")
      assertEquals(6, scopedReads.get())
    } finally {
      activeResponse.complete("""{"sessions":[]}""")
      failedResponse.complete("""{"sessions":[]}""")
      supersededResponse.complete("""{"sessions":[]}""")
      emptyResponse.complete("""{"sessions":[]}""")
      compose.runOnIdle { mounted.value = false }
      try {
        models.clear()
      } finally {
        closeNodeRuntimeTestFixture(runtime)
      }
    }
  }
}
