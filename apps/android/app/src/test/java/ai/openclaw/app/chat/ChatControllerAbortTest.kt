package ai.openclaw.app.chat

import ai.openclaw.app.gateway.GatewayRequestOutcomeUnknown
import ai.openclaw.app.gateway.GatewayRequestRejected
import ai.openclaw.app.gateway.GatewaySession
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
@OptIn(ExperimentalCoroutinesApi::class)
class ChatControllerAbortTest {
  private val json = chatControllerTestJson

  private class AbortCall(
    val gatewayId: String,
    val params: JsonObject,
  )

  private inner class Fixture(
    test: TestScope,
  ) {
    val gateway = ScriptedGateway(json)
    var gatewayScope = ChatCacheScope("gateway-test", 1L)
    val aborts = mutableListOf<AbortCall>()
    var abortResponse: suspend (JsonObject) -> String = { """{"ok":true,"aborted":true}""" }
    val controller =
      test.backgroundScope.createChatController(
        cacheScope = { gatewayScope },
        requestGateway = gateway::request,
        requestGatewayForGateway = { gatewayId, method, params ->
          if (method == "chat.abort") {
            val parsed = json.parseToJsonElement(requireNotNull(params)).jsonObject
            aborts += AbortCall(gatewayId, parsed)
            abortResponse(parsed)
          } else {
            gateway.request(method, params)
          }
        },
      )

    init {
      gateway.respondWith("chat.history", historyResponse("session-research", emptyList()))
      gateway.respondChatSend("started")
    }

    suspend fun start(
      test: TestScope,
      sessionKey: String = "thread-1",
    ) {
      controller.switchSession(sessionKey, "research")
      test.runCurrent()
      val owner = ChatComposerOwner("gateway-test", "research", sessionKey)
      for (id in listOf("run-first", "run-second")) {
        assertTrue(controller.sendMessageForOwnerAwaitAcceptance(id, "off", emptyList(), owner, idempotencyKey = id))
      }
      assertEquals(2, controller.pendingRunCount.value)
    }
  }

  @Test
  fun stopSuppliesTheSelectedOwnerForBareAndQualifiedSessions() =
    runTest {
      for (key in listOf("thread-1", "agent:research:thread-1")) {
        val fixture = Fixture(this)
        fixture.start(this, key)
        val stopped = mutableSetOf<String>()
        fixture.abortResponse = { params ->
          // Explicit-owner Gateways resolve a bare key before looking up its run.
          if (params["agentId"]?.jsonPrimitive?.content != "research") {
            throw GatewayRequestRejected(GatewaySession.ErrorShape("INVALID_REQUEST", "Session has no explicit owner"))
          }
          stopped += params.getValue("runId").jsonPrimitive.content
          """{"ok":true,"aborted":true}"""
        }
        fixture.controller.abort()
        runCurrent()
        assertEquals(key, setOf("run-first", "run-second"), stopped)
        assertNull(fixture.controller.errorText.value)
      }
    }

  @Test
  fun navigationDuringStopDoesNotRetargetRemainingRequests() =
    runTest {
      val fixture = Fixture(this)
      fixture.start(this)
      val firstResponse = CompletableDeferred<Unit>()
      fixture.abortResponse = {
        firstResponse.await()
        """{"ok":true,"aborted":true}"""
      }
      fixture.controller.abort()
      runCurrent()
      assertEquals(1, fixture.aborts.size)
      fixture.controller.onGatewayScopeChanging(retireRunState = true)
      fixture.gatewayScope = ChatCacheScope("gateway-other", 2L)
      fixture.controller.switchSession("thread-2", "ops")
      runCurrent()
      firstResponse.complete(Unit)
      runCurrent()
      assertEquals(2, fixture.aborts.size)
      assertEquals(
        setOf("run-first", "run-second"),
        fixture.aborts
          .map {
            it.params
              .getValue("runId")
              .jsonPrimitive.content
          }.toSet(),
      )
      assertEquals(listOf("thread-1", "thread-1"), fixture.aborts.map { it.params["sessionKey"]?.jsonPrimitive?.content })
      for (call in fixture.aborts) {
        assertEquals("gateway-test", call.gatewayId)
        assertEquals("research", call.params["agentId"]?.jsonPrimitive?.content)
      }
    }

  @Test
  fun rejectedStopIsVisibleAndDoesNotDiscardRunsOrSkipRemainingRequests() = assertStopFailure(GatewayRequestRejected(GatewaySession.ErrorShape("INVALID_REQUEST", "unauthorized")))

  @Test
  fun unknownStopOutcomeIsVisibleAndDoesNotDiscardRunsOrSkipRemainingRequests() = assertStopFailure(GatewayRequestOutcomeUnknown("Gateway disconnected before response"))

  private fun assertStopFailure(failure: Throwable) =
    runTest {
      val fixture = Fixture(this)
      fixture.start(this)
      fixture.abortResponse = {
        if (fixture.aborts.size == 1) throw failure
        """{"ok":true,"aborted":true}"""
      }
      fixture.controller.abort()
      runCurrent()
      assertEquals(2, fixture.aborts.size)
      assertEquals(2, fixture.controller.pendingRunCount.value)
      assertTrue(
        fixture.controller.errorText.value
          .orEmpty()
          .contains(requireNotNull(failure.message)),
      )
    }

  @Test
  fun lateStopFailureDoesNotReplaceAnotherSelectionsError() =
    runTest {
      for (change in listOf("session", "agent", "gateway", "away-and-back")) {
        val fixture = Fixture(this)
        fixture.start(this)
        val response = CompletableDeferred<Unit>()
        fixture.abortResponse = {
          response.await()
          throw GatewayRequestOutcomeUnknown("old Stop outcome unknown")
        }
        fixture.controller.abort()
        runCurrent()
        assertEquals(1, fixture.aborts.size)
        when (change) {
          "session" -> {
            fixture.controller.switchSession("thread-2", "research")
          }

          "agent" -> {
            fixture.controller.switchSession("thread-1", "ops")
          }

          "gateway" -> {
            fixture.controller.onGatewayScopeChanging(retireRunState = true)
            fixture.gatewayScope = ChatCacheScope("gateway-other", 2L)
            fixture.controller.switchSession("thread-1", "research")
          }

          "away-and-back" -> {
            fixture.controller.switchSession("thread-2", "research")
            fixture.controller.switchSession("thread-1", "research")
          }
        }
        runCurrent()
        assertNull(fixture.controller.errorText.value)
        response.complete(Unit)
        runCurrent()
        assertEquals(2, fixture.aborts.size)
        assertNull(change, fixture.controller.errorText.value)
      }
    }

  @Test
  fun cancelledStopDoesNotContinueTheBatch() =
    runTest {
      val fixture = Fixture(this)
      fixture.start(this)
      fixture.abortResponse = { throw CancellationException("controller stopped") }
      fixture.controller.abort()
      runCurrent()
      assertEquals(1, fixture.aborts.size)
      assertNull(fixture.controller.errorText.value)
    }
}
