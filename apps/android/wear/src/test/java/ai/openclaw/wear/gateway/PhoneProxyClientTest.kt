package ai.openclaw.wear.gateway

import ai.openclaw.wear.R
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
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

    val requestDeferred = async { client.request("sessions.list", "{}", timeoutMs = 1_000) }
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
    val events = mutableListOf<GatewayEvent>()
    val collectJob = launch { repeat(2) { events += client.events.first() } }

    messageTransport.emit(
      ProxyMessageEvent(
        path = "/openclaw/event",
        sourceNodeId = "other-phone",
        data = """{"event":"chat","payload":{"state":"ignored"}}""".toByteArray(Charsets.UTF_8),
      ),
    )
    runCurrent()
    assertTrue(events.isEmpty())

    messageTransport.emit(
      ProxyMessageEvent(
        path = "/openclaw/event",
        sourceNodeId = "phone-node",
        data = """{"event":"chat","payload":{"state":"accepted"}}""".toByteArray(Charsets.UTF_8),
      ),
    )
    runCurrent()

    assertEquals(listOf(GatewayEvent("chat", """{"state":"accepted"}""")), events)
    collectJob.cancel()
    scope.cancel()
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
    runCurrent()
    messageTransport.emit(
      ProxyMessageEvent(
        path = "/openclaw/pong",
        sourceNodeId = "phone-node",
        data = """{"ready":true}""".toByteArray(Charsets.UTF_8),
      ),
    )
    runCurrent()
    advanceUntilIdle()
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
