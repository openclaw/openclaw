package ai.openclaw.wear

import ai.openclaw.wear.shared.WearDecodeResult
import ai.openclaw.wear.shared.WearEventType
import ai.openclaw.wear.shared.WearMessage
import ai.openclaw.wear.shared.WearProtocol
import ai.openclaw.wear.shared.WearProtocolCodec
import ai.openclaw.wear.shared.WearRpcMethod
import android.app.Activity
import android.app.Instrumentation
import android.app.RemoteInput
import android.content.Intent
import android.os.Bundle
import android.os.SystemClock
import androidx.lifecycle.ViewModelProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/** Real launcher, input-result callback, ViewModel and wire decoder; only Phone IO is controlled. */
@RunWith(AndroidJUnit4::class)
class WearChatFlowTest {
  private val instrumentation = InstrumentationRegistry.getInstrumentation()
  private val device = UiDevice.getInstance(instrumentation)
  private val failures = mutableListOf<String>()
  private val output by lazy {
    File(instrumentation.targetContext.getExternalFilesDir(null), "chat-flow").apply { mkdirs() }
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
      lateinit var vm: WearViewModel
      instrumentation.runOnMainSync { vm = ViewModelProvider(activity)[WearViewModel::class.java] }
      awaitState("initial history") { !vm.state.value.loading && vm.state.value.connected }
      instrumentation.addMonitor(monitor)
      capture("00-ready")
      for (terminal in listOf("aborted", "error")) {
        scrollToType()
        val priorSends = phone.sends
        device.findObject(By.text("Type")).click()
        awaitState("accepted send") { phone.sends == priorSends + 1 && !vm.state.value.sending && !vm.state.value.loading }
        assertTrue("real input callback sends Hello", phone.lastMessage == "Hello")
        scrollToTop()
        capture("$terminal-01-accepted")
        phone.emit("error", runId = "older-run")
        awaitState("foreign terminal refresh") { !vm.state.value.loading }
        capture("$terminal-02-foreign")
        // A stale foreign terminal must not settle the newly accepted reply.
        checkUi("$terminal foreign terminal preserves pending reply", device.hasObject(By.text("Sending")) || device.hasObject(By.text("Agent working")))
        phone.emit(terminal)
        awaitState("remote terminal refresh") { !vm.state.value.loading && vm.state.value.activeRunId == null }
        scrollToTop()
        capture("$terminal-03-terminal")
        checkUi("$terminal settles Sending with unchanged history", !device.hasObject(By.text("Sending")))
        checkUi("$terminal visible outcome", device.hasObject(By.text(if (terminal == "error") "Error" else "Ready")))
        assertTrue(
          "no assistant fabricated by terminal",
          vm.state.value.messages
            .isEmpty(),
        )
        instrumentation.runOnMainSync { vm.refresh() }
        awaitState("explicit refresh") { !vm.state.value.loading }
        scrollToTop()
        capture("$terminal-04-refreshed")
        checkUi("$terminal outcome survives refresh", device.hasObject(By.text(if (terminal == "error") "Error" else "Ready")))
      }
      phone.emit("delta", runId = "stream-run", text = "Hello world")
      awaitState("canonical stream") { vm.state.value.activeRunId == "stream-run" }
      capture("stream-01-world")
      phone.emit("delta", runId = "stream-run", text = "Hello")
      SystemClock.sleep(700)
      capture("stream-02-shrink")
      checkUi("ordered canonical replacement shrinks", vm.state.value.streamText == "Hello")
      phone.emit("delta", runId = "stream-run", text = "")
      SystemClock.sleep(700)
      capture("stream-03-clear")
      checkUi("ordered canonical replacement clears", vm.state.value.streamText == "")
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

  private fun scrollToType() {
    repeat(6) {
      val button = device.findObject(By.text("Type"))
      if (button != null && button.isEnabled && button.visibleBounds.height() > 12) return
      device.swipe(190, 290, 190, 130, 12)
      SystemClock.sleep(200)
    }
    assertTrue("Type action is reachable", device.wait(Until.hasObject(By.text("Type")), 3_000))
  }

  private fun scrollToTop() {
    repeat(5) { device.swipe(190, 135, 190, 300, 12) }
    SystemClock.sleep(500)
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

  private class ControlledPhone {
    var sequence = 0L
    var sends = 0
    var runId = "not-sent"
    var lastMessage: String? = null
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
            Json.parseToJsonElement("""{"connected":true,"activeAgentId":"main","activeSessionKey":"agent:main:proof","selectedModelRef":"openai/gpt-4o"}""")
          }

          WearRpcMethod.SessionsList -> {
            Json.parseToJsonElement("""{"sessions":[{"key":"agent:main:proof","displayName":"Test chat","agentId":"main","modelRef":"openai/gpt-4o","hasActiveRun":false}]}""")
          }

          WearRpcMethod.ChatHistory -> {
            Json.parseToJsonElement("""{"sessionKey":"agent:main:proof","messages":[],"selectedModelRef":"openai/gpt-4o"}""")
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
