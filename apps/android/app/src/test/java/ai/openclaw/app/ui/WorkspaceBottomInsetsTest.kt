package ai.openclaw.app.ui

import ai.openclaw.app.MainViewModel
import ai.openclaw.app.NodeApp
import ai.openclaw.app.NodeRuntime
import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.bindNodeRuntimeTestFixture
import ai.openclaw.app.closeNodeRuntimeTestFixture
import ai.openclaw.app.gateway.GatewayEndpoint
import ai.openclaw.app.ui.design.ClawDesignTheme
import android.content.Context
import android.provider.Settings
import android.view.View
import androidx.activity.compose.LocalActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performSemanticsAction
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModelStore
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.ErrorCollector
import org.junit.rules.ExternalResource
import org.junit.rules.RuleChain
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.net.InetAddress
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "en-rUS-w360dp-h800dp-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class WorkspaceBottomInsetsTest {
  private val composeRule = createComposeRule()
  private val errors = ErrorCollector()
  private val models = ViewModelStore()
  private lateinit var app: NodeApp
  private lateinit var runtime: NodeRuntime
  private lateinit var view: View
  private lateinit var gateway: BottomInsetsGateway
  private var previousRuntime: NodeRuntime? = null
  private var previousAnimatorScale: String? = null
  private var providers by mutableStateOf(false)
  private var consumeBottom by mutableStateOf(false)
  private var observedBottom = -1

  @get:Rule
  val fixtureRules: RuleChain =
    RuleChain
      .outerRule(errors)
      .around(
        object : ExternalResource() {
          override fun after() {
            try {
              models.clear()
              if (::runtime.isInitialized) closeNodeRuntimeTestFixture(runtime)
            } finally {
              if (::app.isInitialized) {
                bindNodeRuntimeTestFixture(app, previousRuntime)
                Settings.Global.putString(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, previousAnimatorScale)
              }
              if (::gateway.isInitialized) gateway.close()
            }
          }
        },
      ).around(composeRule)

  @Before
  fun setUp() {
    app = RuntimeEnvironment.getApplication() as NodeApp
    previousRuntime = app.peekRuntime()
    previousAnimatorScale = Settings.Global.getString(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE)
    Settings.Global.putFloat(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
    gateway = BottomInsetsGateway()
    val prefs = SecurePrefs(app, app.getSharedPreferences("bottom-insets-" + UUID.randomUUID(), Context.MODE_PRIVATE))
    prefs.setManualTls(false)
    prefs.saveGatewayCredentials(gateway.endpoint.stableId, token = "synthetic-inset-proof")
    runtime = NodeRuntime(app, prefs)
    bindNodeRuntimeTestFixture(app, runtime)
    val model = MainViewModel(app, prefs, SavedStateHandle())
    models.put("insets", model)
    model.setForeground(true)
    composeRule.setContent {
      val activity = requireNotNull(LocalActivity.current)
      val localView = LocalView.current
      val bottom = WindowInsets.safeDrawing.getBottom(LocalDensity.current)
      LaunchedEffect(activity) { WindowCompat.setDecorFitsSystemWindows(activity.window, false) }
      SideEffect {
        view = localView
        observedBottom = bottom
      }
      ClawDesignTheme {
        Box(Modifier.fillMaxSize().testTag("window")) {
          val padding = if (consumeBottom) Modifier.windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Bottom)) else Modifier
          Box(Modifier.fillMaxSize().then(padding)) {
            SidebarNavigationShell(drawerState = rememberDrawerState(DrawerValue.Closed), drawerContent = {}) {
              if (providers) ProvidersModelsScreen(model, {}) else WorkspaceFilesScreen(model, {})
            }
          }
        }
      }
    }
    composeRule.runOnIdle { model.connect(gateway.endpoint) }
    composeRule.waitUntil(10_000) { composeRule.onAllNodes(hasText("notes-01.txt") and hasClickAction()).fetchSemanticsNodes().isNotEmpty() }
  }

  @Test
  fun threeButtonNavigationLeavesEveryScreenReachableWithoutDoublePadding() = verifyScreens(48)

  @Test
  fun gestureNavigationLeavesEveryScreenReachableWithoutDoublePadding() = verifyScreens(24)

  private fun verifyScreens(bottomDp: Int) {
    val bottomPx = (bottomDp * composeRule.density.density).toInt()
    composeRule.runOnIdle {
      ViewCompat.dispatchApplyWindowInsets(
        view,
        WindowInsetsCompat
          .Builder()
          .setInsets(WindowInsetsCompat.Type.navigationBars(), Insets.of(0, 0, 0, bottomPx))
          .setVisible(WindowInsetsCompat.Type.navigationBars(), true)
          .build(),
      )
    }
    composeRule.waitForIdle()
    assertEquals("Compose must observe platform insets before judging layout", bottomPx, observedBottom)

    val list = composeRule.onNode(SemanticsMatcher.keyIsDefined(SemanticsActions.ScrollToIndex))
    list.performScrollToNode(hasText("Load more"))
    verifyViewport("files", bottomDp, "Load more")
    composeRule.onNode(hasText("notes-24.txt") and hasClickAction()).performClick()
    composeRule.waitUntil(10_000) { composeRule.onAllNodes(hasText(PREVIEW_BODY)).fetchSemanticsNodes().isNotEmpty() }
    verifyViewport("preview", bottomDp, PREVIEW_BODY)
    composeRule.onNodeWithContentDescription("Back").performClick()
    composeRule.runOnIdle { providers = true }
    composeRule.waitForIdle()
    composeRule.waitUntil(10_000) { composeRule.onAllNodes(hasText("Example model 01")).fetchSemanticsNodes().isNotEmpty() }
    list.performScrollToNode(hasText("Example model 12"))
    verifyViewport("providers", bottomDp, "Example model 12")
  }

  private fun verifyViewport(
    scene: String,
    bottomDp: Int,
    finalText: String,
  ) {
    val viewport = composeRule.onNode(SemanticsMatcher.keyIsDefined(SemanticsProperties.VerticalScrollAxisRange))
    for (consumed in listOf(false, true)) {
      composeRule.runOnIdle { consumeBottom = consumed }
      viewport.performSemanticsAction(SemanticsActions.ScrollBy) { it(0f, 100_000f) }
      composeRule.waitForIdle()
      val bounds = viewport.getUnclippedBoundsInRoot()
      val window = composeRule.onNodeWithTag("window").getUnclippedBoundsInRoot()
      val range = viewport.fetchSemanticsNode().config[SemanticsProperties.VerticalScrollAxisRange]
      assertTrue("Fixture must overflow the actual production viewport", range.maxValue() > 0f)
      composeRule.onNodeWithText(finalText).assertIsDisplayed()
      errors.checkSucceeds {
        // Each screen keeps its existing 4dp margin above the navigation-safe viewport.
        assertEquals(scene + ": reserve the navigation inset exactly once; ancestor consumed=" + consumed, window.bottom.value - bottomDp - 4f, bounds.bottom.value, 1f / composeRule.density.density)
        val last = composeRule.onNodeWithText(finalText).getUnclippedBoundsInRoot()
        assertTrue(scene + ": the final content must end above navigation", last.bottom.value <= window.bottom.value - bottomDp)
      }
    }
    composeRule.runOnIdle { consumeBottom = false }
  }
}

private val PREVIEW_BODY = (1..48).joinToString("\n") { "Workspace note " + it.toString().padStart(2, '0') }

/** Fixed external RPC data; layout and navigation remain the real application code. */
private class BottomInsetsGateway : AutoCloseable {
  private val server = MockWebServer()
  val endpoint: GatewayEndpoint

  init {
    repeat(2) { server.enqueue(MockResponse().withWebSocketUpgrade(listener())) }
    server.start(InetAddress.getByName("127.0.0.1"), 0)
    endpoint = GatewayEndpoint.manual("127.0.0.1", server.port)
  }

  private fun listener() =
    object : WebSocketListener() {
      override fun onOpen(
        webSocket: WebSocket,
        response: Response,
      ) {
        webSocket.send("""{"type":"event","event":"connect.challenge","payload":{"nonce":"inset-proof","ts":1700000000123}}""")
      }

      override fun onMessage(
        webSocket: WebSocket,
        text: String,
      ) {
        val frame = Json.parseToJsonElement(text).jsonObject
        if (frame["type"] != JsonPrimitive("req")) return
        val method = frame["method"]?.jsonPrimitive?.content
        val params = frame["params"] as? JsonObject ?: JsonObject(emptyMap())
        val payload =
          when (method) {
            "connect" -> {
              Json.parseToJsonElement("""{"type":"hello-ok","protocol":3,"server":{"host":"inset-proof","version":"proof"},"features":{"methods":["agents.list","agents.workspace.list","agents.workspace.get","models.list","models.authStatus","chat.history","chat.metadata","health","sessions.list"],"events":[]},"auth":{"role":${params.getValue("role")},"scopes":["operator.read","operator.write"]},"snapshot":{"sessionDefaults":{"mainSessionKey":"agent:main:main"}}}""")
            }

            "agents.list" -> {
              Json.parseToJsonElement("""{"defaultId":"main","mainKey":"main","agents":[{"id":"main"}]}""")
            }

            "agents.workspace.list" -> {
              buildJsonObject {
                put("agentId", "main")
                put("workspace", "/synthetic-workspace")
                put("path", "")
                put("totalEntries", 30)
                put("offset", 0)
                put(
                  "entries",
                  buildJsonArray {
                    for (index in 1..24) {
                      add(
                        buildJsonObject {
                          val name = "notes-" + index.toString().padStart(2, '0') + ".txt"
                          put("path", name)
                          put("name", name)
                          put("kind", "file")
                          put("size", 1024)
                        },
                      )
                    }
                  },
                )
              }
            }

            "agents.workspace.get" -> {
              buildJsonObject {
                put("agentId", "main")
                put("workspace", "/synthetic-workspace")
                put(
                  "file",
                  buildJsonObject {
                    put("path", params.getValue("path"))
                    put("name", params.getValue("path"))
                    put("mimeType", "text/plain")
                    put("encoding", "utf8")
                    put("content", PREVIEW_BODY)
                  },
                )
              }
            }

            "models.list" -> {
              buildJsonObject {
                put(
                  "models",
                  buildJsonArray {
                    for (index in 1..12) {
                      add(
                        buildJsonObject {
                          val number = index.toString().padStart(2, '0')
                          put("id", "example-model-" + number)
                          put("name", "Example model " + number)
                          put("provider", "example")
                          put("available", true)
                        },
                      )
                    }
                  },
                )
              }
            }

            "models.authStatus" -> {
              Json.parseToJsonElement("""{"providers":[{"id":"example","displayName":"Example Provider","status":"ready","profileCount":1}]}""")
            }

            "chat.history" -> {
              Json.parseToJsonElement("""{"sessionId":"inset-proof","messages":[]}""")
            }

            "chat.metadata" -> {
              Json.parseToJsonElement("""{"commands":[],"models":[]}""")
            }

            "sessions.list" -> {
              Json.parseToJsonElement("""{"sessions":[]}""")
            }

            else -> {
              JsonObject(emptyMap())
            }
          }
        webSocket.send(
          buildJsonObject {
            put("type", "res")
            put("id", frame.getValue("id"))
            put("ok", true)
            put("payload", payload)
          }.toString(),
        )
      }
    }

  override fun close() = server.shutdown()
}
