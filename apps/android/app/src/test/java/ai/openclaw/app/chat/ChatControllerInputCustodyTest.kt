package ai.openclaw.app.chat

import ai.openclaw.app.gateway.GatewayRequestOutcomeUnknown
import ai.openclaw.app.ui.chat.outboxItemsForSession
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** Real controller + Room; only the Gateway I/O is synthetic. No provider/device proof. */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class ChatControllerInputCustodyTest {
  private val json = Json { ignoreUnknownKeys = true }

  private inner class Fixture(
    test: TestScope,
    var custody: Boolean = true,
  ) {
    val outbox = RoomChatCommandOutbox(test.createChatOutboxDatabase())
    var gatewayScope = ChatCacheScope("gateway-test", 1L)
    val requests = mutableListOf<Pair<String, JsonObject>>()
    var response: (JsonObject) -> String = { history() }
    var historyGate: CompletableDeferred<Unit>? = null
    var sendFailure: Throwable? = null
    var ackRunId = "execution-alias"
    val controller =
      ChatController(
        scope = test.backgroundScope,
        json = json,
        commandOutbox = outbox,
        cacheScope = { gatewayScope },
        gatewayAdvertisesCapability = { it == "chat-input-custody-v1" && custody },
        requestGateway = { method, params ->
          val input = params?.let { json.parseToJsonElement(it) as JsonObject } ?: JsonObject(emptyMap())
          requests += method to input
          when (method) {
            "chat.history" -> {
              val captured = response(input)
              historyGate?.await()
              captured
            }

            "chat.send" -> {
              sendFailure?.let { throw it }
              """{"runId":"$ackRunId","status":"started"}"""
            }

            else -> {
              emptyChatGatewayResponse(method)
            }
          }
        },
      )

    suspend fun seed(
      id: String,
      status: ChatOutboxStatus,
      session: String = "agent:main:queue",
      owner: String = "main",
    ) {
      val result = outbox.enqueue("gateway-test", session, "same text", "off", System.currentTimeMillis(), ownerAgentId = owner, idempotencyKey = id)
      val row = (result as ChatOutboxEnqueueResult.Queued).item
      if (status != ChatOutboxStatus.Queued) {
        outbox.updateStatusIfAttempt(row.id, row.attemptVersion, status, 0, if (status == ChatOutboxStatus.Failed) OUTBOX_DELIVERY_UNCONFIRMED_ERROR else null)
      }
    }

    fun open() = controller.load("agent:main:queue")

    fun sendCount() = requests.count { it.first == "chat.send" }

    fun queriedIds(): List<String> =
      requests.filter { it.first == "chat.history" }.flatMap { (_, params) ->
        (params["inputRunIds"] as? JsonArray).orEmpty().map { (it as JsonPrimitive).content }
      }
  }

  private fun history(
    extra: String = "",
    sessionId: String = "physical-1",
    messages: String = "[]",
  ): String = """{"sessionId":"$sessionId","messages":$messages$extra}"""

  private fun page(
    items: String,
    count: Int = 2,
    tail: String = "",
    queuedCount: Int = count,
  ): String = """, "pendingInputs":{"items":[$items],"total":$count,"queuedCount":$queuedCount$tail}"""

  private fun input(
    id: String,
    at: Int,
    state: String = "queued",
    display: Boolean = true,
  ): String = """{"id":"input-$id","runId":"$id","acceptedAt":$at,"state":"$state","queued":${state == "queued"},"message":{"role":"user","content":"same text","display":$display}}"""

  @Test
  fun serverInputsRetainDistinctIdentitiesAndHiddenCancellationRetiresLocalCopy() =
    runTest {
      val f = Fixture(this)
      f.seed("cancelled", ChatOutboxStatus.Failed)
      f.response = { history(page(listOf(input("browser-a", 10), input("browser-b", 20), input("cancelled", 30, "cancelled", false)).joinToString(","), count = 3, queuedCount = 2)) }
      f.open()
      runCurrent()
      val view = requireNotNull(f.controller.pendingInputs.value)
      assertEquals(listOf("browser-a", "browser-b", "cancelled"), view.page.items.map { it.runId })
      assertNull(
        view.page.items
          .last()
          .message,
      )
      assertEquals(listOf(10L, 20L, 30L), view.page.items.map { it.acceptedAtMs })
      f.response = {
        history(
          page(input("browser-a", 10) + "," + input("browser-b", 20)),
          messages = """[{"role":"user","content":"same text","idempotencyKey":"browser-a:user"}]""",
        )
      }
      f.controller.refresh()
      runCurrent()
      assertEquals(
        listOf("browser-b"),
        f.controller.pendingInputs.value
          ?.page
          ?.items
          ?.map { it.runId },
      )
      assertTrue(f.outbox.load("gateway-test").isEmpty())
      assertEquals(0, f.sendCount())
    }

  @Test
  fun pendingNonqueuedReceiptKeepsPostAckStreamingOwnership() =
    runTest {
      val f = Fixture(this)
      f.open()
      runCurrent()
      f.response = {
        history(
          """, "inputReceipts":[{"runId":"original","state":"pending"}],
          "inFlightRun":{"runId":"execution-alias","text":""}""",
        )
      }
      f.controller.sendMessageAwaitAcceptance("same text", "off", emptyList(), idempotencyKey = "original")
      runCurrent()
      f.controller.handleGatewayEvent(
        "chat",
        """{"sessionKey":"agent:main:queue","runId":"execution-alias","state":"delta","message":{"role":"assistant","content":[{"type":"text","text":"Still streaming"}]}}""",
      )
      assertEquals("Still streaming", f.controller.streamingAssistantText.value)
      f.controller.handleGatewayEvent(
        "agent",
        """{"sessionKey":"agent:main:queue","runId":"execution-alias","stream":"tool","data":{"phase":"start","toolCallId":"tool-1","name":"read"}}""",
      )
      assertEquals(
        "tool-1",
        f.controller.pendingToolCalls.value
          .single()
          .toolCallId,
      )
      assertEquals(
        ChatOutboxStatus.Accepted,
        f.outbox
          .load("gateway-test")
          .single()
          .status,
      )
      assertEquals(1, f.sendCount())
    }

  @Test
  fun visibleCancellationReceiptRetiresOnlyLocalCopy() =
    runTest {
      val f = Fixture(this)
      f.seed("cancelled", ChatOutboxStatus.Accepted)
      f.response = {
        history(page(input("cancelled", 10, "cancelled"), 1, queuedCount = 0) + """, "inputReceipts":[{"runId":"cancelled","state":"pending","cancelled":true}]""")
      }
      f.open()
      runCurrent()
      assertTrue(f.outbox.load("gateway-test").isEmpty())
      val cancelled = requireNotNull(f.controller.pendingInputs.value).page.items.single()
      assertEquals("cancelled", cancelled.state)
      assertEquals(
        "same text",
        cancelled.message
          ?.content
          ?.single()
          ?.text,
      )
      f.controller.refresh()
      runCurrent()
      assertEquals(
        listOf(cancelled),
        f.controller.pendingInputs.value
          ?.page
          ?.items,
      )
      assertEquals(0, f.sendCount())
    }

  @Test
  fun exactConsumedReceiptRetiresOriginalIdButNeverSameTextOrAckAlias() =
    runTest {
      val f = Fixture(this)
      f.open()
      runCurrent()
      assertTrue(f.controller.sendMessageAwaitAcceptance("same text", "off", emptyList(), idempotencyKey = "original"))
      runCurrent()
      f.response = {
        history(
          """, "inputReceipts":[{"runId":"execution-alias","state":"consumed","consumedByEventId":"aggregate"}]""",
          messages = """[{"role":"user","content":"same text","idempotencyKey":"someone-else:user"}]""",
        )
      }
      f.controller.refresh()
      runCurrent()
      assertEquals(
        "original",
        f.outbox
          .load("gateway-test")
          .single()
          .id,
      )
      assertTrue("original" in f.queriedIds())
      assertFalse("execution-alias" in f.queriedIds())
      f.response = { history(""", "inputReceipts":[{"runId":"original","state":"consumed","consumedByEventId":"aggregate"}]""") }
      f.controller.refresh()
      runCurrent()
      assertTrue(f.outbox.load("gateway-test").isEmpty())
      assertTrue(
        f.controller.messages.value
          .isEmpty(),
      )
      assertEquals(1, f.sendCount())
    }

  @Test
  fun lostAckAndRestartRecoverOriginalSubmissionWithoutAnotherSend() =
    runTest {
      val f = Fixture(this)
      f.open()
      runCurrent()
      f.sendFailure = GatewayRequestOutcomeUnknown("ACK lost")
      f.controller.sendMessageAwaitAcceptance("same text", "off", emptyList(), idempotencyKey = "lost-ack")
      runCurrent()
      f.controller.onDisconnected("offline")
      f.gatewayScope = f.gatewayScope.copy(connectionGeneration = 2)
      f.response = { history(page(input("lost-ack", 10), 1) + """, "inputReceipts":[{"runId":"lost-ack","state":"pending","queued":true}]""") }
      f.controller.onGatewayConnected()
      runCurrent()
      assertEquals(
        ChatOutboxStatus.Accepted,
        f.outbox
          .load("gateway-test")
          .single()
          .status,
      )
      assertTrue("lost-ack" in f.queriedIds())
      assertEquals(1, f.sendCount())
      assertTrue(
        f.controller.messages.value
          .isEmpty(),
      )
      assertTrue(
        outboxItemsForSession(
          items = f.controller.outboxItems.value,
          sessionKey = "agent:main:queue",
          mainSessionKey = "main",
          ownerAgentId = "main",
          messages = f.controller.messages.value,
          serverInputRunIds =
            requireNotNull(f.controller.pendingInputs.value)
              .page.items
              .mapNotNull { it.runId }
              .toSet(),
        ).isEmpty(),
      )

      // The same production restart sweep handles a process that died before saving the ACK.
      f.seed("crash-left", ChatOutboxStatus.Sending)
      f.outbox.failSendingAfterRestart()
      f.response = { history(""", "inputReceipts":[{"runId":"crash-left","state":"pending"},{"runId":"lost-ack","state":"consumed","consumedByEventId":"aggregate"}]""") }
      f.controller.refresh()
      runCurrent()
      assertEquals(
        "crash-left",
        f.outbox
          .load("gateway-test")
          .single()
          .id,
      )
      assertEquals(
        ChatOutboxStatus.Accepted,
        f.outbox
          .load("gateway-test")
          .single()
          .status,
      )
      assertEquals(1, f.sendCount())
    }

  @Test
  fun consumedHeadReleasesQueuedSuccessorWithoutReplayingOriginal() =
    runTest {
      val f = Fixture(this)
      f.seed("accepted-head", ChatOutboxStatus.Accepted)
      f.seed("successor", ChatOutboxStatus.Queued)
      f.open()
      runCurrent()
      assertEquals(0, f.sendCount())
      f.response = {
        history(""", "inputReceipts":[{"runId":"accepted-head","state":"consumed","consumedByEventId":"combined-event"}]""")
      }
      f.controller.refresh()
      runCurrent()
      advanceTimeBy(751)
      runCurrent()
      assertEquals(listOf("successor"), f.requests.filter { it.first == "chat.send" }.map { (_, p) -> (p.getValue("idempotencyKey") as JsonPrimitive).content })
      assertEquals(
        "successor",
        f.outbox
          .load("gateway-test")
          .single()
          .id,
      )
      assertEquals(
        ChatOutboxStatus.Accepted,
        f.outbox
          .load("gateway-test")
          .single()
          .status,
      )
    }

  @Test
  fun missingReceiptsPreserveUncertaintyWhileLegacyGatewayKeepsIdleFallback() =
    runTest {
      for (supported in listOf(true, false)) {
        val f = Fixture(this, custody = supported)
        f.seed("uncertain", ChatOutboxStatus.Accepted)
        f.open()
        runCurrent()
        advanceTimeBy(751)
        runCurrent()
        f.controller.refresh()
        runCurrent()
        assertEquals(
          if (supported) ChatOutboxStatus.Accepted else ChatOutboxStatus.Failed,
          f.outbox
            .load("gateway-test")
            .single()
            .status,
        )
        assertEquals(supported, "uncertain" in f.queriedIds())
        assertEquals(0, f.sendCount())
      }
    }

  @Test
  fun omittedPagePreservesSamePhysicalSessionButSwitchAndDisconnectDropStaleResults() =
    runTest {
      val f = Fixture(this)
      f.response = { history(page(input("old", 10), 1)) }
      f.open()
      runCurrent()
      f.response = { history() }
      f.controller.refresh()
      runCurrent()
      assertEquals(
        "old",
        f.controller.pendingInputs.value
          ?.page
          ?.items
          ?.single()
          ?.runId,
      )
      f.response = { history(sessionId = "physical-2") }
      f.controller.refresh()
      runCurrent()
      assertNull(f.controller.pendingInputs.value)

      val gate = CompletableDeferred<Unit>()
      f.historyGate = gate
      f.response = { history(page(input("stale", 10), 1)) }
      f.controller.refresh()
      runCurrent()
      f.controller.switchSession("agent:other:queue", "other")
      f.historyGate = null
      f.response = { history(sessionId = "other-physical") }
      runCurrent()
      gate.complete(Unit)
      runCurrent()
      assertNull(f.controller.pendingInputs.value)
      f.controller.onDisconnected("offline")
      assertNull(f.controller.pendingInputs.value)
    }

  @Test
  fun disconnectedHistoryCannotConsumeOriginalOutboxOrLeakAcrossGatewayAndAgent() =
    runTest {
      val f = Fixture(this)
      f.seed("local", ChatOutboxStatus.Failed)
      f.seed("other-agent", ChatOutboxStatus.Failed, session = "global", owner = "other")
      f.response = { history() }
      f.open()
      runCurrent()
      assertFalse("other-agent" in f.queriedIds())
      val gate = CompletableDeferred<Unit>()
      f.historyGate = gate
      f.response = { history(page(input("old-gateway", 10), 1) + """, "inputReceipts":[{"runId":"local","state":"consumed","consumedByEventId":"event"}]""") }
      f.controller.refresh()
      runCurrent()
      f.controller.onDisconnected("offline")
      f.controller.onGatewayScopeChanging(retireRunState = true)
      f.gatewayScope = ChatCacheScope("other-gateway", 2)
      f.historyGate = null
      f.response = { history(sessionId = "other-physical") }
      f.controller.load("agent:other:queue", "other")
      runCurrent()
      gate.complete(Unit)
      runCurrent()
      assertEquals(
        setOf("local", "other-agent"),
        f.outbox
          .load("gateway-test")
          .map { it.id }
          .toSet(),
      )
      assertNull(f.controller.pendingInputs.value)
      assertEquals(0, f.sendCount())
    }

  @Test
  fun newerCustodyEventReadWinsWithoutRetiringSameOwnerHistory() =
    runTest {
      val f = Fixture(this)
      f.response = { history(page(input("initial", 10), 1)) }
      f.open()
      runCurrent()
      val selection = f.controller.selectionGeneration.value
      val olderRead = CompletableDeferred<Unit>()
      f.historyGate = olderRead
      f.response = { history(page(input("stale", 20), 1)) }
      f.controller.handleGatewayEvent("sessions.changed", """{"sessionKey":"agent:main:queue","reason":"send"}""")
      runCurrent()
      assertEquals(
        "initial",
        f.controller.pendingInputs.value
          ?.page
          ?.items
          ?.single()
          ?.runId,
      )
      val readsBeforeRemount = f.requests.count { it.first == "chat.history" }
      f.controller.load("agent:main:queue")
      runCurrent()
      assertEquals(readsBeforeRemount, f.requests.count { it.first == "chat.history" })
      f.historyGate = null
      f.response = { history(page(input("latest", 30), 1)) }
      f.controller.handleGatewayEvent("sessions.changed", """{"sessionKey":"agent:main:queue","reason":"agent.input.settled"}""")
      runCurrent()
      assertEquals(
        "latest",
        f.controller.pendingInputs.value
          ?.page
          ?.items
          ?.single()
          ?.runId,
      )
      olderRead.complete(Unit)
      runCurrent()
      assertEquals(
        "latest",
        f.controller.pendingInputs.value
          ?.page
          ?.items
          ?.single()
          ?.runId,
      )
      assertEquals(selection, f.controller.selectionGeneration.value)
      assertEquals(0, f.sendCount())
    }

  @Test
  fun custodyChangeEventRefreshesAndReceiptRequestsStayWithinFiftyOriginalIds() =
    runTest {
      val f = Fixture(this)
      repeat(50) { f.seed("original-$it", ChatOutboxStatus.Failed) }
      f.open()
      runCurrent()
      assertEquals((0 until 50).map { "original-$it" }.toSet(), f.queriedIds().toSet())
      assertTrue(f.requests.filter { it.first == "chat.history" }.all { (_, p) -> (p["inputRunIds"] as? JsonArray).orEmpty().size <= 50 })
      f.response = { history(page(input("remote", 10), 1, """, "nextBefore":21""")) }
      f.controller.handleGatewayEvent("sessions.changed", """{"sessionKey":"agent:main:queue","agentId":"main","reason":"send"}""")
      runCurrent()
      assertEquals(
        "remote",
        f.controller.pendingInputs.value
          ?.page
          ?.items
          ?.single()
          ?.runId,
      )
      assertEquals(
        21L,
        f.controller.pendingInputs.value
          ?.page
          ?.nextBefore,
      )
      assertEquals(0, f.sendCount())
    }
}
