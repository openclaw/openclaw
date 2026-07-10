package ai.openclaw.app.chat

import ai.openclaw.app.gateway.GatewayRequestNotEnqueued
import ai.openclaw.app.gateway.GatewayRequestOutcomeUnknown
import ai.openclaw.app.gateway.GatewayRequestRejected
import ai.openclaw.app.gateway.GatewaySession
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.UUID

@OptIn(ExperimentalCoroutinesApi::class)
class ChatControllerOutboxTest {
  private val json = Json { ignoreUnknownKeys = true }

  /** In-memory stand-in for the Room outbox; Room persistence itself is covered by [RoomChatCommandOutboxTest]. */
  private class FakeCommandOutbox(
    private val capacity: Int = OUTBOX_MAX_QUEUED,
  ) : ChatCommandOutbox {
    val rows = LinkedHashMap<String, ChatOutboxItem>()
    val gatewayIds = mutableMapOf<String, String>()
    val deletedSessions = mutableListOf<String>()
    var recoveryGate: CompletableDeferred<Unit>? = null
    var recoveryFailure: Throwable? = null
    private var nextCreatedAt = 0L

    fun seed(
      item: ChatOutboxItem,
      gatewayId: String = "gateway-test",
    ) {
      rows[item.id] = item
      gatewayIds[item.id] = gatewayId
      nextCreatedAt = maxOf(nextCreatedAt, item.createdAtMs + 1)
    }

    override suspend fun load(gatewayId: String): List<ChatOutboxItem> = rows.values.filter { gatewayIds[it.id] == gatewayId }.sortedWith(compareBy({ it.createdAtMs }, { it.id }))

    override suspend fun enqueue(
      gatewayId: String,
      sessionKey: String,
      text: String,
      thinkingLevel: String,
      nowMs: Long,
    ): ChatOutboxEnqueueResult {
      if (gatewayIds.values.count { it == gatewayId } >= capacity) return ChatOutboxEnqueueResult.QueueFull
      val createdAt = maxOf(nowMs, nextCreatedAt)
      nextCreatedAt = createdAt + 1
      val item =
        ChatOutboxItem(
          id = UUID.randomUUID().toString(),
          sessionKey = sessionKey,
          text = text,
          thinkingLevel = thinkingLevel,
          createdAtMs = createdAt,
          status = ChatOutboxStatus.Queued,
          retryCount = 0,
          lastError = null,
        )
      rows[item.id] = item
      gatewayIds[item.id] = gatewayId
      return ChatOutboxEnqueueResult.Queued(item)
    }

    override suspend fun updateStatus(
      id: String,
      status: ChatOutboxStatus,
      retryCount: Int,
      lastError: String?,
    ): Int {
      val current = rows[id] ?: return 0
      rows[id] = current.copy(status = status, retryCount = retryCount, lastError = lastError)
      return 1
    }

    override suspend fun requeueForRetry(
      gatewayId: String,
      id: String,
      nowMs: Long,
    ): Int {
      val current = rows[id] ?: return 0
      if (gatewayIds[id] != gatewayId || current.status != ChatOutboxStatus.Failed) return 0
      val createdAt = maxOf(nowMs, nextCreatedAt)
      nextCreatedAt = createdAt + 1
      rows[id] = current.copy(status = ChatOutboxStatus.Queued, retryCount = 0, lastError = null, createdAtMs = createdAt)
      return 1
    }

    override suspend fun delete(id: String) {
      rows.remove(id)
      gatewayIds.remove(id)
    }

    override suspend fun deleteForSession(
      gatewayId: String,
      sessionKey: String,
    ) {
      deletedSessions += sessionKey
      val ids = rows.values.filter { gatewayIds[it.id] == gatewayId && it.sessionKey == sessionKey }.map { it.id }
      ids.forEach {
        rows.remove(it)
        gatewayIds.remove(it)
      }
    }

    override suspend fun clearGateway(gatewayId: String) {
      val ids = gatewayIds.filterValues { it == gatewayId }.keys.toList()
      ids.forEach {
        rows.remove(it)
        gatewayIds.remove(it)
      }
    }

    override suspend fun failSendingAfterRestart() {
      recoveryGate?.await()
      recoveryFailure?.let { throw it }
      for ((id, item) in rows) {
        if (item.status == ChatOutboxStatus.Sending) {
          rows[id] = item.copy(status = ChatOutboxStatus.Failed, lastError = OUTBOX_DELIVERY_UNCONFIRMED_ERROR)
        }
      }
    }

    override suspend fun expireStale(
      gatewayId: String,
      nowMs: Long,
    ) {
      for ((id, item) in rows) {
        if (gatewayIds[id] == gatewayId && item.status == ChatOutboxStatus.Queued && item.createdAtMs <= nowMs - OUTBOX_EXPIRY_MS) {
          rows[id] = item.copy(status = ChatOutboxStatus.Failed, lastError = OUTBOX_EXPIRED_ERROR)
        }
      }
    }
  }

  /** Toggleable gateway seam: records chat.send idempotency keys and echoes them as run ids. */
  private inner class FakeGateway {
    var online = false
    var sendFailureBeforeDispatch: Throwable? = null
    var sendFailureAfterDispatch: Throwable? = null
    var sendResponse: (idempotencyKey: String) -> String = { key -> """{"runId":"$key","status":"started"}""" }
    val sentIdempotencyKeys = mutableListOf<String>()
    val sentMessages = mutableListOf<String>()
    val sentSessionKeys = mutableListOf<String>()
    val sentThinkingLevels = mutableListOf<String>()
    var historyMessagesJson = "[]"
    var metadataModelsJson = "[]"

    suspend fun request(
      method: String,
      paramsJson: String?,
    ): String {
      if (!online) throw IllegalStateException("offline")
      return when (method) {
        "chat.send" -> {
          sendFailureBeforeDispatch?.let { throw it }
          val params = json.parseToJsonElement(paramsJson.orEmpty()) as JsonObject
          val key = (params["idempotencyKey"] as JsonPrimitive).content
          sentIdempotencyKeys += key
          sentMessages += (params["message"] as JsonPrimitive).content
          sentSessionKeys += (params["sessionKey"] as JsonPrimitive).content
          sentThinkingLevels += (params["thinking"] as JsonPrimitive).content
          sendFailureAfterDispatch?.let { throw it }
          sendResponse(key)
        }
        "chat.history" -> """{"sessionId":"session-1","messages":$historyMessagesJson}"""
        "chat.metadata" -> """{"commands":[],"models":$metadataModelsJson}"""
        else -> "{}"
      }
    }
  }

  private fun controller(
    scope: CoroutineScope,
    gateway: FakeGateway,
    outbox: ChatCommandOutbox,
  ): ChatController =
    ChatController(
      scope = scope,
      json = json,
      requestGateway = gateway::request,
      cacheScope = { ChatCacheScope(gatewayId = "gateway-test", connectionGeneration = 1L) },
      commandOutbox = outbox,
    )

  @Test
  fun enqueueWhileOfflineShowsQueuedRowAndSurvivesControllerRecreation() =
    runTest {
      val gateway = FakeGateway()
      val outbox = FakeCommandOutbox()
      val first = controller(this, gateway, outbox)
      first.load("main")
      advanceUntilIdle()
      assertFalse(first.healthOk.value)

      val accepted = first.sendMessageAwaitAcceptance(message = "offline hello", thinkingLevel = "off", attachments = emptyList())

      assertTrue(accepted)
      val queuedRow = first.outboxItems.value.single()
      assertEquals("offline hello", queuedRow.text)
      assertEquals(ChatOutboxStatus.Queued, queuedRow.status)

      // Recreated controller (fresh process analog) republishes the durable row.
      val second = controller(this, gateway, outbox)
      advanceUntilIdle()
      assertEquals(listOf("offline hello"), second.outboxItems.value.map { it.text })
    }

  @Test
  fun offlineAttachmentSendsAreRejectedInsteadOfQueued() =
    runTest {
      val gateway = FakeGateway()
      val outbox = FakeCommandOutbox()
      val chat = controller(this, gateway, outbox)
      chat.load("main")
      advanceUntilIdle()

      val accepted =
        chat.sendMessageAwaitAcceptance(
          message = "with image",
          thinkingLevel = "off",
          attachments = listOf(OutgoingAttachment(type = "image", mimeType = "image/png", fileName = "a.png", base64 = "AAAA")),
        )

      assertFalse(accepted)
      assertEquals("Gateway health not OK; cannot send", chat.errorText.value)
      assertTrue(outbox.rows.isEmpty())
    }

  @Test
  fun reconnectFlushesQueuedCommandsInOrderWithRowIdsAsIdempotencyKeys() =
    runTest {
      val gateway = FakeGateway()
      val outbox = FakeCommandOutbox()
      val chat = controller(this, gateway, outbox)
      chat.load("main")
      advanceUntilIdle()

      chat.sendMessageAwaitAcceptance(message = "one", thinkingLevel = "high", attachments = emptyList())
      chat.sendMessageAwaitAcceptance(message = "two", thinkingLevel = "off", attachments = emptyList())
      chat.sendMessageAwaitAcceptance(message = "three", thinkingLevel = "off", attachments = emptyList())
      val queuedIds = chat.outboxItems.value.map { it.id }
      assertEquals(3, queuedIds.size)
      // A later selector change must not rewrite the thinking level of already-queued sends.
      chat.setThinkingLevel("low")

      gateway.online = true
      chat.handleGatewayEvent("health", null)
      advanceUntilIdle()

      assertEquals(listOf("one", "two", "three"), gateway.sentMessages)
      assertEquals(queuedIds, gateway.sentIdempotencyKeys)
      assertEquals(listOf("main", "main", "main"), gateway.sentSessionKeys)
      assertEquals(listOf("high", "off", "off"), gateway.sentThinkingLevels)
      assertTrue(chat.outboxItems.value.isEmpty())
    }

  @Test
  fun reconnectGatesActiveSessionThinkingAndFailsOpenForOtherSessions() =
    runTest {
      val gateway = FakeGateway()
      val outbox = FakeCommandOutbox()
      val now = System.currentTimeMillis()
      // Gating reads the controller-owned agent-scoped catalog hydrated from chat.metadata,
      // so hydrate first (empty queue) and seed the rows afterwards; the flush loop re-reads
      // the outbox on each health transition.
      gateway.metadataModelsJson =
        """[{"id":"plain","name":"Plain","provider":"openai","available":true,"input":["text"],"reasoning":false}]"""
      val chat = controller(this, gateway, outbox)
      gateway.online = true
      chat.load("main")
      advanceUntilIdle()

      outbox.seed(
        ChatOutboxItem(
          id = "active",
          sessionKey = "main",
          text = "active session",
          thinkingLevel = "high",
          createdAtMs = now,
          status = ChatOutboxStatus.Queued,
          retryCount = 0,
          lastError = null,
        ),
      )
      outbox.seed(
        ChatOutboxItem(
          id = "other",
          sessionKey = "other-session",
          text = "unknown session",
          thinkingLevel = "medium",
          createdAtMs = now + 1,
          status = ChatOutboxStatus.Queued,
          retryCount = 0,
          lastError = null,
        ),
      )
      assertTrue(chat.setSessionModelAwait("main", "openai/plain"))
      // Drop health via a transport failure mid-flush: unlike a disconnect this keeps the
      // hydrated catalog, which is the state where the flush gate has data to act on.
      gateway.sendFailureBeforeDispatch = GatewayRequestNotEnqueued("gateway send failed")
      chat.retryOutboxCommand("active")
      advanceUntilIdle()
      assertFalse(chat.healthOk.value)

      gateway.sendFailureBeforeDispatch = null
      chat.handleGatewayEvent("health", null)
      advanceUntilIdle()

      // retryOutboxCommand refreshes the active row's createdAt, so the untouched
      // unknown-session row flushes first in createdAt order.
      assertEquals(listOf("unknown session", "active session"), gateway.sentMessages)
      assertEquals(listOf("medium", "off"), gateway.sentThinkingLevels)
      assertTrue(chat.outboxItems.value.isEmpty())
    }

  @Test
  fun mainAliasRowsFlushToCanonicalMainSessionAfterHello() =
    runTest {
      val gateway = FakeGateway()
      val outbox = FakeCommandOutbox()
      val chat = controller(this, gateway, outbox)
      chat.load("main")
      advanceUntilIdle()
      chat.sendMessageAwaitAcceptance(message = "queued pre-hello", thinkingLevel = "off", attachments = emptyList())
      val queuedRow = chat.outboxItems.value.single()
      assertEquals("main", queuedRow.sessionKey)

      // Gateway hello announces the canonical main session key, then health recovers.
      gateway.online = true
      chat.applyMainSessionKey("agent:work:main")
      advanceUntilIdle()
      chat.handleGatewayEvent("health", null)
      advanceUntilIdle()

      assertEquals(listOf("agent:work:main"), gateway.sentSessionKeys)
      assertTrue(chat.outboxItems.value.isEmpty())
    }

  @Test
  fun ackRemovesRowAndHistoryCopyIsTheOnlyBubble() =
    runTest {
      val gateway = FakeGateway()
      val outbox = FakeCommandOutbox()
      val chat = controller(this, gateway, outbox)
      chat.load("main")
      advanceUntilIdle()

      chat.sendMessageAwaitAcceptance(message = "queued text", thinkingLevel = "off", attachments = emptyList())
      val queuedRow = chat.outboxItems.value.single()
      val queuedId = queuedRow.id

      // The post-flush history refresh returns the durable copy keyed by the row id.
      gateway.historyMessagesJson =
        """[{ "role": "user", "content": "queued text", "timestamp": 10, "idempotencyKey": "$queuedId" }]"""
      gateway.online = true
      chat.handleGatewayEvent("health", null)
      advanceUntilIdle()

      assertTrue(chat.outboxItems.value.isEmpty())
      val userCopies = chat.messages.value.filter { message -> message.content.any { it.text == "queued text" } }
      assertEquals(1, userCopies.size)
      assertEquals(queuedId, userCopies.single().idempotencyKey)
    }

  @Test
  fun queuedRowsStayWithTheirGatewayAcrossSwitchAndFlushAfterSwitchBack() =
    runTest {
      val gateway = FakeGateway()
      val outbox = FakeCommandOutbox()
      var activeScope = ChatCacheScope(gatewayId = "gateway-a", connectionGeneration = 1L)
      val chat =
        ChatController(
          scope = this,
          json = json,
          requestGateway = gateway::request,
          cacheScope = { activeScope },
          commandOutbox = outbox,
        )
      chat.load("main")
      advanceUntilIdle()
      chat.sendMessageAwaitAcceptance(message = "gateway A queued", thinkingLevel = "off", attachments = emptyList())
      val queuedId =
        chat.outboxItems.value
          .single()
          .id

      activeScope = ChatCacheScope(gatewayId = "gateway-b", connectionGeneration = 2L)
      chat.onGatewayScopeChanging()
      chat.onDisconnected("Offline")
      gateway.online = true
      chat.handleGatewayEvent("health", null)
      advanceUntilIdle()
      assertTrue(gateway.sentMessages.isEmpty())
      assertTrue(chat.outboxItems.value.isEmpty())
      assertEquals(listOf(queuedId), outbox.load("gateway-a").map { it.id })
      assertTrue(outbox.load("gateway-b").isEmpty())

      activeScope = ChatCacheScope(gatewayId = "gateway-a", connectionGeneration = 3L)
      chat.onGatewayScopeChanging()
      chat.onDisconnected("Offline")
      chat.handleGatewayEvent("health", null)
      advanceUntilIdle()
      assertEquals(listOf("gateway A queued"), gateway.sentMessages)
      assertTrue(outbox.load("gateway-a").isEmpty())
    }

  @Test
  fun terminalFailureAcksFailUnconfirmedWithoutReplay() =
    runTest {
      val responses =
        listOf<(String) -> String>(
          { key -> """{"runId":"$key","status":"error"}""" },
          { key -> """{"runId":"$key","status":"timeout"}""" },
          { _ -> """{"status":"error"}""" },
          { _ -> """{"status":"timeout"}""" },
        )

      for ((index, response) in responses.withIndex()) {
        val gateway = FakeGateway()
        val outbox = FakeCommandOutbox()
        val chat = controller(this, gateway, outbox)
        chat.load("main")
        advanceUntilIdle()
        chat.sendMessageAwaitAcceptance(message = "terminal-$index", thinkingLevel = "off", attachments = emptyList())

        gateway.online = true
        gateway.sendResponse = response
        chat.handleGatewayEvent("health", null)
        advanceUntilIdle()

        val failed = chat.outboxItems.value.single()
        assertEquals(ChatOutboxStatus.Failed, failed.status)
        assertEquals(0, failed.retryCount)
        assertEquals(OUTBOX_DELIVERY_UNCONFIRMED_ERROR, failed.lastError)
        assertEquals(1, gateway.sentMessages.size)
        assertFalse(chat.healthOk.value)

        chat.handleGatewayEvent("health", null)
        advanceUntilIdle()
        assertEquals(1, gateway.sentMessages.size)
      }
    }

  @Test
  fun transmittedGatewayRejectionNeverReplaysUntilExplicitRetryAcrossRestart() =
    runTest {
      val gateway = FakeGateway()
      val outbox = FakeCommandOutbox()
      val processJob = SupervisorJob()
      val processScope = CoroutineScope(coroutineContext + processJob)
      val first = controller(processScope, gateway, outbox)
      first.load("main")
      advanceUntilIdle()
      first.sendMessageAwaitAcceptance(message = "manual retry only", thinkingLevel = "off", attachments = emptyList())

      gateway.online = true
      gateway.sendFailureAfterDispatch =
        GatewayRequestRejected(GatewaySession.ErrorShape(code = "UNAVAILABLE", message = "cached run failed"))
      first.handleGatewayEvent("health", null)
      advanceUntilIdle()

      val ambiguous = first.outboxItems.value.single()
      assertEquals(ChatOutboxStatus.Failed, ambiguous.status)
      assertEquals(0, ambiguous.retryCount)
      assertEquals(OUTBOX_DELIVERY_UNCONFIRMED_ERROR, ambiguous.lastError)
      assertEquals(1, gateway.sentMessages.size)
      processJob.cancel()

      gateway.sendFailureAfterDispatch = null
      val restarted = controller(this, gateway, outbox)
      restarted.handleGatewayEvent("health", null)
      advanceUntilIdle()

      assertEquals(1, gateway.sentMessages.size)
      assertEquals(ChatOutboxStatus.Failed, restarted.outboxItems.value.single().status)

      restarted.retryOutboxCommand(ambiguous.id)
      advanceUntilIdle()
      assertEquals(listOf(ambiguous.id, ambiguous.id), gateway.sentIdempotencyKeys)
      assertTrue(restarted.outboxItems.value.isEmpty())
    }

  @Test
  fun notDispatchedKeepsRowQueuedForNextReconnectInsteadOfBurningAttempts() =
    runTest {
      val gateway = FakeGateway()
      val outbox = FakeCommandOutbox()
      val chat = controller(this, gateway, outbox)
      chat.load("main")
      advanceUntilIdle()
      chat.sendMessageAwaitAcceptance(message = "survives drops", thinkingLevel = "off", attachments = emptyList())

      gateway.online = true
      gateway.sendFailureBeforeDispatch = GatewayRequestNotEnqueued("gateway send failed")
      chat.handleGatewayEvent("health", null)
      advanceUntilIdle()

      // The frame never entered the socket queue, so reconnect may retry it automatically.
      val row = chat.outboxItems.value.single()
      assertEquals(ChatOutboxStatus.Queued, row.status)
      assertEquals(0, row.retryCount)
      assertTrue(gateway.sentMessages.isEmpty())
      assertFalse(chat.healthOk.value)

      gateway.sendFailureBeforeDispatch = null
      chat.handleGatewayEvent("health", null)
      advanceUntilIdle()

      assertEquals(listOf("survives drops"), gateway.sentMessages)
      assertTrue(chat.outboxItems.value.isEmpty())
    }

  @Test
  fun droppedAckFailsUnconfirmedAndNeverReplaysUntilExplicitRetry() =
    runTest {
      val gateway = FakeGateway()
      val outbox = FakeCommandOutbox()
      val first = controller(this, gateway, outbox)
      first.load("main")
      advanceUntilIdle()
      first.sendMessageAwaitAcceptance(message = "send once", thinkingLevel = "off", attachments = emptyList())

      gateway.online = true
      gateway.sendFailureAfterDispatch = GatewayRequestOutcomeUnknown("ack lost")
      first.handleGatewayEvent("health", null)
      advanceUntilIdle()

      val ambiguous = first.outboxItems.value.single()
      assertEquals(listOf("send once"), gateway.sentMessages)
      assertFalse(first.healthOk.value)

      gateway.sendFailureAfterDispatch = null
      first.handleGatewayEvent("health", null)
      first.handleGatewayEvent("health", null)
      advanceUntilIdle()
      // Reconnect must not replay an ambiguous row; only the explicit retry below may dispatch it.
      assertEquals(1, gateway.sentMessages.size)
      assertEquals(ChatOutboxStatus.Failed, ambiguous.status)
      assertEquals(0, ambiguous.retryCount)
      assertEquals(OUTBOX_DELIVERY_UNCONFIRMED_ERROR, ambiguous.lastError)

      val restarted = controller(this, gateway, outbox)
      restarted.handleGatewayEvent("health", null)
      advanceUntilIdle()
      assertEquals(1, gateway.sentMessages.size)
      assertEquals(
        ChatOutboxStatus.Failed,
        restarted.outboxItems.value
          .single()
          .status,
      )

      restarted.retryOutboxCommand(ambiguous.id)
      advanceUntilIdle()
      assertEquals(listOf(ambiguous.id, ambiguous.id), gateway.sentIdempotencyKeys)
      assertTrue(restarted.outboxItems.value.isEmpty())
    }

  @Test
  fun runIdOnlyAckRemainsAcceptedForOlderGateways() =
    runTest {
      val gateway = FakeGateway()
      val outbox = FakeCommandOutbox()
      val chat = controller(this, gateway, outbox)
      chat.load("main")
      advanceUntilIdle()
      chat.sendMessageAwaitAcceptance(message = "compatible ack", thinkingLevel = "off", attachments = emptyList())

      gateway.online = true
      gateway.sendResponse = { key -> """{"runId":"$key"}""" }
      chat.handleGatewayEvent("health", null)
      advanceUntilIdle()

      assertEquals(listOf("compatible ack"), gateway.sentMessages)
      assertTrue(chat.outboxItems.value.isEmpty())
    }

  @Test
  fun unknownOrMalformedAckFailsUnconfirmed() =
    runTest {
      val responses =
        listOf<(String) -> String>(
          { key -> """{"runId":"$key","status":"mystery"}""" },
          { _ -> """{"status":"started"}""" },
          { key -> """{"runId":"$key","status":42}""" },
          { key -> """{"runId":"$key","status":null}""" },
          { key -> """{"runId":"$key","status":" "}""" },
          { _ -> "not-json" },
        )

      for ((index, response) in responses.withIndex()) {
        val gateway = FakeGateway()
        val outbox = FakeCommandOutbox()
        val chat = controller(this, gateway, outbox)
        chat.load("main")
        advanceUntilIdle()
        chat.sendMessageAwaitAcceptance(message = "unknown-$index", thinkingLevel = "off", attachments = emptyList())
        gateway.online = true
        gateway.sendResponse = response

        chat.handleGatewayEvent("health", null)
        advanceUntilIdle()

        val failed = chat.outboxItems.value.single()
        assertEquals(ChatOutboxStatus.Failed, failed.status)
        assertEquals(0, failed.retryCount)
        assertEquals(OUTBOX_DELIVERY_UNCONFIRMED_ERROR, failed.lastError)
        assertEquals(1, gateway.sentMessages.size)
        assertFalse(chat.healthOk.value)

        chat.handleGatewayEvent("health", null)
        advanceUntilIdle()
        assertEquals(1, gateway.sentMessages.size)
      }
    }

  @Test
  fun terminalSuccessAckWithoutRunIdRemovesTheRow() =
    runTest {
      val gateway = FakeGateway()
      val outbox = FakeCommandOutbox()
      val chat = controller(this, gateway, outbox)
      chat.load("main")
      advanceUntilIdle()
      chat.sendMessageAwaitAcceptance(message = "completed ack", thinkingLevel = "off", attachments = emptyList())

      gateway.online = true
      gateway.sendResponse = { _ -> """{"status":"ok"}""" }
      chat.handleGatewayEvent("health", null)
      advanceUntilIdle()

      assertEquals(listOf("completed ack"), gateway.sentMessages)
      assertTrue(chat.outboxItems.value.isEmpty())
    }

  @Test
  fun retryResetsFailedRowAndFlushesImmediately() =
    runTest {
      val gateway = FakeGateway()
      val outbox = FakeCommandOutbox()
      outbox.seed(
        ChatOutboxItem(
          id = "failed-row",
          sessionKey = "main",
          text = "try me again",
          thinkingLevel = "off",
          // Recent timestamp: the startup/flush expiry sweep must not expire this row.
          createdAtMs = System.currentTimeMillis(),
          status = ChatOutboxStatus.Failed,
          retryCount = 2,
          lastError = "boom",
        ),
      )
      val chat = controller(this, gateway, outbox)
      gateway.online = true
      chat.load("main")
      advanceUntilIdle()
      assertTrue(chat.healthOk.value)
      val seededRow = chat.outboxItems.value.single()
      assertEquals(ChatOutboxStatus.Failed, seededRow.status)

      chat.retryOutboxCommand("failed-row")
      advanceUntilIdle()

      assertEquals(listOf("failed-row"), gateway.sentIdempotencyKeys)
      assertTrue(chat.outboxItems.value.isEmpty())
    }

  @Test
  fun deleteRemovesQueuedRow() =
    runTest {
      val gateway = FakeGateway()
      val outbox = FakeCommandOutbox()
      val chat = controller(this, gateway, outbox)
      chat.load("main")
      advanceUntilIdle()
      chat.sendMessageAwaitAcceptance(message = "delete me", thinkingLevel = "off", attachments = emptyList())
      val queuedRow = chat.outboxItems.value.single()
      val id = queuedRow.id

      chat.deleteOutboxCommand(id)
      advanceUntilIdle()

      assertTrue(chat.outboxItems.value.isEmpty())
      assertTrue(outbox.rows.isEmpty())
    }

  @Test
  fun queueFullRefusalSurfacesErrorWithoutQueueing() =
    runTest {
      val gateway = FakeGateway()
      val outbox = FakeCommandOutbox(capacity = 1)
      val chat = controller(this, gateway, outbox)
      chat.load("main")
      advanceUntilIdle()
      assertTrue(chat.sendMessageAwaitAcceptance(message = "fits", thinkingLevel = "off", attachments = emptyList()))

      val accepted = chat.sendMessageAwaitAcceptance(message = "overflow", thinkingLevel = "off", attachments = emptyList())

      assertFalse(accepted)
      assertEquals(1, outbox.rows.size)
      val errorText = chat.errorText.value.orEmpty()
      assertTrue(errorText.contains("full"))
    }

  @Test
  fun sendingRowsBecomeDeliveryUnconfirmedOnControllerStartup() =
    runTest {
      val gateway = FakeGateway()
      val outbox = FakeCommandOutbox()
      outbox.seed(
        ChatOutboxItem(
          id = "interrupted",
          sessionKey = "main",
          text = "crashed mid-send",
          thinkingLevel = "off",
          // Recent timestamp: startup recovery must surface this row before any retry decision.
          createdAtMs = System.currentTimeMillis(),
          status = ChatOutboxStatus.Sending,
          retryCount = 1,
          lastError = "socket closed",
        ),
      )

      val chat = controller(this, gateway, outbox)
      advanceUntilIdle()

      val recovered = chat.outboxItems.value.single()
      assertEquals(ChatOutboxStatus.Failed, recovered.status)
      assertEquals(OUTBOX_DELIVERY_UNCONFIRMED_ERROR, recovered.lastError)
      assertEquals(1, recovered.retryCount)
    }

  @Test
  fun startupRecoveryFinishesBeforeAHealthFlushCanClaimQueuedRows() =
    runTest {
      val gateway = FakeGateway()
      val outbox = FakeCommandOutbox()
      val recoveryGate = CompletableDeferred<Unit>()
      outbox.recoveryGate = recoveryGate
      val now = System.currentTimeMillis()
      outbox.seed(
        ChatOutboxItem(
          id = "interrupted",
          sessionKey = "main",
          text = "already dispatched",
          thinkingLevel = "off",
          createdAtMs = now,
          status = ChatOutboxStatus.Sending,
          retryCount = 1,
          lastError = null,
        ),
      )
      outbox.seed(
        ChatOutboxItem(
          id = "queued",
          sessionKey = "main",
          text = "send after recovery",
          thinkingLevel = "off",
          createdAtMs = now + 1,
          status = ChatOutboxStatus.Queued,
          retryCount = 0,
          lastError = null,
        ),
      )

      val chat = controller(this, gateway, outbox)
      gateway.online = true
      chat.handleGatewayEvent("health", null)
      runCurrent()

      try {
        assertTrue(gateway.sentMessages.isEmpty())
        assertEquals(ChatOutboxStatus.Sending, outbox.rows.getValue("interrupted").status)
        assertEquals(ChatOutboxStatus.Queued, outbox.rows.getValue("queued").status)
      } finally {
        // Never strand the controller's child job if a pre-release assertion fails.
        recoveryGate.complete(Unit)
      }
      advanceUntilIdle()

      assertEquals(listOf("send after recovery"), gateway.sentMessages)
      assertEquals(ChatOutboxStatus.Failed, outbox.rows.getValue("interrupted").status)
      assertEquals(OUTBOX_DELIVERY_UNCONFIRMED_ERROR, outbox.rows.getValue("interrupted").lastError)
      assertFalse(outbox.rows.containsKey("queued"))
    }

  @Test
  fun startupRecoveryFailureBlocksFlushUntilRecoveryCanBeRetried() =
    runTest {
      val gateway = FakeGateway()
      val outbox = FakeCommandOutbox()
      val now = System.currentTimeMillis()
      outbox.seed(
        ChatOutboxItem(
          id = "interrupted",
          sessionKey = "main",
          text = "possibly delivered",
          thinkingLevel = "off",
          createdAtMs = now,
          status = ChatOutboxStatus.Sending,
          retryCount = 0,
          lastError = null,
        ),
      )
      outbox.seed(
        ChatOutboxItem(
          id = "queued",
          sessionKey = "main",
          text = "younger queued work",
          thinkingLevel = "off",
          createdAtMs = now + 1,
          status = ChatOutboxStatus.Queued,
          retryCount = 0,
          lastError = null,
        ),
      )
      outbox.recoveryFailure = IllegalStateException("database unavailable")
      val chat = controller(this, gateway, outbox)

      gateway.online = true
      chat.handleGatewayEvent("health", null)
      advanceUntilIdle()

      assertFalse(chat.healthOk.value)
      assertTrue(gateway.sentMessages.isEmpty())
      assertEquals(ChatOutboxStatus.Sending, outbox.rows.getValue("interrupted").status)
      assertEquals(ChatOutboxStatus.Queued, outbox.rows.getValue("queued").status)

      outbox.recoveryFailure = null
      chat.handleGatewayEvent("health", null)
      advanceUntilIdle()

      assertEquals(ChatOutboxStatus.Failed, outbox.rows.getValue("interrupted").status)
      assertEquals(OUTBOX_DELIVERY_UNCONFIRMED_ERROR, outbox.rows.getValue("interrupted").lastError)
      assertEquals(listOf("younger queued work"), gateway.sentMessages)
      assertFalse(outbox.rows.containsKey("queued"))
    }

  @Test
  fun cancellationLeavesTheClaimForStartupRecoveryInsteadOfReplaying() =
    runTest {
      val gateway = FakeGateway()
      val outbox = FakeCommandOutbox()
      val processJob = SupervisorJob()
      val processScope = CoroutineScope(coroutineContext + processJob)
      val first = controller(processScope, gateway, outbox)
      first.load("main")
      advanceUntilIdle()
      first.sendMessageAwaitAcceptance(message = "interrupted send", thinkingLevel = "off", attachments = emptyList())

      gateway.online = true
      gateway.sendFailureAfterDispatch = CancellationException("process stopping")
      first.handleGatewayEvent("health", null)
      advanceUntilIdle()

      assertEquals(listOf("interrupted send"), gateway.sentMessages)
      assertEquals(
        ChatOutboxStatus.Sending,
        outbox.rows.values
          .single()
          .status,
      )
      processJob.cancel()

      gateway.sendFailureAfterDispatch = null
      val restarted = controller(this, gateway, outbox)
      advanceUntilIdle()

      val recovered = restarted.outboxItems.value.single()
      assertEquals(ChatOutboxStatus.Failed, recovered.status)
      assertEquals(OUTBOX_DELIVERY_UNCONFIRMED_ERROR, recovered.lastError)
      restarted.handleGatewayEvent("health", null)
      advanceUntilIdle()
      assertEquals(1, gateway.sentMessages.size)
    }

  @Test
  fun staleQueuedRowsExpireToFailedInsteadOfSendingOnReconnect() =
    runTest {
      val gateway = FakeGateway()
      val outbox = FakeCommandOutbox()
      outbox.seed(
        ChatOutboxItem(
          id = "stale",
          sessionKey = "main",
          text = "two days old",
          thinkingLevel = "off",
          createdAtMs = System.currentTimeMillis() - OUTBOX_EXPIRY_MS,
          status = ChatOutboxStatus.Queued,
          retryCount = 0,
          lastError = null,
        ),
      )
      val chat = controller(this, gateway, outbox)
      gateway.online = true
      chat.handleGatewayEvent("health", null)
      advanceUntilIdle()

      assertTrue(gateway.sentIdempotencyKeys.isEmpty())
      val expired = chat.outboxItems.value.single()
      assertEquals(ChatOutboxStatus.Failed, expired.status)
      assertEquals(OUTBOX_EXPIRED_ERROR, expired.lastError)

      // Retrying an expired row refreshes its createdAt, so the flush sweep cannot
      // immediately re-expire it and the send actually happens.
      chat.retryOutboxCommand("stale")
      advanceUntilIdle()
      assertEquals(listOf("stale"), gateway.sentIdempotencyKeys)
      assertTrue(chat.outboxItems.value.isEmpty())
    }

  @Test
  fun sessionDeleteEventPurgesThatSessionsOutboxRows() =
    runTest {
      val gateway = FakeGateway()
      val outbox = FakeCommandOutbox()
      outbox.seed(
        ChatOutboxItem(
          id = "doomed-session-row",
          sessionKey = "agent:old:main",
          text = "orphaned",
          thinkingLevel = "off",
          createdAtMs = 5,
          status = ChatOutboxStatus.Queued,
          retryCount = 0,
          lastError = null,
        ),
      )
      val chat = controller(this, gateway, outbox)
      advanceUntilIdle()

      chat.handleGatewayEvent(
        "sessions.changed",
        """{"reason":"delete","sessionKey":"agent:old:main"}""",
      )
      advanceUntilIdle()

      assertEquals(listOf("agent:old:main"), outbox.deletedSessions)
      assertTrue(chat.outboxItems.value.isEmpty())
    }
}
