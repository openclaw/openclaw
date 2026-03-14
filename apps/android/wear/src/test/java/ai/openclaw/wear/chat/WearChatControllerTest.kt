package ai.openclaw.wear.chat

import ai.openclaw.wear.R
import ai.openclaw.wear.gateway.GatewayClientInterface
import ai.openclaw.wear.gateway.GatewayEvent
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

@OptIn(ExperimentalCoroutinesApi::class)
class WearChatControllerTest {
  @Test
  fun `final event clears sending when gateway returns a different run id`() = runTest {
    val client = FakeGatewayClient()
    val controllerScope = TestScope(StandardTestDispatcher(testScheduler))
    val controller = WearChatController(controllerScope, client, ::testString)
    advanceUntilIdle()

    client.historyResponses += """{"messages":[]}"""
    client.historyResponses += historyJson(userText = "Ping", assistantText = "Pong")
    client.chatSendResponse = """{"runId":"server-run"}"""

    controller.sendMessage("Ping")
    runCurrent()

    assertTrue(controller.isSending.value)

    client.emitEvent(
      GatewayEvent(
        event = "chat",
        payloadJson = """{"sessionKey":"main","state":"final","runId":"server-run"}""",
      ),
    )
    advanceUntilIdle()

    assertFalse(controller.isSending.value)
    assertEquals(listOf("Ping", "Pong"), controller.messages.value.map { it.text })
    controllerScope.cancel()
  }

  @Test
  fun `timeout clears pending send and surfaces an error`() = runTest {
    val client = FakeGatewayClient().apply {
      chatSendResponse = """{}"""
      historyResponse = """{"messages":[]}"""
    }
    val controllerScope = TestScope(StandardTestDispatcher(testScheduler))
    val controller = WearChatController(controllerScope, client, ::testString)
    advanceUntilIdle()

    controller.sendMessage("Still there?")
    runCurrent()
    assertTrue(controller.isSending.value)

    advanceTimeBy(120_000)
    advanceUntilIdle()

    assertFalse(controller.isSending.value)
    assertEquals("Timed out waiting for a reply. Try again.", controller.errorText.value)
    assertTrue(client.requests.count { it.first == "chat.history" } >= 1)
    controllerScope.cancel()
  }

  @Test
  fun `final event emits latest assistant reply for native tts`() = runTest {
    val client = FakeGatewayClient().apply {
      chatSendResponse = """{"runId":"run-1"}"""
      historyResponses += """{"messages":[]}"""
      historyResponses += historyJson(userText = "Question", assistantText = "Answer from history")
    }
    val controllerScope = TestScope(StandardTestDispatcher(testScheduler))
    val controller = WearChatController(controllerScope, client, ::testString)
    val replies = mutableListOf<String>()
    val collectJob =
      controllerScope.launch {
        controller.assistantReplies.collect { replies += it }
      }
    advanceUntilIdle()

    controller.sendMessage("Question")
    runCurrent()

    client.emitEvent(
      GatewayEvent(
        event = "chat",
        payloadJson = """{"sessionKey":"main","state":"final","runId":"run-1"}""",
      ),
    )
    advanceUntilIdle()

    assertEquals(listOf("Answer from history"), replies)
    collectJob.cancel()
    controllerScope.cancel()
  }

  @Test
  fun `main session key event switches away from placeholder session`() = runTest {
    val client = FakeGatewayClient().apply {
      historyResponse = historyJson(userText = "Scoped", assistantText = "Loaded for forwarded main session")
    }
    val controllerScope = TestScope(StandardTestDispatcher(testScheduler))
    val controller = WearChatController(controllerScope, client, ::testString)
    advanceUntilIdle()

    client.emitEvent(
      GatewayEvent(
        event = "mainSessionKey",
        payloadJson = "agent:watch-main",
      ),
    )
    runCurrent()

    assertEquals("agent:watch-main", controller.sessionKey.value)
    assertEquals(
      listOf("Scoped", "Loaded for forwarded main session"),
      controller.messages.value.map { it.text },
    )
    controllerScope.cancel()
  }

  @Test
  fun `out of order final event still resolves pending send`() = runTest {
    val client = FakeGatewayClient().apply {
      chatSendDeferred = CompletableDeferred()
      historyResponses += """{"messages":[]}"""
      historyResponses += historyJson(userText = "Ping", assistantText = "Pong")
    }
    val controllerScope = TestScope(StandardTestDispatcher(testScheduler))
    val controller = WearChatController(controllerScope, client, ::testString)
    advanceUntilIdle()

    controller.sendMessage("Ping")
    runCurrent()
    assertTrue(controller.isSending.value)

    client.emitEvent(
      GatewayEvent(
        event = "chat",
        payloadJson = """{"sessionKey":"main","state":"final","runId":"server-run"}""",
      ),
    )
    advanceUntilIdle()

    assertFalse(controller.isSending.value)
    assertEquals(listOf("Ping", "Pong"), controller.messages.value.map { it.text })

    client.chatSendDeferred?.complete("""{"runId":"server-run"}""")
    advanceUntilIdle()
    controllerScope.cancel()
  }

  @Test
  fun `history polling resolves reply when final event is missed`() = runTest {
    val client = FakeGatewayClient().apply {
      chatSendResponse = """{"runId":"server-run"}"""
      historyResponses += """{"messages":[]}"""
      historyResponses += historyJson(userText = "Ping", assistantText = "Pong from polling")
    }
    val controllerScope = TestScope(StandardTestDispatcher(testScheduler))
    val controller = WearChatController(controllerScope, client, ::testString)
    val replies = mutableListOf<String>()
    val collectJob =
      controllerScope.launch {
        controller.assistantReplies.collect { replies += it }
      }
    advanceUntilIdle()

    controller.sendMessage("Ping")
    runCurrent()
    assertTrue(controller.isSending.value)

    advanceTimeBy(1_500)
    advanceUntilIdle()

    assertFalse(controller.isSending.value)
    assertEquals(listOf("Ping", "Pong from polling"), controller.messages.value.map { it.text })
    assertEquals(listOf("Pong from polling"), replies)

    collectJob.cancel()
    controllerScope.cancel()
  }

  @Test
  fun `polling does not replay the previous assistant reply after send`() = runTest {
    val client = FakeGatewayClient().apply {
      historyResponse = historyJson(userText = "Older question", assistantText = "Older answer")
      chatSendDeferred = CompletableDeferred()
    }
    val controllerScope = TestScope(StandardTestDispatcher(testScheduler))
    val controller = WearChatController(controllerScope, client, ::testString)
    val replies = mutableListOf<String>()
    val collectJob =
      controllerScope.launch {
        controller.assistantReplies.collect { replies += it }
      }

    controller.loadHistory()
    advanceUntilIdle()
    assertEquals(listOf("Older question", "Older answer"), controller.messages.value.map { it.text })

    controller.sendMessage("New question")
    runCurrent()
    assertTrue(controller.isSending.value)

    advanceTimeBy(1_500)
    runCurrent()

    assertTrue(controller.isSending.value)
    assertEquals(
      listOf("Older question", "Older answer", "New question"),
      controller.messages.value.map { it.text },
    )
    assertTrue(replies.isEmpty())

    collectJob.cancel()
    controllerScope.cancel()
  }

  @Test
  fun `send message preserves the original user text in gateway prompt`() = runTest {
    val client = FakeGatewayClient().apply {
      chatSendResponse = """{"runId":"run-1"}"""
      historyResponse = """{"messages":[]}"""
    }
    val controllerScope = TestScope(StandardTestDispatcher(testScheduler))
    val controller = WearChatController(controllerScope, client, ::testString)
    advanceUntilIdle()

    controller.sendMessage("How are you?")
    runCurrent()

    val chatSendParams =
      client.requests.last { it.first == "chat.send" }.second ?: error("missing chat.send params")
    val message =
      Json.parseToJsonElement(chatSendParams)
        .jsonObject["message"]
        ?.jsonPrimitive
        ?.content ?: error("missing message field")

    assertEquals("How are you?", message)
    controllerScope.cancel()
  }
}

private fun testString(resId: Int): String =
  when (resId) {
    R.string.wear_chat_error_failed -> "Chat failed"
    R.string.wear_chat_error_loading_failed -> "Couldn't load chat"
    R.string.wear_chat_error_send_failed -> "Couldn't send reply"
    R.string.wear_chat_error_timed_out -> "Timed out waiting for a reply. Try again."
    else -> error("Unexpected string resource: $resId")
  }

private class FakeGatewayClient : GatewayClientInterface {
  private val _connected = MutableStateFlow(true)
  override val connected: StateFlow<Boolean> = _connected.asStateFlow()

  private val _statusText = MutableStateFlow("Connected")
  override val statusText: StateFlow<String> = _statusText.asStateFlow()

  private val _events = MutableSharedFlow<GatewayEvent>(replay = 1, extraBufferCapacity = 16)
  override val events: SharedFlow<GatewayEvent> = _events.asSharedFlow()

  var chatSendResponse: String = """{"runId":"local-run"}"""
  var chatSendDeferred: CompletableDeferred<String>? = null
  var historyResponse: String = """{"messages":[]}"""
  val historyResponses = ArrayDeque<String>()
  val requests = mutableListOf<Pair<String, String?>>()

  override suspend fun request(method: String, paramsJson: String?, timeoutMs: Long): String {
    requests += method to paramsJson
    return when (method) {
      "chat.send" -> chatSendDeferred?.await() ?: chatSendResponse
      "chat.history" -> historyResponses.removeFirstOrNull() ?: historyResponse
      "sessions.list" -> """{"sessions":[]}"""
      else -> """{}"""
    }
  }

  suspend fun emitEvent(event: GatewayEvent) {
    _events.emit(event)
  }
}

private fun historyJson(userText: String, assistantText: String): String {
  return """
    {
      "messages": [
        {
          "role": "user",
          "timestamp": 1,
          "content": [{"type":"text","text":"$userText"}]
        },
        {
          "role": "assistant",
          "timestamp": 2,
          "content": [{"type":"text","text":"$assistantText"}]
        }
      ]
    }
  """.trimIndent()
}
