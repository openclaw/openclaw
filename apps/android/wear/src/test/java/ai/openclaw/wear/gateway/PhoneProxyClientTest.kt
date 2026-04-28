package ai.openclaw.wear.gateway

import ai.openclaw.android.gateway.GatewayEvent
import ai.openclaw.wear.R
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class PhoneProxyClientTest {
  @Test
  fun `connected proxy drops offline when health checks stop receiving pong`() = runTest {
    val scope = TestScope(StandardTestDispatcher(testScheduler))
    val messageTransport = FakeProxyMessageTransport()
    val nodeFinder =
      FakeProxyNodeFinder(
        listOf(
          ProxyNode(
            id = "phone-node",
            displayName = "Pixel",
            isNearby = true,
          ),
        ),
      )
    val client =
      PhoneProxyClient(
        stringResolver = ::testString,
        formattedStringResolver = ::testFormattedString,
        scope = scope,
        messageTransport = messageTransport,
        nodeFinder = nodeFinder,
      )

    client.connect()
    runCurrent()
    assertEquals(listOf("/openclaw/ping"), messageTransport.sentPaths())

    messageTransport.emit(
      ProxyMessageEvent(
        path = "/openclaw/pong",
        sourceNodeId = "phone-node",
        data = """{"ready":true}""".toByteArray(Charsets.UTF_8),
      ),
    )
    runCurrent()

    assertTrue(client.connected.value)
    assertEquals("Connected via phone", client.statusText.value)

    advanceTimeBy(30_000)
    runCurrent()
    assertEquals(listOf("/openclaw/ping", "/openclaw/ping"), messageTransport.sentPaths())

    advanceTimeBy(5_000)
    runCurrent()

    assertFalse(client.connected.value)
    assertEquals("Phone not responding, retrying…", client.statusText.value)

    scope.cancel()
  }

  @Test
  fun `proxy ignores rpc responses from a different node`() = runTest {
    val scope = TestScope(StandardTestDispatcher(testScheduler))
    val messageTransport = FakeProxyMessageTransport()
    val client = connectedProxyClient(scope, messageTransport)

    val requestDeferred = scope.async { client.request("sessions.list", "{}", timeoutMs = 1_000) }
    runCurrent()

    val rpcMessage = messageTransport.sentMessages().last()
    val requestId = kotlinx.serialization.json.Json.parseToJsonElement(String(rpcMessage.third)).jsonObject["id"]!!.jsonPrimitive.content

    messageTransport.emit(
      ProxyMessageEvent(
        path = "/openclaw/rpc-response",
        sourceNodeId = "other-phone",
        data = """{"id":"$requestId","ok":true,"payload":{"ignored":true}}""".toByteArray(Charsets.UTF_8),
      ),
    )
    runCurrent()
    assertFalse(requestDeferred.isCompleted)

    messageTransport.emit(
      ProxyMessageEvent(
        path = "/openclaw/rpc-response",
        sourceNodeId = "phone-node",
        data = """{"id":"$requestId","ok":true,"payload":{"ok":true}}""".toByteArray(Charsets.UTF_8),
      ),
    )
    runCurrent()

    assertEquals("""{"ok":true}""", requestDeferred.await())
    scope.cancel()
  }

  @Test
  fun `proxy ignores events from a different node`() = runTest {
    val scope = TestScope(StandardTestDispatcher(testScheduler))
    val messageTransport = FakeProxyMessageTransport()
    val client = connectedProxyClient(scope, messageTransport)
    val startupEvent = scope.async { client.events.first() }
    scope.runCurrent()
    assertEquals(GatewayEvent("proxy.connected", null), startupEvent.await())

    val eventDeferred = scope.async { client.events.first() }
    scope.runCurrent()

    messageTransport.emit(
      ProxyMessageEvent(
        path = "/openclaw/event",
        sourceNodeId = "other-phone",
        data = """{"event":"chat","payload":{"state":"ignored"}}""".toByteArray(Charsets.UTF_8),
      ),
    )
    scope.runCurrent()
    assertFalse(eventDeferred.isCompleted)

    messageTransport.emit(
      ProxyMessageEvent(
        path = "/openclaw/event",
        sourceNodeId = "phone-node",
        data = """{"event":"chat","payload":{"state":"accepted"}}""".toByteArray(Charsets.UTF_8),
      ),
    )
    scope.runCurrent()

    assertEquals(GatewayEvent("chat", """{"state":"accepted"}"""), eventDeferred.await())
    scope.cancel()
  }

  @Test
  fun `connect tries the next node after a ping timeout`() = runTest {
    val scope = TestScope(StandardTestDispatcher(testScheduler))
    val messageTransport = FakeProxyMessageTransport()
    val nodeFinder =
      FakeProxyNodeFinder(
        listOf(
          ProxyNode(
            id = "bad-node",
            displayName = "Bad phone",
            isNearby = true,
          ),
          ProxyNode(
            id = "good-node",
            displayName = "Good phone",
            isNearby = false,
          ),
        ),
      )
    val client =
      PhoneProxyClient(
        stringResolver = ::testString,
        formattedStringResolver = ::testFormattedString,
        scope = scope,
        messageTransport = messageTransport,
        nodeFinder = nodeFinder,
      )

    client.connect()
    runCurrent()
    assertEquals(listOf("bad-node"), messageTransport.sentMessages().map { it.first })

    advanceTimeBy(5_000)
    runCurrent()
    assertEquals(listOf("bad-node", "good-node"), messageTransport.sentMessages().map { it.first })

    messageTransport.emit(
      ProxyMessageEvent(
        path = "/openclaw/pong",
        sourceNodeId = "good-node",
        data = """{"ready":true}""".toByteArray(Charsets.UTF_8),
      ),
    )
    runCurrent()

    assertTrue(client.connected.value)
    assertEquals("Connected via phone", client.statusText.value)
    scope.cancel()
  }

  @Test
  fun `selectReadyProxyNode keeps trying after per-node probe exceptions`() = runTest {
    val attempts = mutableListOf<String>()
    val selection =
      selectReadyProxyNode(
        nodes =
          listOf(
            ProxyNode(id = "bad-node", displayName = "Bad phone", isNearby = true),
            ProxyNode(id = "good-node", displayName = "Good phone", isNearby = false),
          ),
        notRespondingStatus = "Phone not responding, retrying…",
        gatewayUnavailableStatus = "Gateway unavailable",
      ) { node ->
        attempts += node.id
        if (node.id == "bad-node") {
          throw Exception("stale node")
        } else {
          ProxyHandshake(ready = true, statusText = null)
        }
      }

    assertEquals(listOf("bad-node", "good-node"), attempts)
    assertEquals("good-node", selection.node?.id)
  }

  @Test
  fun `connect tries the next node after a not ready pong`() = runTest {
    val scope = TestScope(StandardTestDispatcher(testScheduler))
    val messageTransport = FakeProxyMessageTransport()
    val nodeFinder =
      FakeProxyNodeFinder(
        listOf(
          ProxyNode(
            id = "bad-node",
            displayName = "Bad phone",
            isNearby = true,
          ),
          ProxyNode(
            id = "good-node",
            displayName = "Good phone",
            isNearby = false,
          ),
        ),
      )
    val client =
      PhoneProxyClient(
        stringResolver = ::testString,
        formattedStringResolver = ::testFormattedString,
        scope = scope,
        messageTransport = messageTransport,
        nodeFinder = nodeFinder,
      )

    client.connect()
    runCurrent()
    messageTransport.emit(
      ProxyMessageEvent(
        path = "/openclaw/pong",
        sourceNodeId = "bad-node",
        data = """{"ready":false,"statusText":"Gateway unavailable"}""".toByteArray(Charsets.UTF_8),
      ),
    )
    runCurrent()

    assertEquals(listOf("bad-node", "good-node"), messageTransport.sentMessages().map { it.first })

    messageTransport.emit(
      ProxyMessageEvent(
        path = "/openclaw/pong",
        sourceNodeId = "good-node",
        data = """{"ready":true}""".toByteArray(Charsets.UTF_8),
      ),
    )
    runCurrent()

    val requestDeferred = scope.async { client.request("sessions.list", "{}", timeoutMs = 1_000) }
    runCurrent()
    val rpcMessage = messageTransport.sentMessages().last()
    assertEquals("good-node", rpcMessage.first)
    val requestId =
      kotlinx.serialization.json.Json
        .parseToJsonElement(String(rpcMessage.third))
        .jsonObject["id"]!!
        .jsonPrimitive
        .content

    messageTransport.emit(
      ProxyMessageEvent(
        path = "/openclaw/rpc-response",
        sourceNodeId = "good-node",
        data = """{"id":"$requestId","ok":true,"payload":{"ok":true}}""".toByteArray(Charsets.UTF_8),
      ),
    )
    runCurrent()

    assertEquals("""{"ok":true}""", requestDeferred.await())
    scope.cancel()
  }

  @Test
  fun `active ready false pong fails every in flight request immediately`() = runTest {
    val scope = TestScope(StandardTestDispatcher(testScheduler))
    val messageTransport = FakeProxyMessageTransport()
    val client = connectedProxyClient(scope, messageTransport)

    val firstRequest = scope.async { client.request("chat.history", "{}", timeoutMs = 1_000) }
    val secondRequest = scope.async { client.request("sessions.list", "{}", timeoutMs = 1_000) }
    runCurrent()

    messageTransport.emit(
      ProxyMessageEvent(
        path = "/openclaw/pong",
        sourceNodeId = "phone-node",
        data = """{"ready":false,"statusText":"Gateway unavailable"}""".toByteArray(Charsets.UTF_8),
      ),
    )
    runCurrent()

    assertFalse(client.connected.value)
    assertEquals("Gateway unavailable", client.statusText.value)
    assertTrue(firstRequest.isCompleted)
    assertTrue(secondRequest.isCompleted)
    try {
      firstRequest.await()
      fail("Expected first request to fail")
    } catch (e: Throwable) {
      assertEquals("Gateway unavailable", e.message)
    }
    try {
      secondRequest.await()
      fail("Expected second request to fail")
    } catch (e: Throwable) {
      assertEquals("Gateway unavailable", e.message)
    }
    scope.cancel()
  }

  @Test
  fun `proxy error responses drop the phone connection immediately`() = runTest {
    val scope = TestScope(StandardTestDispatcher(testScheduler))
    val messageTransport = FakeProxyMessageTransport()
    val client = connectedProxyClient(scope, messageTransport)

    val requestDeferred = scope.async { client.request("sessions.list", "{}", timeoutMs = 1_000) }
    runCurrent()
    val rpcMessage = messageTransport.sentMessages().last()
    val requestId =
      kotlinx.serialization.json.Json
        .parseToJsonElement(String(rpcMessage.third))
        .jsonObject["id"]!!
        .jsonPrimitive
        .content

    messageTransport.emit(
      ProxyMessageEvent(
        path = "/openclaw/rpc-response",
        sourceNodeId = "phone-node",
        data =
          """{"id":"$requestId","ok":false,"error":{"code":"PROXY_ERROR","message":"Gateway disconnected"}}"""
            .toByteArray(Charsets.UTF_8),
      ),
    )
    runCurrent()

    assertFalse(client.connected.value)
    assertEquals("Phone reachable, gateway unavailable", client.statusText.value)
    try {
      requestDeferred.await()
      fail("Expected proxy error request to fail")
    } catch (e: Throwable) {
      assertEquals("PROXY_ERROR: Gateway disconnected", e.message)
    }
    scope.cancel()
  }

  @Test
  fun `proxy error responses fail every in flight request immediately`() = runTest {
    val scope = TestScope(StandardTestDispatcher(testScheduler))
    val messageTransport = FakeProxyMessageTransport()
    val client = connectedProxyClient(scope, messageTransport)

    val firstRequest = scope.async { client.request("chat.history", "{}", timeoutMs = 1_000) }
    val secondRequest = scope.async { client.request("sessions.list", "{}", timeoutMs = 1_000) }
    runCurrent()

    val requestId =
      kotlinx.serialization.json.Json
        .parseToJsonElement(String(messageTransport.sentMessages().last().third))
        .jsonObject["id"]!!
        .jsonPrimitive
        .content

    messageTransport.emit(
      ProxyMessageEvent(
        path = "/openclaw/rpc-response",
        sourceNodeId = "phone-node",
        data =
          """{"id":"$requestId","ok":false,"error":{"code":"PROXY_ERROR","message":"Gateway disconnected"}}"""
            .toByteArray(Charsets.UTF_8),
      ),
    )
    runCurrent()

    assertTrue(firstRequest.isCompleted)
    assertTrue(secondRequest.isCompleted)
    try {
      firstRequest.await()
      fail("Expected first request to fail")
    } catch (e: Throwable) {
      assertEquals("PROXY_ERROR: Gateway disconnected", e.message)
    }
    try {
      secondRequest.await()
      fail("Expected second request to fail")
    } catch (e: Throwable) {
      assertEquals("PROXY_ERROR: Gateway disconnected", e.message)
    }
    scope.cancel()
  }

  @Test
  fun `proxy handshake does not sync direct fallback config from a not ready phone`() = runTest {
    val scope = TestScope(StandardTestDispatcher(testScheduler))
    val messageTransport = FakeProxyMessageTransport()
    val syncedConfigs = mutableListOf<Pair<WearGatewayConfig, String?>>()
    val nodeFinder =
      FakeProxyNodeFinder(
        listOf(
          ProxyNode(
            id = "phone-node",
            displayName = "Pixel",
            isNearby = true,
          ),
        ),
      )
    val client =
      PhoneProxyClient(
        stringResolver = ::testString,
        formattedStringResolver = ::testFormattedString,
        scope = scope,
        messageTransport = messageTransport,
        nodeFinder = nodeFinder,
        onGatewayConfigSynced = { config, fingerprint ->
          syncedConfigs += config to fingerprint
        },
      )

    client.connect()
    runCurrent()
    messageTransport.emit(
      ProxyMessageEvent(
        path = "/openclaw/pong",
        sourceNodeId = "phone-node",
        data =
          """
          {
            "ready": false,
            "statusText": "Gateway unavailable",
            "gatewayConfig": {
              "host": "gateway.example",
              "port": 443,
              "useTls": true,
              "token": "token-1",
              "bootstrapToken": "bootstrap-1",
              "password": "password-1",
              "tlsFingerprintSha256": "sha256:abcd"
            }
          }
          """.trimIndent().toByteArray(Charsets.UTF_8),
      ),
    )
    runCurrent()

    assertTrue(syncedConfigs.isEmpty())
    assertFalse(client.connected.value)
    assertEquals("Gateway unavailable", client.statusText.value)
    scope.cancel()
  }

  @Test
  fun `proxy handshake syncs direct fallback config from the selected ready phone`() = runTest {
    val scope = TestScope(StandardTestDispatcher(testScheduler))
    val messageTransport = FakeProxyMessageTransport()
    val syncedConfigs = mutableListOf<Pair<WearGatewayConfig, String?>>()
    val nodeFinder =
      FakeProxyNodeFinder(
        listOf(
          ProxyNode(
            id = "phone-node",
            displayName = "Pixel",
            isNearby = true,
          ),
        ),
      )
    val client =
      PhoneProxyClient(
        stringResolver = ::testString,
        formattedStringResolver = ::testFormattedString,
        scope = scope,
        messageTransport = messageTransport,
        nodeFinder = nodeFinder,
        onGatewayConfigSynced = { config, fingerprint ->
          syncedConfigs += config to fingerprint
        },
      )

    client.connect()
    runCurrent()
    messageTransport.emit(
      ProxyMessageEvent(
        path = "/openclaw/pong",
        sourceNodeId = "phone-node",
        data =
          """
          {
            "ready": true,
            "gatewayConfig": {
              "host": "gateway.example",
              "port": 443,
              "useTls": true,
              "token": "token-1",
              "bootstrapToken": "bootstrap-1",
              "password": "password-1",
              "tlsFingerprintSha256": "sha256:abcd"
            }
          }
          """.trimIndent().toByteArray(Charsets.UTF_8),
      ),
    )
    runCurrent()

    assertEquals(1, syncedConfigs.size)
    val (config, fingerprint) = syncedConfigs.single()
    assertEquals("gateway.example", config.host)
    assertEquals(443, config.port)
    assertEquals("token-1", config.token)
    assertEquals("bootstrap-1", config.bootstrapToken)
    assertEquals("password-1", config.password)
    assertTrue(config.useTls)
    assertEquals("sha256:abcd", fingerprint)
    assertTrue(client.connected.value)
    assertEquals("Connected via phone", client.statusText.value)
    scope.cancel()
  }

  @Test
  fun `proxy handshake syncs direct fallback config only from the selected ready phone`() = runTest {
    val scope = TestScope(StandardTestDispatcher(testScheduler))
    val messageTransport = FakeProxyMessageTransport()
    val syncedConfigs = mutableListOf<Pair<WearGatewayConfig, String?>>()
    val nodeFinder =
      FakeProxyNodeFinder(
        listOf(
          ProxyNode(
            id = "bad-node",
            displayName = "Bad phone",
            isNearby = true,
          ),
          ProxyNode(
            id = "good-node",
            displayName = "Good phone",
            isNearby = false,
          ),
        ),
      )
    val client =
      PhoneProxyClient(
        stringResolver = ::testString,
        formattedStringResolver = ::testFormattedString,
        scope = scope,
        messageTransport = messageTransport,
        nodeFinder = nodeFinder,
        onGatewayConfigSynced = { config, fingerprint ->
          syncedConfigs += config to fingerprint
        },
      )

    client.connect()
    runCurrent()
    messageTransport.emit(
      ProxyMessageEvent(
        path = "/openclaw/pong",
        sourceNodeId = "bad-node",
        data =
          """
          {
            "ready": false,
            "statusText": "Gateway unavailable",
            "gatewayConfig": {
              "host": "bad.example",
              "port": 443,
              "useTls": true,
              "token": "bad-token",
              "bootstrapToken": "bad-bootstrap",
              "password": "bad-password",
              "tlsFingerprintSha256": "sha256:bad"
            }
          }
          """.trimIndent().toByteArray(Charsets.UTF_8),
      ),
    )
    runCurrent()

    messageTransport.emit(
      ProxyMessageEvent(
        path = "/openclaw/pong",
        sourceNodeId = "good-node",
        data =
          """
          {
            "ready": true,
            "gatewayConfig": {
              "host": "good.example",
              "port": 443,
              "useTls": true,
              "token": "good-token",
              "bootstrapToken": "good-bootstrap",
              "password": "good-password",
              "tlsFingerprintSha256": "sha256:good"
            }
          }
          """.trimIndent().toByteArray(Charsets.UTF_8),
      ),
    )
    runCurrent()

    assertEquals(1, syncedConfigs.size)
    val (config, fingerprint) = syncedConfigs.single()
    assertEquals("good.example", config.host)
    assertEquals("good-token", config.token)
    assertEquals("good-bootstrap", config.bootstrapToken)
    assertEquals("good-password", config.password)
    assertEquals("sha256:good", fingerprint)
    assertTrue(client.connected.value)
    assertEquals("Connected via phone", client.statusText.value)
    scope.cancel()
  }

  @Test
  fun `active ready pongs refresh changed direct fallback config`() = runTest {
    val scope = TestScope(StandardTestDispatcher(testScheduler))
    val messageTransport = FakeProxyMessageTransport()
    val syncedConfigs = mutableListOf<Pair<WearGatewayConfig, String?>>()
    val nodeFinder =
      FakeProxyNodeFinder(
        listOf(
          ProxyNode(
            id = "phone-node",
            displayName = "Pixel",
            isNearby = true,
          ),
        ),
      )
    val client =
      PhoneProxyClient(
        stringResolver = ::testString,
        formattedStringResolver = ::testFormattedString,
        scope = scope,
        messageTransport = messageTransport,
        nodeFinder = nodeFinder,
        onGatewayConfigSynced = { config, fingerprint ->
          syncedConfigs += config to fingerprint
        },
      )

    client.connect()
    runCurrent()
    messageTransport.emit(
      ProxyMessageEvent(
        path = "/openclaw/pong",
        sourceNodeId = "phone-node",
        data =
          """
          {
            "ready": true,
            "gatewayConfig": {
              "host": "gateway.example",
              "port": 443,
              "useTls": true,
              "token": "token-1",
              "bootstrapToken": "bootstrap-1",
              "password": "password-1",
              "tlsFingerprintSha256": "sha256:abcd"
            }
          }
          """.trimIndent().toByteArray(Charsets.UTF_8),
      ),
    )
    runCurrent()

    messageTransport.emit(
      ProxyMessageEvent(
        path = "/openclaw/pong",
        sourceNodeId = "phone-node",
        data =
          """
          {
            "ready": true,
            "gatewayConfig": {
              "host": "gateway-2.example",
              "port": 8443,
              "useTls": true,
              "token": "token-2",
              "bootstrapToken": "bootstrap-2",
              "password": "password-2",
              "tlsFingerprintSha256": "sha256:efgh"
            }
          }
          """.trimIndent().toByteArray(Charsets.UTF_8),
      ),
    )
    runCurrent()

    assertEquals(2, syncedConfigs.size)
    val (config, fingerprint) = syncedConfigs.last()
    assertEquals("gateway-2.example", config.host)
    assertEquals(8443, config.port)
    assertEquals("token-2", config.token)
    assertEquals("bootstrap-2", config.bootstrapToken)
    assertEquals("password-2", config.password)
    assertTrue(config.useTls)
    assertEquals("sha256:efgh", fingerprint)
    assertTrue(client.connected.value)
    assertEquals("Connected via phone", client.statusText.value)
    scope.cancel()
  }

  @Test
  fun `active ready pongs do not resync an unchanged direct fallback config`() = runTest {
    val scope = TestScope(StandardTestDispatcher(testScheduler))
    val messageTransport = FakeProxyMessageTransport()
    val syncedConfigs = mutableListOf<Pair<WearGatewayConfig, String?>>()
    val nodeFinder =
      FakeProxyNodeFinder(
        listOf(
          ProxyNode(
            id = "phone-node",
            displayName = "Pixel",
            isNearby = true,
          ),
        ),
      )
    val client =
      PhoneProxyClient(
        stringResolver = ::testString,
        formattedStringResolver = ::testFormattedString,
        scope = scope,
        messageTransport = messageTransport,
        nodeFinder = nodeFinder,
        onGatewayConfigSynced = { config, fingerprint ->
          syncedConfigs += config to fingerprint
        },
      )

    client.connect()
    runCurrent()

    val readyPong =
      """
      {
        "ready": true,
        "gatewayConfig": {
          "host": "gateway.example",
          "port": 443,
          "useTls": true,
          "token": "token-1",
          "bootstrapToken": "bootstrap-1",
          "password": "password-1",
          "tlsFingerprintSha256": "sha256:abcd"
        }
      }
      """.trimIndent().toByteArray(Charsets.UTF_8)

    messageTransport.emit(
      ProxyMessageEvent(
        path = "/openclaw/pong",
        sourceNodeId = "phone-node",
        data = readyPong,
      ),
    )
    runCurrent()

    messageTransport.emit(
      ProxyMessageEvent(
        path = "/openclaw/pong",
        sourceNodeId = "phone-node",
        data = readyPong,
      ),
    )
    runCurrent()

    assertEquals(1, syncedConfigs.size)
    scope.cancel()
  }

  @Test
  fun `prioritize proxy nodes prefers nearby devices first`() {
    val ordered =
      prioritizeProxyNodes(
        listOf(
          ProxyNode(id = "2", displayName = "Tablet", isNearby = false),
          ProxyNode(id = "3", displayName = "Alpha phone", isNearby = true),
          ProxyNode(id = "1", displayName = "Beta phone", isNearby = true),
        ),
      )

    assertEquals(listOf("3", "1", "2"), ordered.map { it.id })
  }

  private fun connectedProxyClient(
    scope: TestScope,
    messageTransport: FakeProxyMessageTransport,
  ): PhoneProxyClient {
    val nodeFinder =
      FakeProxyNodeFinder(
        listOf(
          ProxyNode(
            id = "phone-node",
            displayName = "Pixel",
            isNearby = true,
          ),
        ),
      )
    val client =
      PhoneProxyClient(
        stringResolver = ::testString,
        formattedStringResolver = ::testFormattedString,
        scope = scope,
        messageTransport = messageTransport,
        nodeFinder = nodeFinder,
      )
    client.connect()
    scope.runCurrent()
    messageTransport.emit(
      ProxyMessageEvent(
        path = "/openclaw/pong",
        sourceNodeId = "phone-node",
        data = """{"ready":true}""".toByteArray(Charsets.UTF_8),
      ),
    )
    scope.runCurrent()
    return client
  }

  private fun testString(resId: Int): String {
    return when (resId) {
      R.string.wear_status_phone_proxy_offline -> "Phone proxy offline"
      R.string.wear_status_finding_phone -> "Finding phone…"
      R.string.wear_status_phone_not_responding -> "Phone not responding, retrying…"
      R.string.wear_status_phone_gateway_unavailable -> "Phone reachable, gateway unavailable"
      R.string.wear_status_connected_via_phone -> "Connected via phone"
      R.string.wear_status_no_phone_found -> "No phone found"
      R.string.wear_status_pinging_phone -> "Pinging phone…"
      R.string.wear_status_phone_ping_timed_out -> "Phone ping timed out, retrying…"
      R.string.wear_status_failed -> "Failed: %1\$s"
      else -> "res-$resId"
    }
  }

  private fun testFormattedString(resId: Int, args: Array<out Any>): String {
    return when (resId) {
      R.string.wear_status_failed -> "Failed: ${args.firstOrNull()?.toString().orEmpty()}"
      else -> testString(resId)
    }
  }
}

private class FakeProxyNodeFinder(
  private val nodes: List<ProxyNode>,
) : ProxyNodeFinder {
  override suspend fun connectedNodes(): List<ProxyNode> = nodes
}

private class FakeProxyMessageTransport : ProxyMessageTransport {
  private val listeners = linkedSetOf<ProxyMessageListener>()
  private val sent = mutableListOf<Triple<String, String, ByteArray>>()

  override fun addListener(listener: ProxyMessageListener) {
    listeners += listener
  }

  override fun removeListener(listener: ProxyMessageListener) {
    listeners -= listener
  }

  override suspend fun sendMessage(nodeId: String, path: String, data: ByteArray) {
    sent += Triple(nodeId, path, data)
  }

  fun emit(event: ProxyMessageEvent) {
    listeners.forEach { it.onMessageReceived(event) }
  }

  fun sentPaths(): List<String> = sent.map { it.second }

  fun sentMessages(): List<Triple<String, String, ByteArray>> = sent.toList()
}
