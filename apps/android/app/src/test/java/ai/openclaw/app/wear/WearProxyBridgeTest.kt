package ai.openclaw.app.wear

import ai.openclaw.android.gateway.GatewayEvent
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class WearProxyBridgeTest {
  private val json = Json { ignoreUnknownKeys = true }

  @Test
  fun `openEventSession does not replay events emitted before the session starts`() = runTest {
    val scope = TestScope(StandardTestDispatcher(testScheduler))
    val bridge =
      WearProxyBridge(
        scope = scope,
        json = json,
        isConnected = { true },
        operatorStatusText = { "Connected" },
        statusText = { "Connected" },
        gatewayConfig = { null },
      )

    bridge.emit("chat", """{"state":"final","runId":"stale"}""")
    runCurrent()

    val session = bridge.openEventSession(logTag = "WearProxy:test")
    val events = mutableListOf<GatewayEvent>()
    val collectJob =
      scope.launch {
        session.events.take(1).collect { events += it }
      }
    runCurrent()

    bridge.emit("chat", """{"state":"final","runId":"fresh"}""")
    advanceUntilIdle()

    assertEquals(
      listOf(GatewayEvent("chat", """{"state":"final","runId":"fresh"}""")),
      events,
    )

    collectJob.cancel()
    session.close()
    scope.cancel()
  }

  @Test
  fun `openEventSession fans out events to multiple sessions`() = runTest {
    val scope = TestScope(StandardTestDispatcher(testScheduler))
    val bridge =
      WearProxyBridge(
        scope = scope,
        json = json,
        isConnected = { true },
        operatorStatusText = { "Connected" },
        statusText = { "Connected" },
        gatewayConfig = { null },
      )

    val sessionA = bridge.openEventSession(logTag = "WearProxy:a")
    val sessionB = bridge.openEventSession(logTag = "WearProxy:b")
    val receiveA = async { sessionA.events.first() }
    val receiveB = async { sessionB.events.first() }
    runCurrent()

    val chatEvent = GatewayEvent("chat", """{"state":"final","runId":"fanout"}""")
    bridge.emit(chatEvent)
    advanceUntilIdle()

    assertEquals(chatEvent, receiveA.await())
    assertEquals(chatEvent, receiveB.await())

    sessionA.close()
    sessionB.close()
    scope.cancel()
  }
}
