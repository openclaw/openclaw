package ai.openclaw.app.chat

import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.gateway.DeviceAuthStore
import ai.openclaw.app.gateway.DeviceIdentityStore
import ai.openclaw.app.gateway.GatewaySession
import java.lang.reflect.Field
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@RunWith(RobolectricTestRunner::class)
class ChatControllerSessionPolicyTest {
  @Test
  fun applyMainSessionKeyMovesCurrentSessionWhenStillOnDefault() {
    val state =
      applyMainSessionKey(
        currentSessionKey = "main",
        appliedMainSessionKey = "main",
        nextMainSessionKey = "agent:ops:node-device",
      )

    assertEquals("agent:ops:node-device", state.currentSessionKey)
    assertEquals("agent:ops:node-device", state.appliedMainSessionKey)
  }

  @Test
  fun applyMainSessionKeyKeepsUserSelectedSession() {
    val state =
      applyMainSessionKey(
        currentSessionKey = "custom",
        appliedMainSessionKey = "agent:ops:node-old",
        nextMainSessionKey = "agent:ops:node-new",
      )

    assertEquals("custom", state.currentSessionKey)
    assertEquals("agent:ops:node-new", state.appliedMainSessionKey)
  }

  @Test
  fun ignoresStreamingEventsWithoutMatchingSessionKey() = runBlocking {
    val controller = buildController()
    controller.load("agent:main:chat-1")

    controller.handleGatewayEvent(
      "chat",
      """{"state":"delta","sessionKey":"agent:main:chat-2","message":{"role":"assistant","content":[{"type":"text","text":"leak"}]}}""",
    )
    assertNull(controller.streamingAssistantText.first())

    controller.handleGatewayEvent(
      "chat",
      """{"state":"delta","message":{"role":"assistant","content":[{"type":"text","text":"blank"}]}}""",
    )
    assertNull(controller.streamingAssistantText.first())

    controller.handleGatewayEvent(
      "agent",
      """{"stream":"assistant","sessionKey":"agent:main:chat-2","data":{"text":"tool leak"}}""",
    )
    assertNull(controller.streamingAssistantText.first())

    controller.handleGatewayEvent(
      "agent",
      """{"stream":"assistant","data":{"text":"blank tool leak"}}""",
    )
    assertNull(controller.streamingAssistantText.first())

    controller.handleGatewayEvent(
      "agent",
      """{"stream":"assistant","sessionKey":"agent:main:chat-1","data":{"text":"ok"}}""",
    )
    assertEquals("ok", controller.streamingAssistantText.first())
  }

  @Test
  fun canDeleteSessionRejectsMainAliases() {
    assertFalse(canDeleteSession("main", "main"))
    assertFalse(canDeleteSession("main", "agent:ops:main"))
    assertFalse(canDeleteSession("agent:ops:main", "agent:ops:main"))
    assertTrue(canDeleteSession("agent:ops:subagent:abc", "agent:ops:main"))
  }

  @Test
  fun resolveDeletionFallbackPrefersSameAgentMainThenRecentSession() {
    val sessions =
      listOf(
        ChatSessionEntry(key = "agent:ops:main", updatedAtMs = 100L),
        ChatSessionEntry(key = "agent:ops:subagent:older", updatedAtMs = 90L),
        ChatSessionEntry(key = "agent:main:main", updatedAtMs = 80L),
      )

    assertEquals(
      "agent:ops:main",
      resolveDeletionFallbackSessionKey(
        currentSessionKey = "agent:ops:subagent:older",
        sessions = sessions,
        mainSessionKey = "agent:main:main",
      ),
    )

    assertEquals(
      "agent:main:main",
      resolveDeletionFallbackSessionKey(
        currentSessionKey = "agent:main:subagent:missing",
        sessions = sessions,
        mainSessionKey = "agent:main:main",
      ),
    )
  }

  @Test
  fun deleteSessionThroughGatewayUsesCanonicalDeleteTranscriptPayload() = runBlocking {
    var requestedMethod: String? = null
    var requestedParamsJson: String? = null

    val outcome =
      deleteSessionThroughGateway(
        request = { method, paramsJson ->
          requestedMethod = method
          requestedParamsJson = paramsJson
          GatewaySession.RpcResult(
            ok = true,
            payloadJson = """{"ok":true,"deleted":true}""",
            error = null,
          )
        },
        sessionKey = "agent:ops:subagent:abc",
      )

    assertTrue(outcome.deleted)
    assertNull(outcome.errorText)
    assertEquals("sessions.delete", requestedMethod)
    val params = Json.parseToJsonElement(requestedParamsJson ?: error("missing params")).jsonObject
    assertEquals("agent:ops:subagent:abc", params.getValue("key").jsonPrimitive.content)
    assertTrue(params.getValue("deleteTranscript").jsonPrimitive.boolean)
  }

  @Test
  fun deleteSessionThroughGatewayReturnsGatewayErrorMessage() = runBlocking {
    val outcome =
      deleteSessionThroughGateway(
        request = { _, _ ->
          GatewaySession.RpcResult(
            ok = false,
            payloadJson = null,
            error = GatewaySession.ErrorShape(code = "FORBIDDEN", message = "missing scope: operator.admin"),
          )
        },
        sessionKey = "agent:ops:subagent:abc",
      )

    assertFalse(outcome.deleted)
    assertEquals("missing scope: operator.admin", outcome.errorText)
  }

  @Test
  fun resolveAuthoritativeCurrentSessionKeyFallsBackWhenCurrentMissing() {
    val sessions =
      listOf(
        ChatSessionEntry(key = "agent:ops:main", updatedAtMs = 200L),
        ChatSessionEntry(key = "agent:ops:subagent:newer", updatedAtMs = 150L),
        ChatSessionEntry(key = "agent:main:main", updatedAtMs = 100L),
      )

    assertEquals(
      "agent:ops:main",
      resolveAuthoritativeCurrentSessionKey(
        currentSessionKey = "agent:ops:subagent:missing",
        sessions = sessions,
        mainSessionKey = "agent:main:main",
      ),
    )
  }

  @Test
  fun createSessionIgnoresDuplicateInFlightRequests() {
    runBlocking {
      val gate = CompletableDeferred<String?>()
      var calls = 0
      val controller =
        buildController(
          createSessionRequest = {
            calls += 1
            gate.await()
          },
        )

      controller.createSession()
      controller.createSession()

      assertEquals(1, calls)
      assertTrue(controller.sessionActionInFlight.first())

      gate.complete("agent:main:chat-2")
    }
  }

  @Test
  fun deleteSessionIgnoresDuplicateInFlightRequests() {
    runBlocking {
      val gate = CompletableDeferred<DeleteSessionOutcome>()
      var calls = 0
      val controller =
        buildController(
          deleteSessionRequest = {
            calls += 1
            gate.await()
          },
        )

      controller.load("agent:ops:subagent:abc")
      controller.deleteCurrentSession()
      controller.deleteCurrentSession()

      assertEquals(1, calls)
      assertTrue(controller.sessionActionInFlight.first())

      gate.complete(DeleteSessionOutcome(deleted = true))
    }
  }

  @Test
  fun switchSessionIsBlockedWhileRunIsPending() = runBlocking {
    val controller = buildController()
    controller.load("agent:main:chat-1")
    mutableIntStateField(controller, "_pendingRunCount").value = 1

    controller.switchSession("agent:main:chat-2")

    assertEquals("agent:main:chat-1", controller.sessionKey.first())
    assertEquals("Wait for the current run to finish before changing chats.", controller.errorText.first())
  }

  private fun buildController(
    createSessionRequest: suspend (String) -> String? = { null },
    deleteSessionRequest: suspend (String) -> DeleteSessionOutcome = { DeleteSessionOutcome(deleted = false) },
  ): ChatController {
    val context = RuntimeEnvironment.getApplication()
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
    val session =
      GatewaySession(
        scope = scope,
        identityStore = DeviceIdentityStore(context),
        deviceAuthStore = DeviceAuthStore(SecurePrefs(context)),
        onConnected = { _, _, _ -> },
        onDisconnected = { _ -> },
        onEvent = { _, _ -> },
      )
    return ChatController(
      scope = scope,
      session = session,
      json = Json { ignoreUnknownKeys = true },
      supportsChatSubscribe = false,
      createSessionRequest = createSessionRequest,
      deleteSessionRequest = deleteSessionRequest,
    )
  }

  @Suppress("UNCHECKED_CAST")
  private fun mutableIntStateField(controller: ChatController, name: String): kotlinx.coroutines.flow.MutableStateFlow<Int> {
    val field: Field = ChatController::class.java.getDeclaredField(name)
    field.isAccessible = true
    return field.get(controller) as kotlinx.coroutines.flow.MutableStateFlow<Int>
  }
}
