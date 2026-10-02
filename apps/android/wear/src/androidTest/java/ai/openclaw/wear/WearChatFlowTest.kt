package ai.openclaw.wear

import ai.openclaw.app.gateway.DeviceIdentityStore
import ai.openclaw.app.gateway.GatewayEndpoint
import ai.openclaw.wear.shared.WearDecodeResult
import ai.openclaw.wear.shared.WearEventType
import ai.openclaw.wear.shared.WearMessage
import ai.openclaw.wear.shared.WearProtocol
import ai.openclaw.wear.shared.WearProtocolCodec
import ai.openclaw.wear.shared.WearReplyText
import ai.openclaw.wear.shared.WearRpcMethod
import android.app.Activity
import android.app.Instrumentation
import android.app.RemoteInput
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.SystemClock
import android.view.ViewTreeObserver
import android.view.accessibility.AccessibilityNodeInfo.AccessibilityAction
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Direction
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
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
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/** Real launcher, input callback and readers; Phone IO or the Direct WebSocket peer is controlled. */
@RunWith(AndroidJUnit4::class)
class WearChatFlowTest {
  private val instrumentation = InstrumentationRegistry.getInstrumentation()
  private val device = UiDevice.getInstance(instrumentation)
  private val failures = mutableListOf<String>()
  private val output by lazy {
    File(instrumentation.targetContext.getExternalFilesDir(null), "chat-flow").apply { mkdirs() }
  }

  @Test
  fun directReplyPagesReachTheCanonicalTailThroughTheRealLauncher() {
    val full =
      "DIRECT HEAD SENTINEL\n" +
        (1..22).joinToString("\n") {
          "Direct reply paragraph $it. " + "Canonical reply text remains available beyond the displayed preview. ".repeat(3)
        } + "\nDIRECT TRAILING SENTINEL"
    val gateway = ControlledDirectGateway(full)
    val app = instrumentation.targetContext.applicationContext as WearApplication
    val preferenceName = "direct-reply-proof-" + UUID.randomUUID()
    val store = WearGatewayStore(app.getSharedPreferences(preferenceName, Context.MODE_PRIVATE))
    val endpoint = GatewayEndpoint.manual("127.0.0.1", gateway.server.port, false).copy(name = "Direct reply fixture")
    store.replace(WearGatewaySetup(endpoint, "fixture-bootstrap"), DeviceIdentityStore.withPrefs(app, store).loadOrCreate().deviceId)
    val job = SupervisorJob()
    val runtime = WearDirectRuntime(app, CoroutineScope(job + Dispatchers.Default), store)
    val field = WearApplication::class.java.getDeclaredField("directRuntime\$delegate").apply { isAccessible = true }
    val previous = field.get(app)
    field.set(app, lazyOf(runtime))
    var activity: MainActivity? = null
    try {
      activity = instrumentation.startActivitySync(Intent(app, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as MainActivity
      awaitState("Direct history") { runtime.state.value.messages.size == 1 }
      reveal("Read full reply")
      capture("direct-01-preview")
      clickAction("Read full reply")
      assertTrue(device.wait(Until.hasObject(By.text("DIRECT HEAD SENTINEL")), 10_000))
      capture("direct-02-first-page")
      assertEquals("The reader must fetch the canonical message, not present its preview as complete", 1, gateway.replyReads.get())
      reveal(app.getString(R.string.reply_next_page))
      clickAction(app.getString(R.string.reply_next_page))
      awaitState("second Direct reply page") { gateway.replyReads.get() == 2 }
      reveal("DIRECT TRAILING SENTINEL")
      capture("direct-03-tail")
      assertTrue(device.hasObject(By.text("DIRECT TRAILING SENTINEL")))
      device.pressBack()
      assertTrue("Back returns to Direct chat", device.wait(Until.hasObject(By.text("CHAT")), 5_000))
      capture("direct-04-return")
      reveal("Read full reply")
      assertTrue(device.hasObject(By.text("Read full reply")))
    } finally {
      activity?.let { current -> instrumentation.runOnMainSync { current.finish() } }
      instrumentation.waitForIdleSync()
      runtime.disconnect()
      runBlocking { withTimeout(15_000) { job.cancelAndJoin() } }
      field.set(app, previous)
      app.deleteSharedPreferences(preferenceName)
      gateway.server.shutdown()
    }
  }

  @Test
  fun completeReplyIsReachableThroughTheRealLauncherAndWireDecoder() {
    val full = "HEAD SENTINEL\n" + (1..85).joinToString("\n") { "Reply line $it is complete." } + "\nTRAILING SENTINEL"
    val phone = ControlledPhone(full)
    val app = instrumentation.targetContext.applicationContext as WearApplication
    val clientField = WearApplication::class.java.getDeclaredField("proxyClient\$delegate").apply { isAccessible = true }
    val repositoryField = WearApplication::class.java.getDeclaredField("gatewayRepository\$delegate").apply { isAccessible = true }
    val previousClient = clientField.get(app)
    val previousRepository = repositoryField.get(app)
    clientField.set(app, lazyOf(phone.client))
    repositoryField.set(app, lazyOf(WearGatewayRepository(phone.client)))
    WearSettingsStore(app).writeThemeMode(WearThemeMode.Dark)
    WearSettingsStore(app).writeAutoSpeak(false)
    var activity: MainActivity? = null
    try {
      activity = instrumentation.startActivitySync(Intent(app, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as MainActivity
      awaitState("history") { phone.historyResponses.get() > 0 }
      scrollToTop()
      awaitState("reply preview") { device.hasObject(By.textContains("HEAD SENTINEL")) }
      assertTrue(!device.hasObject(By.textContains("TRAILING SENTINEL")))
      capture("full-01-preview")

      reveal("Read full reply")
      clickAction("Read full reply")
      assertTrue(device.wait(Until.hasObject(By.text("HEAD SENTINEL")), 10_000))
      capture("full-02-open")
      reveal("TRAILING SENTINEL")
      capture("full-03-tail")
      assertTrue(device.hasObject(By.text("TRAILING SENTINEL")))
      device.pressBack()
      assertTrue(device.wait(Until.hasObject(By.text("Read full reply")), 5_000))
    } finally {
      activity?.let { current -> instrumentation.runOnMainSync { current.finish() } }
      instrumentation.waitForIdleSync()
      clientField.set(app, previousClient)
      repositoryField.set(app, previousRepository)
    }
  }

  @Test
  fun remoteTerminalsAndCanonicalReplacements() {
    val phone = ControlledPhone()
    val app = instrumentation.targetContext.applicationContext as WearApplication
    // Reuse the existing production transport seam, without a new runtime/fixture owner.
    val clientField = WearApplication::class.java.getDeclaredField("proxyClient\$delegate")
    clientField.isAccessible = true
    val previousClient = clientField.get(app)
    clientField.set(app, lazyOf(phone.client))
    val repositoryField = WearApplication::class.java.getDeclaredField("gatewayRepository\$delegate")
    repositoryField.isAccessible = true
    val previousRepository = repositoryField.get(app)
    repositoryField.set(app, lazyOf(WearGatewayRepository(phone.client)))
    WearSettingsStore(app).writeThemeMode(WearThemeMode.Dark)
    WearSettingsStore(app).writeAutoSpeak(false)
    val monitor =
      object : Instrumentation.ActivityMonitor() {
        override fun onStartActivity(intent: Intent): Instrumentation.ActivityResult? {
          val result = Intent()
          RemoteInput.addResultsToIntent(
            arrayOf(RemoteInput.Builder(REPLY_RESULT_KEY).setLabel("Message").build()),
            result,
            Bundle().apply { putCharSequence(REPLY_RESULT_KEY, "Hello") },
          )
          return Instrumentation.ActivityResult(Activity.RESULT_OK, result)
        }
      }
    var activity: MainActivity? = null
    try {
      activity =
        instrumentation.startActivitySync(
          Intent(app, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        ) as MainActivity
      awaitState("initial history") { phone.historyResponses.get() > 0 }
      scrollToTop()
      awaitState("initial connected UI") { device.hasObject(By.text("Ready")) }
      instrumentation.addMonitor(monitor)
      capture("00-ready")
      for (terminal in listOf("aborted", "error")) {
        scrollToAction("Type")
        val priorSends = phone.sends
        clickAction("Type")
        awaitState("accepted send") { phone.sends == priorSends + 1 }
        assertTrue("real input callback sends Hello", phone.lastMessage == "Hello")
        scrollToTop()
        awaitState("accepted reply UI") { device.hasObject(By.text("Sending")) || device.hasObject(By.text("Agent working")) }
        capture("$terminal-01-accepted")
        renderAfter(activity) { phone.emit("error", runId = "older-run") }
        capture("$terminal-02-foreign")
        // A stale foreign terminal must not settle the newly accepted reply.
        checkUi("$terminal foreign terminal preserves pending reply", device.hasObject(By.text("Sending")) || device.hasObject(By.text("Agent working")))
        val beforeTerminalHistory = phone.historyResponses.get()
        phone.emit(terminal)
        awaitState("remote terminal history response") { phone.historyResponses.get() > beforeTerminalHistory }
        scrollToTop()
        val outcome = if (terminal == "error") "Error" else "Ready"
        awaitState("remote terminal UI") {
          device.hasObject(By.text(outcome)) && !device.hasObject(By.text("Sending")) && device.hasObject(By.text("Start a conversation"))
        }
        capture("$terminal-03-terminal")
        checkUi("$terminal settles Sending with unchanged history", !device.hasObject(By.text("Sending")))
        checkUi("$terminal visible outcome", device.hasObject(By.text(outcome)))
        checkUi("empty controlled history produces no assistant", device.hasObject(By.text("Start a conversation")))
        val beforeExplicitHistory = phone.historyResponses.get()
        refreshFromControls()
        awaitState("explicit refresh history response") { phone.historyResponses.get() > beforeExplicitHistory }
        scrollToTop()
        awaitState("explicit refresh UI") { device.hasObject(By.text(outcome)) && !device.hasObject(By.text("Sending")) }
        capture("$terminal-04-refreshed")
        checkUi("$terminal outcome survives refresh", device.hasObject(By.text(outcome)))
      }
      phone.emit("delta", runId = "stream-run", text = "Hello world")
      awaitState("canonical stream UI") { device.hasObject(By.text("Hello world")) }
      capture("stream-01-world")
      phone.emit("delta", runId = "stream-run", text = "Hello")
      awaitState("canonical stream shrinks") { device.hasObject(By.text("Hello")) && !device.hasObject(By.text("Hello world")) }
      capture("stream-02-shrink")
      checkUi("ordered canonical replacement shrinks", device.hasObject(By.text("Hello")) && !device.hasObject(By.text("Hello world")))
      phone.emit("delta", runId = "stream-run", text = "")
      scrollToTop()
      awaitState("canonical stream clears") { !device.hasObject(By.text("Hello")) && device.hasObject(By.text("Start a conversation")) }
      capture("stream-03-clear")
      checkUi("ordered canonical replacement clears", !device.hasObject(By.text("Hello")) && device.hasObject(By.text("Start a conversation")))
      File(output, "assertions.txt").writeText(if (failures.isEmpty()) "PASS\n" else failures.joinToString("\n"))
      assertEquals("Regression invariants", emptyList<String>(), failures)
    } finally {
      instrumentation.removeMonitor(monitor)
      activity?.let { current -> instrumentation.runOnMainSync { current.finish() } }
      instrumentation.waitForIdleSync()
      clientField.set(app, previousClient)
      repositoryField.set(app, previousRepository)
    }
  }

  private fun checkUi(
    label: String,
    passed: Boolean,
  ) {
    if (!passed) failures += label
  }

  private fun renderAfter(
    activity: MainActivity,
    event: () -> Unit,
  ) {
    val rendered = CountDownLatch(1)
    val view = activity.window.decorView
    val listener = ViewTreeObserver.OnDrawListener { view.post { rendered.countDown() } }
    instrumentation.runOnMainSync {
      // A foreign terminal intentionally has no history response to use as a barrier.
      event()
      view.viewTreeObserver.addOnDrawListener(listener)
      view.postInvalidateOnAnimation()
    }
    try {
      assertTrue("event reached a real UI draw", rendered.await(15, TimeUnit.SECONDS))
      instrumentation.waitForIdleSync()
    } finally {
      instrumentation.runOnMainSync { view.viewTreeObserver.removeOnDrawListener(listener) }
    }
  }

  private fun scrollToAction(label: String) {
    reveal(label)
    assertTrue("$label action is enabled", device.findObject(By.text(label)).isEnabled)
  }

  private fun refreshFromControls() {
    // The connection host owns the real UI's ViewModel; drive its refresh through the pager.
    navigateToPage("CONTROLS", forward = true)
    scrollToAction("Refresh")
    clickAction("Refresh")
    // The pager retains each list's position; leave its header visible for the next visit.
    scrollToTop("CONTROLS")
    navigateToPage("CHAT", forward = false)
  }

  private fun navigateToPage(
    label: String,
    forward: Boolean,
  ) {
    // Voice has its own pager; a fixed swipe count does not establish the outer page.
    repeat(4) {
      if (device.hasObject(By.text(label))) return
      val start = if (forward) 4 else 1
      val end = if (forward) 1 else 4
      assertTrue(device.swipe(device.displayWidth * start / 5, device.displayHeight / 2, device.displayWidth * end / 5, device.displayHeight / 2, 40))
      device.waitForIdle()
    }
    if (!device.hasObject(By.text(label))) capture("unreachable-page-$label")
    assertTrue("$label page is reachable", device.hasObject(By.text(label)))
  }

  private fun reveal(text: String) {
    repeat(100) {
      val node = device.findObject(By.text(text))
      if (node != null && node.visibleBounds.centerY() in device.displayHeight / 5..device.displayHeight * 4 / 5) return
      // UiAutomator's scroll gesture stops before lifting, unlike a fling-producing swipe.
      verticalList().scroll(Direction.DOWN, 0.3f)
    }
    capture("unreachable-$text")
    assertTrue("Reachable $text", false)
  }

  private fun clickAction(label: String) {
    val action = requireNotNull(device.findObject(By.text(label)))
    val point = action.visibleCenter
    // Unlike UiObject2.click(), this exposes a rejected native input injection.
    assertTrue("$label native tap is accepted", device.click(point.x, point.y))
  }

  private fun scrollToTop(label: String = "CHAT") {
    repeat(5) {
      if (device.hasObject(By.text(label))) return
      verticalList().scroll(Direction.UP, 1f)
    }
    assertTrue("$label header is reachable", device.hasObject(By.text(label)))
  }

  private fun verticalList(): UiObject2 =
    device.findObjects(By.scrollable(true)).single { node ->
      node.accessibilityNodeInfo.actionList.any { action ->
        action.id == AccessibilityAction.ACTION_SCROLL_UP.id || action.id == AccessibilityAction.ACTION_SCROLL_DOWN.id
      }
    }

  private fun capture(name: String) {
    SystemClock.sleep(900)
    assertTrue(device.takeScreenshot(File(output, "$name.png")))
    device.dumpWindowHierarchy(File(output, "$name.xml"))
  }

  private fun awaitState(
    label: String,
    predicate: () -> Boolean,
  ) {
    val deadline = SystemClock.elapsedRealtime() + 15_000
    while (!predicate() && SystemClock.elapsedRealtime() < deadline) SystemClock.sleep(50)
    assertTrue(label, predicate())
    instrumentation.waitForIdleSync()
    SystemClock.sleep(300)
  }

  private class ControlledDirectGateway(
    fullReply: String,
  ) {
    val replyReads = AtomicInteger()

    private fun message(
      text: String,
      truncated: Boolean,
    ) = buildJsonObject {
      put("role", "assistant")
      put(
        "content",
        JsonArray(
          text.split('\n').map { paragraph ->
            buildJsonObject {
              put("type", "text")
              put("text", paragraph)
            }
          },
        ),
      )
      put(
        "__openclaw",
        buildJsonObject {
          put("id", "stored-native-reply")
          put("truncated", truncated)
        },
      )
    }

    val server =
      MockWebServer().apply {
        dispatcher =
          object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse =
              MockResponse().withWebSocketUpgrade(
                object : WebSocketListener() {
                  override fun onOpen(
                    webSocket: WebSocket,
                    response: Response,
                  ) {
                    webSocket.send("""{"type":"event","event":"connect.challenge","payload":{"nonce":"direct-reply-fixture","ts":1700000000123}}""")
                  }

                  override fun onMessage(
                    webSocket: WebSocket,
                    text: String,
                  ) {
                    val frame = Json.parseToJsonElement(text).jsonObject
                    val params = frame["params"]!!.jsonObject
                    val payload =
                      when (frame["method"]!!.jsonPrimitive.content) {
                        "connect" -> {
                          Json.parseToJsonElement(
                            if (params["role"]!!.jsonPrimitive.content == "node") {
                              """{"auth":{"role":"node","deviceToken":"fixture-node","scopes":[],"deviceTokens":[{"role":"operator","deviceToken":"fixture-operator","scopes":["operator.read","operator.write","operator.approvals"]}]},"snapshot":{"sessionDefaults":{"mainSessionKey":"agent:main:main"}}}"""
                            } else {
                              """{"features":{"methods":["chat.message.get"]},"auth":{"role":"operator","deviceToken":"fixture-operator","scopes":["operator.read","operator.write","operator.approvals"]},"snapshot":{"sessionDefaults":{"mainSessionKey":"agent:main:main"}}}"""
                            },
                          )
                        }

                        "sessions.list" -> {
                          Json.parseToJsonElement("""{"sessions":[{"key":"agent:main:main","displayName":"Direct reply fixture"}]}""")
                        }

                        "sessions.messages.subscribe" -> {
                          Json.parseToJsonElement("""{"subscribed":true,"key":"agent:main:main","agentId":"main","approvalReplay":{"sessionKey":"agent:main:main","updatedAtMs":1,"truncated":false,"approvals":[]}}""")
                        }

                        "chat.history" -> {
                          buildJsonObject { put("messages", JsonArray(listOf(message(fullReply.take(2000), true)))) }
                        }

                        "chat.message.get" -> {
                          assertEquals("agent:main:main", params["sessionKey"]!!.jsonPrimitive.content)
                          assertEquals("main", params["agentId"]!!.jsonPrimitive.content)
                          assertEquals("stored-native-reply", params["messageId"]!!.jsonPrimitive.content)
                          assertEquals(WearReplyText.MAX_TEXT_LENGTH.toString(), params["maxChars"]!!.jsonPrimitive.content)
                          replyReads.incrementAndGet()
                          buildJsonObject {
                            put("ok", true)
                            put("message", message(fullReply, false))
                          }
                        }

                        else -> {
                          error("Unexpected Direct fixture method")
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

                  override fun onClosing(
                    webSocket: WebSocket,
                    code: Int,
                    reason: String,
                  ) {
                    webSocket.close(code, reason)
                  }
                },
              )
          }
        start()
      }
  }

  private class ControlledPhone(
    private val fullReply: String? = null,
  ) {
    @Volatile var sequence = 0L

    @Volatile var sends = 0

    @Volatile var runId = "not-sent"

    @Volatile var lastMessage: String? = null
    val historyResponses = AtomicInteger()
    val client: WearProxyClient =
      WearProxyClient.createForTests(
        nodeResolver = WearNodeResolver { "synthetic-phone" },
        transport = WearMessageTransport { _, path, bytes -> respond(path, bytes) },
      )

    private suspend fun respond(
      path: String,
      bytes: ByteArray,
    ) {
      assertEquals(WearProtocol.REQUEST_PATH, path)
      val request = (WearProtocolCodec.decode(bytes) as WearDecodeResult.Success).message as WearMessage.Request
      val result =
        when (request.method) {
          WearRpcMethod.ProxyStatus -> {
            Json.parseToJsonElement("""{"connected":true,"activeAgentId":"main","activeSessionKey":"agent:main:proof","selectedModelRef":"openai/gpt-4o","capabilities":["reply-text"]}""")
          }

          WearRpcMethod.SessionsList -> {
            Json.parseToJsonElement("""{"sessions":[{"key":"agent:main:proof","displayName":"Test chat","agentId":"main","modelRef":"openai/gpt-4o","hasActiveRun":false}]}""")
          }

          WearRpcMethod.ReplyText -> {
            WearReplyText.encode(
              WearReplyText.page(
                checkNotNull(fullReply),
                "native-proof",
                request.params
                  .getValue("offset")
                  .jsonPrimitive.content
                  .toInt(),
                request.params["revision"]?.jsonPrimitive?.content,
              ),
            )
          }

          WearRpcMethod.ChatHistory -> {
            if (fullReply != null) {
              buildJsonObject {
                put("sessionKey", "agent:main:proof")
                put(
                  "messages",
                  kotlinx.serialization.json.buildJsonArray {
                    add(
                      buildJsonObject {
                        put("id", "row")
                        put("entryId", "canonical")
                        put("role", "assistant")
                        put("content", fullReply.take(250))
                        put("textTruncated", true)
                      },
                    )
                  },
                )
              }
            } else {
              Json.parseToJsonElement("""{"sessionKey":"agent:main:proof","messages":[],"selectedModelRef":"openai/gpt-4o"}""")
            }
          }

          WearRpcMethod.ChatSend -> {
            runId =
              request.params
                .getValue("idempotencyKey")
                .jsonPrimitive.content
            lastMessage =
              request.params
                .getValue("message")
                .jsonPrimitive.content
            sends += 1
            buildJsonObject {
              put("runId", runId)
              put("status", "started")
            }
          }

          else -> {
            error("Unexpected controlled IO: " + request.method)
          }
        }
      client.handleMessage(
        "synthetic-phone",
        WearProtocol.RESPONSE_PATH,
        WearProtocolCodec.encode(WearMessage.Response(requestId = request.requestId, ok = true, result = result, eventStreamId = "proof-epoch", eventSequence = sequence)),
      )
      if (request.method == WearRpcMethod.ChatHistory) historyResponses.incrementAndGet()
    }

    fun emit(
      state: String,
      runId: String = this.runId,
      text: String? = null,
    ) = runBlocking {
      sequence += 1
      val payload: JsonObject =
        buildJsonObject {
          put("sessionKey", "agent:main:proof")
          put("runId", runId)
          put("state", state)
          if (text != null) {
            put("streamText", text)
            put("streamTextComplete", true)
          }
        }
      client.handleMessage(
        "synthetic-phone",
        WearProtocol.EVENT_PATH,
        WearProtocolCodec.encode(WearMessage.Event(sequence = sequence, event = WearEventType.Chat, payload = payload, streamId = "proof-epoch")),
      )
    }
  }
}
