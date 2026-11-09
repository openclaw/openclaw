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
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModelStore
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.ExternalResource
import org.junit.rules.RuleChain
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w1000dp-h1000dp-mdpi")
class WorkspaceEntryAccessibilityTest {
  private val composeRule = createComposeRule()
  private val models = ViewModelStore()
  private lateinit var app: NodeApp
  private lateinit var runtime: NodeRuntime
  private lateinit var gateway: WorkspaceEntryGateway
  private var previousRuntime: NodeRuntime? = null

  @get:Rule
  val fixtureRules: RuleChain =
    RuleChain
      .outerRule(
        object : ExternalResource() {
          override fun after() {
            try {
              models.clear()
              if (::runtime.isInitialized) closeNodeRuntimeTestFixture(runtime)
            } finally {
              if (::app.isInitialized) bindNodeRuntimeTestFixture(app, previousRuntime)
              if (::gateway.isInitialized) gateway.close()
            }
          }
        },
      ).around(composeRule)

  @Before
  fun setUp() {
    app = RuntimeEnvironment.getApplication() as NodeApp
    previousRuntime = app.peekRuntime()
    gateway = WorkspaceEntryGateway()
    val storage = app.getSharedPreferences("workspace-entry-" + UUID.randomUUID(), Context.MODE_PRIVATE)
    val prefs = SecurePrefs(app, storage)
    prefs.setManualTls(false)
    prefs.saveGatewayCredentials(gateway.endpoint.stableId, token = "synthetic-workspace-entry-proof")
    runtime = NodeRuntime(app, prefs)
    bindNodeRuntimeTestFixture(app, runtime)
    val model = MainViewModel(app, prefs, SavedStateHandle())
    models.put("workspace", model)
    model.setForeground(true)
    composeRule.setContent {
      ClawDesignTheme {
        WorkspaceFilesScreen(viewModel = model, onBack = {})
      }
    }
    composeRule.runOnIdle { model.connect(gateway.endpoint) }
    awaitEntry("archive.txt")
  }

  @Test
  fun mergedRowsDiscloseActualKindAndKeepDirectoryAndFileActions() {
    val folder = composeRule.onNode(hasText("archive.txt") and hasClickAction())
    val file = composeRule.onNode(hasText("LICENSE") and hasClickAction())
    folder.assertIsDisplayed()
    file.assertIsDisplayed()
    folder.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Folder"))
    file.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "File"))

    folder.performClick()
    composeRule.waitForIdle()
    awaitEntry("nested")
    val nested = composeRule.onNode(hasText("nested") and hasClickAction())
    nested.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "File"))
    nested.performClick()
    composeRule.waitForIdle()
    awaitPreview()
    composeRule.onNodeWithText("Nested file body").assertIsDisplayed()

    composeRule.onNodeWithContentDescription("Back").performClick()
    composeRule.waitForIdle()
    awaitEntry("nested")
    composeRule.onNodeWithContentDescription("Back").performClick()
    composeRule.waitForIdle()
    awaitEntry("LICENSE")
    file.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "File"))
    file.performClick()
    composeRule.waitForIdle()
    awaitPreview()
    composeRule.onNodeWithText("Root file body").assertIsDisplayed()
  }

  private fun awaitEntry(name: String) {
    composeRule.waitUntil(10_000) {
      val nodes = composeRule.onAllNodes(hasText(name) and hasClickAction()).fetchSemanticsNodes()
      nodes.isNotEmpty()
    }
  }

  private fun awaitPreview() {
    composeRule.waitUntil(10_000) {
      val nodes = composeRule.onAllNodes(hasText("Nested file body") or hasText("Root file body"))
      nodes.fetchSemanticsNodes().isNotEmpty()
    }
  }
}

/** Only external RPC data is synthetic; parsing, list composition, clicks and previews are production. */
private class WorkspaceEntryGateway : AutoCloseable {
  private val server = MockWebServer()
  val endpoint: GatewayEndpoint

  init {
    server.dispatcher =
      object : Dispatcher() {
        override fun dispatch(request: RecordedRequest): MockResponse =
          if (request.getHeader("Upgrade").equals("websocket", ignoreCase = true)) {
            MockResponse().withWebSocketUpgrade(listener())
          } else {
            MockResponse().setResponseCode(404)
          }
      }
    server.start(java.net.InetAddress.getByName("127.0.0.1"), 0)
    endpoint = GatewayEndpoint.manual("127.0.0.1", server.port)
  }

  private fun listener() =
    object : WebSocketListener() {
      override fun onOpen(
        webSocket: WebSocket,
        response: Response,
      ) {
        webSocket.send(
          """{"type":"event","event":"connect.challenge","payload":{"nonce":"entry-proof","ts":1700000000123}}""",
        )
      }

      override fun onMessage(
        webSocket: WebSocket,
        text: String,
      ) {
        val frame = Json.parseToJsonElement(text).jsonObject
        if (frame["type"]?.jsonPrimitive?.content != "req") return
        val method = frame["method"]?.jsonPrimitive?.content
        val params = frame["params"] as? JsonObject ?: JsonObject(emptyMap())
        val payload =
          when (method) {
            "connect" -> {
              buildJsonObject {
                put("type", "hello-ok")
                put("protocol", 3)
                put(
                  "server",
                  buildJsonObject {
                    put("host", "entry-proof")
                    put("version", "proof")
                  },
                )
                put(
                  "features",
                  buildJsonObject {
                    put(
                      "methods",
                      buildJsonArray {
                        add("agents.list")
                        add("agents.workspace.list")
                        add("agents.workspace.get")
                        add("chat.history")
                        add("chat.metadata")
                        add("health")
                        add("sessions.list")
                      },
                    )
                    put("events", buildJsonArray {})
                  },
                )
                put(
                  "auth",
                  buildJsonObject {
                    put("role", params.getValue("role"))
                    put(
                      "scopes",
                      buildJsonArray {
                        if (params.getValue("role").jsonPrimitive.content == "operator") {
                          add("operator.read")
                          add("operator.write")
                        }
                      },
                    )
                  },
                )
                put(
                  "snapshot",
                  buildJsonObject {
                    put("sessionDefaults", buildJsonObject { put("mainSessionKey", "agent:main:main") })
                  },
                )
              }
            }

            "agents.list" -> {
              Json.parseToJsonElement("""{"defaultId":"main","mainKey":"main","agents":[{"id":"main"}]}""")
            }

            "agents.workspace.list" -> {
              val path = params["path"]?.jsonPrimitive?.content.orEmpty()
              buildJsonObject {
                put("path", path)
                put(
                  "entries",
                  buildJsonArray {
                    if (path.isEmpty()) {
                      add(entry("archive.txt", directory = true))
                      add(entry("LICENSE", directory = false))
                    } else {
                      check(path == "archive.txt")
                      add(entry("archive.txt/nested", directory = false))
                    }
                  },
                )
                put("totalEntries", if (path.isEmpty()) 2 else 1)
                put("offset", 0)
              }
            }

            "agents.workspace.get" -> {
              val path = params.getValue("path").jsonPrimitive.content
              check(path == "LICENSE" || path == "archive.txt/nested")
              buildJsonObject {
                put(
                  "file",
                  buildJsonObject {
                    put("path", path)
                    put("name", path.substringAfterLast('/'))
                    put("mimeType", "text/plain")
                    put("encoding", "utf8")
                    put("content", if (path == "LICENSE") "Root file body" else "Nested file body")
                  },
                )
              }
            }

            "chat.history" -> {
              Json.parseToJsonElement("""{"sessionId":"entry-proof","messages":[]}""")
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
        val result =
          buildJsonObject {
            put("type", "res")
            put("id", frame.getValue("id"))
            put("ok", true)
            put("payload", payload)
          }
        webSocket.send(result.toString())
      }
    }

  private fun entry(
    path: String,
    directory: Boolean,
  ): JsonObject =
    buildJsonObject {
      put("path", path)
      put("name", path.substringAfterLast('/'))
      put("kind", if (directory) "directory" else "file")
    }

  override fun close() {
    server.shutdown()
  }
}
