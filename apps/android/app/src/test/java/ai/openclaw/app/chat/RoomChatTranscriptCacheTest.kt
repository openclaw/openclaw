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

  private fun cache(): RoomChatTranscriptCache = RoomChatTranscriptCache(database = database)

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
      val store = cache()
      val imagePart = ChatMessageContent(type = "image", mimeType = "image/png", fileName = "a.png", base64 = "AAAA")
      store.saveTranscript(
        gatewayId = "gateway-a",
        sessionKey = "main",
        messages =
          listOf(
            message("hello", role = "user", timestampMs = 10, idempotencyKey = "run-1:user", extraParts = listOf(imagePart)),
            // Attachment-only messages have no cacheable text and are skipped entirely.
            ChatMessage(id = "img", role = "user", content = listOf(imagePart), timestampMs = 11),
            message("world", role = "assistant", timestampMs = 12),
          ),
      )

      val loaded = store.loadTranscript("gateway-a", "main")

      assertEquals(listOf("hello", "world"), loaded.map { it.content.single().text })
      assertTrue(loaded.all { message -> message.content.all { part -> part.type == "text" && part.base64 == null } })
      assertEquals(listOf("user", "assistant"), loaded.map { it.role })
      assertEquals(listOf(10L, 12L), loaded.map { it.timestampMs })
      assertEquals(listOf("run-1:user", null), loaded.map { it.idempotencyKey })
    }

  @Test
  fun transcriptRoundTripDropsInternalRoleRows() =
    runTest {
      val store = cache()
      store.saveTranscript(
        gatewayId = "gateway-a",
        sessionKey = "main",
        messages =
          listOf(
            message("hello", role = "user"),
            message("private tool output", role = "toolResult"),
            message("visible plugin notice", role = "custom"),
            message("reply", role = "assistant"),
          ),
      )

      val loaded = store.loadTranscript("gateway-a", "main")

      assertEquals(listOf("hello", "visible plugin notice", "reply"), loaded.map { it.content.single().text })
      assertEquals(listOf("user", "custom", "assistant"), loaded.map { it.role })
    }

  @Test
  fun transcriptWriteKeepsOnlyNewestBoundedMessages() =
    runTest {
      val store = cache()
      store.saveTranscript(
        gatewayId = "gateway-a",
        sessionKey = "main",
        messages = (0 until MAX_CACHED_MESSAGES_PER_SESSION + 50).map { index -> message("m$index", timestampMs = index.toLong()) },
      )

      val loadedTexts = store.loadTranscript("gateway-a", "main").map { it.content.single().text }

      assertEquals(MAX_CACHED_MESSAGES_PER_SESSION, loadedTexts.size)
      assertEquals("m50", loadedTexts.first())
      assertEquals("m249", loadedTexts.last())
    }

  @Test
  fun sessionWriteEvictsBeyondBoundAndDropsOrphanedTranscripts() =
    runTest {
      val store = cache()
      store.saveTranscript(gatewayId = "gateway-a", sessionKey = "session-10", messages = listOf(message("kept")))
      store.saveTranscript(gatewayId = "gateway-a", sessionKey = "session-55", messages = listOf(message("evicted")))

      store.saveSessions(
        gatewayId = "gateway-a",
        sessions =
          (0 until MAX_CACHED_SESSIONS + 10).map { index ->
            ChatSessionEntry(key = "session-$index", updatedAtMs = 1000L - index, displayName = "Session $index")
          },
      )

      val sessions = store.loadSessions("gateway-a")
      assertEquals(MAX_CACHED_SESSIONS, sessions.size)
      assertEquals("session-0", sessions.first().key)
      assertEquals("session-${MAX_CACHED_SESSIONS - 1}", sessions.last().key)
      assertEquals("Session 0", sessions.first().displayName)
      assertEquals(listOf("kept"), store.loadTranscript("gateway-a", "session-10").map { it.content.single().text })
      assertEquals(emptyList<ChatMessage>(), store.loadTranscript("gateway-a", "session-55"))
    }

  @Test
  fun transcriptForSessionOutsideFullCachedListSurvivesEviction() =
    runTest {
      val store = cache()
      store.saveSessions(
        gatewayId = "gateway-a",
        sessions =
          (0 until MAX_CACHED_SESSIONS).map { index ->
            ChatSessionEntry(key = "session-$index", updatedAtMs = 1000L - index)
          },
      )

      store.saveTranscript(gatewayId = "gateway-a", sessionKey = "deep-session", messages = listOf(message("deep text")))

      assertEquals(listOf("deep text"), store.loadTranscript("gateway-a", "deep-session").map { it.content.single().text })
      val sessionKeys = store.loadSessions("gateway-a").map { it.key }
      assertEquals(MAX_CACHED_SESSIONS, sessionKeys.size)
      assertTrue(sessionKeys.contains("deep-session"))
    }

  @Test
  fun activeDeepTranscriptSurvivesSessionListRefresh() =
    runTest {
      val store = cache()
      val listedSessions =
        (0 until MAX_CACHED_SESSIONS).map { index ->
          ChatSessionEntry(key = "session-$index", updatedAtMs = 1000L - index)
        }
      store.saveSessions(gatewayId = "gateway-a", sessions = listedSessions)
      store.saveTranscript(
        gatewayId = "gateway-a",
        sessionKey = "deep-session",
        messages = listOf(message("deep text")),
      )

      store.saveSessions(
        gatewayId = "gateway-a",
        sessions = listedSessions,
        retainedSessionKey = "deep-session",
      )

      assertEquals(MAX_CACHED_SESSIONS, store.loadSessions("gateway-a").size)
      assertTrue(store.loadSessions("gateway-a").any { it.key == "deep-session" })
      assertEquals(
        listOf("deep text"),
        store.loadTranscript("gateway-a", "deep-session").map { it.content.single().text },
      )
    }

  @Test
  fun completeSessionListRefreshDropsMissingDeepTranscript() =
    runTest {
      val store = cache()
      store.saveSessions(
        gatewayId = "gateway-a",
        sessions = listOf(ChatSessionEntry(key = "deep-session", updatedAtMs = 1)),
      )
      store.saveTranscript(
        gatewayId = "gateway-a",
        sessionKey = "deep-session",
        messages = listOf(message("deleted remotely")),
      )

      store.saveSessions(
        gatewayId = "gateway-a",
        sessions = listOf(ChatSessionEntry(key = "main", updatedAtMs = 2)),
      )

      assertEquals(listOf("main"), store.loadSessions("gateway-a").map { it.key })
      assertTrue(store.loadTranscript("gateway-a", "deep-session").isEmpty())
    }

  @Test
  fun deleteSessionRemovesSessionRowAndTranscript() =
    runTest {
      val store = cache()
      store.saveSessions(
        gatewayId = "gateway-a",
        sessions =
          listOf(
            ChatSessionEntry(key = "main", updatedAtMs = 1),
            ChatSessionEntry(key = "other", updatedAtMs = 2),
          ),
      )
      store.saveTranscript(gatewayId = "gateway-a", sessionKey = "main", messages = listOf(message("delete me")))
      store.saveTranscript(gatewayId = "gateway-a", sessionKey = "other", messages = listOf(message("keep me")))

      store.deleteSession("gateway-a", "main")

      assertEquals(emptyList<ChatMessage>(), store.loadTranscript("gateway-a", "main"))
      assertEquals(listOf("other"), store.loadSessions("gateway-a").map { it.key })
      assertEquals(listOf("keep me"), store.loadTranscript("gateway-a", "other").map { it.content.single().text })
    }

  @Test
  fun transcriptsAreScopedToGatewayIdentity() =
    runTest {
      val store = cache()
      store.saveTranscript(gatewayId = "gateway-a", sessionKey = "main", messages = listOf(message("gateway a text")))
      store.saveSessions("gateway-a", listOf(ChatSessionEntry(key = "main", updatedAtMs = 1)))

      assertEquals(emptyList<ChatMessage>(), store.loadTranscript("gateway-b", "main"))
      assertEquals(emptyList<ChatSessionEntry>(), store.loadSessions("gateway-b"))
      store.saveTranscript(gatewayId = "gateway-b", sessionKey = "main", messages = listOf(message("gateway b text")))

      assertEquals(listOf("gateway a text"), store.loadTranscript("gateway-a", "main").map { it.content.single().text })
      assertEquals(listOf("main"), store.loadSessions("gateway-a").map { it.key })
    }

  @Test
  fun blankGatewayIdentityDisablesReadsAndWrites() =
    runTest {
      val store = cache()
      store.saveTranscript(gatewayId = "", sessionKey = "main", messages = listOf(message("must not persist")))
      store.saveSessions("", listOf(ChatSessionEntry(key = "main", updatedAtMs = 1)))

      assertEquals(emptyList<ChatMessage>(), store.loadTranscript("", "main"))
      assertEquals(emptyList<ChatSessionEntry>(), store.loadSessions(""))

      // Nothing was written under a fallback scope either.
      assertEquals(emptyList<ChatMessage>(), store.loadTranscript("gateway-a", "main"))
      assertEquals(emptyList<ChatSessionEntry>(), store.loadSessions("gateway-a"))
    }
}
