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

  private class FakeTranscriptCache : ChatTranscriptCache {
    val transcripts = mutableMapOf<String, List<ChatMessage>>()
    var sessions: List<ChatSessionEntry> = emptyList()
    val savedTranscripts = mutableListOf<Pair<String, List<ChatMessage>>>()
    val savedSessions = mutableListOf<List<ChatSessionEntry>>()
    val deletedSessions = mutableListOf<String>()

    override suspend fun loadSessions(): List<ChatSessionEntry> = sessions

    override suspend fun loadTranscript(sessionKey: String): List<ChatMessage> = transcripts[sessionKey].orEmpty()

    override suspend fun saveSessions(sessions: List<ChatSessionEntry>) {
      savedSessions += sessions
    }

    override suspend fun saveTranscript(
      sessionKey: String,
      messages: List<ChatMessage>,
    ) {
      savedTranscripts += sessionKey to messages
    }

    override suspend fun deleteSession(sessionKey: String) {
      deletedSessions += sessionKey
    }

    override suspend fun clearAll() {
      transcripts.clear()
      sessions = emptyList()
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
      cache.transcripts["main"] = listOf(cachedMessage("cached hello"), cachedMessage("cached reply"))
      cache.sessions = listOf(ChatSessionEntry(key = "main", updatedAtMs = 5, displayName = "Main"))
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { _, _ -> throw IllegalStateException("offline") },
          transcriptCache = cache,
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
      cache.transcripts["main"] =
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
      assertEquals("main", savedTranscript.first)
      assertEquals(
        listOf("cached hello", "fresh reply"),
        savedTranscript.second.map { it.content.single().text },
      )
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun switchSessionOfflineShowsCachedTranscriptForThatSession() =
    runTest {
      val cache = FakeTranscriptCache()
      cache.transcripts["agent:other:main"] = listOf(cachedMessage("other session text"))
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { _, _ -> throw IllegalStateException("offline") },
          transcriptCache = cache,
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
        )

      controller.handleGatewayEvent(
        "sessions.changed",
        """{"reason":"delete","sessionKey":"agent:old:main"}""",
      )
      advanceUntilIdle()

      assertEquals(listOf("agent:old:main"), cache.deletedSessions)
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
        )

      controller.load("main")
      advanceUntilIdle()

      assertEquals(listOf("main"), cache.savedSessions.last().map { it.key })
      assertEquals(listOf("main"), controller.sessions.value.map { it.key })
    }
}
