package ai.openclaw.app.voice

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class RealtimeAgentCoordinatorTest {
  @Test
  fun `consult correlates the active run and submits its final text`() =
    runTest {
      val calls = mutableListOf<GatewayCall>()
      val working = mutableListOf<RealtimeAgentSession>()
      val coordinator =
        coordinator(
          calls = calls,
          responses = { method -> if (method == "talk.client.toolCall") """{"runId":"run-1"}""" else "{}" },
          onWorking = working::add,
        )
      val session = RealtimeAgentSession("relay-1", "session-1")
      coordinator.beginSession(session)

      assertTrue(
        coordinator.handleToolCall(
          callId = "call-1",
          name = "openclaw_agent_consult",
          args = null,
          forced = false,
        ),
      )
      runCurrent()

      assertEquals(listOf(session), working)
      assertFalse(
        coordinator.handleChatEvent(
          sessionKey = "other-session",
          runId = "run-1",
          state = "final",
          message = Json.parseToJsonElement("""{"role":"assistant","content":"wrong"}"""),
        ),
      )
      assertTrue(
        coordinator.handleChatEvent(
          sessionKey = "session-1",
          runId = "run-1",
          state = "final",
          message = Json.parseToJsonElement("""{"role":"assistant","content":"done"}"""),
        ),
      )
      runCurrent()

      val consult = calls.single { it.method == "talk.client.toolCall" }
      assertEquals(15_000L, consult.timeoutMs)
      assertTrue(consult.params.contains("\"name\":\"openclaw_agent_consult\""))
      val result = calls.single { it.method == "talk.session.submitToolResult" }
      assertTrue(result.params.contains("\"sessionId\":\"relay-1\""))
      assertTrue(result.params.contains("\"callId\":\"call-1\""))
      assertTrue(result.params.contains("\"text\":\"done\""))
    }

  @Test
  fun `early completion waits for run metadata`() =
    runTest {
      val calls = mutableListOf<GatewayCall>()
      val response = CompletableDeferred<String>()
      val coordinator =
        coordinator(
          calls = calls,
          responses = { method -> if (method == "talk.client.toolCall") response.await() else "{}" },
        )
      coordinator.beginSession(RealtimeAgentSession("relay-1", "session-1"))
      coordinator.handleToolCall("call-1", "openclaw_agent_consult", null, forced = false)
      runCurrent()

      assertTrue(
        coordinator.handleChatEvent(
          sessionKey = "session-1",
          runId = "run-early",
          state = "final",
          message = Json.parseToJsonElement("""{"role":"assistant","content":"early"}"""),
        ),
      )
      response.complete("""{"runId":"run-early"}""")
      runCurrent()

      assertTrue(
        calls
          .single { it.method == "talk.session.submitToolResult" }
          .params
          .contains("\"text\":\"early\""),
      )
    }

  @Test
  fun `validates tool names and dispatches control without a consult`() =
    runTest {
      val calls = mutableListOf<GatewayCall>()
      val coordinator =
        coordinator(
          calls = calls,
          responses = { method ->
            when (method) {
              "talk.session.steer" -> """{"status":"steered"}"""
              else -> "{}"
            }
          },
        )
      coordinator.beginSession(RealtimeAgentSession("relay-1", "session-1"))

      coordinator.handleToolCall(
        callId = "control-1",
        name = "openclaw_agent_control",
        args = Json.parseToJsonElement("""{"text":"stop","mode":"cancel"}"""),
        forced = false,
      )
      coordinator.handleToolCall(
        callId = "unknown-1",
        name = "other_tool",
        args = null,
        forced = false,
      )
      runCurrent()

      assertTrue(calls.none { it.method == "talk.client.toolCall" })
      val steer = calls.single { it.method == "talk.session.steer" }
      assertTrue(steer.params.contains("\"mode\":\"cancel\""))
      val results = calls.filter { it.method == "talk.session.submitToolResult" }
      assertTrue(results.any { it.params.contains("\"status\":\"steered\"") })
      assertTrue(results.any { it.params.contains("unsupported realtime Talk tool: other_tool") })
    }

  @Test
  fun `forced consult reports working then returns gateway errors`() =
    runTest {
      val calls = mutableListOf<GatewayCall>()
      val errors = mutableListOf<String>()
      val coordinator =
        coordinator(
          calls = calls,
          responses = { method ->
            if (method == "talk.client.toolCall") error("gateway offline") else "{}"
          },
          onError = errors::add,
        )
      coordinator.beginSession(RealtimeAgentSession("relay-1", "session-1"))

      coordinator.handleToolCall(
        callId = "call-1",
        name = "openclaw_agent_consult",
        args = null,
        forced = true,
      )
      runCurrent()

      val results = calls.filter { it.method == "talk.session.submitToolResult" }
      assertEquals(2, results.size)
      assertTrue(results[0].params.contains("\"status\":\"working\""))
      assertTrue(results[0].params.contains("\"willContinue\":true"))
      assertTrue(results[1].params.contains("\"error\":\"gateway offline\""))
      assertEquals(listOf("realtime toolCall failed: gateway offline"), errors)
    }

  @Test
  fun `session replacement quarantines the old run while a call id is reused`() =
    runTest {
      val calls = mutableListOf<GatewayCall>()
      val oldResponse = CompletableDeferred<String>()
      val newResponse = CompletableDeferred<String>()
      var requestCount = 0
      val coordinator =
        coordinator(
          calls = calls,
          responses = { method ->
            if (method != "talk.client.toolCall") {
              "{}"
            } else if (requestCount++ == 0) {
              oldResponse.await()
            } else {
              newResponse.await()
            }
          },
        )
      coordinator.beginSession(RealtimeAgentSession("relay-old", "session-main"))
      coordinator.handleToolCall("call-shared", "openclaw_agent_consult", null, forced = false)
      runCurrent()

      coordinator.beginSession(RealtimeAgentSession("relay-new", "session-main"))
      coordinator.handleToolCall("call-shared", "openclaw_agent_consult", null, forced = false)
      runCurrent()

      assertTrue(
        coordinator.handleChatEvent(
          sessionKey = "session-main",
          runId = "run-new",
          state = "final",
          message = Json.parseToJsonElement("""{"role":"assistant","content":"fresh"}"""),
        ),
      )
      newResponse.complete("""{"runId":"run-new"}""")
      runCurrent()

      val result = calls.single { it.method == "talk.session.submitToolResult" }
      assertTrue(result.params.contains("\"sessionId\":\"relay-new\""))
      assertTrue(result.params.contains("\"text\":\"fresh\""))

      oldResponse.complete("""{"runId":"run-old"}""")
      runCurrent()
      assertTrue(
        coordinator.handleChatEvent(
          sessionKey = "session-main",
          runId = "run-old",
          state = "final",
          message = Json.parseToJsonElement("""{"role":"assistant","content":"stale"}"""),
        ),
      )
      assertEquals(1, calls.count { it.method == "talk.session.submitToolResult" })
    }

  @Test
  fun `transport reset cancels an old consult before a new gateway session`() =
    runTest {
      val calls = mutableListOf<GatewayCall>()
      val oldResponse = CompletableDeferred<String>()
      val coordinator =
        coordinator(
          calls = calls,
          responses = { method -> if (method == "talk.client.toolCall") oldResponse.await() else "{}" },
        )
      coordinator.beginSession(RealtimeAgentSession("relay-old", "session-main"))
      coordinator.handleToolCall("call-old", "openclaw_agent_consult", null, forced = false)
      coordinator.handleToolCall("call-old-2", "openclaw_agent_consult", null, forced = false)
      runCurrent()

      coordinator.resetTransport()
      coordinator.beginSession(RealtimeAgentSession("relay-new", "session-main"))
      oldResponse.complete("""{"runId":"run-old"}""")
      runCurrent()

      assertTrue(calls.none { it.method == "talk.session.submitToolResult" })
      assertFalse(
        coordinator.handleChatEvent(
          sessionKey = "session-main",
          runId = "run-old",
          state = "final",
          message = Json.parseToJsonElement("""{"role":"assistant","content":"stale"}"""),
        ),
      )
    }

  @Test
  fun `old session request does not buffer a new session completion`() =
    runTest {
      val calls = mutableListOf<GatewayCall>()
      val oldResponse = CompletableDeferred<String>()
      val coordinator =
        coordinator(
          calls = calls,
          responses = { method -> if (method == "talk.client.toolCall") oldResponse.await() else "{}" },
        )
      coordinator.beginSession(RealtimeAgentSession("relay-old", "session-old"))
      coordinator.handleToolCall("call-old", "openclaw_agent_consult", null, forced = false)
      runCurrent()

      coordinator.beginSession(RealtimeAgentSession("relay-new", "session-new"))

      assertFalse(
        coordinator.handleChatEvent(
          sessionKey = "session-new",
          runId = "ordinary-run",
          state = "final",
          message = Json.parseToJsonElement("""{"role":"assistant","content":"ordinary"}"""),
        ),
      )
      oldResponse.complete("""{"runId":"run-old"}""")
      runCurrent()
      assertTrue(calls.none { it.method == "talk.session.submitToolResult" })
    }

  @Test
  fun `session replacement consumes a known old run with the same session key`() =
    runTest {
      val calls = mutableListOf<GatewayCall>()
      val coordinator =
        coordinator(
          calls = calls,
          responses = { method -> if (method == "talk.client.toolCall") """{"runId":"run-old"}""" else "{}" },
        )
      coordinator.beginSession(RealtimeAgentSession("relay-old", "session-main"))
      coordinator.handleToolCall("call-old", "openclaw_agent_consult", null, forced = false)
      runCurrent()

      coordinator.beginSession(RealtimeAgentSession("relay-new", "session-main"))

      assertTrue(
        coordinator.handleChatEvent(
          sessionKey = "session-main",
          runId = "run-old",
          state = "final",
          message = Json.parseToJsonElement("""{"role":"assistant","content":"stale"}"""),
        ),
      )
      runCurrent()

      assertTrue(calls.none { it.method == "talk.session.submitToolResult" })
    }

  @Test
  fun `session end quarantines a final that beats the old run response`() =
    runTest {
      val calls = mutableListOf<GatewayCall>()
      val unhandled = mutableListOf<RealtimeAgentUnhandledCompletion>()
      val response = CompletableDeferred<String>()
      val coordinator =
        coordinator(
          calls = calls,
          responses = { method -> if (method == "talk.client.toolCall") response.await() else "{}" },
          onUnhandledCompletion = unhandled::add,
        )
      coordinator.beginSession(RealtimeAgentSession("relay-old", "session-main"))
      coordinator.handleToolCall("call-old", "openclaw_agent_consult", null, forced = false)
      runCurrent()

      coordinator.endSession("relay-old")
      assertTrue(
        coordinator.handleChatEvent(
          sessionKey = "session-main",
          runId = "run-old",
          state = "final",
          message = Json.parseToJsonElement("""{"role":"assistant","content":"stale"}"""),
        ),
      )
      assertTrue(
        coordinator.handleChatEvent(
          sessionKey = "session-main",
          runId = "ordinary-run",
          state = "final",
          message = Json.parseToJsonElement("""{"role":"assistant","content":"ordinary"}"""),
        ),
      )
      response.complete("""{"runId":"run-old"}""")
      runCurrent()

      assertTrue(calls.none { it.method == "talk.session.submitToolResult" })
      assertEquals(listOf("ordinary-run"), unhandled.map { it.runId })
      assertEquals("session-main", unhandled.single().sessionKey)
      assertTrue(
        coordinator.handleChatEvent(
          sessionKey = "session-main",
          runId = "run-old",
          state = "final",
          message = Json.parseToJsonElement("""{"role":"assistant","content":"duplicate"}"""),
        ),
      )
    }

  @Test
  fun `early completion cache stays bounded`() =
    runTest {
      val calls = mutableListOf<GatewayCall>()
      val responses = List(3) { CompletableDeferred<String>() }
      var responseIndex = 0
      val coordinator =
        coordinator(
          calls = calls,
          responses = { method ->
            if (method == "talk.client.toolCall") responses[responseIndex++].await() else "{}"
          },
          maxCachedCompletions = 2,
        )
      coordinator.beginSession(RealtimeAgentSession("relay-1", "session-1"))
      repeat(3) { index ->
        coordinator.handleToolCall("call-${index + 1}", "openclaw_agent_consult", null, forced = false)
      }
      runCurrent()
      repeat(3) { index ->
        coordinator.handleChatEvent(
          sessionKey = "session-1",
          runId = "run-${index + 1}",
          state = "final",
          message = Json.parseToJsonElement("""{"role":"assistant","content":"result-${index + 1}"}"""),
        )
      }
      responses.forEachIndexed { index, response -> response.complete("""{"runId":"run-${index + 1}"}""") }
      runCurrent()

      val submittedCallIds =
        calls
          .filter { it.method == "talk.session.submitToolResult" }
          .map { call ->
            (Json.parseToJsonElement(call.params) as JsonObject).getValue("callId").jsonPrimitive.content
          }
      assertEquals(listOf("call-2", "call-3"), submittedCallIds)
    }

  private fun kotlinx.coroutines.test.TestScope.coordinator(
    calls: MutableList<GatewayCall>,
    responses: suspend (String) -> String,
    onWorking: (RealtimeAgentSession) -> Unit = {},
    onError: (String) -> Unit = {},
    onUnhandledCompletion: (RealtimeAgentUnhandledCompletion) -> Unit = {},
    maxCachedCompletions: Int = 128,
  ) = RealtimeAgentCoordinator(
    parentScope = backgroundScope,
    requestGateway = { method, params, timeoutMs ->
      calls += GatewayCall(method, params.orEmpty(), timeoutMs)
      responses(method)
    },
    onWorking = onWorking,
    onError = { _, message -> onError(message) },
    onUnhandledCompletion = onUnhandledCompletion,
    maxCachedCompletions = maxCachedCompletions,
  )

  private data class GatewayCall(
    val method: String,
    val params: String,
    val timeoutMs: Long,
  )
}
