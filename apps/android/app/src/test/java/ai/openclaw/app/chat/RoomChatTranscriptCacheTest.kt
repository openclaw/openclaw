package ai.openclaw.app.chat

import androidx.room.Room
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@RunWith(RobolectricTestRunner::class)
class RoomChatTranscriptCacheTest {
  private val database: ChatCacheDatabase =
    Room
      .inMemoryDatabaseBuilder(RuntimeEnvironment.getApplication(), ChatCacheDatabase::class.java)
      .build()

  @After
  fun tearDown() {
    database.close()
  }

  private fun cache(gatewayId: () -> String?): RoomChatTranscriptCache = RoomChatTranscriptCache(database = database, gatewayId = gatewayId)

  private fun message(
    text: String,
    role: String = "user",
    timestampMs: Long? = 1L,
    idempotencyKey: String? = null,
    extraParts: List<ChatMessageContent> = emptyList(),
  ): ChatMessage =
    ChatMessage(
      id = "id-$text",
      role = role,
      content = listOf(ChatMessageContent(type = "text", text = text)) + extraParts,
      timestampMs = timestampMs,
      idempotencyKey = idempotencyKey,
    )

  @Test
  fun transcriptRoundTripKeepsTextRowsOnly() =
    runTest {
      val store = cache { "gateway-a" }
      val imagePart = ChatMessageContent(type = "image", mimeType = "image/png", fileName = "a.png", base64 = "AAAA")
      store.saveTranscript(
        sessionKey = "main",
        messages =
          listOf(
            message("hello", role = "user", timestampMs = 10, idempotencyKey = "run-1:user", extraParts = listOf(imagePart)),
            // Attachment-only messages have no cacheable text and are skipped entirely.
            ChatMessage(id = "img", role = "user", content = listOf(imagePart), timestampMs = 11),
            message("world", role = "assistant", timestampMs = 12),
          ),
      )

      val loaded = store.loadTranscript("main")

      assertEquals(listOf("hello", "world"), loaded.map { it.content.single().text })
      assertTrue(loaded.all { message -> message.content.all { part -> part.type == "text" && part.base64 == null } })
      assertEquals(listOf("user", "assistant"), loaded.map { it.role })
      assertEquals(listOf(10L, 12L), loaded.map { it.timestampMs })
      assertEquals(listOf("run-1:user", null), loaded.map { it.idempotencyKey })
    }

  @Test
  fun transcriptWriteKeepsOnlyNewestBoundedMessages() =
    runTest {
      val store = cache { "gateway-a" }
      store.saveTranscript(
        sessionKey = "main",
        messages = (0 until MAX_CACHED_MESSAGES_PER_SESSION + 50).map { index -> message("m$index", timestampMs = index.toLong()) },
      )

      val loadedTexts = store.loadTranscript("main").map { it.content.single().text }

      assertEquals(MAX_CACHED_MESSAGES_PER_SESSION, loadedTexts.size)
      assertEquals("m50", loadedTexts.first())
      assertEquals("m249", loadedTexts.last())
    }

  @Test
  fun sessionWriteEvictsBeyondBoundAndDropsOrphanedTranscripts() =
    runTest {
      val store = cache { "gateway-a" }
      store.saveTranscript(sessionKey = "session-10", messages = listOf(message("kept")))
      store.saveTranscript(sessionKey = "session-55", messages = listOf(message("evicted")))

      store.saveSessions(
        (0 until MAX_CACHED_SESSIONS + 10).map { index ->
          ChatSessionEntry(key = "session-$index", updatedAtMs = 1000L - index, displayName = "Session $index")
        },
      )

      val sessions = store.loadSessions()
      assertEquals(MAX_CACHED_SESSIONS, sessions.size)
      assertEquals("session-0", sessions.first().key)
      assertEquals("session-${MAX_CACHED_SESSIONS - 1}", sessions.last().key)
      assertEquals("Session 0", sessions.first().displayName)
      assertEquals(listOf("kept"), store.loadTranscript("session-10").map { it.content.single().text })
      assertEquals(emptyList<ChatMessage>(), store.loadTranscript("session-55"))
    }

  @Test
  fun transcriptForSessionOutsideFullCachedListSurvivesEviction() =
    runTest {
      val store = cache { "gateway-a" }
      store.saveSessions(
        (0 until MAX_CACHED_SESSIONS).map { index ->
          ChatSessionEntry(key = "session-$index", updatedAtMs = 1000L - index)
        },
      )

      store.saveTranscript(sessionKey = "deep-session", messages = listOf(message("deep text")))

      assertEquals(listOf("deep text"), store.loadTranscript("deep-session").map { it.content.single().text })
      val sessionKeys = store.loadSessions().map { it.key }
      assertEquals(MAX_CACHED_SESSIONS, sessionKeys.size)
      assertTrue(sessionKeys.contains("deep-session"))
    }

  @Test
  fun deleteSessionRemovesSessionRowAndTranscript() =
    runTest {
      val store = cache { "gateway-a" }
      store.saveSessions(
        listOf(
          ChatSessionEntry(key = "main", updatedAtMs = 1),
          ChatSessionEntry(key = "other", updatedAtMs = 2),
        ),
      )
      store.saveTranscript(sessionKey = "main", messages = listOf(message("delete me")))
      store.saveTranscript(sessionKey = "other", messages = listOf(message("keep me")))

      store.deleteSession("main")

      assertEquals(emptyList<ChatMessage>(), store.loadTranscript("main"))
      assertEquals(listOf("other"), store.loadSessions().map { it.key })
      assertEquals(listOf("keep me"), store.loadTranscript("other").map { it.content.single().text })
    }

  @Test
  fun transcriptsAreScopedToGatewayIdentity() =
    runTest {
      var gateway: String? = "gateway-a"
      val store = cache { gateway }
      store.saveTranscript(sessionKey = "main", messages = listOf(message("gateway a text")))
      store.saveSessions(listOf(ChatSessionEntry(key = "main", updatedAtMs = 1)))

      gateway = "gateway-b"
      assertEquals(emptyList<ChatMessage>(), store.loadTranscript("main"))
      assertEquals(emptyList<ChatSessionEntry>(), store.loadSessions())
      store.saveTranscript(sessionKey = "main", messages = listOf(message("gateway b text")))

      gateway = "gateway-a"
      assertEquals(listOf("gateway a text"), store.loadTranscript("main").map { it.content.single().text })
      assertEquals(listOf("main"), store.loadSessions().map { it.key })
    }

  @Test
  fun clearAllPurgesEveryGatewayScope() =
    runTest {
      var gateway: String? = "gateway-a"
      val store = cache { gateway }
      store.saveSessions(listOf(ChatSessionEntry(key = "main", updatedAtMs = 1)))
      store.saveTranscript(sessionKey = "main", messages = listOf(message("a text")))
      gateway = "gateway-b"
      store.saveTranscript(sessionKey = "main", messages = listOf(message("b text")))

      store.clearAll()

      assertEquals(emptyList<ChatMessage>(), store.loadTranscript("main"))
      assertEquals(emptyList<ChatSessionEntry>(), store.loadSessions())
      gateway = "gateway-a"
      assertEquals(emptyList<ChatMessage>(), store.loadTranscript("main"))
      assertEquals(emptyList<ChatSessionEntry>(), store.loadSessions())
    }

  @Test
  fun missingGatewayIdentityDisablesReadsAndWrites() =
    runTest {
      var gateway: String? = null
      val store = cache { gateway }
      store.saveTranscript(sessionKey = "main", messages = listOf(message("must not persist")))
      store.saveSessions(listOf(ChatSessionEntry(key = "main", updatedAtMs = 1)))

      assertEquals(emptyList<ChatMessage>(), store.loadTranscript("main"))
      assertEquals(emptyList<ChatSessionEntry>(), store.loadSessions())

      // Nothing was written under a fallback scope either.
      gateway = "gateway-a"
      assertEquals(emptyList<ChatMessage>(), store.loadTranscript("main"))
      assertEquals(emptyList<ChatSessionEntry>(), store.loadSessions())
    }
}
