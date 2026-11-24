package ai.openclaw.app.chat

import ai.openclaw.app.PersonalSessionPinAccess
import ai.openclaw.app.gateway.GatewayErrorDetails
import ai.openclaw.app.gateway.GatewayRequestNotEnqueued
import ai.openclaw.app.gateway.GatewayRequestRejected
import ai.openclaw.app.gateway.GatewaySession
import ai.openclaw.app.ui.awaitSessionStatusExpiry
import ai.openclaw.app.ui.nextSessionPin
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class ChatControllerSessionWakeRecoveryTest {
  private val json = Json { ignoreUnknownKeys = true }
  private val gateway = ScriptedGateway(json)
  private var connection = ChatCacheScope("gateway", 1)
  private var operatorEpoch = 1L
  private var agent = "main"
  private var agentRevision = 1L
  private var socket = 1
  private var beforeEnqueue: suspend () -> Unit = {}

  private suspend fun TestScope.loadPage(serverNow: Long = 100): ChatController {
    gateway.respondWith("sessions.list", """{"ts":$serverNow,"activityExpiresAt":${serverNow + 99},"sessions":[{"key":"recent"}],"hasMore":true,"nextOffset":1}""")
    return ChatController(
      scope = this,
      commandOutbox = createChatCommandOutbox(),
      json = json,
      requestGateway = gateway::request,
      cacheScope = { connection },
      currentGatewayCatalogRevision = { operatorEpoch },
      currentDefaultAgentId = { agent },
      currentDefaultAgentRevision = { agentRevision },
      captureRequestLease = {
        val capturedSocket = socket
        GatewaySession.RequestLease(connection.gatewayId, isCurrentImpl = { socket == capturedSocket }) { method, params, _, guard ->
          beforeEnqueue()
          if (socket != capturedSocket) throw GatewayRequestNotEnqueued("socket retired")
          guard {}
          gateway.request(method, params)
        }
      },
    ).also { controller ->
      controller.outboxPresentationRestored.first { it }
      controller.refreshSessions(limit = 1)
      runCurrent()
      assertEquals(listOf("recent"), controller.sessions.value.map { it.key })
    }
  }

  private fun refuse(
    code: String,
    retryAfterMs: Int? = null,
  ): Nothing =
    throw GatewayRequestRejected(
      GatewaySession.ErrorShape(code, "roster read refused", retryAfterMs?.let { GatewayErrorDetails(null, false, null, reason = "gateway-suspending", method = "sessions.list", retryAfterMs = it) }, retryable = retryAfterMs != null),
    )

  @Test
  fun liveSnoozeUsesIssuingGatewayTimeForExistingAndNewRows() =
    runTest {
      val before = System.currentTimeMillis()
      val serverNow = before - 300_000L
      val controller = loadPage(serverNow)
      val after = System.currentTimeMillis()
      val raw = serverNow + 60_000L
      val access = PersonalSessionPinAccess.Verified(ownSessionsOnly = false, savedKeys = setOf("recent"))

      fun peerSnoozes(key: String): ChatSessionEntry {
        controller.handleGatewayEvent("sessions.changed", """{"agentId":"main","session":{"key":"$key","pinned":false,"snoozedUntil":$raw}}""")
        return controller.sessions.value.single { it.key == key }
      }
      for (key in listOf("recent", "new")) {
        val row = peerSnoozes(key)
        val wake = requireNotNull(row.localSnoozeWakeMs)
        assertEquals(raw, row.snoozedUntil)
        assertTrue("Gateway's one-minute snooze is not expired locally", wake in (before + 60_000L)..(after + 60_000L))
        assertEquals(false.takeIf { key == "recent" }, access.nextSessionPin(row, wake - 1))
        assertEquals(true, access.nextSessionPin(row, wake))
      }
      // A socket reconnect keeps the cache scope but may reach a restarted Gateway clock.
      controller.onDisconnected("socket closed")
      assertFalse(peerSnoozes("recent").isSnoozed(after))
      connection = connection.copy(connectionGeneration = connection.connectionGeneration + 1)
      assertFalse(peerSnoozes("new").isSnoozed(after))
    }

  @Test
  fun menuSnoozeSavesTheChosenHandsetTimeInGatewayTime() =
    runTest {
      val before = System.currentTimeMillis()
      val serverNow = before - 300_000L
      val controller = loadPage(serverNow)
      val after = System.currentTimeMillis()
      gateway.respondWith("sessions.patch", "{}")
      val chosen = after + 3_600_000L
      assertTrue(controller.patchSession(ChatSessionPatch(key = "recent", ownerAgentId = "main", expectedSessionId = "recent-id", snoozedUntil = chosen)))
      val patch = json.parseToJsonElement(requireNotNull(gateway.calls.last { it.method == "sessions.patch" }.paramsJson)).jsonObject
      val sent = requireNotNull(patch["snoozedUntil"]?.toString()?.toLong())
      // The handset is five minutes fast, so the Gateway deadline is five minutes earlier.
      assertTrue(sent in (chosen - (after - serverNow))..(chosen - (before - serverNow)))
      controller.handleGatewayEvent("sessions.changed", """{"agentId":"main","session":{"key":"recent","snoozedUntil":$sent}}""")
      val wake =
        requireNotNull(
          controller.sessions.value
            .single { it.key == "recent" }
            .localSnoozeWakeMs,
        )
      assertTrue("the label shows the chosen time", wake in (chosen - (after - before))..(chosen + (after - before)))
    }

  @Test
  fun twoVisibleClaimantsShareOneHintedRetryOfTheLoadedPrefix() =
    runTest {
      val controller = loadPage()
      val wake = requireNotNull(controller.sessionWindowWake.value)
      gateway.respondWith("sessions.list", """{"sessions":[{"key":"next"}],"hasMore":true,"nextOffset":2}""")
      assertTrue(controller.loadMoreSessions())
      var attempts = 0
      gateway.respond("sessions.list") {
        if (++attempts == 1) refuse("UNAVAILABLE", retryAfterMs = 1_000)
        """{"sessions":[{"key":"old-pin","pinned":true},{"key":"recent"}]}"""
      }
      val beforeFailure = System.currentTimeMillis()
      repeat(2) { controller.refreshSessionsAfterWake(wake) }
      runCurrent()
      val revision = controller.sessionBrowserRevision.value
      assertEquals(1, attempts)
      assertEquals(listOf("recent", "next"), controller.sessions.value.map { it.key })
      val retry = controller.sessionWindowWake.value
      assertNotNull("a transient failure must leave a retry for the mounted views", retry)
      val clock = testScheduler.currentTime
      val delay = 1_000L
      assertTrue(requireNotNull(retry).localMs in (beforeFailure + delay)..(System.currentTimeMillis() + delay))
      val local = retry.localMs - delay
      // The old waiter cannot steal this retry, and two visible waiters must still share it.
      controller.refreshSessionsAfterWake(wake)
      repeat(2) {
        launch {
          awaitSessionStatusExpiry(retry.localMs, nowMs = { local + testScheduler.currentTime - clock })
          controller.refreshSessionsAfterWake(retry)
        }
      }
      testScheduler.advanceTimeBy(delay)
      assertEquals(1, attempts)
      runCurrent()
      assertEquals(2, attempts)
      assertEquals(listOf("old-pin", "recent"), controller.sessions.value.map { it.key })
      assertEquals(
        true,
        controller.sessions.value
          .first()
          .pinned,
      )
      assertNull(controller.sessionWindowWake.value)
      assertEquals(revision + 1, controller.sessionBrowserRevision.value)
      assertTrue(
        gateway.calls.filter { it.method == "sessions.list" }.takeLast(2).all {
          val params = json.parseToJsonElement(requireNotNull(it.paramsJson)).jsonObject
          params["limit"] == JsonPrimitive(2) && params["offset"] == null && params["agentId"] == JsonPrimitive("main")
        },
      )
      controller.refreshSessionsAfterWake(retry)
      testScheduler.advanceTimeBy(60_000)
      runCurrent()
      assertEquals(2, attempts)
    }

  @Test
  fun permanentRefusalAndRepeatedUnavailabilityDoNotPoll() =
    runTest {
      for (code in listOf("FORBIDDEN", "UNAVAILABLE")) {
        val controller = loadPage()
        val wake = requireNotNull(controller.sessionWindowWake.value)
        var attempts = 0
        gateway.respond("sessions.list") {
          attempts++
          refuse(code)
        }
        controller.refreshSessionsAfterWake(wake)
        runCurrent()
        if (code == "UNAVAILABLE") {
          val retry = requireNotNull(controller.sessionWindowWake.value)
          // Once the view leaves there is no background poll. A remount can claim the retry.
          testScheduler.advanceTimeBy(60_000)
          assertEquals(1, attempts)
          controller.refreshSessionsAfterWake(retry)
          runCurrent()
          controller.refreshSessionsAfterWake(retry)
        }
        controller.refreshSessionsAfterWake(wake)
        testScheduler.advanceTimeBy(60_000)
        runCurrent()
        assertEquals(if (code == "UNAVAILABLE") 2 else 1, attempts)
        assertNull(controller.sessionWindowWake.value)
        assertEquals(listOf("recent"), controller.sessions.value.map { it.key })
      }
    }

  @Test
  fun cursorAppendCannotDischargeARetryButAnAcceptedRefreshCan() =
    runTest {
      val controller = loadPage()
      val wake = requireNotNull(controller.sessionWindowWake.value)
      gateway.respond("sessions.list") { refuse("UNAVAILABLE") }
      controller.refreshSessionsAfterWake(wake)
      runCurrent()
      val retry = requireNotNull(controller.sessionWindowWake.value)
      gateway.respondWith("sessions.list", """{"sessions":[{"key":"next"}]}""")
      assertTrue(controller.loadMoreSessions())
      assertEquals(retry, controller.sessionWindowWake.value)
      gateway.respondWith("sessions.list", """{"ts":201,"activityExpiresAt":299,"sessions":[{"key":"restored","pinned":true}]}""")
      controller.refreshSessionsForCurrentWindow()
      runCurrent()
      val reads = gateway.callCount("sessions.list")
      controller.refreshSessionsAfterWake(retry)
      runCurrent()
      assertEquals(reads, gateway.callCount("sessions.list"))
      assertEquals(300L, controller.sessionWindowWake.value?.serverMs)
      assertEquals(listOf("restored"), controller.sessions.value.map { it.key })
    }

  @Test
  fun distinctRowWakeCannotErasePendingRecoveryAndScopedQueriesReadOnceAfterIt() =
    runTest {
      val controller = loadPage()
      val wake = requireNotNull(controller.sessionWindowWake.value)
      val revision = controller.sessionBrowserRevision.value
      val queries =
        async {
          controller.sessionBrowserRevision.first { it != revision }
          listOf(controller.fetchSessionList("Cedar", false), controller.fetchSessionList(null, true))
        }
      gateway.respond("sessions.list") { refuse("UNAVAILABLE") }
      controller.refreshSessionsAfterWake(wake)
      runCurrent()
      val retry = requireNotNull(controller.sessionWindowWake.value)
      val other = SessionWakeDeadline(wake.serverMs + 50, wake.localMs + 50)
      gateway.respond("sessions.list") { refuse("FORBIDDEN") }
      controller.refreshSessionsAfterWake(other)
      runCurrent()
      assertEquals(retry, controller.sessionWindowWake.value)
      assertFalse(queries.isCompleted)
      gateway.respond("sessions.list") { raw ->
        val params = json.parseToJsonElement(requireNotNull(raw)).jsonObject
        when {
          params["search"] == JsonPrimitive("Cedar") -> """{"sessions":[{"key":"Cedar","pinned":true}]}"""
          params["archived"] == JsonPrimitive(true) -> """{"sessions":[{"key":"archived","archived":true}]}"""
          else -> """{"sessions":[{"key":"recent"}]}""" // Only the scoped reads change.
        }
      }
      controller.refreshSessionsAfterWake(retry)
      runCurrent()
      assertEquals(listOf("Cedar", "archived"), queries.await().map { it?.single()?.key })
      assertEquals(revision + 1, controller.sessionBrowserRevision.value)
      val reads = gateway.callCount("sessions.list")
      controller.refreshSessionsAfterWake(wake)
      controller.refreshSessionsAfterWake(other)
      runCurrent()
      assertEquals(reads, gateway.callCount("sessions.list"))
    }

  @Test
  fun agentChangeWhileTheTransportWaitsPreventsRetryEnqueue() =
    runTest {
      val controller = loadPage()
      val wake = requireNotNull(controller.sessionWindowWake.value)
      gateway.respond("sessions.list") { refuse("UNAVAILABLE") }
      controller.refreshSessionsAfterWake(wake)
      runCurrent()
      val reads = gateway.callCount("sessions.list")
      val entered = CompletableDeferred<Unit>()
      val release = CompletableDeferred<Unit>()
      beforeEnqueue = {
        entered.complete(Unit)
        release.await()
      }
      controller.refreshSessionsAfterWake(requireNotNull(controller.sessionWindowWake.value))
      entered.await()
      agent = "new-agent"
      release.complete(Unit)
      runCurrent()
      assertEquals(reads, gateway.callCount("sessions.list"))
      assertNull(controller.sessionWindowWake.value)
    }

  @Test
  fun supersededOwnersCannotDispatchPendingRetriesOrPublishTheirLateResults() =
    runTest {
      val retireOwners =
        listOf<() -> Unit>(
          { connection = connection.copy(gatewayId = connection.gatewayId + "-next") },
          { connection = connection.copy(connectionGeneration = connection.connectionGeneration + 1) },
          { operatorEpoch++ },
          { socket++ },
          { agent += "-next" },
          { agentRevision++ },
        )
      for (retire in retireOwners) {
        for (inFlight in listOf(false, true)) {
          val controller = loadPage()
          val wake = requireNotNull(controller.sessionWindowWake.value)
          gateway.respond("sessions.list") { refuse("UNAVAILABLE") }
          controller.refreshSessionsAfterWake(wake)
          runCurrent()
          val retry = requireNotNull(controller.sessionWindowWake.value)
          val held = CompletableDeferred<String>()
          var requested = false
          gateway.respond("sessions.list") {
            requested = true
            held.await()
          }
          if (!inFlight) retire()
          controller.refreshSessionsAfterWake(retry)
          runCurrent()
          assertEquals(inFlight, requested)
          assertNull(controller.sessionWindowWake.value)
          if (inFlight) retire()
          held.complete("""{"sessions":[{"key":"wrong-owner","pinned":true}]}""")
          runCurrent()
          assertFalse(controller.sessions.value.any { it.key == "wrong-owner" })
        }
      }
    }
}
