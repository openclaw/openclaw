package ai.openclaw.app.ui.chat

import ai.openclaw.app.MainViewModel
import ai.openclaw.app.NodeApp
import ai.openclaw.app.NodeRuntime
import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.bindNodeRuntimeTestFixture
import ai.openclaw.app.closeNodeRuntimeTestFixture
import ai.openclaw.app.gateway.GatewayEndpoint
import ai.openclaw.app.ui.design.ClawDesignTheme
import ai.openclaw.app.ui.design.ClawTheme
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Looper
import android.provider.Settings
import androidx.activity.compose.LocalActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.core.content.FileProvider
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModelStore
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.ExternalResource
import org.junit.rules.RuleChain
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.shadows.ShadowContentResolver
import java.io.File
import java.net.InetAddress
import java.util.Base64
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

private const val FILE_CHAT = "agent:main:file-proof"
private const val PDF_NAME = "release-report.pdf"
private const val CSV_NAME = "release-metrics.csv"
private const val FILE_READY_TIMEOUT_MS = 15_000L
private const val DOWNLOAD_FAILURE = "Could not download. Try again or reconnect. If the file was removed or expired, ask for it to be sent again."
private const val VIEWER_FAILURE = "No app can open this file. Use Share to send it to another app."
private val CSV_BYTES = "check,status\nbuild,passed\ntests,passed\n".toByteArray()

/** Real ChatScreen actions and runtime/RPC parsing; Android launches are observed, not simulated UI. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "en-rUS-w360dp-h800dp-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ChatFileAttachmentLayoutTest {
  private val composeRule = createComposeRule()

  @get:Rule
  val fixtureRules: RuleChain =
    RuleChain
      .outerRule(
        object : ExternalResource() {
          override fun after() = tearDown()
        },
      ).around(composeRule)

  private lateinit var app: NodeApp
  private lateinit var runtime: NodeRuntime
  private lateinit var model: MainViewModel
  private lateinit var activity: Activity
  private lateinit var gateway: FileAttachmentGateway
  private val models = ViewModelStore()
  private var previousRuntime: NodeRuntime? = null
  private var restoreAnimatorScale: (() -> Unit)? = null
  private var exportRoot: File? = null
  private var originalExports = emptySet<File>()
  private var exportRootExisted = false
  private var missingViewer = false

  @Before
  fun setUp() {
    app = RuntimeEnvironment.getApplication() as NodeApp
    previousRuntime = app.peekRuntime()
    val resolver = app.contentResolver
    val originalScale = Settings.Global.getString(resolver, Settings.Global.ANIMATOR_DURATION_SCALE)
    restoreAnimatorScale = { Settings.Global.putString(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, originalScale) }
    Settings.Global.putFloat(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
    exportRoot =
      File(app.cacheDir, "chat-files").also {
        exportRootExisted = it.exists()
        originalExports = it.listFiles().orEmpty().toSet()
      }
    assertTrue(ShadowContentResolver.getProvider(Uri.parse("content://${app.packageName}.fileprovider")) is FileProvider)
    gateway = FileAttachmentGateway()
    val prefs = SecurePrefs(app, app.getSharedPreferences("file-proof-${UUID.randomUUID()}", Context.MODE_PRIVATE))
    prefs.setManualTls(false)
    prefs.saveGatewayCredentials(gateway.endpoint.stableId, token = "synthetic-file-proof")
    runtime = NodeRuntime(app, prefs)
    bindNodeRuntimeTestFixture(app, runtime)
    model = MainViewModel(app, prefs, SavedStateHandle())
    models.put("chat", model)
    model.setForeground(true)
    composeRule.setContent {
      activity = requireNotNull(LocalActivity.current)
      val context =
        remember(activity) {
          object : ContextWrapper(activity) {
            override fun startActivity(intent: Intent) {
              if (missingViewer && intent.action == Intent.ACTION_VIEW) {
                throw ActivityNotFoundException("Synthetic missing document viewer")
              }
              super.startActivity(intent)
            }
          }
        }
      CompositionLocalProvider(LocalContext provides context) {
        ClawDesignTheme {
          Box(Modifier.fillMaxSize().background(ClawTheme.colors.canvas).testTag("file-proof-chat")) {
            ChatScreen(model, false, true, {}, {}, {}, {})
          }
        }
      }
    }
    composeRule.runOnIdle { model.connect(gateway.endpoint) }
    composeRule.waitUntil(FILE_READY_TIMEOUT_MS) { runtime.gatewayConnectionDisplay.value.isConnected }
    composeRule.runOnIdle { model.switchChatSession(FILE_CHAT, ownerAgentId = "main") }
    composeRule.waitUntil(FILE_READY_TIMEOUT_MS) {
      shadowOf(Looper.getMainLooper()).idle()
      model.chatSessionKey.value == FILE_CHAT && !model.chatHistoryLoading.value &&
        model.chatMessages.value
          .lastOrNull()
          ?.entryId == "file-answer" && model.chatHealthOk.value
    }
    composeRule.onNodeWithText(PDF_NAME, useUnmergedTree = true).assertIsDisplayed()
    composeRule.onNodeWithText(CSV_NAME, useUnmergedTree = true).assertIsDisplayed()
    assertTrue("Rendering history must not download its attachments", gateway.downloads.isEmpty())
    assertNull(shadowOf(activity).nextStartedActivity)
  }

  @Test
  fun renderedDocumentsDownloadOnDemandAndOpenOrShareExactBytes() {
    // Capture before the first new-action assertion so the unchanged baseline retains its image.
    capture("ready")
    gateway.holdNext.set(true)
    composeRule
      .onNodeWithContentDescription("Open $PDF_NAME")
      .assertIsDisplayed()
      .assertIsEnabled()
      .performClick()
    composeRule.waitUntil(FILE_READY_TIMEOUT_MS) { gateway.hasHeldDownload() }
    composeRule.onNodeWithText("Downloading…").assertIsDisplayed()
    composeRule.onNodeWithContentDescription("Open $PDF_NAME").assertIsNotEnabled()
    composeRule.onNodeWithContentDescription("Share $PDF_NAME").assertIsNotEnabled()
    assertNull(shadowOf(activity).nextStartedActivity)
    capture("loading")
    gateway.releaseDownload()
    val opened = awaitLaunch()
    assertEquals(Intent.ACTION_VIEW, opened.action)
    val pdfUri = checkExport(opened, checkNotNull(opened.data), "application/pdf", gateway.pdfBytes)
    capture("downloaded")

    composeRule.onNodeWithContentDescription("Share $PDF_NAME").assertIsEnabled().performClick()
    val sharedPdf = shareIntent(awaitLaunch())
    assertEquals(pdfUri, checkExport(sharedPdf, stream(sharedPdf), "application/pdf", gateway.pdfBytes))
    assertEquals("Sharing a downloaded file reuses its immutable bytes", listOf("report"), gateway.downloadIds())

    composeRule.onNodeWithContentDescription("Share $CSV_NAME").assertIsEnabled().performClick()
    val sharedCsv = shareIntent(awaitLaunch())
    checkExport(sharedCsv, stream(sharedCsv), "text/csv", CSV_BYTES)
    assertEquals(listOf("report", "metrics"), gateway.downloadIds())
    assertTrue(gateway.downloads.all { it["sessionKey"]?.jsonPrimitive?.content == FILE_CHAT && it["agentId"]?.jsonPrimitive?.content == "main" })
    composeRule.onNodeWithText("The PDF summarizes the checks; the CSV contains the results.", useUnmergedTree = true).assertIsDisplayed()
    capture("both-downloaded")
  }

  @Test
  fun failedDownloadRetriesAndMissingViewerStillAllowsSharing() {
    gateway.failNext.set(true)
    composeRule.onNodeWithContentDescription("Open $CSV_NAME").assertIsDisplayed().performClick()
    awaitText(DOWNLOAD_FAILURE)
    assertNull(shadowOf(activity).nextStartedActivity)
    capture("download-error")
    composeRule.onNodeWithText("Retry").assertIsEnabled().performClick()
    val csv = awaitLaunch()
    checkExport(csv, checkNotNull(csv.data), "text/csv", CSV_BYTES)
    assertEquals(listOf("metrics", "metrics"), gateway.downloadIds())

    missingViewer = true
    composeRule.onNodeWithContentDescription("Open $PDF_NAME").assertIsEnabled().performClick()
    awaitText(VIEWER_FAILURE)
    assertNull(shadowOf(activity).nextStartedActivity)
    composeRule.onNodeWithContentDescription("Share $PDF_NAME").assertIsEnabled()
    capture("missing-viewer")
    composeRule.onNodeWithContentDescription("Share $PDF_NAME").performClick()
    val shared = shareIntent(awaitLaunch())
    checkExport(shared, stream(shared), "application/pdf", gateway.pdfBytes)
    assertEquals("Viewer failure does not discard a successful download", listOf("metrics", "metrics", "report"), gateway.downloadIds())
    composeRule.onNodeWithText(VIEWER_FAILURE).assertDoesNotExist()
    capture("recovered")
  }

  private fun awaitText(text: String) {
    composeRule.waitUntil(FILE_READY_TIMEOUT_MS) {
      composeRule
        .onAllNodes(
          androidx.compose.ui.test
            .hasText(text),
        ).fetchSemanticsNodes()
        .isNotEmpty()
    }
    composeRule.onNodeWithText(text).assertIsDisplayed()
  }

  private fun awaitLaunch(): Intent {
    var launched: Intent? = null
    composeRule.waitUntil(FILE_READY_TIMEOUT_MS) {
      launched = shadowOf(activity).nextStartedActivity
      launched != null
    }
    composeRule.waitForIdle()
    return checkNotNull(launched)
  }

  private fun shareIntent(chooser: Intent): Intent {
    assertEquals(Intent.ACTION_CHOOSER, chooser.action)
    return checkNotNull(chooser.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)).also {
      assertEquals(Intent.ACTION_SEND, it.action)
    }
  }

  private fun stream(intent: Intent): Uri = checkNotNull(intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java))

  private fun checkExport(
    intent: Intent,
    uri: Uri,
    mimeType: String,
    bytes: ByteArray,
  ): Uri {
    assertEquals(mimeType, intent.type)
    assertEquals("content", uri.scheme)
    assertEquals("${app.packageName}.fileprovider", uri.authority)
    assertTrue(intent.flags and Intent.FLAG_GRANT_READ_URI_PERMISSION != 0)
    assertEquals(uri, intent.clipData?.getItemAt(0)?.uri)
    assertArrayEquals(bytes, checkNotNull(app.contentResolver.openInputStream(uri)).use { it.readBytes() })
    return uri
  }

  private fun capture(name: String) {
    val directory = System.getenv("OPENCLAW_MEDIA_PROOF_DIR") ?: return
    val bitmap = composeRule.onNodeWithTag("file-proof-chat").captureToImage().asAndroidBitmap()
    assertEquals(360, bitmap.width)
    assertEquals(800, bitmap.height)
    val file = File(directory, "file-chat-$name.png")
    file.parentFile!!.mkdirs()
    file.outputStream().use { assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)) }
  }

  private fun tearDown() {
    try {
      models.clear()
    } finally {
      try {
        if (::runtime.isInitialized) closeNodeRuntimeTestFixture(runtime)
      } finally {
        try {
          if (::app.isInitialized) bindNodeRuntimeTestFixture(app, previousRuntime)
        } finally {
          try {
            if (::gateway.isInitialized) gateway.close()
          } finally {
            restoreAnimatorScale?.invoke()
            exportRoot?.let { root ->
              root
                .listFiles()
                .orEmpty()
                .filterNot(originalExports::contains)
                .forEach { assertTrue(it.deleteRecursively()) }
              if (!exportRootExisted && root.exists()) assertTrue(root.delete())
            }
          }
        }
      }
    }
  }
}

private class FileAttachmentGateway : AutoCloseable {
  private val server = MockWebServer()
  private val heldDownload = AtomicReference<(() -> Unit)?>(null)
  val holdNext = AtomicBoolean(false)
  val failNext = AtomicBoolean(false)
  val downloads = CopyOnWriteArrayList<JsonObject>()
  val pdfBytes = syntheticPdf()
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
    server.start(InetAddress.getByName("127.0.0.1"), 0)
    endpoint = GatewayEndpoint.manual("127.0.0.1", server.port)
  }

  fun hasHeldDownload(): Boolean = heldDownload.get() != null

  fun releaseDownload() = checkNotNull(heldDownload.getAndSet(null)).invoke()

  fun downloadIds(): List<String> = downloads.map { it.getValue("artifactId").jsonPrimitive.content }

  private fun listener() =
    object : WebSocketListener() {
      override fun onOpen(
        webSocket: WebSocket,
        response: Response,
      ) {
        webSocket.send("""{"type":"event","event":"connect.challenge","payload":{"nonce":"file-proof","ts":1700000000123}}""")
      }

      override fun onMessage(
        webSocket: WebSocket,
        text: String,
      ) {
        val frame = Json.parseToJsonElement(text).jsonObject
        if (frame["type"]?.jsonPrimitive?.content != "req") return
        val id = frame.getValue("id")
        val method = frame["method"]?.jsonPrimitive?.content
        val params = frame["params"] as? JsonObject ?: JsonObject(emptyMap())

        fun respond(payload: JsonElement?) {
          webSocket.send(
            buildJsonObject {
              put("type", JsonPrimitive("res"))
              put("id", id)
              put("ok", JsonPrimitive(payload != null))
              if (payload != null) {
                put("payload", payload)
              } else {
                put(
                  "error",
                  buildJsonObject {
                    put("code", JsonPrimitive("UNAVAILABLE"))
                    put("message", JsonPrimitive("Synthetic file download failure"))
                  },
                )
              }
            }.toString(),
          )
        }
        if (method == "artifacts.download") {
          downloads += params
          val artifact = params.getValue("artifactId").jsonPrimitive.content
          val reply = {
            if (failNext.getAndSet(false)) {
              respond(null)
            } else {
              val pdf = artifact == "report"
              respond(
                buildJsonObject {
                  put(
                    "artifact",
                    buildJsonObject {
                      put("id", JsonPrimitive(artifact))
                      put("type", JsonPrimitive("file"))
                      put("mimeType", JsonPrimitive(if (pdf) "application/pdf" else "text/csv"))
                    },
                  )
                  put("data", JsonPrimitive(Base64.getEncoder().encodeToString(if (pdf) pdfBytes else CSV_BYTES)))
                },
              )
            }
          }
          if (holdNext.getAndSet(false)) {
            check(heldDownload.compareAndSet(null, reply))
          } else {
            reply()
          }
          return
        }
        respond(
          when (method) {
            "connect" -> {
              val role = params.getValue("role").jsonPrimitive.content
              Json.parseToJsonElement("""{"type":"hello-ok","protocol":3,"server":{"host":"file-proof","version":"proof"},"features":{"methods":["agents.list","artifacts.download","chat.history","chat.metadata","models.list","health","sessions.list"],"events":[],"capabilities":["session-scoped-model-catalog"]},"auth":{"role":"$role","scopes":${if (role == "operator") "[\"operator.read\",\"operator.write\"]" else "[]"}},"snapshot":{"sessionDefaults":{"mainSessionKey":"agent:main:main"}}}""")
            }

            "agents.list" -> {
              Json.parseToJsonElement("""{"defaultId":"main","mainKey":"main","agents":[{"id":"main"}]}""")
            }

            "chat.history" -> {
              buildJsonObject {
                put("sessionId", JsonPrimitive("file-proof-transcript"))
                put(
                  "messages",
                  Json.parseToJsonElement(
                    """[
            {"role":"user","content":"Please prepare the release report and metrics.","__openclaw":{"id":"file-question"}},
            {"role":"assistant","content":[
              {"type":"text","text":"Here are the release files."},
              {"type":"file","artifactId":"report","fileName":"$PDF_NAME","mimeType":"application/pdf"},
              {"type":"file","artifactId":"metrics","fileName":"$CSV_NAME","mimeType":"text/csv"},
              {"type":"text","text":"The PDF summarizes the checks; the CSV contains the results."}
            ],"__openclaw":{"id":"file-answer"}}
          ]""",
                  ) as JsonArray,
                )
              }
            }

            "chat.metadata" -> {
              Json.parseToJsonElement("""{"commands":[]}""")
            }

            "models.list" -> {
              Json.parseToJsonElement("""{"models":[]}""")
            }

            "sessions.list" -> {
              Json.parseToJsonElement("""{"sessions":[]}""")
            }

            "health", "sessions.subscribe", "sessions.messages.subscribe" -> {
              JsonObject(emptyMap())
            }

            else -> {
              null
            }
          },
        )
      }
    }

  override fun close() = server.shutdown()
}

private fun syntheticPdf(): ByteArray {
  val text = "BT /F1 14 Tf 36 100 Td (Release checks passed.) Tj ET\n"
  val objects =
    listOf(
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 150] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
      "<< /Length ${text.length} >>\nstream\n${text}endstream",
    )
  val pdf = StringBuilder("%PDF-1.4\n")
  val offsets =
    objects.mapIndexed { index, value ->
      pdf.length.also { pdf.append("${index + 1} 0 obj\n$value\nendobj\n") }
    }
  val xref = pdf.length
  pdf.append("xref\n0 6\n0000000000 65535 f \n")
  offsets.forEach { pdf.append(it.toString().padStart(10, '0')).append(" 00000 n \n") }
  pdf.append("trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n$xref\n%%EOF\n")
  return pdf.toString().toByteArray(Charsets.US_ASCII)
}
