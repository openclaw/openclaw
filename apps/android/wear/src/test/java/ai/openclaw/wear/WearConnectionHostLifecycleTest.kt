package ai.openclaw.wear

import ai.openclaw.app.gateway.GatewayEndpoint
import ai.openclaw.app.gateway.GatewayRegistryEntry
import ai.openclaw.app.gateway.GatewayRegistryEntryKind
import ai.openclaw.app.gateway.GatewayRegistryStore
import ai.openclaw.wear.shared.WearDecodeResult
import ai.openclaw.wear.shared.WearMessage
import ai.openclaw.wear.shared.WearProtocol
import ai.openclaw.wear.shared.WearProtocolCodec
import ai.openclaw.wear.shared.WearRpcMethod
import android.app.Activity
import android.app.RemoteInput
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.os.Bundle
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import androidx.compose.ui.platform.ViewRootForTest
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ViewModelProvider
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CompletableJob
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestCoroutineScheduler
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.yield
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.android.controller.ActivityController
import org.robolectric.annotation.Config
import java.time.Duration
import java.util.UUID

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(application = WearApplication::class, sdk = [35], qualifiers = "w400dp-h800dp-mdpi")
class WearConnectionHostLifecycleTest {
  @Test
  fun recreationRetainsPendingPhoneSendWithoutResubmission() =
    withHost { host ->
      val send = host.submit()
      val originalActivity = host.controller.get()

      host.controller.recreate()
      host.idle()

      assertNotSame(originalActivity, host.controller.get())
      assertTrue("Activity recreation must retain the original transport coroutine", send.job.isActive)
      host.assertPending(send)
      host.release(send)
    }

  @Test
  fun connectionSettingsAndBackRetainPendingPhoneSend() =
    withHost { host ->
      val send = host.submit()

      host.openConnectionSettings()
      assertTrue("Connection settings is presentation, not a Phone Proxy owner change", send.job.isActive)
      assertEquals(
        Lifecycle.State.RESUMED,
        host.controller
          .get()
          .lifecycle.currentState,
      )
      host.controller
        .get()
        .onBackPressedDispatcher
        .onBackPressed()
      host.idle()

      host.assertPending(send)
      host.release(send)
    }

  @Test
  fun directSelectionRetiresPhoneSendAndReentryCreatesFreshWork() =
    withHost { host ->
      val send = host.submit()
      host.openConnectionSettings()
      host.click("Saved Gateway")
      host.idle()

      assertEquals(host.gateway.stableId, host.store.registry.activeStableId.value)
      assertEquals(
        host.gateway.stableId,
        host.runtime.state.value.selected
          ?.stableId,
      )
      assertFalse("A successful mode change must cancel the old Phone Proxy transport", send.job.isActive)
      assertTrue(send.job.isCompleted)
      host.click("Connection")
      host.click("Phone Proxy")
      host.awaitPhoneProxy()

      assertTrue(host.runtime.isPhoneProxySelected())
      assertEquals("Returning cannot resend the retired request", 1, host.sends.size)
      assertFalse(host.hasText("Sending"))
      val fresh = host.submit()
      assertNotSame(send.job, fresh.job)
      assertFalse(send.request.requestId == fresh.request.requestId)
      assertFalse(send.key == fresh.key)
      host.release(fresh)
    }

  @Test
  fun finishingActivityCancelsPendingPhoneSend() =
    withHost { host ->
      val send = host.submit()
      host.finish()

      assertFalse("Final Activity destruction must cancel the transport", send.job.isActive)
      assertTrue(send.job.isCompleted)
      assertEquals(1, host.sends.size)
    }

  @Test
  fun failedSavedSelectionRetainsPhoneSendAndRecoveryActions() =
    withHost { host ->
      val send = host.submit()
      host.openConnectionSettings()
      host.failSavedSelection(send)
    }

  @Test
  fun failedSavedSelectionCanRetryWithoutResubmittingPhoneSend() =
    withHost { host ->
      val send = host.submit()
      host.openConnectionSettings()
      host.failSavedSelection(send)

      host.failRegistryCommit = false
      host.click("Saved Gateway")
      host.awaitConnectionIdle()

      assertEquals(host.gateway.stableId, host.store.registry.storedActiveStableId())
      assertEquals(
        host.gateway.stableId,
        host.runtime.state.value.selected
          ?.stableId,
      )
      assertFalse(host.runtime.state.value.connectionManagementRequired)
      assertFalse(send.job.isActive)
      assertTrue(send.job.isCompleted)
      assertEquals("Successful retry cannot resubmit the old Phone Proxy send", 1, host.sends.size)
    }

  @Test
  fun failedSavedSelectionCanGoBackWithoutRetiringPhoneSend() =
    withHost { host ->
      val send = host.submit()
      host.openConnectionSettings()
      host.failSavedSelection(send)

      host.controller
        .get()
        .onBackPressedDispatcher
        .onBackPressed()
      host.awaitPhoneProxy()

      assertEquals(null, host.store.registry.storedActiveStableId())
      assertEquals(null, host.runtime.state.value.error)
      var enqueued = false
      host.runtime.capturePhoneProxy().invoke { enqueued = true }
      assertTrue("Explicit cancellation restores Phone Proxy admission", enqueued)
      host.assertPending(send)
      host.release(send)
    }

  private fun withHost(test: (Host) -> Unit) {
    val host = Host()
    try {
      host.start()
      test(host)
    } finally {
      host.close()
    }
  }

  private data class HeldSend(
    val request: WearMessage.Request,
    val job: Job,
    val ordinal: Int,
    val release: CompletableDeferred<Unit> = CompletableDeferred(),
  ) {
    val key: String
      get() =
        request.params
          .getValue("idempotencyKey")
          .jsonPrimitive.content
  }

  private class Host {
    private val app = RuntimeEnvironment.getApplication() as WearApplication
    private val scheduler = TestCoroutineScheduler()
    private lateinit var runtimeJob: CompletableJob
    private val fields =
      listOf("proxyClient\$delegate", "gatewayRepository\$delegate", "directRuntime\$delegate")
        .associateWith { name -> WearApplication::class.java.getDeclaredField(name).apply { isAccessible = true } }
    private val previous = fields.mapValues { (_, field) -> field.get(app) }
    private val factoryInstance =
      ViewModelProvider.AndroidViewModelFactory::class.java.getDeclaredField("_instance").apply { isAccessible = true }
    private val previousFactory = factoryInstance.get(null)
    private lateinit var server: MockWebServer
    lateinit var gateway: GatewayEndpoint
    lateinit var store: WearGatewayStore
    lateinit var runtime: WearDirectRuntime
    lateinit var controller: ActivityController<MainActivity>
    val sends = mutableListOf<HeldSend>()
    private var finished = false
    private var historyMessages = "[]"
    private lateinit var client: WearProxyClient
    var failRegistryCommit = false
    private var rejectedRegistryCommits = 0

    fun start() {
      // Robolectric replaces Application between cases; AndroidX's process singleton does not.
      factoryInstance.set(null, null)
      val factory = ViewModelProvider.AndroidViewModelFactory.getInstance(app)
      val factoryApplication =
        ViewModelProvider.AndroidViewModelFactory::class.java
          .getDeclaredField("application")
          .apply { isAccessible = true }
          .get(factory)
      assertSame("Production factory and fixture must use the same Application", app, factoryApplication)
      runtimeJob = SupervisorJob()
      server = MockWebServer()
      server.start()
      gateway = GatewayEndpoint.manual("127.0.0.1", server.port, false)
      val backing = app.getSharedPreferences("host-${UUID.randomUUID()}", Context.MODE_PRIVATE)
      store =
        WearGatewayStore(
          object : SharedPreferences by backing {
            override fun edit(): SharedPreferences.Editor {
              val edit = backing.edit()
              var writesRegistry = false
              return object : SharedPreferences.Editor by edit {
                override fun putString(
                  key: String?,
                  value: String?,
                ): SharedPreferences.Editor {
                  writesRegistry = writesRegistry || key == GatewayRegistryStore.STORAGE_KEY
                  edit.putString(key, value)
                  return this
                }

                override fun commit(): Boolean {
                  val committed = edit.commit()
                  if (failRegistryCommit && writesRegistry) {
                    rejectedRegistryCommits += 1
                    return false
                  }
                  return committed
                }
              }
            }
          },
        )
      client =
        WearProxyClient.createForTests(
          nodeResolver = WearNodeResolver { "phone-a" },
          transport = WearMessageTransport { _, _, bytes -> respond(bytes) },
        )
      // Selection, not Gateway authentication, is this control's boundary.
      server.enqueue(MockResponse().setResponseCode(503))
      store.registry.upsert(GatewayRegistryEntry(gateway.stableId, GatewayRegistryEntryKind.MANUAL, "Saved Gateway", gateway.host, gateway.port, false))
      runtime = WearDirectRuntime(app, CoroutineScope(runtimeJob + StandardTestDispatcher(scheduler)), store)
      fields.getValue("proxyClient\$delegate").set(app, lazyOf(client))
      fields.getValue("gatewayRepository\$delegate").set(app, lazyOf(WearGatewayRepository(client)))
      fields.getValue("directRuntime\$delegate").set(app, lazyOf(runtime))
      controller = Robolectric.buildActivity(MainActivity::class.java)
      controller.setup().visible()
      idle()
      assertTrue(runtime.isPhoneProxySelected())
      assertTrue("Phone Proxy setup must render Type", hasAction("Type"))
    }

    fun idle() {
      scheduler.runCurrent()
      shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(32))
    }

    fun awaitPhoneProxy() =
      runBlocking {
        withTimeout(8_000) {
          while (!runtime.isPhoneProxySelected()) {
            idle()
            yield()
          }
          idle()
        }
      }

    fun awaitConnectionIdle() =
      runBlocking {
        withTimeout(8_000) {
          while (runtime.state.value.busy) {
            idle()
            yield()
          }
          idle()
        }
      }

    fun failSavedSelection(send: HeldSend) {
      val persisted = store.getString(GatewayRegistryStore.STORAGE_KEY)
      val originalKey = send.key
      failRegistryCommit = true
      click("Saved Gateway")
      awaitConnectionIdle()

      assertEquals("The real registry commit must reach the failing storage owner", 1, rejectedRegistryCommits)
      assertEquals(persisted, store.getString(GatewayRegistryStore.STORAGE_KEY))
      assertEquals(null, store.registry.storedActiveStableId())
      assertEquals(null, runtime.state.value.selected)
      assertRetainedSend(send)
      assertEquals(originalKey, send.key)
      assertTrue("Failed selection must keep its recovery error visible", hasText(checkNotNull(runtime.state.value.error)))
      assertTrue("Saved Gateway retry must remain enabled", hasEnabledAction("Saved Gateway"))
      assertTrue("Setup recovery must remain enabled", hasEnabledAction(app.getString(R.string.watch_setup_code)))
      assertTrue(runtime.state.value.connectionManagementRequired)
      var enqueued = false
      assertThrows(WearProxyException::class.java) { runtime.capturePhoneProxy().invoke { enqueued = true } }
      assertFalse("Recovery management must block new Phone Proxy enqueues", enqueued)
    }

    fun submit(): HeldSend {
      val before = sends.size
      click("Type")
      val launch = checkNotNull(shadowOf(controller.get()).nextStartedActivityForResult)
      val result = Intent()
      RemoteInput.addResultsToIntent(
        arrayOf(RemoteInput.Builder(REPLY_RESULT_KEY).setLabel("Message").build()),
        result,
        Bundle().apply { putCharSequence(REPLY_RESULT_KEY, "Pending Phone Proxy message") },
      )
      shadowOf(controller.get()).receiveResult(launch.intent, Activity.RESULT_OK, result)
      idle()
      assertEquals("One UI submission must enqueue exactly one request", before + 1, sends.size)
      return sends[before].also(::assertPending)
    }

    fun assertPending(send: HeldSend) {
      idle()
      assertRetainedSend(send)
      assertTrue("Pending UI remains rendered", hasText("Sending"))
      assertTrue(hasAction("Abort run"))
    }

    private fun assertRetainedSend(send: HeldSend) {
      assertTrue("Original send remains in flight", send.job.isActive)
      assertSame(send, sends[send.ordinal - 1])
      assertEquals("No second send with any request key", send.ordinal, sends.size)
      assertEquals(1, sends.count { it.key == send.key })
      assertEquals(
        "agent:main:proof",
        send.request.params
          .getValue("sessionKey")
          .jsonPrimitive.content,
      )
    }

    fun release(send: HeldSend) {
      historyMessages = """[{"id":"completed-reply","role":"assistant","content":"Completed reply","idempotencyKey":"${send.key}"}]"""
      send.release.complete(Unit)
      idle()
      assertTrue("Original transport settles after its held response", send.job.isCompleted)
      assertEquals(send.ordinal, sends.size)
      assertEquals(1, sends.count { it.key == send.key })
      assertFalse(hasText("Sending"))
      assertFalse(hasAction("Abort run"))
      assertTrue(hasText("Completed reply"))
    }

    fun openConnectionSettings() {
      val pager =
        nodes().single { node ->
          SemanticsProperties.HorizontalScrollAxisRange in node.config &&
            SemanticsActions.ScrollToIndex in node.config
        }
      assertEquals(true, pager.config[SemanticsActions.ScrollToIndex].action?.invoke(2))
      idle()
      click("Connection")
      assertTrue(hasText("Phone Proxy"))
    }

    fun click(label: String) {
      val action =
        nodes().firstOrNull { node ->
          SemanticsActions.OnClick in node.config &&
            node.config.getOrNull(SemanticsProperties.Text)?.any { it.text == label } == true
        }
      assertTrue("Missing rendered action $label", action != null)
      assertEquals(true, checkNotNull(action).config[SemanticsActions.OnClick].action?.invoke())
      idle()
    }

    fun hasText(text: String): Boolean = nodes().any { it.config.getOrNull(SemanticsProperties.Text)?.any { value -> value.text == text } == true }

    private fun hasAction(label: String): Boolean =
      nodes().any {
        SemanticsActions.OnClick in it.config &&
          it.config.getOrNull(SemanticsProperties.Text)?.any { value -> value.text == label } == true
      }

    private fun hasEnabledAction(label: String): Boolean =
      nodes().any {
        SemanticsActions.OnClick in it.config &&
          SemanticsProperties.Disabled !in it.config &&
          it.config.getOrNull(SemanticsProperties.Text)?.any { value -> value.text == label } == true
      }

    private fun nodes(): List<SemanticsNode> {
      fun roots(view: View): List<ViewRootForTest> =
        when (view) {
          is ViewRootForTest -> listOf(view)
          is ViewGroup -> (0 until view.childCount).flatMap { roots(view.getChildAt(it)) }
          else -> emptyList()
        }

      fun descend(node: SemanticsNode): List<SemanticsNode> = listOf(node) + node.children.flatMap(::descend)
      return roots(controller.get().window.decorView).flatMap {
        it.measureAndLayoutForTest()
        descend(it.semanticsOwner.rootSemanticsNode)
      }
    }

    private suspend fun respond(bytes: ByteArray) {
      val request = (WearProtocolCodec.decode(bytes) as WearDecodeResult.Success).message as WearMessage.Request
      val result =
        when (request.method) {
          WearRpcMethod.ProxyStatus -> {
            Json.parseToJsonElement("""{"connected":true,"activeAgentId":"main","activeSessionKey":"agent:main:proof"}""")
          }

          WearRpcMethod.SessionsList -> {
            Json.parseToJsonElement("""{"sessions":[{"key":"agent:main:proof","displayName":"Test chat","hasActiveRun":false}]}""")
          }

          WearRpcMethod.ChatHistory -> {
            buildJsonObject {
              put("sessionKey", request.params.getValue("sessionKey"))
              put("messages", Json.parseToJsonElement(historyMessages))
            }
          }

          WearRpcMethod.ChatSend -> {
            val send = HeldSend(request, checkNotNull(currentCoroutineContext()[Job]), sends.size + 1)
            sends += send
            send.release.await()
            buildJsonObject {
              put("runId", send.key)
              put("status", "started")
            }
          }

          else -> {
            error("Unexpected fixture RPC ${request.method}")
          }
        }
      client.handleMessage(
        "phone-a",
        WearProtocol.RESPONSE_PATH,
        WearProtocolCodec.encode(WearMessage.Response(requestId = request.requestId, ok = true, result = result, eventSequence = 0L, eventStreamId = "host-epoch")),
      )
    }

    fun finish() {
      if (finished || !::controller.isInitialized) return
      controller.get().finish()
      if (controller.get().lifecycle.currentState == Lifecycle.State.RESUMED) controller.pause()
      if (controller
          .get()
          .lifecycle.currentState
          .isAtLeast(Lifecycle.State.STARTED)
      ) {
        controller.stop()
      }
      if (controller
          .get()
          .lifecycle.currentState
          .isAtLeast(Lifecycle.State.CREATED)
      ) {
        controller.destroy()
      }
      finished = true
      idle()
    }

    fun close() {
      try {
        finish()
      } finally {
        try {
          if (::runtimeJob.isInitialized) {
            runtimeJob.cancel()
            scheduler.runCurrent()
            runBlocking { withTimeout(8_000) { runtimeJob.join() } }
          }
        } finally {
          try {
            sends.forEach {
              it.job.cancel()
              it.release.complete(Unit)
            }
            idle()
            runBlocking { withTimeout(8_000) { sends.forEach { it.job.join() } } }
          } finally {
            fields.forEach { (name, field) -> field.set(app, previous.getValue(name)) }
            factoryInstance.set(null, previousFactory)
            if (::server.isInitialized) server.shutdown()
          }
        }
      }
    }
  }
}
