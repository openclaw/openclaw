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
import kotlinx.serialization.json.JsonObject
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

private const val TEST_TIMEOUT_MS = 8_000L
private const val CONNECT_CHALLENGE_FRAME =
  """{"type":"event","event":"connect.challenge","payload":{"nonce":"android-test-nonce"}}"""

private class InMemoryDeviceAuthStore : DeviceAuthTokenStore {
  private val tokens = mutableMapOf<String, String>()

  override fun loadToken(deviceId: String, role: String): String? = tokens["${deviceId.trim()}|${role.trim()}"]?.trim()?.takeIf { it.isNotEmpty() }

  override fun saveToken(deviceId: String, role: String, token: String) {
    tokens["${deviceId.trim()}|${role.trim()}"] = token.trim()
  }
}

private data class NodeHarness(
  val session: GatewaySession,
  val sessionJob: SupervisorJob,
)

private data class InvokeScenarioResult(
  val request: GatewaySession.InvokeRequest,
  val resultParams: JsonObject,
)

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class GatewaySessionInvokeTest {
  @Test
  fun nodeInvokeRequest_roundTripsInvokeResult() = runBlocking {
    val handshakeOrigin = AtomicReference<String?>(null)
    val result =
      runInvokeScenario(
        invokeEventFrame =
          """{"type":"event","event":"node.invoke.request","payload":{"id":"invoke-1","nodeId":"node-1","command":"debug.ping","params":{"ping":"pong"},"timeoutMs":5000}}""",
        onHandshake = { request -> handshakeOrigin.compareAndSet(null, request.getHeader("Origin")) },
      ) {
        GatewaySession.InvokeResult.ok("""{"handled":true}""")
      }

    assertEquals("invoke-1", result.request.id)
    assertEquals("node-1", result.request.nodeId)
    assertEquals("debug.ping", result.request.command)
    assertEquals("""{"ping":"pong"}""", result.request.paramsJson)
    assertNull(handshakeOrigin.get())
    assertEquals("invoke-1", result.resultParams["id"]?.jsonPrimitive?.content)
    assertEquals("node-1", result.resultParams["nodeId"]?.jsonPrimitive?.content)
    assertEquals(true, result.resultParams["ok"]?.jsonPrimitive?.content?.toBooleanStrict())
    assertEquals(
      true,
      result.resultParams["payload"]?.jsonObject?.get("handled")?.jsonPrimitive?.content?.toBooleanStrict(),
    )
  }

  @Test
  fun nodeInvokeRequest_usesParamsJsonWhenProvided() = runBlocking {
    val result =
      runInvokeScenario(
        invokeEventFrame =
          """{"type":"event","event":"node.invoke.request","payload":{"id":"invoke-2","nodeId":"node-2","command":"debug.raw","paramsJSON":"{\\"raw\\":true}","params":{"ignored":1},"timeoutMs":5000}}""",
      ) {
        GatewaySession.InvokeResult.ok("""{"handled":true}""")
      }

    assertEquals("invoke-2", result.request.id)
    assertEquals("node-2", result.request.nodeId)
    assertEquals("debug.raw", result.request.command)
    assertEquals("""{"raw":true}""", result.request.paramsJson)
    assertEquals("invoke-2", result.resultParams["id"]?.jsonPrimitive?.content)
    assertEquals("node-2", result.resultParams["nodeId"]?.jsonPrimitive?.content)
    assertEquals(true, result.resultParams["ok"]?.jsonPrimitive?.content?.toBooleanStrict())
  }

  @Test
  fun nodeInvokeRequest_mapsCodePrefixedErrorsIntoInvokeResult() = runBlocking {
    val result =
      runInvokeScenario(
        invokeEventFrame =
          """{"type":"event","event":"node.invoke.request","payload":{"id":"invoke-3","nodeId":"node-3","command":"camera.snap","params":{"facing":"front"},"timeoutMs":5000}}""",
      ) {
        throw IllegalStateException("CAMERA_PERMISSION_REQUIRED: grant Camera permission")
      }

    assertEquals("invoke-3", result.resultParams["id"]?.jsonPrimitive?.content)
    assertEquals("node-3", result.resultParams["nodeId"]?.jsonPrimitive?.content)
    assertEquals(false, result.resultParams["ok"]?.jsonPrimitive?.content?.toBooleanStrict())
    assertEquals(
      "CAMERA_PERMISSION_REQUIRED",
      result.resultParams["error"]?.jsonObject?.get("code")?.jsonPrimitive?.content,
    )
    assertEquals(
      "grant Camera permission",
      result.resultParams["error"]?.jsonObject?.get("message")?.jsonPrimitive?.content,
    )
  }

  @Test
  fun refreshNodeCanvasCapability_sendsObjectParamsAndUpdatesScopedUrl() = runBlocking {
    val json = testJson()
    val connected = CompletableDeferred<Unit>()
    val refreshRequestParams = CompletableDeferred<String?>()
    val lastDisconnect = AtomicReference("")

    val server =
      startGatewayServer(json) { webSocket, id, method, frame ->
        when (method) {
          "connect" -> {
            webSocket.send(connectResponseFrame(id, canvasHostUrl = "http://127.0.0.1/__openclaw__/cap/old-cap"))
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

    val harness =
      createNodeHarness(
        connected = connected,
        lastDisconnect = lastDisconnect,
      ) { GatewaySession.InvokeResult.ok("""{"handled":true}""") }

    try {
      connectNodeSession(harness.session, server.port)
      awaitConnectedOrThrow(connected, lastDisconnect, server)

      val refreshed = harness.session.refreshNodeCanvasCapability(timeoutMs = TEST_TIMEOUT_MS)
      val refreshParamsJson = withTimeout(TEST_TIMEOUT_MS) { refreshRequestParams.await() }

      assertEquals(true, refreshed)
      assertEquals("{}", refreshParamsJson)
      assertEquals(
        "http://127.0.0.1:${server.port}/__openclaw__/cap/new-cap",
        harness.session.currentCanvasHostUrl(),
      )
    } finally {
      shutdownHarness(harness, server)
    }
  }

  private fun testJson(): Json = Json { ignoreUnknownKeys = true }

  private fun createNodeHarness(
    connected: CompletableDeferred<Unit>,
    lastDisconnect: AtomicReference<String>,
    onInvoke: (GatewaySession.InvokeRequest) -> GatewaySession.InvokeResult,
  ): NodeHarness {
    val app = RuntimeEnvironment.getApplication()
    val sessionJob = SupervisorJob()
    val session =
      GatewaySession(
        scope = CoroutineScope(sessionJob + Dispatchers.Default),
        identityStore = DeviceIdentityStore(app),
        deviceAuthStore = InMemoryDeviceAuthStore(),
        onConnected = { _, _, _ ->
          if (!connected.isCompleted) connected.complete(Unit)
        },
        onDisconnected = { message ->
          lastDisconnect.set(message)
        },
        onEvent = { _, _ -> },
        onInvoke = onInvoke,
      )

    return NodeHarness(session = session, sessionJob = sessionJob)
  }

  private suspend fun connectNodeSession(session: GatewaySession, port: Int) {
    session.connect(
      endpoint =
        GatewayEndpoint(
          stableId = "manual|127.0.0.1|$port",
          name = "test",
          host = "127.0.0.1",
          port = port,
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
  }

  private suspend fun awaitConnectedOrThrow(
    connected: CompletableDeferred<Unit>,
    lastDisconnect: AtomicReference<String>,
    server: MockWebServer,
  ) {
    val connectedWithinTimeout =
      withTimeoutOrNull(TEST_TIMEOUT_MS) {
        connected.await()
        true
      } == true
    if (!connectedWithinTimeout) {
      throw AssertionError("never connected; lastDisconnect=${lastDisconnect.get()}; requests=${server.requestCount}")
    }
  }

  private suspend fun shutdownHarness(harness: NodeHarness, server: MockWebServer) {
    harness.session.disconnect()
    harness.sessionJob.cancelAndJoin()
    server.shutdown()
  }

  private suspend fun runInvokeScenario(
    invokeEventFrame: String,
    onHandshake: ((RecordedRequest) -> Unit)? = null,
    onInvoke: (GatewaySession.InvokeRequest) -> GatewaySession.InvokeResult,
  ): InvokeScenarioResult {
    val json = testJson()
    val connected = CompletableDeferred<Unit>()
    val invokeRequest = CompletableDeferred<GatewaySession.InvokeRequest>()
    val invokeResultParams = CompletableDeferred<String>()
    val lastDisconnect = AtomicReference("")
    val server =
      startGatewayServer(
        json = json,
        onHandshake = onHandshake,
      ) { webSocket, id, method, frame ->
        when (method) {
          "connect" -> {
            webSocket.send(connectResponseFrame(id))
            webSocket.send(invokeEventFrame)
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
    val harness =
      createNodeHarness(
        connected = connected,
        lastDisconnect = lastDisconnect,
      ) { req ->
        if (!invokeRequest.isCompleted) invokeRequest.complete(req)
        onInvoke(req)
      }

    try {
      connectNodeSession(harness.session, server.port)
      awaitConnectedOrThrow(connected, lastDisconnect, server)
      val request = withTimeout(TEST_TIMEOUT_MS) { invokeRequest.await() }
      val resultParamsJson = withTimeout(TEST_TIMEOUT_MS) { invokeResultParams.await() }
      val resultParams = json.parseToJsonElement(resultParamsJson).jsonObject
      return InvokeScenarioResult(request = request, resultParams = resultParams)
    } finally {
      shutdownHarness(harness, server)
    }
  }

  private fun connectResponseFrame(id: String, canvasHostUrl: String? = null): String {
    val canvas = canvasHostUrl?.let { "\"canvasHostUrl\":\"$it\"," } ?: ""
    return """{"type":"res","id":"$id","ok":true,"payload":{$canvas"snapshot":{"sessionDefaults":{"mainSessionKey":"main"}}}}"""
  }

  private fun startGatewayServer(
    json: Json,
    onHandshake: ((RecordedRequest) -> Unit)? = null,
    onRequestFrame: (webSocket: WebSocket, id: String, method: String, frame: JsonObject) -> Unit,
  ): MockWebServer =
    MockWebServer().apply {
      dispatcher =
        object : Dispatcher() {
          override fun dispatch(request: RecordedRequest): MockResponse {
            onHandshake?.invoke(request)
            return MockResponse().withWebSocketUpgrade(
              object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                  webSocket.send(CONNECT_CHALLENGE_FRAME)
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                  val frame = json.parseToJsonElement(text).jsonObject
                  if (frame["type"]?.jsonPrimitive?.content != "req") return
                  val id = frame["id"]?.jsonPrimitive?.content ?: return
                  val method = frame["method"]?.jsonPrimitive?.content ?: return
                  onRequestFrame(webSocket, id, method, frame)
                }
              },
            )
          }
        }
      start()
    }
}
