package ai.openclaw.app.chat

import ai.openclaw.app.ui.chat.ChatTimelineItem
import ai.openclaw.app.ui.chat.buildChatTimeline
import ai.openclaw.app.ui.chat.withCompletedWorkGroups
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
class RoomChatTranscriptCacheDiskTest {
  private val context = RuntimeEnvironment.getApplication()
  private val databaseName = "transcript-reopen-${UUID.randomUUID()}.db"

  @After
  fun tearDown() {
    context.deleteDatabase(databaseName)
  }

  // Use the production disk opener, as the outbox and ClientDatabases reopen tests do.
  // Each block owns a fresh Room instance and closes it before the next block can read.
  private suspend fun withDatabase(block: suspend (GatewayCacheDatabase) -> Unit) {
    val database = GatewayCacheDatabase.open(context, databaseName)
    try {
      block(database)
    } finally {
      database.close()
    }
  }

  @Test
  fun admittedToolResultEvictsOldestTextAndSurvivesDiskReopenWithinItsScope() =
    runTest {
      withDatabase { database ->
        val store = RoomChatTranscriptCache(database)
        // The accepted contract is 200 shared rows, not 200 text rows plus tool results.
        val textRows =
          (0 until 200).map { index ->
            ChatMessage(
              id = "text-$index",
              role = if (index % 2 == 0) "user" else "assistant",
              content = listOf(ChatMessageContent(type = "text", text = "transcript text $index")),
              timestampMs = index.toLong(),
              idempotencyKey = "text-$index",
            )
          }
        store.saveTranscript("gateway-a", "main", "review", textRows)
        val atCapacity = store.loadTranscript("gateway-a", "main", "review")
        assertEquals(200, atCapacity.size)
        assertEquals((0 until 200).map { "text-$it" }, atCapacity.map { it.idempotencyKey })

        // Reuse the session key, tool call ID, and idempotency key in other real scopes.
        store.saveTranscript("gateway-b", "main", "review", listOf(toolResult("gateway B report")))
        store.saveTranscript("gateway-a", "ops", "review", listOf(toolResult("ops report")))
        store.saveTranscript("gateway-a", "main", "review", atCapacity + toolResult("report.txt is missing", isError = true))
      }
      assertTrue(context.getDatabasePath(databaseName).isFile)

      withDatabase { database ->
        val reopened = RoomChatTranscriptCache(database)
        val loaded = reopened.loadTranscript("gateway-a", "main", "review")
        assertEquals(200, loaded.size)
        assertEquals(200, database.dao().messages("gateway-a", "main", "review").size)
        assertEquals((1 until 200).map { "transcript text $it" }, loaded.dropLast(1).map { it.content.single().text })
        assertEquals((1 until 200).map { "text-$it" } + "run-review:result", loaded.map { it.idempotencyKey })
        assertEquals((1L..200L).toList(), loaded.map { it.timestampMs })
        assertEquals(99, loaded.count { it.role == "user" })
        assertEquals(100, loaded.count { it.role == "assistant" })
        assertToolResult(loaded.last(), "report.txt is missing", isError = true)
        assertEquals("run-review", loaded.last().runId)
        assertEquals("run-parent", loaded.last().steerTargetRunId)
        assertTrue(loaded.all { it.entryId == null })

        assertToolResult(reopened.loadTranscript("gateway-b", "main", "review").single(), "gateway B report")
        assertToolResult(reopened.loadTranscript("gateway-a", "ops", "review").single(), "ops report")
        assertTrue(reopened.loadTranscript("gateway-b", "ops", "review").isEmpty())
        assertTrue(reopened.loadTranscript("gateway-a", "main", "other").isEmpty())
        assertEquals(listOf("review" to "main"), reopened.loadSessions("gateway-a", "main").map { it.key to it.ownerAgentId })
        assertEquals(listOf("review" to "ops"), reopened.loadSessions("gateway-a", "ops").map { it.key to it.ownerAgentId })
      }
    }

  @Test
  fun legacyPayloadsCanBeLoadedResavedAndReopenedAlongsideToolMetadata() =
    runTest {
      withDatabase { database ->
        val store = RoomChatTranscriptCache(database)
        store.saveSessions("gateway-a", "main", listOf(ChatSessionEntry(key = "review", updatedAtMs = null)))
        // These are stored payload fixtures, not output from the serializer under test.
        // Older string/content arrays and marker-only rows coexist with a tool payload.
        val payloads =
          listOf(
            """["legacy request","second paragraph"]""",
            """[{"type":"text","text":"legacy answer"}]""",
            """{"content":[],"provenance":{"kind":"internal_system","sourceTool":"restart-sentinel"},"__openclaw":{"kind":"compaction","id":"checkpoint-1","tokensBefore":42500.0,"tokensAfter":2000.0}}""",
            """{"content":[{"type":"toolResult","toolActivity":{"toolCallId":"call-read","name":"read","detail":"report.txt","result":"legacy report","isError":false,"arguments":{"path":"report.txt","limit":20}}}],"runId":"run-review","steerTargetRunId":"run-parent","turnBoundary":true}""",
          )
        val roles = listOf("user", "assistant", "system", "toolresult")
        database.dao().insertMessages(
          payloads.mapIndexed { index, payload ->
            CachedMessageEntity(
              gatewayId = "gateway-a",
              agentId = "main",
              sessionKey = "review",
              rowOrder = index,
              role = roles[index],
              textPartsJson = payload,
              timestampMs = 10L + index,
              idempotencyKey = "legacy-$index",
            )
          },
        )
        store.saveTranscript("gateway-b", "main", "review", listOf(toolResult("gateway B report")))
        store.saveTranscript("gateway-a", "ops", "review", listOf(toolResult("ops report")))

        val loaded = store.loadTranscript("gateway-a", "main", "review")
        assertLegacyTranscript(loaded)
        store.saveTranscript("gateway-a", "main", "review", loaded)
      }
      assertTrue(context.getDatabasePath(databaseName).isFile)

      withDatabase { database ->
        val reopened = RoomChatTranscriptCache(database)
        assertLegacyTranscript(reopened.loadTranscript("gateway-a", "main", "review"))
        assertToolResult(reopened.loadTranscript("gateway-b", "main", "review").single(), "gateway B report")
        assertToolResult(reopened.loadTranscript("gateway-a", "ops", "review").single(), "ops report")
        assertTrue(reopened.loadTranscript("gateway-b", "ops", "review").isEmpty())
        assertTrue(reopened.loadTranscript("gateway-a", "main", "other").isEmpty())
      }
    }

  @Test
  fun emptyTurnBoundarySurvivesDiskReopenAndProtectsTheEarlierReply() =
    runTest {
      withDatabase { database ->
        RoomChatTranscriptCache(database).saveTranscript(
          "gateway-a",
          "main",
          "review",
          listOf(
            ChatMessage("first", "assistant", listOf(ChatMessageContent(text = "first complete")), 1000),
            ChatMessage("boundary", "toolresult", emptyList(), 2000, turnBoundary = true),
            ChatMessage("work", "assistant", listOf(ChatMessageContent(text = "checking")), 3000),
            ChatMessage("second", "assistant", listOf(ChatMessageContent(text = "second complete")), 4000),
          ),
        )
      }
      withDatabase { database ->
        val loaded = RoomChatTranscriptCache(database).loadTranscript("gateway-a", "main", "review")
        assertEquals(4, loaded.size)
        assertTrue(loaded[1].turnBoundary)
        assertTrue(loaded[1].content.isEmpty())
        val timeline =
          buildChatTimeline(loaded, 0, emptyList(), null)
            .withCompletedWorkGroups(loaded, false, emptySet(), "agent:main:dashboard:review")
        assertEquals(
          listOf("second complete", "first complete"),
          timeline.items.filterIsInstance<ChatTimelineItem.Message>().map {
            it.message.content
              .single()
              .text
          },
        )
      }
    }

  private fun assertLegacyTranscript(loaded: List<ChatMessage>) {
    assertEquals(listOf("user", "assistant", "system", "toolresult"), loaded.map { it.role })
    assertEquals(listOf("legacy-0", "legacy-1", "legacy-2", "legacy-3"), loaded.map { it.idempotencyKey })
    assertEquals(listOf(10L, 11L, 12L, 13L), loaded.map { it.timestampMs })
    assertEquals(listOf("legacy request", "second paragraph"), loaded[0].content.map { it.text })
    assertEquals("legacy answer", loaded[1].content.single().text)
    assertTrue(loaded[2].content.isEmpty())
    assertEquals(ChatMessageProvenance("internal_system", "restart-sentinel"), loaded[2].provenance)
    assertEquals(ChatTranscriptMarker("compaction", "checkpoint-1", 42_500.0, 2_000.0), loaded[2].transcriptMarker)
    assertToolResult(loaded[3], "legacy report")
    assertEquals("run-review", loaded[3].runId)
    assertEquals("run-parent", loaded[3].steerTargetRunId)
    assertNull(loaded[0].runId)
    assertTrue(loaded.take(3).none { it.turnBoundary })
    assertTrue(loaded.all { it.entryId == null })
  }

  private fun toolResult(
    result: String,
    isError: Boolean = false,
  ): ChatMessage =
    ChatMessage(
      id = "tool-result",
      role = "toolresult",
      content =
        listOf(
          ChatMessageContent(
            type = "toolResult",
            toolActivity =
              ChatToolActivity(
                toolCallId = "call-read",
                name = "read",
                detail = "report.txt",
                result = result,
                isError = isError,
                arguments = JsonObject(mapOf("path" to JsonPrimitive("report.txt"), "limit" to JsonPrimitive(20))),
              ),
          ),
        ),
      timestampMs = 200,
      idempotencyKey = "run-review:result",
      runId = "run-review",
      steerTargetRunId = "run-parent",
      entryId = "live-tool-entry",
      turnBoundary = true,
    )

  private fun assertToolResult(
    message: ChatMessage,
    result: String,
    isError: Boolean = false,
  ) {
    assertEquals("toolresult", message.role)
    assertTrue(message.turnBoundary)
    val content = message.content.single()
    assertEquals("toolResult", content.type)
    val activity = requireNotNull(content.toolActivity)
    assertEquals("call-read", activity.toolCallId)
    assertEquals("read", activity.name)
    assertEquals("report.txt", activity.detail)
    assertEquals(result, activity.result)
    assertEquals(isError, activity.isError)
    assertEquals(JsonObject(mapOf("path" to JsonPrimitive("report.txt"), "limit" to JsonPrimitive(20))), activity.arguments)
  }
}
