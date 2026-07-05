package ai.openclaw.app.chat

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Deterministic streaming replay scenarios: a ScriptedGateway replays scripted
 * chat.event/chat.history sequences into ChatController under virtual time.
 */
class ChatControllerStreamReplayTest {
  private val json = Json { ignoreUnknownKeys = true }

  private fun TestScope.newController(gateway: ScriptedGateway): ChatController =
    ChatController(scope = this, json = json, requestGateway = gateway::request)

  private fun transcript(controller: ChatController): List<Pair<String, String?>> =
    controller.messages.value.map { message ->
      message.role to message.content.firstOrNull { it.type == "text" }?.text
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun cleanRunStreamsThenConvergesToHistoryWithoutDuplicates() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondChatSend(status = "started")
      val controller = newController(gateway)
      controller.handleGatewayEvent("health", null)

      assertTrue(controller.sendMessageAwaitAcceptance("Hello there", "off", emptyList()))
      val runId = requireNotNull(gateway.lastRunId)
      assertEquals(1, controller.pendingRunCount.value)
      val optimisticUserId = controller.messages.value.single { it.role == "user" }.id

      controller.handleGatewayEvent("chat", chatDeltaPayload("main", runId, "Str"))
      assertEquals("Str", controller.streamingAssistantText.value)
      controller.handleGatewayEvent("chat", chatDeltaPayload("main", runId, "Streamed reply."))
      assertEquals("Streamed reply.", controller.streamingAssistantText.value)

      gateway.respondWith(
        "chat.history",
        historyResponse(
          sessionId = "session-1",
          messages =
            listOf(
              ReplayHistoryMessage("user", "Hello there", 1_000, idempotencyKey = "$runId:user"),
              ReplayHistoryMessage("assistant", "Streamed reply.", 2_000),
            ),
        ),
      )
      controller.handleGatewayEvent("chat", chatTerminalPayload("main", runId))
      advanceUntilIdle()

      assertEquals(
        listOf("user" to "Hello there", "assistant" to "Streamed reply."),
        transcript(controller),
      )
      // Gateway copy replaces the optimistic echo in place: same row identity, no duplicate.
      assertEquals(optimisticUserId, controller.messages.value.single { it.role == "user" }.id)
      assertEquals(0, controller.pendingRunCount.value)
      assertNull(controller.streamingAssistantText.value)
      assertNull(controller.errorText.value)
      assertEquals("session-1", controller.sessionId.value)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun duplicateDeltaAndTerminalDeliveryProducesNoDuplicateRows() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondChatSend(status = "started")
      val controller = newController(gateway)
      controller.handleGatewayEvent("health", null)

      assertTrue(controller.sendMessageAwaitAcceptance("dedupe me", "off", emptyList()))
      val runId = requireNotNull(gateway.lastRunId)

      val delta = chatDeltaPayload("main", runId, "Only once.")
      controller.handleGatewayEvent("chat", delta)
      controller.handleGatewayEvent("chat", delta)
      assertEquals("Only once.", controller.streamingAssistantText.value)

      gateway.respondWith(
        "chat.history",
        historyResponse(
          sessionId = "session-1",
          messages =
            listOf(
              ReplayHistoryMessage("user", "dedupe me", 1_000, idempotencyKey = "$runId:user"),
              ReplayHistoryMessage("assistant", "Only once.", 2_000),
            ),
        ),
      )
      val terminal = chatTerminalPayload("main", runId)
      controller.handleGatewayEvent("chat", terminal)
      advanceUntilIdle()
      val idsAfterFirstTerminal = controller.messages.value.map { it.id }

      // Redelivered terminal event triggers a second history refresh with the same payload.
      controller.handleGatewayEvent("chat", terminal)
      advanceUntilIdle()

      assertEquals(2, gateway.callCount("chat.history"))
      assertEquals(
        listOf("user" to "dedupe me", "assistant" to "Only once."),
        transcript(controller),
      )
      // Row identities stay stable across the duplicate refresh.
      assertEquals(idsAfterFirstTerminal, controller.messages.value.map { it.id })
      assertEquals(0, controller.pendingRunCount.value)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun optimisticAckTimeoutDiscardsUserEchoUnderVirtualTime() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondChatSend(status = "started")
      val controller = newController(gateway)
      controller.handleGatewayEvent("health", null)

      assertTrue(controller.sendMessageAwaitAcceptance("never answered", "off", emptyList()))
      assertEquals(1, controller.pendingRunCount.value)

      // One virtual millisecond before the 120s ack deadline nothing changes.
      advanceTimeBy(119_999)
      runCurrent()
      assertEquals(1, controller.pendingRunCount.value)
      assertTrue(transcript(controller).contains("user" to "never answered"))
      assertNull(controller.errorText.value)

      advanceTimeBy(1)
      runCurrent()
      assertEquals(0, controller.pendingRunCount.value)
      assertFalse(transcript(controller).contains("user" to "never answered"))
      assertEquals("Timed out waiting for a reply; try again or refresh.", controller.errorText.value)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun reconnectMidRunClearsTransientStateAndHistoryConverges() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondChatSend(status = "started")
      val controller = newController(gateway)
      controller.handleGatewayEvent("health", null)

      assertTrue(controller.sendMessageAwaitAcceptance("survive reconnect", "off", emptyList()))
      val runId = requireNotNull(gateway.lastRunId)
      val optimisticUserId = controller.messages.value.single { it.role == "user" }.id

      controller.handleGatewayEvent("chat", chatDeltaPayload("main", runId, "partial ans"))
      controller.handleGatewayEvent(
        "agent",
        """{"sessionKey":"main","ts":10,"stream":"tool","data":{"phase":"start","name":"exec","toolCallId":"tool-1"}}""",
      )
      assertEquals("partial ans", controller.streamingAssistantText.value)
      assertEquals(1, controller.pendingToolCalls.value.size)

      controller.onDisconnected("connection lost")
      assertNull(controller.streamingAssistantText.value)
      assertEquals(0, controller.pendingRunCount.value)
      assertTrue(controller.pendingToolCalls.value.isEmpty())
      assertNull(controller.sessionId.value)
      assertFalse(controller.healthOk.value)
      // The local echo stays rendered until the next history load resolves it.
      assertTrue(transcript(controller).contains("user" to "survive reconnect"))

      controller.handleGatewayEvent("health", null)
      gateway.respondWith(
        "chat.history",
        historyResponse(
          sessionId = "session-1",
          messages =
            listOf(
              ReplayHistoryMessage("user", "survive reconnect", 1_000, idempotencyKey = "$runId:user"),
              ReplayHistoryMessage("assistant", "Recovered reply.", 2_000),
            ),
        ),
      )
      controller.refresh()
      advanceUntilIdle()

      assertEquals(
        listOf("user" to "survive reconnect", "assistant" to "Recovered reply."),
        transcript(controller),
      )
      assertEquals(optimisticUserId, controller.messages.value.single { it.role == "user" }.id)
      assertEquals("session-1", controller.sessionId.value)

      // Disconnect cancelled the 120s ack timer: the converged transcript must not decay.
      advanceTimeBy(120_000)
      runCurrent()
      assertNull(controller.errorText.value)
      assertEquals(2, controller.messages.value.size)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun staleHistoryResponseIsDroppedByGenerationTracking() =
    runTest {
      val gateway = ScriptedGateway(json)
      val controller = newController(gateway)

      gateway.respondWith(
        "chat.history",
        historyResponse(
          sessionId = "session-main",
          messages = listOf(ReplayHistoryMessage("assistant", "main transcript", 1_000)),
        ),
      )
      controller.load("main")
      advanceUntilIdle()
      assertEquals(listOf("assistant" to "main transcript"), transcript(controller))

      // Gate the next "main" history fetch so its response arrives after a session switch.
      val staleMainGate = CompletableDeferred<Unit>()
      gateway.respond("chat.history") { paramsJson ->
        when (gateway.sessionKeyOf(paramsJson)) {
          "other" ->
            historyResponse(
              sessionId = "session-other",
              messages = listOf(ReplayHistoryMessage("assistant", "other transcript", 3_000)),
            )
          else -> {
            staleMainGate.await()
            historyResponse(
              sessionId = "session-main",
              messages = listOf(ReplayHistoryMessage("assistant", "stale main row", 9_000)),
            )
          }
        }
      }

      controller.handleGatewayEvent("chat", chatTerminalPayload("main", runId = null))
      runCurrent() // history refetch for "main" is now suspended on the gate

      controller.switchSession("other")
      advanceUntilIdle()
      assertEquals(listOf("assistant" to "other transcript"), transcript(controller))
      assertEquals("session-other", controller.sessionId.value)

      staleMainGate.complete(Unit)
      advanceUntilIdle()

      // The stale "main" response resolved after the switch and must be dropped.
      assertEquals(listOf("assistant" to "other transcript"), transcript(controller))
      assertEquals("session-other", controller.sessionId.value)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun markdownFixtureStreamsByteIdenticalAndConvergesLosslessly() =
    runTest {
      val fixture =
        checkNotNull(javaClass.getResourceAsStream("/chat/markdown_stream_fixture.md")) {
          "missing markdown stream fixture resource"
        }.readBytes().toString(Charsets.UTF_8)
      val fixtureBytes = fixture.toByteArray(Charsets.UTF_8)

      val gateway = ScriptedGateway(json)
      gateway.respondChatSend(status = "started")
      val controller = newController(gateway)
      controller.handleGatewayEvent("health", null)

      assertTrue(controller.sendMessageAwaitAcceptance("render markdown shapes", "off", emptyList()))
      val runId = requireNotNull(gateway.lastRunId)

      // Odd chunk size on purpose so boundaries fall inside words, escapes, and emoji.
      val chunks = chunkPreservingCodePoints(fixture, chunkSize = 47)
      assertTrue("fixture should stream in many chunks", chunks.size > 10)
      var accumulated = ""
      for (chunk in chunks) {
        accumulated += chunk
        controller.handleGatewayEvent("chat", chatDeltaPayload("main", runId, accumulated))
        assertEquals(accumulated, controller.streamingAssistantText.value)
      }

      val streamed = requireNotNull(controller.streamingAssistantText.value)
      assertArrayEquals(fixtureBytes, streamed.toByteArray(Charsets.UTF_8))

      gateway.respondWith(
        "chat.history",
        historyResponse(
          sessionId = "session-md",
          messages =
            listOf(
              ReplayHistoryMessage("user", "render markdown shapes", 1_000, idempotencyKey = "$runId:user"),
              ReplayHistoryMessage("assistant", fixture, 2_000),
            ),
        ),
      )
      controller.handleGatewayEvent("chat", chatTerminalPayload("main", runId))
      advanceUntilIdle()

      val confirmed =
        controller.messages.value
          .single { it.role == "assistant" }
          .content
          .single { it.type == "text" }
          .text
      assertArrayEquals(fixtureBytes, requireNotNull(confirmed).toByteArray(Charsets.UTF_8))
      assertNull(controller.streamingAssistantText.value)
      assertEquals(0, controller.pendingRunCount.value)
    }
}
