package ai.openclaw.app.chat

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatControllerTranscriptCacheTest {
  private val json = Json { ignoreUnknownKeys = true }
  private val gatewayScope = ChatCacheScope(gatewayId = "gateway-a", connectionGeneration = 1)

  private class FakeTranscriptCache : ChatTranscriptCache {
    val transcripts = mutableMapOf<Pair<String, String>, List<ChatMessage>>()
    var sessions: List<ChatSessionEntry> = emptyList()
    val sessionsByGateway = mutableMapOf<String, List<ChatSessionEntry>>()
    val savedTranscripts = mutableListOf<Triple<String, String, List<ChatMessage>>>()
    val savedSessions = mutableListOf<Pair<String, List<ChatSessionEntry>>>()
    val retainedSessionKeys = mutableListOf<String?>()
    val deletedSessions = mutableListOf<Pair<String, String>>()

    override suspend fun loadSessions(gatewayId: String): List<ChatSessionEntry> = sessionsByGateway[gatewayId] ?: sessions

    override suspend fun loadTranscript(
      gatewayId: String,
      sessionKey: String,
    ): List<ChatMessage> = transcripts[gatewayId to sessionKey].orEmpty()

    override suspend fun saveSessions(
      gatewayId: String,
      sessions: List<ChatSessionEntry>,
      retainedSessionKey: String?,
    ) {
      savedSessions += gatewayId to sessions
      retainedSessionKeys += retainedSessionKey
    }

    override suspend fun saveTranscript(
      gatewayId: String,
      sessionKey: String,
      messages: List<ChatMessage>,
    ) {
      savedTranscripts += Triple(gatewayId, sessionKey, messages)
    }

    override suspend fun deleteSession(
      gatewayId: String,
      sessionKey: String,
    ) {
      deletedSessions += gatewayId to sessionKey
    }

    override suspend fun clearGateway(gatewayId: String) {
      transcripts.keys.removeAll { it.first == gatewayId }
      savedTranscripts.removeAll { it.first == gatewayId }
      savedSessions.removeAll { it.first == gatewayId }
    }
  }

  private fun cachedMessage(
    text: String,
    role: String = "assistant",
    timestampMs: Long = 1L,
  ): ChatMessage =
    ChatMessage(
      id = "cached-$text",
      role = role,
      content = listOf(ChatMessageContent(type = "text", text = text)),
      timestampMs = timestampMs,
    )

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun offlineColdOpenShowsCachedTranscriptAndSessionsAndKeepsSendBlocked() =
    runTest {
      val cache = FakeTranscriptCache()
      cache.transcripts["gateway-a" to "main"] = listOf(cachedMessage("cached hello"), cachedMessage("cached reply"))
      cache.sessions = listOf(ChatSessionEntry(key = "main", updatedAtMs = 5, displayName = "Main"))
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { _, _ -> throw IllegalStateException("offline") },
          transcriptCache = cache,
          cacheScope = { gatewayScope },
        )

      controller.load("main")
      advanceUntilIdle()

      assertEquals(
        listOf("cached hello", "cached reply"),
        controller.messages.value.map { it.content.single().text },
      )
      assertTrue(controller.messagesFromCache.value)
      assertEquals(listOf("main"), controller.sessions.value.map { it.key })
      assertFalse(controller.healthOk.value)

      val accepted =
        controller.sendMessageAwaitAcceptance(message = "hi", thinkingLevel = "off", attachments = emptyList())
      assertFalse(accepted)
      assertEquals("Gateway health not OK; cannot send", controller.errorText.value)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun cachedTranscriptEmitsFirstThenLiveHistoryReplacesWholesale() =
    runTest {
      val cache = FakeTranscriptCache()
      cache.transcripts["gateway-a" to "main"] =
        listOf(
          cachedMessage("cached hello", role = "user", timestampMs = 10),
          cachedMessage("stale line", role = "assistant", timestampMs = 11),
        )
      val historyGate = CompletableDeferred<Unit>()
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, _ ->
            when (method) {
              "chat.history" -> {
                historyGate.await()
                """
                {
                  "sessionId": "session-1",
                  "messages": [
                    { "role": "user", "content": "cached hello", "timestamp": 10 },
                    { "role": "assistant", "content": "fresh reply", "timestamp": 20 }
                  ]
                }
                """.trimIndent()
              }
              else -> "{}"
            }
          },
          transcriptCache = cache,
          cacheScope = { gatewayScope },
        )

      controller.load("main")
      runCurrent()

      // Cached transcript is visible while chat.history is still in flight.
      assertTrue(controller.messagesFromCache.value)
      assertEquals(
        listOf("cached hello", "stale line"),
        controller.messages.value.map { it.content.single().text },
      )
      val cachedFirstMessageId =
        controller.messages.value
          .first()
          .id

      historyGate.complete(Unit)
      advanceUntilIdle()

      assertFalse(controller.messagesFromCache.value)
      assertEquals(
        listOf("cached hello", "fresh reply"),
        controller.messages.value.map { it.content.single().text },
      )
      // Existing reconciliation keeps stable ids for rows the live history confirms.
      val liveFirstMessageId =
        controller.messages.value
          .first()
          .id
      assertEquals(cachedFirstMessageId, liveFirstMessageId)
      // Live history is written through to the cache.
      val savedTranscript = cache.savedTranscripts.last()
      assertEquals("gateway-a", savedTranscript.first)
      assertEquals("main", savedTranscript.second)
      assertEquals(
        listOf("cached hello", "fresh reply"),
        savedTranscript.third.map { it.content.single().text },
      )
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun switchSessionOfflineShowsCachedTranscriptForThatSession() =
    runTest {
      val cache = FakeTranscriptCache()
      cache.transcripts["gateway-a" to "agent:other:main"] = listOf(cachedMessage("other session text"))
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { _, _ -> throw IllegalStateException("offline") },
          transcriptCache = cache,
          cacheScope = { gatewayScope },
        )
      controller.load("main")
      advanceUntilIdle()
      assertEquals(emptyList<ChatMessage>(), controller.messages.value)

      controller.switchSession("agent:other:main")
      advanceUntilIdle()

      assertEquals(
        listOf("other session text"),
        controller.messages.value.map { it.content.single().text },
      )
      assertTrue(controller.messagesFromCache.value)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun sessionDeleteEventPurgesCachedSession() =
    runTest {
      val cache = FakeTranscriptCache()
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { _, _ -> "{}" },
          transcriptCache = cache,
          cacheScope = { gatewayScope },
        )

      controller.handleGatewayEvent(
        "sessions.changed",
        """{"reason":"delete","sessionKey":"agent:old:main"}""",
      )
      advanceUntilIdle()

      assertEquals(listOf("gateway-a" to "agent:old:main"), cache.deletedSessions)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun liveSessionListIsWrittenThroughToCache() =
    runTest {
      val cache = FakeTranscriptCache()
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, _ ->
            when (method) {
              "sessions.list" -> """{"sessions":[{"key":"main","updatedAt":7,"displayName":"Main"}]}"""
              "chat.history" -> """{"sessionId":"session-1","messages":[]}"""
              else -> "{}"
            }
          },
          transcriptCache = cache,
          cacheScope = { gatewayScope },
        )

      controller.load("main")
      advanceUntilIdle()

      assertEquals("gateway-a", cache.savedSessions.last().first)
      assertEquals(
        listOf("main"),
        cache.savedSessions
          .last()
          .second
          .map { it.key },
      )
      assertEquals(null, cache.retainedSessionKeys.last())
      assertEquals(listOf("main"), controller.sessions.value.map { it.key })
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun sessionListParsesGroupingAndUnreadMetadata() =
    runTest {
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, _ ->
            when (method) {
              "sessions.list" ->
                """
                {
                  "sessions": [{
                    "key": "main",
                    "label": "Daily",
                    "category": "Work",
                    "pinned": true,
                    "archived": false,
                    "unread": true,
                    "lastReadAt": 10,
                    "lastActivityAt": 20
                  }]
                }
                """.trimIndent()
              else -> "{}"
            }
          },
        )

      controller.refreshSessions()
      advanceUntilIdle()

      val session = controller.sessions.value.single()
      assertEquals("Daily", session.label)
      assertEquals("Work", session.category)
      assertEquals(true, session.pinned)
      assertEquals(false, session.archived)
      assertEquals(true, session.unread)
      assertEquals(10L, session.lastReadAt)
      assertEquals(20L, session.lastActivityAt)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun partialSessionChangedEventPreservesExistingMetadata() =
    runTest {
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, _ ->
            when (method) {
              "sessions.list" ->
                """{"sessions":[{"key":"main","label":"Daily","category":"Work","pinned":true,"unread":true}]}"""
              else -> "{}"
            }
          },
        )
      controller.refreshSessions()
      advanceUntilIdle()

      controller.handleGatewayEvent(
        "sessions.changed",
        """{"session":{"key":"main","lastActivityAt":30}}""",
      )

      val session = controller.sessions.value.single()
      assertEquals("Daily", session.label)
      assertEquals("Work", session.category)
      assertEquals(true, session.pinned)
      assertEquals(true, session.unread)
      assertEquals(30L, session.lastActivityAt)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun truncatedSessionListRetainsActiveDeepTranscript() =
    runTest {
      val cache = FakeTranscriptCache()
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, _ ->
            when (method) {
              "sessions.list" ->
                """{"totalCount":2,"hasMore":true,"sessions":[{"key":"main","updatedAt":7}]}"""
              "chat.history" -> """{"sessionId":"session-1","messages":[]}"""
              else -> "{}"
            }
          },
          transcriptCache = cache,
          cacheScope = { gatewayScope },
        )

      controller.load("deep-session")
      advanceUntilIdle()

      assertEquals("deep-session", cache.retainedSessionKeys.last())
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun completeSessionListRetainsActiveTranscriptBeyondLocalCacheWindow() =
    runTest {
      val cache = FakeTranscriptCache()
      val sessions =
        (0 until MAX_CACHED_SESSIONS + 10).joinToString(",") { index ->
          """{"key":"session-$index","updatedAt":${100 - index}}"""
        }
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, _ ->
            when (method) {
              "sessions.list" ->
                """{"totalCount":60,"hasMore":false,"sessions":[$sessions]}"""
              "chat.history" -> """{"sessionId":"session-55","messages":[]}"""
              else -> "{}"
            }
          },
          transcriptCache = cache,
          cacheScope = { gatewayScope },
        )

      controller.load("session-55")
      advanceUntilIdle()

      assertEquals("session-55", cache.retainedSessionKeys.last())
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun oldGatewayHistoryResponseIsNeitherAppliedNorCachedAfterScopeChange() =
    runTest {
      val cache = FakeTranscriptCache()
      val historyGate = CompletableDeferred<Unit>()
      var currentScope = gatewayScope
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, _ ->
            if (method == "chat.history") {
              historyGate.await()
              """{"sessionId":"old","messages":[{"role":"assistant","content":"old gateway"}]}"""
            } else {
              "{}"
            }
          },
          transcriptCache = cache,
          cacheScope = { currentScope },
        )

      controller.load("main")
      runCurrent()
      assertTrue(controller.historyLoading.value)
      currentScope = ChatCacheScope(gatewayId = "gateway-b", connectionGeneration = 2)
      controller.onGatewayScopeChanging()
      assertFalse(controller.historyLoading.value)
      historyGate.complete(Unit)
      advanceUntilIdle()

      assertTrue(controller.messages.value.isEmpty())
      assertTrue(cache.savedTranscripts.isEmpty())
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun oldGatewaySessionListIsNeitherAppliedNorCachedAfterScopeChange() =
    runTest {
      val cache = FakeTranscriptCache()
      val sessionsGate = CompletableDeferred<Unit>()
      var currentScope = gatewayScope
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, _ ->
            if (method == "sessions.list") {
              sessionsGate.await()
              """{"sessions":[{"key":"old-gateway-session"}]}"""
            } else {
              "{}"
            }
          },
          transcriptCache = cache,
          cacheScope = { currentScope },
        )

      controller.refreshSessions()
      runCurrent()
      currentScope = ChatCacheScope(gatewayId = "gateway-b", connectionGeneration = 2)
      sessionsGate.complete(Unit)
      advanceUntilIdle()

      assertTrue(controller.sessions.value.isEmpty())
      assertTrue(cache.savedSessions.isEmpty())
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun switchingGatewayScopeIsolatesCachedTranscriptAndSessionsThenRestoresThem() =
    runTest {
      val cache = FakeTranscriptCache()
      cache.transcripts["gateway-a" to "main"] = listOf(cachedMessage("gateway A transcript"))
      cache.sessionsByGateway["gateway-a"] = listOf(ChatSessionEntry(key = "main", updatedAtMs = 1L, displayName = "Gateway A"))
      cache.sessionsByGateway["gateway-b"] = emptyList()
      var currentScope = ChatCacheScope(gatewayId = "gateway-a", connectionGeneration = 1)
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { _, _ -> throw IllegalStateException("offline") },
          transcriptCache = cache,
          cacheScope = { currentScope },
        )

      controller.load("main")
      advanceUntilIdle()
      assertEquals(listOf("gateway A transcript"), controller.messages.value.map { it.content.single().text })
      assertEquals(listOf("Gateway A"), controller.sessions.value.mapNotNull { it.displayName })

      currentScope = ChatCacheScope(gatewayId = "gateway-b", connectionGeneration = 2)
      controller.onGatewayScopeChanging()
      controller.load("main")
      advanceUntilIdle()
      assertTrue(controller.messages.value.isEmpty())
      assertTrue(controller.sessions.value.isEmpty())

      currentScope = ChatCacheScope(gatewayId = "gateway-a", connectionGeneration = 3)
      controller.onGatewayScopeChanging()
      controller.load("main")
      advanceUntilIdle()
      assertEquals(listOf("gateway A transcript"), controller.messages.value.map { it.content.single().text })
      assertEquals(listOf("Gateway A"), controller.sessions.value.mapNotNull { it.displayName })
    }
}
