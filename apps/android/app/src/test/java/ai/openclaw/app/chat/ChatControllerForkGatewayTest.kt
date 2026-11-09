package ai.openclaw.app.chat

import ai.openclaw.app.gateway.GatewaySession
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class ChatControllerForkGatewayTest {
  @Test
  fun forkResultRetainsGatewayOwnershipAcrossCreateAndRosterRefresh() =
    runTest {
      for (heldMethod in listOf("sessions.create", "sessions.list")) {
        for (retirement in Retirement.entries) {
          val fixture = ForkFixture(this, heldMethod)
          fixture.controller.outboxPresentationRestored.first { it }
          val fork =
            async {
              fixture.controller.forkSession("custom", "main", fromLastCompleted = true)
            }
          try {
            fixture.entered.await()
            assertFalse(fork.isCompleted)
            fixture.retire(retirement)
            fixture.release.complete(Unit)

            val result = fork.await()
            assertEquals(
              "$heldMethod / $retirement",
              if (retirement == Retirement.None) "agent:main:fork-a" else null,
              result,
            )
            val create = fixture.calls.single { it.method == "sessions.create" }
            assertEquals("gateway-a", create.owner.gatewayId)
            val params = chatControllerTestJson.parseToJsonElement(create.params!!).jsonObject
            assertEquals(JsonPrimitive("custom"), params["parentSessionKey"])
            assertEquals(JsonPrimitive("main"), params["agentId"])
            assertEquals(JsonPrimitive(true), params["fork"])
            assertEquals(JsonPrimitive("last-completed"), params["forkFrom"])
            val expectedLists =
              if (heldMethod == "sessions.create" && retirement != Retirement.None) 0 else 1
            assertEquals(expectedLists, fixture.calls.count { it.method == "sessions.list" })
            assertNull(fixture.controller.errorText.value)
          } finally {
            fixture.release.complete(Unit)
            fork.cancelAndJoin()
          }
        }
      }
    }

  @Test
  fun forkFailureCannotReplaceAnErrorOwnedByTheReplacementGateway() =
    runTest {
      for (retirement in Retirement.entries) {
        val fixture = ForkFixture(this, "sessions.create", failCreate = true)
        fixture.controller.outboxPresentationRestored.first { it }
        val fork = async { fixture.controller.forkSession("custom", "main") }
        try {
          fixture.entered.await()
          fixture.retire(retirement)
          fixture.controller.handleGatewayEvent("agent", """{"stream":"error"}""")
          val currentError = fixture.controller.errorText.value
          assertFalse(currentError.isNullOrEmpty())
          fixture.release.complete(Unit)

          assertNull(fork.await())
          assertEquals(
            retirement.name,
            if (retirement == Retirement.None) "Fork rejected" else currentError,
            fixture.controller.errorText.value,
          )
          assertEquals(1, fixture.calls.count { it.method == "sessions.create" })
          assertEquals(0, fixture.calls.count { it.method == "sessions.list" })
        } finally {
          fixture.release.complete(Unit)
          fork.cancelAndJoin()
        }
      }
    }

  @Test
  fun forkAtEntryRetainsGatewayOwnershipForRosterRefreshAndErrors() =
    runTest {
      for (failFork in listOf(false, true)) {
        for (retirement in listOf(Retirement.None, Retirement.Gateway, Retirement.Reconnect)) {
          val fixture = ForkFixture(this, "sessions.fork", failFork = failFork)
          fixture.controller.outboxPresentationRestored.first { it }
          val fork = async { fixture.controller.forkSessionAtEntry("main", "entry-1") }
          try {
            fixture.entered.await()
            fixture.retire(retirement)
            if (failFork && retirement != Retirement.None) {
              fixture.controller.handleGatewayEvent("agent", """{"stream":"error"}""")
            }
            val replacementError = fixture.controller.errorText.value
            fixture.release.complete(Unit)

            val result = fork.await()
            if (!failFork && retirement == Retirement.None) {
              assertEquals("agent:main:fork-entry-a", result?.sessionKey)
            } else {
              assertNull(result)
            }
            assertEquals(0, fixture.calls.count { it.method == "sessions.list" })
            if (failFork) {
              assertEquals(
                if (retirement == Retirement.None) "Entry fork rejected" else replacementError,
                fixture.controller.errorText.value,
              )
            }
          } finally {
            fixture.release.complete(Unit)
            fork.cancelAndJoin()
          }
        }
      }
    }

  private enum class Retirement { None, Gateway, Reconnect, Socket }

  private data class Call(
    val owner: ChatCacheScope,
    val method: String,
    val params: String?,
  )

  private class ForkFixture(
    scope: CoroutineScope,
    private val heldMethod: String,
    private val failCreate: Boolean = false,
    private val failFork: Boolean = false,
  ) {
    private var gatewayScope = ChatCacheScope("gateway-a", 1L)
    private var socketCurrent = true
    val entered = CompletableDeferred<Unit>()
    val release = CompletableDeferred<Unit>()
    val calls = mutableListOf<Call>()
    val controller =
      scope.createChatController(
        cacheScope = { gatewayScope },
        requestGateway = { method, params -> request(gatewayScope, method, params) },
        captureRequestLease = { captured ->
          val owner = requireNotNull(captured)
          GatewaySession.RequestLease(
            endpointStableId = owner.gatewayId,
            isCurrentImpl = { socketCurrent },
          ) { method, params, _, withEnqueue ->
            withEnqueue {}
            request(owner, method, params)
          }
        },
      )

    fun retire(retirement: Retirement) {
      when (retirement) {
        Retirement.None -> {
          return
        }

        Retirement.Gateway -> {
          gatewayScope = ChatCacheScope("gateway-b", 2L)
        }

        Retirement.Reconnect -> {
          gatewayScope = ChatCacheScope("gateway-a", 2L)
        }

        Retirement.Socket -> {
          socketCurrent = false
        }
      }
      // Keep the old lease live for logical-scope cases, as a background Gateway can be.
      controller.onGatewayScopeChanging()
    }

    private suspend fun request(
      owner: ChatCacheScope,
      method: String,
      params: String?,
    ): String {
      calls += Call(owner, method, params)
      if (method == heldMethod) {
        entered.complete(Unit)
        release.await()
      }
      return when (method) {
        "sessions.create" -> {
          if (failCreate) error("Fork rejected")
          """{"key":"agent:main:fork-a"}"""
        }

        "sessions.fork" -> {
          if (failFork) error("Entry fork rejected")
          """{"sessionKey":"agent:main:fork-entry-a"}"""
        }

        "sessions.list" -> {
          """{"sessions":[]}"""
        }

        else -> {
          emptyChatGatewayResponse(method)
        }
      }
    }
  }
}
