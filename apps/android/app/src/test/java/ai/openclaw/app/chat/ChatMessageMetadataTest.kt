package ai.openclaw.app.chat

import ai.openclaw.app.ui.chat.ChatTimelineItem
import ai.openclaw.app.ui.chat.buildTimeline
import ai.openclaw.app.ui.chat.chatMessageMetadata
import ai.openclaw.app.ui.chat.prepareChatHistory
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import java.util.UUID

/** Gateway JSON -> controller -> production timeline/metadata, including the existing disk cache. */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class ChatMessageMetadataTest {
  @Test
  fun historyFactsStayWithTheirCallAcrossTurnsReloadAndDiskRecreation() =
    runTest {
      val history = """{
      "sessionId":"metadata-proof",
      "sessionInfo":{"key":"main","model":"different-current-model","contextTokens":999999,"outputTokens":88888},
      "messages":[
        {"role":"user","content":"First question","timestamp":1000},
        {"role":"assistant","content":[{"type":"toolCall","id":"read-1","name":"read","arguments":{"path":"report.txt"}}],"timestamp":2000,"model":"first-model","usage":{"input":80,"output":10,"cacheWrite":23}},
        {"role":"toolResult","toolCallId":"read-1","toolName":"read","content":"report","timestamp":2100},
        {"role":"assistant","content":"First answer","phase":"final_answer","timestamp":3000,"model":"provider/first-model","usage":{"input":120,"output":30,"cacheRead":40,"cacheWrite":17,"cost":{"total":0.012}}},
        {"role":"user","content":"Second question","timestamp":4000},
        {"role":"assistant","content":"Second answer","phase":"final_answer","timestamp":5000,"model":"second-model","usage":{"input":200,"output":50,"cache_creation_input_tokens":19}},
        {"role":"assistant","content":[],"timestamp":6000,"usage":{"output":999}},
        {"role":"assistant","content":"Delivered copy","timestamp":6100,"provider":"openclaw","model":"delivery-mirror","usage":{"output":999},"openclawDeliveryMirror":{"kind":"channel-final"}},
        {"role":"user","content":"Unknown call","timestamp":7000},
        {"role":"assistant","content":"No metadata","timestamp":8000}
      ]
    }"""
      val controller =
        backgroundScope.createChatController(requestGateway = { method, _ ->
          if (method == "chat.history") history else emptyChatGatewayResponse(method)
        })
      controller.load("main")
      runCurrent()
      val original = controller.messages.value
      assertEquals(10, original.size)

      fun verify(messages: List<ChatMessage>) {
        val timeline = prepareChatHistory(messages, "main", "main").buildTimeline(0, emptyList(), null)
        val displayed = timeline.items.filterIsInstance<ChatTimelineItem.Message>().associate { chatText(it.message) to chatMessageMetadata(it.message).toMap() }
        assertEquals(mapOf("Input tokens" to "120", "Output tokens" to "30", "Cache read" to "40", "Cache write" to "17", "Est. cost" to "$0.012", "Model" to "first-model"), displayed["First answer"])
        assertEquals(mapOf("Input tokens" to "200", "Output tokens" to "50", "Cache write" to "19", "Model" to "second-model"), displayed["Second answer"])
        assertTrue(displayed.getValue("No metadata").isEmpty())
        assertTrue(messages.filter { it.model == "delivery-mirror" }.all { chatMessageMetadata(it).isEmpty() })
        assertFalse(displayed.values.any { facts -> facts.values.any { it == "999" || it == "88.9k" || it == "different-current-model" } })
        assertEquals(23L, messages.first { it.model == "first-model" }.usage?.cacheWrite)
      }
      verify(original)
      controller.refresh()
      runCurrent()
      verify(controller.messages.value)
      val context = RuntimeEnvironment.getApplication()
      val name = "message-metadata-${UUID.randomUUID()}.db"
      try {
        GatewayCacheDatabase.open(context, name).let { database ->
          try {
            RoomChatTranscriptCache(database).saveTranscript("fixture", "main", "main", controller.messages.value)
          } finally {
            database.close()
          }
        }
        GatewayCacheDatabase.open(context, name).let { database ->
          try {
            verify(RoomChatTranscriptCache(database).loadTranscript("fixture", "main", "main"))
          } finally {
            database.close()
          }
        }
      } finally {
        context.deleteDatabase(name)
      }
    }

  @Test
  fun absentInvalidSyntheticAndErrorFactsAreNotReplacedWithSessionUsage() =
    runTest {
      val rows =
        listOf(
          """{"content":"unknown","usage":{"input":-1,"output":0,"cacheWrite":-2}}""",
          """{"content":"model only","model":"provider/example-model"}""",
          """{"content":[{"type":"file","fileName":"report.txt"}],"model":"media-model","usage":{"output":12}}""",
          """{"content":"failed","stopReason":"error","usage":{"output":3}}""",
          """{"content":"aborted","stopReason":"aborted","usage":{"output":4}}""",
          """{"content":"projected","model":"example-model","usage":{"output":500},"openclawStreamFallback":{"runId":"r"}}""",
          """{"content":"forwarded","model":"example-model","provenance":{"kind":"inter_session","sourceTool":"sessions_send"}}""",
          """{"content":"cache only","usage":{"cacheWrite":9}}""",
        )
      val messages = rows.mapIndexed { index, row -> "{\"role\":\"assistant\",\"timestamp\":${index + 1000},${row.drop(1)}" }.joinToString(",")
      val controller =
        backgroundScope.createChatController(requestGateway = { method, _ ->
          if (method == "chat.history") "{\"messages\":[$messages]}" else emptyChatGatewayResponse(method)
        })
      controller.load("main")
      runCurrent()
      val parsed = controller.messages.value
      assertEquals(rows.size, parsed.size)
      assertEquals(emptyList<Pair<String, String>>(), chatMessageMetadata(parsed[0]))
      assertEquals(listOf("Model" to "example-model"), chatMessageMetadata(parsed[1]))
      assertEquals(listOf("Output tokens" to "12", "Model" to "media-model"), chatMessageMetadata(parsed[2]))
      assertEquals(listOf("Output tokens" to "3"), chatMessageMetadata(parsed[3]))
      assertEquals(listOf("Output tokens" to "4"), chatMessageMetadata(parsed[4]))
      assertTrue(parsed[3].isError && parsed[4].isError)
      assertTrue(chatMessageMetadata(parsed[5]).isEmpty())
      assertTrue(chatMessageMetadata(parsed[6]).isEmpty())
      assertEquals(listOf("Cache write" to "9"), chatMessageMetadata(parsed[7]))
    }

  private fun chatText(message: ChatMessage) = message.content.mapNotNull { it.text }.joinToString("")
}
