package ai.openclaw.app.ui

import ai.openclaw.app.MainViewModel
import ai.openclaw.app.NodeApp
import ai.openclaw.app.NodeRuntime
import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.bindNodeRuntimeTestFixture
import ai.openclaw.app.closeNodeRuntimeTestFixture
import ai.openclaw.app.drainWithMainLooper
import ai.openclaw.app.gateway.GatewayEndpoint
import ai.openclaw.app.gateway.GatewayRequestNotEnqueued
import ai.openclaw.app.ui.design.ClawDesignTheme
import android.content.Context
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextReplacement
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModelStore
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.util.ReflectionHelpers
import java.util.UUID
import java.util.concurrent.atomic.AtomicInteger

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w1000dp-h1000dp-mdpi")
class SessionsScreenReconnectSearchTest {
  @get:Rule val composeRule = createComposeRule()

  @Test
  fun reconnectRepeatsOfflineSearchEvenWhenTheRecentRosterIsUnchanged() {
    val app = RuntimeEnvironment.getApplication() as NodeApp
    val preferences = app.getSharedPreferences("search-${UUID.randomUUID()}", Context.MODE_PRIVATE)
    val prefs = SecurePrefs(app, preferences)
    val previousRuntime = app.peekRuntime()
    val runtime = NodeRuntime(app, prefs, initialReconnectSuppressed = true)
    val models = ViewModelStore()
    val mounted = mutableStateOf(true)
    val onlineSearches = AtomicInteger()
    val rosterRequests = AtomicInteger()
    val connected = ReflectionHelpers.getField<MutableStateFlow<Boolean>>(runtime, "_isConnected")
    val roster =
      (0 until 200).map { index ->
        buildJsonObject {
          put("key", JsonPrimitive("agent:main:recent-$index"))
          put("label", JsonPrimitive("Recent note $index"))
          put("updatedAt", JsonPrimitive(1_000L - index))
        }
      }
    val older =
      buildJsonObject {
        put("key", JsonPrimitive("agent:main:older"))
        put("label", JsonPrimitive("Older trip"))
        put("updatedAt", JsonPrimitive(1L))
      }

    fun setConnected(value: Boolean) {
      ReflectionHelpers.setField(runtime, "operatorConnected", value)
      connected.value = value
      if (!value) runtime.chat.onDisconnected("Synthetic network loss")
    }

    val requester: suspend (String, String?) -> String = { method, raw ->
      check(method == "sessions.list")
      if (!connected.value) throw GatewayRequestNotEnqueued("Synthetic network loss")
      val parsed = Json.parseToJsonElement(requireNotNull(raw))
      val params = parsed.jsonObject
      val query = params["search"]?.jsonPrimitive?.content
      val rows =
        if (query == null) {
          rosterRequests.incrementAndGet()
          roster
        } else {
          assertEquals("Older trip", query)
          assertEquals("main", params["agentId"]?.jsonPrimitive?.content)
          onlineSearches.incrementAndGet()
          listOf(older)
        }
      buildJsonObject {
        put("sessions", JsonArray(rows))
        put("hasMore", JsonPrimitive(query == null))
        put("totalCount", JsonPrimitive(if (query == null) 201 else 1))
      }.toString()
    }
    try {
      ReflectionHelpers.setField(
        runtime,
        "connectedEndpoint",
        GatewayEndpoint.manual("127.0.0.1", 18789),
      )
      ReflectionHelpers.setField(runtime.chat, "requestGateway", requester)
      bindNodeRuntimeTestFixture(app, runtime)
      setConnected(true)
      runtime.chat.prepareMainSessionKey("agent:main:main")
      runtime.chat.refreshSessions(limit = 200)
      drainWithMainLooper {
        withTimeout(10_000) { runtime.chat.sessions.first { it.size == 200 } }
      }
      val cached = runtime.chat.sessions.value
      setConnected(false)
      val model = MainViewModel(app, prefs, SavedStateHandle())
      models.put("search", model)
      val runtimeRef =
        ReflectionHelpers.getField<MutableStateFlow<NodeRuntime?>>(model, "runtimeRef")
      runtimeRef.value = runtime
      composeRule.setContent {
        if (mounted.value) {
          ClawDesignTheme {
            SessionsScreen(model, false, {}, {})
          }
        }
      }
      composeRule.waitForIdle()
      assertRowDisplayed("Recent note 0")
      // Offline matching still uses the real controller's cached-list fallback.
      composeRule.onNode(hasSetTextAction()).performTextReplacement("Recent note 0")
      composeRule.waitForIdle()
      composeRule.mainClock.advanceTimeBy(300)
      composeRule.waitForIdle()
      assertRowDisplayed("Recent note 0")
      assertEquals(0, onlineSearches.get())

      composeRule.onNode(hasSetTextAction()).performTextReplacement("Older trip")
      composeRule.waitForIdle()
      composeRule.mainClock.advanceTimeBy(300)
      composeRule.waitForIdle()
      composeRule.onNodeWithText("No matching threads").assertIsDisplayed()
      assertFalse(model.isConnected.value)
      val requestsBeforeReconnect = rosterRequests.get()
      composeRule.runOnIdle { setConnected(true) }
      composeRule.waitForIdle()
      composeRule.waitUntil(10_000) { rosterRequests.get() > requestsBeforeReconnect }
      composeRule.waitForIdle()
      composeRule.mainClock.advanceTimeBy(300)
      composeRule.waitForIdle()

      // Expected RED on base: no retry means the remote-only row stays missing.
      assertRowDisplayed("Older trip")
      assertEquals(1, onlineSearches.get())
      assertEquals(cached, runtime.chat.sessions.value)
      composeRule.onNodeWithText("No matching threads").assertDoesNotExist()

      composeRule.onNodeWithContentDescription("Clear thread search").performClick()
      composeRule.waitForIdle()
      assertRowDisplayed("Recent note 0")
      assertEquals(1, onlineSearches.get())
    } finally {
      composeRule.runOnIdle { mounted.value = false }
      try {
        models.clear()
      } finally {
        try {
          closeNodeRuntimeTestFixture(runtime)
        } finally {
          bindNodeRuntimeTestFixture(app, previousRuntime)
        }
      }
    }
  }

  private fun assertRowDisplayed(title: String) {
    val row = hasText(title) and hasClickAction() and !hasSetTextAction()
    composeRule.onNode(row).assertIsDisplayed()
  }
}
