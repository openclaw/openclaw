package ai.openclaw.android.gateway

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
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
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.util.concurrent.atomic.AtomicReference

private class InMemoryDeviceAuthStore : DeviceAuthTokenStore {
  private val tokens = mutableMapOf<String, String>()

  override fun loadToken(deviceId: String, role: String): String? = tokens["${deviceId.trim()}|${role.trim()}"]?.trim()?.takeIf { it.isNotEmpty() }

  override fun saveToken(deviceId: String, role: String, token: String) {
    tokens["${deviceId.trim()}|${role.trim()}"] = token.trim()
  }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class GatewaySessionInvokeTest {
  @Test
  fun nodeInvokeRequest_roundTripsInvokeResult() = runBlocking {
    val json = Json { ignoreUnknownKeys = true }
    val connected = CompletableDeferred<Unit>()
    val invokeRequest = CompletableDeferred<GatewaySession.InvokeRequest>()
    val invokeResultParams = CompletableDeferred<String>()
    val handshakeOrigin = AtomicReference<String?>(null)
    val lastDisconnect = AtomicReference("")
    val server =
      MockWebServer().apply {
        dispatcher =
          object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
              handshakeOrigin.compareAndSet(null, request.getHeader("Origin"))
              return MockResponse().withWebSocketUpgrade(
                object : WebSocketListener() {
                  override fun onOpen(webSocket: WebSocket, response: Response) {
                    webSocket.send(
                      """{"type":"event","event":"connect.challenge","payload":{"nonce":"android-test-nonce"}}""",
                    )
                  }

                  override fun onMessage(webSocket: WebSocket, text: String) {
                    val frame = json.parseToJsonElement(text).jsonObject
                    if (frame["type"]?.jsonPrimitive?.content != "req") return
                    val id = frame["id"]?.jsonPrimitive?.content ?: return
                    val method = frame["method"]?.jsonPrimitive?.content ?: return
                    when (method) {
                      "connect" -> {
                        webSocket.send(
                          """{"type":"res","id":"$id","ok":true,"payload":{"snapshot":{"sessionDefaults":{"mainSessionKey":"main"}}}}""",
                        )
                        webSocket.send(
                          """{"type":"event","event":"node.invoke.request","payload":{"id":"invoke-1","nodeId":"node-1","command":"debug.ping","params":{"ping":"pong"},"timeoutMs":5000}}""",
                        )
                      }
                      "node.invoke.result" -> {
                        if (!invokeResultParams.isCompleted) {
                          invokeResultParams.complete(frame["params"]?.toString().orEmpty())
                        }
                        webSocket.send("""{"type":"res","id":"$id","ok":true,"payload":{"ok":true}}""")
                        webSocket.close(1000, "done")
                      }
                    }
                  }
                },
              )
            }
          }
        start()
      }

    val app = RuntimeEnvironment.getApplication()
    val sessionJob = SupervisorJob()
    val deviceAuthStore = InMemoryDeviceAuthStore()
    val session =
      GatewaySession(
        scope = CoroutineScope(sessionJob + Dispatchers.Default),
        identityStore = DeviceIdentityStore(app),
        deviceAuthStore = deviceAuthStore,
        onConnected = { _, _, _ ->
          if (!connected.isCompleted) connected.complete(Unit)
        },
        onDisconnected = { message ->
          lastDisconnect.set(message)
        },
        onEvent = { _, _ -> },
        onInvoke = { req ->
          if (!invokeRequest.isCompleted) invokeRequest.complete(req)
          GatewaySession.InvokeResult.ok("""{"handled":true}""")
        },
      )

    try {
      session.connect(
        endpoint =
          GatewayEndpoint(
            stableId = "manual|127.0.0.1|${server.port}",
            name = "test",
            host = "127.0.0.1",
            port = server.port,
            tlsEnabled = false,
          ),
        token = "test-token",
        password = null,
        options =
          GatewayConnectOptions(
            role = "node",
            scopes = listOf("node:invoke"),
            caps = emptyList(),
            commands = emptyList(),
            permissions = emptyMap(),
            client =
              GatewayClientInfo(
                id = "openclaw-android-test",
                displayName = "Android Test",
                version = "1.0.0-test",
                platform = "android",
                mode = "node",
                instanceId = "android-test-instance",
                deviceFamily = "android",
                modelIdentifier = "test",
              ),
          ),
        tls = null,
      )

      val connectedWithinTimeout = withTimeoutOrNull(8_000) {
        connected.await()
        true
      } == true
      if (!connectedWithinTimeout) {
        throw AssertionError("never connected; lastDisconnect=${lastDisconnect.get()}; requests=${server.requestCount}")
      }
      val req = withTimeout(8_000) { invokeRequest.await() }
      val resultParamsJson = withTimeout(8_000) { invokeResultParams.await() }
      val resultParams = json.parseToJsonElement(resultParamsJson).jsonObject

      assertEquals("invoke-1", req.id)
      assertEquals("node-1", req.nodeId)
      assertEquals("debug.ping", req.command)
      assertEquals("""{"ping":"pong"}""", req.paramsJson)
      assertNull(handshakeOrigin.get())
      assertEquals("invoke-1", resultParams["id"]?.jsonPrimitive?.content)
      assertEquals("node-1", resultParams["nodeId"]?.jsonPrimitive?.content)
      assertEquals(true, resultParams["ok"]?.jsonPrimitive?.content?.toBooleanStrict())
      assertEquals(
        true,
        resultParams["payload"]?.jsonObject?.get("handled")?.jsonPrimitive?.content?.toBooleanStrict(),
      )
    } finally {
      session.disconnect()
      sessionJob.cancelAndJoin()
      server.shutdown()
    }
  }

  @Test
  fun nodeInvokeRequest_usesParamsJsonWhenProvided() = runBlocking {
    val json = Json { ignoreUnknownKeys = true }
    val connected = CompletableDeferred<Unit>()
    val invokeRequest = CompletableDeferred<GatewaySession.InvokeRequest>()
    val invokeResultParams = CompletableDeferred<String>()
    val lastDisconnect = AtomicReference("")
    val server =
      MockWebServer().apply {
        dispatcher =
          object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
              return MockResponse().withWebSocketUpgrade(
                object : WebSocketListener() {
                  override fun onOpen(webSocket: WebSocket, response: Response) {
                    webSocket.send(
                      """{"type":"event","event":"connect.challenge","payload":{"nonce":"android-test-nonce"}}""",
                    )
                  }

                  override fun onMessage(webSocket: WebSocket, text: String) {
                    val frame = json.parseToJsonElement(text).jsonObject
                    if (frame["type"]?.jsonPrimitive?.content != "req") return
                    val id = frame["id"]?.jsonPrimitive?.content ?: return
                    val method = frame["method"]?.jsonPrimitive?.content ?: return
                    when (method) {
                      "connect" -> {
                        webSocket.send(
                          """{"type":"res","id":"$id","ok":true,"payload":{"snapshot":{"sessionDefaults":{"mainSessionKey":"main"}}}}""",
                        )
                        webSocket.send(
                          """{"type":"event","event":"node.invoke.request","payload":{"id":"invoke-2","nodeId":"node-2","command":"debug.raw","paramsJSON":"{\"raw\":true}","params":{"ignored":1},"timeoutMs":5000}}""",
                        )
                      }
                      "node.invoke.result" -> {
                        if (!invokeResultParams.isCompleted) {
                          invokeResultParams.complete(frame["params"]?.toString().orEmpty())
                        }
                        webSocket.send("""{"type":"res","id":"$id","ok":true,"payload":{"ok":true}}""")
                        webSocket.close(1000, "done")
                      }
                    }
                  }
                },
              )
            }
          }
        start()
      }

    val app = RuntimeEnvironment.getApplication()
    val sessionJob = SupervisorJob()
    val deviceAuthStore = InMemoryDeviceAuthStore()
    val session =
      GatewaySession(
        scope = CoroutineScope(sessionJob + Dispatchers.Default),
        identityStore = DeviceIdentityStore(app),
        deviceAuthStore = deviceAuthStore,
        onConnected = { _, _, _ ->
          if (!connected.isCompleted) connected.complete(Unit)
        },
        onDisconnected = { message ->
          lastDisconnect.set(message)
        },
        onEvent = { _, _ -> },
        onInvoke = { req ->
          if (!invokeRequest.isCompleted) invokeRequest.complete(req)
          GatewaySession.InvokeResult.ok("""{"handled":true}""")
        },
      )

    try {
      session.connect(
        endpoint =
          GatewayEndpoint(
            stableId = "manual|127.0.0.1|${server.port}",
            name = "test",
            host = "127.0.0.1",
            port = server.port,
            tlsEnabled = false,
          ),
        token = "test-token",
        password = null,
        options =
          GatewayConnectOptions(
            role = "node",
            scopes = listOf("node:invoke"),
            caps = emptyList(),
            commands = emptyList(),
            permissions = emptyMap(),
            client =
              GatewayClientInfo(
                id = "openclaw-android-test",
                displayName = "Android Test",
                version = "1.0.0-test",
                platform = "android",
                mode = "node",
                instanceId = "android-test-instance",
                deviceFamily = "android",
                modelIdentifier = "test",
              ),
          ),
        tls = null,
      )

      val connectedWithinTimeout = withTimeoutOrNull(8_000) {
        connected.await()
        true
      } == true
      if (!connectedWithinTimeout) {
        throw AssertionError("never connected; lastDisconnect=${lastDisconnect.get()}; requests=${server.requestCount}")
      }

      val req = withTimeout(8_000) { invokeRequest.await() }
      val resultParamsJson = withTimeout(8_000) { invokeResultParams.await() }
      val resultParams = json.parseToJsonElement(resultParamsJson).jsonObject

      assertEquals("invoke-2", req.id)
      assertEquals("node-2", req.nodeId)
      assertEquals("debug.raw", req.command)
      assertEquals("""{"raw":true}""", req.paramsJson)
      assertEquals("invoke-2", resultParams["id"]?.jsonPrimitive?.content)
      assertEquals("node-2", resultParams["nodeId"]?.jsonPrimitive?.content)
      assertEquals(true, resultParams["ok"]?.jsonPrimitive?.content?.toBooleanStrict())
    } finally {
      session.disconnect()
      sessionJob.cancelAndJoin()
      server.shutdown()
    }
  }

  @Test
  fun nodeInvokeRequest_mapsCodePrefixedErrorsIntoInvokeResult() = runBlocking {
    val json = Json { ignoreUnknownKeys = true }
    val connected = CompletableDeferred<Unit>()
    val invokeResultParams = CompletableDeferred<String>()
    val lastDisconnect = AtomicReference("")
    val server =
      MockWebServer().apply {
        dispatcher =
          object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
              return MockResponse().withWebSocketUpgrade(
                object : WebSocketListener() {
                  override fun onOpen(webSocket: WebSocket, response: Response) {
                    webSocket.send(
                      """{"type":"event","event":"connect.challenge","payload":{"nonce":"android-test-nonce"}}""",
                    )
                  }

                  override fun onMessage(webSocket: WebSocket, text: String) {
                    val frame = json.parseToJsonElement(text).jsonObject
                    if (frame["type"]?.jsonPrimitive?.content != "req") return
                    val id = frame["id"]?.jsonPrimitive?.content ?: return
                    val method = frame["method"]?.jsonPrimitive?.content ?: return
                    when (method) {
                      "connect" -> {
                        webSocket.send(
                          """{"type":"res","id":"$id","ok":true,"payload":{"snapshot":{"sessionDefaults":{"mainSessionKey":"main"}}}}""",
                        )
                        webSocket.send(
                          """{"type":"event","event":"node.invoke.request","payload":{"id":"invoke-3","nodeId":"node-3","command":"camera.snap","params":{"facing":"front"},"timeoutMs":5000}}""",
                        )
                      }
                      "node.invoke.result" -> {
                        if (!invokeResultParams.isCompleted) {
                          invokeResultParams.complete(frame["params"]?.toString().orEmpty())
                        }
                        webSocket.send("""{"type":"res","id":"$id","ok":true,"payload":{"ok":true}}""")
                        webSocket.close(1000, "done")
                      }
                    }
                  }
                },
              )
            }
          }
        start()
      }

    val app = RuntimeEnvironment.getApplication()
    val sessionJob = SupervisorJob()
    val deviceAuthStore = InMemoryDeviceAuthStore()
    val session =
      GatewaySession(
        scope = CoroutineScope(sessionJob + Dispatchers.Default),
        identityStore = DeviceIdentityStore(app),
        deviceAuthStore = deviceAuthStore,
        onConnected = { _, _, _ ->
          if (!connected.isCompleted) connected.complete(Unit)
        },
        onDisconnected = { message ->
          lastDisconnect.set(message)
        },
        onEvent = { _, _ -> },
        onInvoke = {
          throw IllegalStateException("CAMERA_PERMISSION_REQUIRED: grant Camera permission")
        },
      )

    try {
      session.connect(
        endpoint =
          GatewayEndpoint(
            stableId = "manual|127.0.0.1|${server.port}",
            name = "test",
            host = "127.0.0.1",
            port = server.port,
            tlsEnabled = false,
          ),
        token = "test-token",
        password = null,
        options =
          GatewayConnectOptions(
            role = "node",
            scopes = listOf("node:invoke"),
            caps = emptyList(),
            commands = emptyList(),
            permissions = emptyMap(),
            client =
              GatewayClientInfo(
                id = "openclaw-android-test",
                displayName = "Android Test",
                version = "1.0.0-test",
                platform = "android",
                mode = "node",
                instanceId = "android-test-instance",
                deviceFamily = "android",
                modelIdentifier = "test",
              ),
          ),
        tls = null,
      )

      val connectedWithinTimeout = withTimeoutOrNull(8_000) {
        connected.await()
        true
      } == true
      if (!connectedWithinTimeout) {
        throw AssertionError("never connected; lastDisconnect=${lastDisconnect.get()}; requests=${server.requestCount}")
      }

      val resultParamsJson = withTimeout(8_000) { invokeResultParams.await() }
      val resultParams = json.parseToJsonElement(resultParamsJson).jsonObject

      assertEquals("invoke-3", resultParams["id"]?.jsonPrimitive?.content)
      assertEquals("node-3", resultParams["nodeId"]?.jsonPrimitive?.content)
      assertEquals(false, resultParams["ok"]?.jsonPrimitive?.content?.toBooleanStrict())
      assertEquals(
        "CAMERA_PERMISSION_REQUIRED",
        resultParams["error"]?.jsonObject?.get("code")?.jsonPrimitive?.content,
      )
      assertEquals(
        "grant Camera permission",
        resultParams["error"]?.jsonObject?.get("message")?.jsonPrimitive?.content,
      )
    } finally {
      session.disconnect()
      sessionJob.cancelAndJoin()
      server.shutdown()
    }
  }

  @Test
  fun refreshNodeCanvasCapability_sendsObjectParamsAndUpdatesScopedUrl() = runBlocking {
    val json = Json { ignoreUnknownKeys = true }
    val connected = CompletableDeferred<Unit>()
    val refreshRequestParams = CompletableDeferred<String?>()
    val lastDisconnect = AtomicReference("")
    val server =
      MockWebServer().apply {
        dispatcher =
          object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
              return MockResponse().withWebSocketUpgrade(
                object : WebSocketListener() {
                  override fun onOpen(webSocket: WebSocket, response: Response) {
                    webSocket.send(
                      """{"type":"event","event":"connect.challenge","payload":{"nonce":"android-test-nonce"}}""",
                    )
                  }

                  override fun onMessage(webSocket: WebSocket, text: String) {
                    val frame = json.parseToJsonElement(text).jsonObject
                    if (frame["type"]?.jsonPrimitive?.content != "req") return
                    val id = frame["id"]?.jsonPrimitive?.content ?: return
                    val method = frame["method"]?.jsonPrimitive?.content ?: return
                    when (method) {
                      "connect" -> {
                        webSocket.send(
                          """{"type":"res","id":"$id","ok":true,"payload":{"canvasHostUrl":"http://127.0.0.1/__openclaw__/cap/old-cap","snapshot":{"sessionDefaults":{"mainSessionKey":"main"}}}}""",
                        )
                      }
                      "node.canvas.capability.refresh" -> {
                        if (!refreshRequestParams.isCompleted) {
                          refreshRequestParams.complete(frame["params"]?.toString())
                        }
                        webSocket.send(
                          """{"type":"res","id":"$id","ok":true,"payload":{"canvasCapability":"new-cap"}}""",
                        )
                        webSocket.close(1000, "done")
                      }
                    }
                  }
                },
              )
            }
          }
        start()
      }

    val app = RuntimeEnvironment.getApplication()
    val sessionJob = SupervisorJob()
    val deviceAuthStore = InMemoryDeviceAuthStore()
    val session =
      GatewaySession(
        scope = CoroutineScope(sessionJob + Dispatchers.Default),
        identityStore = DeviceIdentityStore(app),
        deviceAuthStore = deviceAuthStore,
        onConnected = { _, _, _ ->
          if (!connected.isCompleted) connected.complete(Unit)
        },
        onDisconnected = { message ->
          lastDisconnect.set(message)
        },
        onEvent = { _, _ -> },
        onInvoke = { GatewaySession.InvokeResult.ok("""{"handled":true}""") },
      )

    try {
      session.connect(
        endpoint =
          GatewayEndpoint(
            stableId = "manual|127.0.0.1|${server.port}",
            name = "test",
            host = "127.0.0.1",
            port = server.port,
            tlsEnabled = false,
          ),
        token = "test-token",
        password = null,
        options =
          GatewayConnectOptions(
            role = "node",
            scopes = listOf("node:invoke"),
            caps = emptyList(),
            commands = emptyList(),
            permissions = emptyMap(),
            client =
              GatewayClientInfo(
                id = "openclaw-android-test",
                displayName = "Android Test",
                version = "1.0.0-test",
                platform = "android",
                mode = "node",
                instanceId = "android-test-instance",
                deviceFamily = "android",
                modelIdentifier = "test",
              ),
          ),
        tls = null,
      )

      val connectedWithinTimeout = withTimeoutOrNull(8_000) {
        connected.await()
        true
      } == true
      if (!connectedWithinTimeout) {
        throw AssertionError("never connected; lastDisconnect=${lastDisconnect.get()}; requests=${server.requestCount}")
      }

      val refreshed = session.refreshNodeCanvasCapability(timeoutMs = 8_000)
      val refreshParamsJson = withTimeout(8_000) { refreshRequestParams.await() }

      assertEquals(true, refreshed)
      assertEquals("{}", refreshParamsJson)
      assertEquals(
        "http://127.0.0.1:${server.port}/__openclaw__/cap/new-cap",
        session.currentCanvasHostUrl(),
      )
    } finally {
      session.disconnect()
      sessionJob.cancelAndJoin()
      server.shutdown()
    }
  }
}
