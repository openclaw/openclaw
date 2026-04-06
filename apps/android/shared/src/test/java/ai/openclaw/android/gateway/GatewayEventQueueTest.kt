package ai.openclaw.android.gateway

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class GatewayEventQueueTest {
  private val json = Json { ignoreUnknownKeys = true }

  @Test
  fun `coalesces chat deltas before final`() = runTest {
    val scope = TestScope(StandardTestDispatcher(testScheduler))
    val queue = GatewayEventQueue(scope = scope, json = json, maxQueueSize = 10)
    val events = mutableListOf<GatewayEvent>()

    scope.launch { queue.events.collect { events += it } }
    scope.runCurrent()

    val delta1 = """{"state":"delta","runId":"r1","sessionKey":"main","message":{"role":"assistant","content":[{"type":"text","text":"one"}]}}"""
    val delta2 = """{"state":"delta","runId":"r1","sessionKey":"main","message":{"role":"assistant","content":[{"type":"text","text":"two"}]}}"""
    val final = """{"state":"final","runId":"r1","sessionKey":"main"}"""

    queue.emit("chat", delta1)
    queue.emit("chat", delta2)
    queue.emit("chat", final)

    scope.runCurrent()
    scope.advanceUntilIdle()

    assertEquals(listOf(GatewayEvent("chat", final)), events)
  }

  @Test
  fun `preserves terminal events under overflow`() = runTest {
    val scope = TestScope(StandardTestDispatcher(testScheduler))
    val queue = GatewayEventQueue(scope = scope, json = json, maxQueueSize = 2)
    val events = mutableListOf<GatewayEvent>()

    scope.launch { queue.events.collect { events += it } }
    scope.runCurrent()

    queue.emit("health", """{"ok":true}""")
    queue.emit("tick", null)
    queue.emit("chat", """{"state":"delta","runId":"r1","sessionKey":"main","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}""")
    val final = """{"state":"final","runId":"r1","sessionKey":"main"}"""
    queue.emit("chat", final)

    scope.runCurrent()
    scope.advanceUntilIdle()

    assertTrue(events.any { it == GatewayEvent("chat", final) })
  }

  @Test
  fun `delivers queued events after a collector attaches`() = runTest {
    val scope = TestScope(StandardTestDispatcher(testScheduler))
    val queue = GatewayEventQueue(scope = scope, json = json, maxQueueSize = 10)

    val mainSessionKey = GatewayEvent("mainSessionKey", "\"main-forwarded\"")
    val final = GatewayEvent("chat", """{"state":"final","runId":"r1","sessionKey":"main-forwarded"}""")

    queue.emit(mainSessionKey)
    queue.emit(final)

    scope.runCurrent()
    scope.advanceUntilIdle()

    val events = mutableListOf<GatewayEvent>()
    scope.launch {
      queue.events.take(2).collect { events += it }
    }

    scope.runCurrent()
    scope.advanceUntilIdle()

    assertEquals(listOf(mainSessionKey, final), events)
  }
}
