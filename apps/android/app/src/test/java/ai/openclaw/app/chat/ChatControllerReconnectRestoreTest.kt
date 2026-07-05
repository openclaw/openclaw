package ai.openclaw.app.chat

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Reconnect recovery scenarios: after a gateway disconnect, the next health event
 * refetches chat.history and re-adopts the run the gateway still reports in flight
 * (`inFlightRun`), matching the reconnect snapshot contract the TUI consumes.
 */
class ChatControllerReconnectRestoreTest {
  private val json = Json { ignoreUnknownKeys = true }

  private fun TestScope.newController(gateway: ScriptedGateway): ChatController =
    ChatController(scope = this, json = json, requestGateway = gateway::request)

  private val userTurn = ReplayHistoryMessage("user", "keep working", 1_000)

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun reconnectAdoptsInFlightRunAndConsumesLiveEvents() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith("chat.history", historyResponse("session-1", listOf(userTurn)))
      val controller = newController(gateway)
      controller.load("main")
      runCurrent()
      assertEquals(0, controller.pendingRunCount.value)

      controller.onDisconnected("Reconnecting…")
      gateway.respondWith(
        "chat.history",
        historyResponse("session-1", listOf(userTurn), inFlightRun = "run-active" to "partial reply"),
      )
      controller.handleGatewayEvent("health", null)
      runCurrent()

      assertEquals(1, controller.pendingRunCount.value)
      assertEquals("partial reply", controller.streamingAssistantText.value)
      assertEquals(1, controller.messages.value.size)

      // The adopted run keeps consuming live deltas and its terminal event.
      controller.handleGatewayEvent(
        "chat",
        chatDeltaPayload("main", "run-active", 5, " more", "partial reply more"),
      )
      assertEquals("partial reply more", controller.streamingAssistantText.value)
      gateway.respondWith(
        "chat.history",
        historyResponse(
          "session-1",
          listOf(userTurn, ReplayHistoryMessage("assistant", "partial reply more", 2_000)),
        ),
      )
      controller.handleGatewayEvent("chat", chatTerminalPayload("main", "run-active", seq = 6))
      runCurrent()

      assertEquals(0, controller.pendingRunCount.value)
      assertNull(controller.streamingAssistantText.value)
      assertEquals(2, controller.messages.value.size)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun reconnectWithoutInFlightRunStaysClean() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith("chat.history", historyResponse("session-1", listOf(userTurn)))
      val controller = newController(gateway)
      controller.load("main")
      runCurrent()
      val historyCallsAfterLoad = gateway.callCount("chat.history")

      controller.onDisconnected("Offline")
      controller.handleGatewayEvent("health", null)
      runCurrent()

      // Reconnect refetched history once and restored nothing.
      assertEquals(historyCallsAfterLoad + 1, gateway.callCount("chat.history"))
      assertEquals(0, controller.pendingRunCount.value)
      assertNull(controller.streamingAssistantText.value)
      assertNull(controller.errorText.value)
      assertTrue(controller.healthOk.value)
      assertEquals(1, controller.messages.value.size)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun repeatedReconnectsDoNotDuplicateRunOrRows() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith(
        "chat.history",
        historyResponse("session-1", listOf(userTurn), inFlightRun = "run-active" to "partial"),
      )
      val controller = newController(gateway)
      controller.load("main")
      runCurrent()
      assertEquals(1, controller.pendingRunCount.value)

      repeat(2) {
        controller.onDisconnected("Reconnecting…")
        assertEquals(0, controller.pendingRunCount.value)
        controller.handleGatewayEvent("health", null)
        runCurrent()
      }

      assertEquals(1, controller.pendingRunCount.value)
      assertEquals("partial", controller.streamingAssistantText.value)
      assertEquals(1, controller.messages.value.size)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun staleSnapshotRunDoesNotReplaceLocallyOwnedSend() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith("chat.history", historyResponse("session-1", emptyList()))
      gateway.respondChatSend(status = "started")
      val controller = newController(gateway)
      controller.load("main")
      runCurrent()

      // Reconnect arms a recovery refresh, then a send lands before it executes.
      controller.onDisconnected("Reconnecting…")
      gateway.respondWith(
        "chat.history",
        historyResponse("session-1", emptyList(), inFlightRun = "run-stale" to "old text"),
      )
      controller.handleGatewayEvent("health", null)
      assertTrue(controller.sendMessageAwaitAcceptance("new work", "off", emptyList()))
      val localRunId = requireNotNull(gateway.lastRunId)
      runCurrent()

      assertEquals(1, controller.pendingRunCount.value)
      controller.handleGatewayEvent(
        "chat",
        chatDeltaPayload("main", localRunId, 1, "ours", "ours"),
      )
      assertEquals("ours", controller.streamingAssistantText.value)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun seqGapRefetchesHistoryAndRestoresInFlightRun() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith(
        "chat.history",
        historyResponse("session-1", listOf(userTurn), inFlightRun = "run-active" to "still going"),
      )
      val controller = newController(gateway)
      controller.load("main")
      runCurrent()
      assertEquals(1, controller.pendingRunCount.value)

      controller.handleGatewayEvent("seqGap", null)
      runCurrent()

      assertEquals(1, controller.pendingRunCount.value)
      assertEquals("still going", controller.streamingAssistantText.value)
      assertNull(controller.errorText.value)
      assertEquals(1, controller.messages.value.size)
    }
}
