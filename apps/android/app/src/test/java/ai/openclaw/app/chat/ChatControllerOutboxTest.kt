package ai.openclaw.app.chat

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
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
    ) {
      val current = rows[id] ?: return
      if (gatewayIds[id] != gatewayId) return
      val createdAt = maxOf(nowMs, nextCreatedAt)
      nextCreatedAt = createdAt + 1
      rows[id] = current.copy(status = ChatOutboxStatus.Queued, retryCount = 0, lastError = null, createdAtMs = createdAt)
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

    override suspend fun requeueSendingAfterRestart() {
      for ((id, item) in rows) {
        if (item.status == ChatOutboxStatus.Sending) {
          rows[id] = item.copy(status = ChatOutboxStatus.Queued)
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
    var failSendsWithTransportError = false
    var sendResponse: (idempotencyKey: String) -> String = { key -> """{"runId":"$key"}""" }
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
          if (failSendsWithTransportError) throw IllegalStateException("socket closed")
          val params = json.parseToJsonElement(paramsJson.orEmpty()) as JsonObject
          val key = (params["idempotencyKey"] as JsonPrimitive).content
          sentIdempotencyKeys += key
          sentMessages += (params["message"] as JsonPrimitive).content
          sentSessionKeys += (params["sessionKey"] as JsonPrimitive).content
          sentThinkingLevels += (params["thinking"] as JsonPrimitive).content
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
      gateway.failSendsWithTransportError = true
      chat.retryOutboxCommand("active")
      advanceUntilIdle()
      assertFalse(chat.healthOk.value)

      gateway.failSendsWithTransportError = false
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
  fun gatewayScopeSwitchDuringRetryBackoffStopsTheFlushWithoutReplaying() =
    runTest {
      val gateway = FakeGateway()
      val outbox = FakeCommandOutbox()
      var activeScope: ChatCacheScope? = ChatCacheScope(gatewayId = "gateway-test", connectionGeneration = 1L)
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
      chat.sendMessageAwaitAcceptance(message = "old gateway text", thinkingLevel = "off", attachments = emptyList())

      gateway.online = true
      gateway.sendResponse = { """{"status":"error"}""" }
      chat.handleGatewayEvent("health", null)
      // Run up to the retry backoff delay, then switch the gateway scope while it is pending.
      runCurrent()
      activeScope = ChatCacheScope(gatewayId = "gateway-other", connectionGeneration = 2L)
      advanceUntilIdle()

      // Only the pre-switch attempt happened; the captured row was not replayed into the new scope.
      assertEquals(1, gateway.sentIdempotencyKeys.size)
      val row = outbox.rows.values.single()
      assertEquals(ChatOutboxStatus.Queued, row.status)
      assertEquals(1, row.retryCount)
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
  fun rowDeletedDuringRetryBackoffIsNeverResent() =
    runTest {
      val gateway = FakeGateway()
      val outbox = FakeCommandOutbox()
      val chat = controller(this, gateway, outbox)
      chat.load("main")
      advanceUntilIdle()
      chat.sendMessageAwaitAcceptance(message = "deleted mid-retry", thinkingLevel = "off", attachments = emptyList())
      val queuedRow = chat.outboxItems.value.single()
      val id = queuedRow.id

      gateway.online = true
      gateway.sendResponse = { """{"status":"error"}""" }
      chat.handleGatewayEvent("health", null)
      // Run up to the retry backoff delay; the row stays 'sending' so the UI offers no actions.
      runCurrent()
      assertEquals(ChatOutboxStatus.Sending, outbox.rows.getValue(id).status)
      // Simulate the row disappearing through a non-UI path (e.g. session purge) mid-backoff.
      outbox.rows.remove(id)
      advanceUntilIdle()

      // The post-delay re-claim found no row, so the captured text was not sent again.
      assertEquals(1, gateway.sentIdempotencyKeys.size)
      assertTrue(outbox.rows.isEmpty())
      assertTrue(chat.outboxItems.value.isEmpty())
    }

  @Test
  fun sendFailuresBackOffThenParkAsFailedAfterMaxAttempts() =
    runTest {
      val gateway = FakeGateway()
      val outbox = FakeCommandOutbox()
      val chat = controller(this, gateway, outbox)
      chat.load("main")
      advanceUntilIdle()
      chat.sendMessageAwaitAcceptance(message = "doomed", thinkingLevel = "off", attachments = emptyList())

      gateway.online = true
      gateway.sendResponse = { """{"status":"error"}""" }
      chat.handleGatewayEvent("health", null)
      advanceUntilIdle()

      assertEquals(OUTBOX_MAX_SEND_ATTEMPTS, gateway.sentIdempotencyKeys.size)
      val failed = chat.outboxItems.value.single()
      assertEquals(ChatOutboxStatus.Failed, failed.status)
      assertEquals(OUTBOX_MAX_SEND_ATTEMPTS, failed.retryCount)
      assertNotNull(failed.lastError)
    }

  @Test
  fun transportFailureKeepsRowQueuedForNextReconnectInsteadOfBurningAttempts() =
    runTest {
      val gateway = FakeGateway()
      val outbox = FakeCommandOutbox()
      val chat = controller(this, gateway, outbox)
      chat.load("main")
      advanceUntilIdle()
      chat.sendMessageAwaitAcceptance(message = "survives drops", thinkingLevel = "off", attachments = emptyList())

      gateway.online = true
      gateway.failSendsWithTransportError = true
      chat.handleGatewayEvent("health", null)
      advanceUntilIdle()

      // No ack means delivery state is unknown: the row must stay queued with attempts intact.
      val row = chat.outboxItems.value.single()
      assertEquals(ChatOutboxStatus.Queued, row.status)
      assertEquals(0, row.retryCount)
      assertFalse(chat.healthOk.value)

      gateway.failSendsWithTransportError = false
      chat.handleGatewayEvent("health", null)
      advanceUntilIdle()

      assertEquals(listOf("survives drops"), gateway.sentMessages)
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
          retryCount = OUTBOX_MAX_SEND_ATTEMPTS,
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
  fun sendingRowsRecoverToQueuedOnControllerStartup() =
    runTest {
      val gateway = FakeGateway()
      val outbox = FakeCommandOutbox()
      outbox.seed(
        ChatOutboxItem(
          id = "interrupted",
          sessionKey = "main",
          text = "crashed mid-send",
          thinkingLevel = "off",
          // Recent timestamp: the startup expiry sweep must not expire the recovered row.
          createdAtMs = System.currentTimeMillis(),
          status = ChatOutboxStatus.Sending,
          retryCount = 1,
          lastError = "socket closed",
        ),
      )

      val chat = controller(this, gateway, outbox)
      advanceUntilIdle()

      val recovered = chat.outboxItems.value.single()
      assertEquals(ChatOutboxStatus.Queued, recovered.status)
      assertEquals(1, recovered.retryCount)
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
