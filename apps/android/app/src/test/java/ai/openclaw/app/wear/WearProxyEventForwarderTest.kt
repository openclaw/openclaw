package ai.openclaw.app.wear

import ai.openclaw.android.gateway.GatewayEvent
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class WearProxyEventForwarderTest {
  @Test
  fun `forwarder keeps sending events to the handshake node`() = runTest {
    val scope = TestScope(StandardTestDispatcher(testScheduler))
    val mainSessionKey = MutableStateFlow("main")
    val events = MutableSharedFlow<GatewayEvent>(extraBufferCapacity = 4)
    val sent = mutableListOf<Triple<String, String, String?>>()

    val job =
      WearProxyEventForwarder(
        nodeId = "watch-node-a",
        mainSessionKey = mainSessionKey,
        events = events,
        sendEvent = { nodeId, event, payload ->
          sent += Triple(nodeId, event, payload)
        },
      ).startIn(scope)

    advanceUntilIdle()
    events.emit(GatewayEvent(event = "chat", payloadJson = """{"state":"streaming"}"""))
    advanceUntilIdle()

    assertEquals(
      listOf(
        Triple("watch-node-a", "mainSessionKey", "main"),
        Triple("watch-node-a", "chat", """{"state":"streaming"}"""),
      ),
      sent,
    )

    job.cancel()
    scope.cancel()
  }

  @Test
  fun `forwarding registry keeps independent forwarders for multiple watches`() = runTest {
    val scope = TestScope(StandardTestDispatcher(testScheduler))
    val mainSessionKey = MutableStateFlow("main")
    val sent = mutableListOf<Triple<String, String, String?>>()
    val eventQueues = linkedMapOf<String, Channel<GatewayEvent>>()
    val registry =
      WearProxyForwardingRegistry(
        scope = scope,
        mainSessionKey = mainSessionKey,
        openEventSession = { nodeId ->
          val events = Channel<GatewayEvent>(capacity = Channel.UNLIMITED)
          eventQueues[nodeId] = events
          object : WearProxyEventSession {
            override val events: Flow<GatewayEvent> = events.receiveAsFlow()

            override fun close() {
              eventQueues.remove(nodeId)
              events.close()
            }
          }
        },
        sendEvent = { nodeId, event, payload ->
          sent += Triple(nodeId, event, payload)
        },
        forwarderFactory =
          WearProxyForwarderFactory { nodeId, mainSessionKey, events, sendEvent, scope ->
            scope.launch {
              sendEvent(nodeId, "mainSessionKey", mainSessionKey.value.takeIf { it.isNotBlank() })
              events.collect { event ->
                sendEvent(nodeId, event.event, event.payloadJson)
              }
            }
          },
      )

    registry.ensureForwarding("watch-node-a")
    registry.ensureForwarding("watch-node-b")
    advanceUntilIdle()

    eventQueues.values.forEach { it.trySend(GatewayEvent("chat", """{"state":"streaming"}""")) }
    advanceUntilIdle()

    assertEquals(
      listOf(
        Triple("watch-node-a", "mainSessionKey", "main"),
        Triple("watch-node-b", "mainSessionKey", "main"),
        Triple("watch-node-a", "chat", """{"state":"streaming"}"""),
        Triple("watch-node-b", "chat", """{"state":"streaming"}"""),
      ),
      sent,
    )

    registry.stopForwarding("watch-node-a")
    eventQueues.values.forEach { it.trySend(GatewayEvent("chat", """{"state":"final"}""")) }
    advanceUntilIdle()

    assertEquals(
      listOf(
        Triple("watch-node-a", "mainSessionKey", "main"),
        Triple("watch-node-b", "mainSessionKey", "main"),
        Triple("watch-node-a", "chat", """{"state":"streaming"}"""),
        Triple("watch-node-b", "chat", """{"state":"streaming"}"""),
        Triple("watch-node-b", "chat", """{"state":"final"}"""),
      ),
      sent,
    )

    registry.stopAll()
    scope.cancel()
  }
}
