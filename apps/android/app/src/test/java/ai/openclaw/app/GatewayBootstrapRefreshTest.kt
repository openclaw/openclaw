package ai.openclaw.app

import ai.openclaw.app.gateway.GatewayEndpoint
import ai.openclaw.app.gateway.GatewayRegistryEntry
import ai.openclaw.app.gateway.GatewayRegistryEntryKind
import ai.openclaw.app.gateway.GatewaySession
import ai.openclaw.app.protocol.OpenClawCameraCommand
import ai.openclaw.app.voice.TalkModeManager
import android.Manifest
import android.content.Context
import android.media.AudioRecord
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.job
import kotlinx.coroutines.joinAll
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowAudioRecord
import org.robolectric.util.ReflectionHelpers
import java.net.InetAddress
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class GatewayBootstrapRefreshTest {
  @Test
  fun microphoneGrantDuringTalkStartupPreservesOperatorAndStartsOnce() =
    runBlocking {
      val app = RuntimeEnvironment.getApplication()
      app
        .getSharedPreferences("openclaw.node", Context.MODE_PRIVATE)
        .edit()
        .clear()
        .commit()
      shadowOf(app).denyPermissions(Manifest.permission.RECORD_AUDIO)
      val prefs = SecurePrefs(app, app.getSharedPreferences("talk-refresh-${UUID.randomUUID()}", Context.MODE_PRIVATE))
      prefs.setManualTls(false)
      val configRequest = CompletableDeferred<Pair<WebSocket, String>>()
      val refreshedNode = CompletableDeferred<Triple<WebSocket, String, JsonObject>>()
      val closedSession = CompletableDeferred<JsonObject>()
      val captureStarted = CompletableDeferred<AudioRecord>()
      val finishCaptureRead = CountDownLatch(1)
      val operatorConnects = AtomicInteger()
      val creates = AtomicInteger()
      val refreshing = AtomicBoolean()
      val gateway =
        ConsumedBootstrapGateway(sharedToken = "test-token", interceptRequest = { frame, socket ->
          val id = frame.getValue("id").jsonPrimitive.content
          when (frame["method"]?.jsonPrimitive?.content) {
            "connect" -> {
              val params = frame.getValue("params").jsonObject
              when (params.getValue("role").jsonPrimitive.content) {
                "operator" -> {
                  operatorConnects.incrementAndGet() > 1
                }

                "node" -> {
                  if (refreshing.get()) {
                    refreshedNode.complete(Triple(socket, id, params))
                    true
                  } else {
                    false
                  }
                }

                else -> {
                  false
                }
              }
            }

            "talk.config" -> {
              configRequest.complete(socket to id)
              true
            }

            "talk.session.create" -> {
              creates.incrementAndGet()
              socket.send("""{"type":"res","id":"$id","ok":true,"payload":{"relaySessionId":"permission-talk"}}""")
              true
            }

            "talk.session.close" -> {
              closedSession.complete(frame.getValue("params").jsonObject)
              false
            }

            else -> {
              false
            }
          }
        })
      ShadowAudioRecord.setSourceProvider { recorder ->
        object : ShadowAudioRecord.AudioRecordSource {
          override fun readInByteArray(
            buffer: ByteArray,
            offset: Int,
            size: Int,
            blocking: Boolean,
          ): Int {
            captureStarted.complete(recorder)
            check(finishCaptureRead.await(5, TimeUnit.SECONDS)) { "Talk capture was not stopped" }
            return 0
          }
        }
      }
      val runtime = createRuntime(app, prefs)
      try {
        val endpoint = GatewayEndpoint.manual("127.0.0.1", gateway.server.port)
        runtime.connect(endpoint, NodeRuntime.GatewayConnectAuth("test-token", null, null))
        withTimeout(5_000) { runtime.gatewayConnectionDisplay.first { it.statusText == "Connected" } }
        withTimeout(5_000) { runtime.gatewayConnectionHandoff.first { !it.pending } }
        val initialNode = withTimeout(5_000) { gateway.nodeConnects.receive() }
        assertEquals(
          "false",
          initialNode
            .getValue("permissions")
            .jsonObject
            .getValue("microphone")
            .jsonPrimitive.content,
        )
        val operator = ReflectionHelpers.getField<GatewaySession>(runtime, "operatorSession")
        val originalLease = checkNotNull(operator.captureRequestLease(endpoint.stableId))

        // ActivityResult starts Talk before MainActivity refreshes the changed permission surface.
        shadowOf(app).grantPermissions(Manifest.permission.RECORD_AUDIO)
        runtime.setTalkModeEnabled(true)
        val (configSocket, configId) = withTimeout(5_000) { configRequest.await() }
        refreshing.set(true)
        runtime.refreshNodePermissionSurface()
        assertTrue("A node permission grant must preserve the in-flight operator request", originalLease.isCurrent())
        val (nodeSocket, nodeId, nodeParams) = withTimeout(5_000) { refreshedNode.await() }
        assertEquals(
          "true",
          nodeParams
            .getValue("permissions")
            .jsonObject
            .getValue("microphone")
            .jsonPrimitive.content,
        )
        assertFalse(runtime.nodeConnected.value)

        configSocket.send("""{"type":"res","id":"$configId","ok":true,"payload":{"config":{"clientHints":{"realtime":{"gatewayRelaySupported":true}}}}}""")
        withTimeout(5_000) { runtime.talkModeListening.first { it } }
        val recorder = withTimeout(5_000) { captureStarted.await() }
        assertNull(runtime.talkFailureNotice.value)
        assertEquals(1, operatorConnects.get())
        assertEquals(1, creates.get())
        assertEquals(AudioRecord.RECORDSTATE_RECORDING, recorder.recordingState)

        runtime.setTalkModeEnabled(false)
        finishCaptureRead.countDown()
        assertEquals("permission-talk", withTimeout(5_000) { closedSession.await() }.getValue("sessionId").jsonPrimitive.content)
        val talkMode = ReflectionHelpers.getField<Lazy<TalkModeManager>>(runtime, "talkMode\$delegate").value
        withTimeout(5_000) { talkMode.audioRetirement.await() }
        assertEquals(AudioRecord.STATE_UNINITIALIZED, recorder.state)
        nodeSocket.send(gateway.hello(nodeId, "node"))
        withTimeout(5_000) { runtime.nodeConnected.first { it } }
        assertFalse(runtime.talkModeEnabled.value)
        assertFalse(runtime.talkModeListening.value)
        assertEquals(1, creates.get())
        assertTrue(originalLease.isCurrent())
      } finally {
        try {
          runtime.setTalkModeEnabled(false)
          finishCaptureRead.countDown()
          closeNodeRuntimeTestFixture(runtime)
        } finally {
          ShadowAudioRecord.clearSource()
          gateway.server.shutdown()
          gateway.nodeConnects.close()
        }
      }
    }

  @Test
  fun capabilityChangeDuringSetupPreservesHandoffAndRelaunchAccess() =
    runBlocking {
      val app = RuntimeEnvironment.getApplication()
      // Robolectric owns this application's preference directory; no live app state is used.
      app
        .getSharedPreferences("openclaw.node", Context.MODE_PRIVATE)
        .edit()
        .clear()
        .commit()
      val secure = app.getSharedPreferences("bootstrap-refresh-${UUID.randomUUID()}", Context.MODE_PRIVATE)
      val prefs =
        SecurePrefs(app, secure).apply {
          setManualTls(false)
          setCameraEnabled(false)
        }
      val gateway = ConsumedBootstrapGateway()
      val endpoint = GatewayEndpoint.manual("127.0.0.1", gateway.server.port)
      // Start without cold-start auto-connect, then use the normal setup admission boundary.
      var runtime = createRuntime(app, prefs)
      try {
        val operation = checkNotNull(runtime.beginGatewayConnectionOperation { true })
        assertTrue(
          runtime.configureGatewayAndConnect(
            endpoint = endpoint,
            explicitAuth = NodeRuntime.GatewayConnectAuth(null, "setup-token", null),
            operation = operation,
            replaceAuth = true,
            clearComposer = {},
          ) {
            prefs.saveGatewayCredentials(endpoint.stableId, bootstrapToken = "setup-token")
            prefs.gatewayRegistry.upsert(
              GatewayRegistryEntry(
                stableId = endpoint.stableId,
                kind = GatewayRegistryEntryKind.MANUAL,
                name = endpoint.name,
                host = endpoint.host,
                port = endpoint.port,
                tls = false,
              ),
            )
          },
        )
        val initial = withTimeout(5_000) { gateway.nodeConnects.receive() }
        assertEquals("setup-token", initial.auth()["bootstrapToken"]?.jsonPrimitive?.content)
        val delayedHello = withTimeout(5_000) { gateway.consumedBootstrap.await() }

        // The Gateway has consumed the setup code, but Android has not received the role grants.
        // Changing an onboarding capability must not replace that in-flight handoff socket.
        runtime.setCameraEnabled(true)
        delayedHello.first.send(gateway.hello(delayedHello.second, "node", bootstrap = true))

        val refreshed = withTimeout(5_000) { gateway.nodeConnects.receive() }
        assertEquals("node-token", refreshed.auth()["token"]?.jsonPrimitive?.content)
        assertNull(refreshed.auth()["bootstrapToken"])
        assertTrue(refreshed["commands"]!!.jsonArray.any { it.jsonPrimitive.content == OpenClawCameraCommand.Snap.rawValue })
        withTimeout(5_000) { runtime.gatewayConnectionDisplay.first { it.isConnected } }
        assertNull(prefs.loadGatewayCredentials(endpoint.stableId).bootstrapToken)

        closeNodeRuntimeTestFixture(runtime)
        val reopenedPrefs = SecurePrefs(app, secure)
        runtime = createRuntime(app, reopenedPrefs)
        assertTrue(runtime.connectSwitchingGateway(endpoint))
        val relaunched = withTimeout(5_000) { gateway.nodeConnects.receive() }
        assertEquals("node-token", relaunched.auth()["token"]?.jsonPrimitive?.content)
        assertNull(relaunched.auth()["bootstrapToken"])
        withTimeout(5_000) { runtime.gatewayConnectionDisplay.first { it.isConnected } }
        assertNull(reopenedPrefs.loadGatewayCredentials(endpoint.stableId).bootstrapToken)
      } finally {
        try {
          closeNodeRuntimeTestFixture(runtime)
        } finally {
          gateway.server.shutdown()
          gateway.nodeConnects.close()
        }
      }
    }

  private fun JsonObject.auth(): JsonObject = getValue("auth").jsonObject

  private suspend fun createRuntime(
    context: Context,
    prefs: SecurePrefs,
  ): NodeRuntime =
    NodeRuntime.forGatewayAuthReset(context, prefs).also { runtime ->
      // Retire discovery/fleet producers before arming the saved gateway. Keep the runtime's
      // parent alive for actual setup, socket IO, capability refresh and readiness callbacks.
      val startupJobs =
        ReflectionHelpers
          .getField<CoroutineScope>(runtime, "scope")
          .coroutineContext.job.children
          .toList()
      startupJobs.forEach { it.cancel() }
      startupJobs.joinAll()
    }

  private class ConsumedBootstrapGateway(
    private val sharedToken: String? = null,
    private val interceptRequest: (JsonObject, WebSocket) -> Boolean = { _, _ -> false },
  ) {
    val nodeConnects = Channel<JsonObject>(Channel.UNLIMITED)
    val consumedBootstrap = CompletableDeferred<Pair<WebSocket, String>>()
    private val bootstrapConsumed = AtomicBoolean()
    val server =
      MockWebServer().apply {
        dispatcher =
          object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
              if (!request.getHeader("Upgrade").equals("websocket", ignoreCase = true)) {
                return MockResponse().setResponseCode(404)
              }
              return MockResponse().withWebSocketUpgrade(
                object : WebSocketListener() {
                  override fun onOpen(
                    webSocket: WebSocket,
                    response: Response,
                  ) {
                    webSocket.send("""{"type":"event","event":"connect.challenge","payload":{"nonce":"refresh-test","ts":1700000000123}}""")
                  }

                  override fun onMessage(
                    webSocket: WebSocket,
                    text: String,
                  ) {
                    val frame = Json.parseToJsonElement(text).jsonObject
                    val id = frame["id"]?.jsonPrimitive?.content ?: return
                    if (interceptRequest(frame, webSocket)) return
                    if (frame["method"]?.jsonPrimitive?.content != "connect") {
                      webSocket.send("""{"type":"res","id":"$id","ok":true,"payload":{}}""")
                      return
                    }
                    val params = frame.getValue("params").jsonObject
                    val role = params.getValue("role").jsonPrimitive.content
                    val auth = params["auth"]?.jsonObject
                    if (role == "node") nodeConnects.trySend(params)
                    if (auth?.get("bootstrapToken")?.jsonPrimitive?.content == "setup-token") {
                      if (bootstrapConsumed.compareAndSet(false, true)) {
                        consumedBootstrap.complete(webSocket to id)
                      } else {
                        webSocket.send("""{"type":"res","id":"$id","ok":false,"error":{"code":"UNAUTHORIZED","message":"bootstrap token invalid or expired","details":{"code":"AUTH_BOOTSTRAP_TOKEN_INVALID"}}}""")
                      }
                      return
                    }
                    val token = auth?.get("token")?.jsonPrimitive?.content
                    if (token != "$role-token" && (sharedToken == null || token != sharedToken)) {
                      webSocket.send("""{"type":"res","id":"$id","ok":false,"error":{"code":"UNAUTHORIZED","message":"device token mismatch","details":{"code":"AUTH_DEVICE_TOKEN_MISMATCH"}}}""")
                      return
                    }
                    webSocket.send(hello(id, role))
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
          }
        start(InetAddress.getByName("127.0.0.1"), 0)
      }

    fun hello(
      id: String,
      role: String,
      bootstrap: Boolean = false,
    ): String {
      val handoff = if (bootstrap) ""","deviceTokens":[{"deviceToken":"operator-token","role":"operator","scopes":["operator.read","operator.write"]}]""" else ""
      return """{"type":"res","id":"$id","ok":true,"payload":{"auth":{"deviceToken":"$role-token","role":"$role","scopes":[]$handoff},"features":{"methods":[]},"snapshot":{"sessionDefaults":{"mainSessionKey":"main"}}}}"""
    }
  }
}
