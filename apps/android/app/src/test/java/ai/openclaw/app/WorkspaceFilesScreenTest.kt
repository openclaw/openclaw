package ai.openclaw.app

import ai.openclaw.app.gateway.GatewayEndpoint
import ai.openclaw.app.gateway.GatewaySession
import ai.openclaw.app.node.ConnectionManager
import ai.openclaw.app.ui.WorkspaceFilesScreen
import ai.openclaw.app.ui.design.ClawDesignTheme
import android.content.Context
import android.provider.Settings
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToIndex
import androidx.compose.ui.test.performScrollToNode
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModelStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.job
import kotlinx.coroutines.joinAll
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.util.ReflectionHelpers
import java.net.InetAddress
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicReference

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h891dp")
class WorkspaceFilesScreenTest {
  @get:Rule val compose = createComposeRule()

  private val app get() = RuntimeEnvironment.getApplication() as NodeApp
  private val server = MockWebServer()
  private val requests = CopyOnWriteArrayList<JsonObject>()
  private val finalPage = AtomicReference<Pair<WebSocket, String>>()
  private val models = ViewModelStore()
  private lateinit var runtime: NodeRuntime
  private lateinit var session: GatewaySession
  private var showScreen by mutableStateOf(true)
  private var animationScale = 1f
  private var contentInstalled = false

  @Before
  fun setUp() {
    animationScale = Settings.Global.getFloat(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f)
    Settings.Global.putFloat(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
    val prefs = SecurePrefs(app, app.getSharedPreferences("workspace-files-screen-test", Context.MODE_PRIVATE))
    prefs.setOnboardingCompleted(true)
    runtime = NodeRuntime(app, prefs, NodeRuntimeMode.ScreenshotFixture)
    bindNodeRuntimeTestFixture(app, runtime)
    session = ReflectionHelpers.getField(runtime, "operatorSession")
    drainWithMainLooper {
      val jobs =
        ReflectionHelpers
          .getField<CoroutineScope>(runtime, "scope")
          .coroutineContext.job.children
          .toList()
      jobs.forEach { it.cancel() }
      jobs.joinAll()
      session.disconnectAndJoin()
      ReflectionHelpers.getField<GatewaySession>(runtime, "nodeSession").disconnectAndJoin()
    }
    server.enqueue(MockResponse().withWebSocketUpgrade(listener()))
    server.start(InetAddress.getByName("127.0.0.1"), 0)
    val endpoint = GatewayEndpoint.manual("127.0.0.1", server.port)
    ReflectionHelpers.setField(runtime, "connectedEndpoint", endpoint)
    val manager = ReflectionHelpers.getField<ConnectionManager>(runtime, "connectionManager")
    runtime.selectChatAgent("main")
    session.connect(endpoint, "synthetic-files-proof", null, null, manager.buildOperatorConnectOptions())
    compose.waitUntil(15_000) { runtime.isConnected.value }
    val model = MainViewModel(app, prefs, SavedStateHandle())
    models.put("files", model)
    model.setForeground(true)
    compose.setContent {
      ClawDesignTheme(dark = false) {
        if (showScreen) WorkspaceFilesScreen(model, onBack = {})
      }
    }
    contentInstalled = true
    compose.waitUntil(15_000) { requests.size == 1 }
    awaitReady()
    compose.onNodeWithText("file-000.txt").assertIsDisplayed()
  }

  @After
  fun tearDown() {
    try {
      try {
        if (contentInstalled) {
          compose.runOnIdle { showScreen = false }
          compose.waitForIdle()
        }
      } finally {
        models.clear()
        if (::runtime.isInitialized) closeNodeRuntimeTestFixture(runtime)
      }
    } finally {
      bindNodeRuntimeTestFixture(app, null)
      server.shutdown()
      Settings.Global.putFloat(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, animationScale)
    }
  }

  @Test
  fun successfulFinalPageClearsAppendErrorAndRepeatedFailuresKeepRows() {
    // The default RPC page is 250 rows. Both failed retries must keep that offset and those rows.
    loadMore()
    compose.waitUntil(15_000) { requests.size == 2 }
    assertFailedPage()
    loadMore()
    compose.waitUntil(15_000) { requests.size == 3 }
    assertFailedPage()

    loadMore()
    compose.waitUntil(15_000) { finalPage.get() != null }
    // A pending retry is not recovery: retain the old error until the request succeeds.
    compose.onNode(hasScrollAction()).performScrollToIndex(0)
    compose.onNodeWithText("Files unavailable").assertIsDisplayed()
    compose.onNodeWithText("file-000.txt").assertIsDisplayed()
    val (socket, id) = checkNotNull(finalPage.getAndSet(null))
    socket.send(response(id, listing(offset = 250, count = 1)))
    awaitReady()
    compose.onNode(hasScrollAction()).performScrollToNode(hasText("file-250.txt"))
    compose.onNodeWithText("file-250.txt").assertIsDisplayed()
    compose.onNodeWithText("Load more").assertDoesNotExist()
    compose.onNode(hasScrollAction()).performScrollToIndex(0)
    compose.onNodeWithText("file-000.txt").assertIsDisplayed()
    compose.onNodeWithText("Files unavailable").assertDoesNotExist()
    compose.onNodeWithText("Could not load this folder.").assertDoesNotExist()
    assertEquals(listOf(null, "250", "250", "250"), requests.map { it["offset"]?.jsonPrimitive?.content })
    // Exercise the server's default page size instead of reducing it for this fixture.
    requests.forEach { assertEquals(null, it["limit"]) }
  }

  private fun loadMore() {
    compose.onNode(hasScrollAction()).performScrollToNode(hasText("Load more"))
    compose.onNodeWithText("Load more").performClick()
  }

  private fun awaitReady() {
    compose.waitUntil(15_000) {
      compose.onAllNodesWithContentDescription("Refresh").fetchSemanticsNodes().isNotEmpty()
    }
  }

  private fun assertFailedPage() {
    compose.onNode(hasScrollAction()).performScrollToIndex(0)
    awaitReady()
    compose.onNodeWithText("Files unavailable").assertIsDisplayed()
    compose.onNodeWithText("Could not load this folder.").assertIsDisplayed()
    compose.onNodeWithText("file-000.txt").assertIsDisplayed()
    compose.onNode(hasScrollAction()).performScrollToNode(hasText("250 of 251"))
    compose.onNodeWithText("Load more").assertIsDisplayed()
  }

  private fun listener() =
    object : WebSocketListener() {
      override fun onOpen(
        webSocket: WebSocket,
        response: Response,
      ) {
        webSocket.send("""{"type":"event","event":"connect.challenge","payload":{"nonce":"files-proof","ts":1700000000123}}""")
      }

      override fun onMessage(
        webSocket: WebSocket,
        text: String,
      ) {
        val frame = Json.parseToJsonElement(text).jsonObject
        if (frame["type"]?.jsonPrimitive?.content != "req") return
        val id = checkNotNull(frame["id"]).toString()
        val method = frame["method"]?.jsonPrimitive?.content
        val payload =
          when (method) {
            "connect" -> {
              """{"server":{"host":"files-proof"},"auth":{"role":"operator","scopes":["operator.read"]},"snapshot":{"sessionDefaults":{"mainSessionKey":"main"}}}"""
            }

            "agents.list" -> {
              """{"defaultId":"main","mainKey":"main","agents":[{"id":"main"}]}"""
            }

            "agents.workspace.list" -> {
              requests += frame["params"]!!.jsonObject
              when (requests.size) {
                1 -> {
                  listing(offset = 0, count = 250)
                }

                2, 3 -> {
                  webSocket.send("""{"type":"res","id":$id,"ok":false,"error":{"code":"UNAVAILABLE","message":"synthetic page failure"}}""")
                  return
                }

                else -> {
                  finalPage.set(webSocket to id)
                  return
                }
              }
            }

            else -> {
              "{}"
            }
          }
        webSocket.send(response(id, payload))
      }
    }

  private fun response(
    id: String,
    payload: String,
  ) = """{"type":"res","id":$id,"ok":true,"payload":$payload}"""

  private fun listing(
    offset: Int,
    count: Int,
  ): String =
    buildJsonObject {
      put("path", "")
      put("offset", offset)
      put("totalEntries", 251)
      put(
        "entries",
        JsonArray(
          (offset until offset + count).map { index ->
            val name = "file-" + index.toString().padStart(3, '0') + ".txt"
            buildJsonObject {
              put("path", name)
              put("name", name)
              put("kind", "file")
              put("size", 1)
            }
          },
        ),
      )
    }.toString()
}
