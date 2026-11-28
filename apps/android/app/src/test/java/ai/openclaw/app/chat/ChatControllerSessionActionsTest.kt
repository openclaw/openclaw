package ai.openclaw.app.chat

import ai.openclaw.app.gateway.GatewayRequestNotEnqueued
import ai.openclaw.app.gateway.GatewaySession
import ai.openclaw.app.ui.awaitSessionStatusExpiry
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class ChatControllerSessionActionsTest {
  private val json = Json { ignoreUnknownKeys = true }

  private suspend fun controller(
    scope: kotlinx.coroutines.CoroutineScope,
    gateway: ScriptedGateway,
  ): ChatController =
    ChatController(
      scope = scope,
      commandOutbox = scope.createChatCommandOutbox(),
      cacheScope = { ChatCacheScope("gateway-test", 1L) },
      json = json,
      requestGateway = gateway::request,
      gatewayAdvertisesCapability = { it == "session-scoped-model-catalog" },
    ).also { it.outboxPresentationRestored.first { restored -> restored } }

  private fun ScriptedGateway.respondWithBranchHistory() {
    respondWith(
      "chat.history",
      historyResponse(
        sessionId = "session-main",
        messages = listOf(ReplayHistoryMessage("user", "hello", 1, entryId = "entry-user")),
      ),
    )
    respondWith(
      "sessions.branches.list",
      """{"branches":[{"leafEntryId":"entry-user","headline":"Current work","messageCount":1,"updatedAt":"2026-07-20T12:00:00Z","active":true}]}""",
    )
  }

  @Test
  fun snoozeAndWakeSendLifecycleIdentityAndRefreshSessions() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith("sessions.patch", "{}")
      val controller = controller(this, gateway)
      val wakeAt = 1_800_003_600_000L

      assertTrue(
        controller.patchSession(
          ChatSessionPatch(
            key = "custom",
            ownerAgentId = "main",
            expectedSessionId = "session-custom",
            snoozedUntil = wakeAt,
          ),
        ),
      )
      assertTrue(
        controller.patchSession(
          ChatSessionPatch(
            key = "custom",
            ownerAgentId = "main",
            expectedSessionId = "session-custom",
            clearSnooze = true,
          ),
        ),
      )

      val patches =
        gateway.calls.filter { it.method == "sessions.patch" }.map { json.parseToJsonElement(it.paramsJson!!).jsonObject }
      assertEquals(listOf(JsonPrimitive(wakeAt), JsonNull), patches.map { it["snoozedUntil"] })
      assertTrue(patches.all { it["key"] == JsonPrimitive("custom") })
      assertTrue(patches.all { it["agentId"] == JsonPrimitive("main") })
      assertTrue(patches.all { it["expectedSessionId"] == JsonPrimitive("session-custom") })
      assertEquals(2, gateway.callCount("sessions.list"))
      assertEquals("main", controller.sessionKey.value)
    }

  @Test
  fun personalPinWriteNeedsSupportOnItsOwnSocketAndCannotCarrySharedSettings() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith("sessions.patch", "{}")
      gateway.respondWith("sessions.list", """{"sessions":[]}""")
      var caps = emptySet<String>()
      val controller =
        ChatController(
          scope = this,
          json = json,
          commandOutbox = createChatCommandOutbox(),
          cacheScope = { ChatCacheScope("gateway-test", 1L) },
          requestGateway = gateway::request,
          captureRequestLease = {
            GatewaySession.RequestLease("gateway-test", advertisedCapabilities = caps) { method, params, _, enqueue ->
              enqueue {}
              gateway.request(method, params)
            }
          },
        )
      controller.outboxPresentationRestored.first { it }
      val pin = ChatSessionPatch(key = "thread", ownerAgentId = "main", expectedSessionId = "thread-id", pinned = true)
      assertFalse(controller.patchSession(pin))
      assertEquals("Update the Gateway to change personal session pins.", controller.errorText.value)
      caps = setOf("personal-session-pins")
      assertFalse(controller.patchSession(pin.copy(archived = false)))
      assertEquals(0, gateway.callCount("sessions.patch"))
      assertTrue(controller.patchSession(pin))
      val sent = gateway.calls.single { it.method == "sessions.patch" }
      val params = json.parseToJsonElement(sent.paramsJson!!).jsonObject
      assertEquals(JsonPrimitive(true), params["pinned"])
      assertEquals(JsonPrimitive("thread-id"), params["expectedSessionId"])
    }

  @Test
  fun aPinAcknowledgementReusesItsPushReadAndReadsAgainOnlyWhenThatReadFails() =
    runTest {
      val gateway = ScriptedGateway(json)
      var pinned = false
      var failNextRead = false
      gateway.respond("sessions.list") {
        if (failNextRead) {
          failNextRead = false
          error("roster read failed")
        }
        """{"sessions":[{"key":"thread","sessionId":"thread-id","pinned":$pinned}]}"""
      }
      var pushBeforeAck = true
      lateinit var controller: ChatController
      gateway.respond("sessions.patch") {
        pinned = !pinned
        if (pushBeforeAck) controller.handleGatewayEvent("users.prefs.changed", """{"keys":["ui.railShortcuts"]}""")
        "{}"
      }
      controller =
        ChatController(
          scope = this,
          json = json,
          commandOutbox = createChatCommandOutbox(),
          cacheScope = { ChatCacheScope("gateway-test", 1L) },
          requestGateway = gateway::request,
          captureRequestLease = {
            GatewaySession.RequestLease("gateway-test", advertisedCapabilities = setOf("personal-session-pins")) { method, params, _, enqueue ->
              enqueue {}
              gateway.request(method, params)
            }
          },
        )
      controller.outboxPresentationRestored.first { it }
      // Push read succeeds: one read. Push read fails: the ack reads again. No push: the ack reads.
      for ((push, failPushRead, reads) in listOf(Triple(true, false, 1), Triple(true, true, 2), Triple(false, false, 1))) {
        pushBeforeAck = push
        failNextRead = failPushRead
        val before = gateway.callCount("sessions.list")
        assertTrue(controller.patchSession(ChatSessionPatch(key = "thread", ownerAgentId = "main", expectedSessionId = "thread-id", pinned = !pinned)))
        runCurrent()
        assertEquals(reads, gateway.callCount("sessions.list") - before)
        assertEquals(
          pinned,
          controller.sessions.value
            .single()
            .pinned,
        )
      }
    }

  @Test
  fun personalPinChangesRefreshTheOpenRosterButUnrelatedPreferencesDoNot() =
    runTest {
      val gateway = ScriptedGateway(json)

      fun roster(pinned: Boolean) = """{"sessions":[{"key":"custom","sessionId":"session-custom","archived":true,"pinned":$pinned}]}"""
      gateway.respondWith("sessions.list", roster(false))
      val controller = controller(this, gateway)
      controller.refreshSessions(limit = 7, archived = true)
      runCurrent()
      assertEquals(
        false,
        controller.sessions.value
          .single()
          .pinned,
      )
      gateway.respondWith("sessions.list", roster(true))
      controller.handleGatewayEvent("users.prefs.changed", """{"keys":["ui.theme"]}""")
      runCurrent()
      assertEquals(1, gateway.callCount("sessions.list"))
      controller.handleGatewayEvent("users.prefs.changed", """{"keys":["ui.railShortcuts"]}""")
      runCurrent()
      assertEquals(
        true,
        controller.sessions.value
          .single()
          .pinned,
      )
      val reads = gateway.calls.filter { it.method == "sessions.list" }.map { json.parseToJsonElement(it.paramsJson!!).jsonObject }
      assertEquals(2, reads.size)
      assertEquals(reads.first()["agentId"], reads.last()["agentId"])
      assertEquals(JsonPrimitive(7), reads.last()["limit"])
      assertEquals(JsonPrimitive(true), reads.last()["archived"])
    }

  @Test
  fun wakeAndPinPushInvalidateOffWindowSearchWithoutSwitchingTheArchivedRoster() =
    runTest {
      val gateway = ScriptedGateway(json)
      var searchPin = false
      gateway.respond("sessions.list") { raw ->
        val params = json.parseToJsonElement(requireNotNull(raw)).jsonObject
        when {
          params["search"] == JsonPrimitive("Cedar") -> """{"sessions":[{"key":"cedar","pinned":$searchPin}]}"""
          params["archived"] == JsonPrimitive(true) -> """{"sessions":[{"key":"archived","archived":true}]}"""
          else -> """{"sessions":[{"key":"recent"}]}"""
        }
      }
      val controller = controller(this, gateway)
      controller.refreshSessions(limit = 7, archived = true)
      runCurrent()
      val archived = controller.sessions.value
      assertEquals(listOf("archived"), archived.map { it.key })
      assertFalse(requireNotNull(controller.fetchSessionList("Cedar", archived = false)).single().pinned == true)
      for (afterWake in listOf(true, false)) {
        val before = controller.sessionBrowserRevision.value
        val matchingRows =
          async {
            controller.sessionBrowserRevision.first { it != before }
            controller.fetchSessionList("Cedar", archived = false)
          }
        runCurrent()
        controller.handleGatewayEvent("users.prefs.changed", """{"keys":["ui.theme"]}""")
        runCurrent()
        assertFalse(matchingRows.isCompleted)
        searchPin = afterWake
        if (afterWake) {
          controller.refreshSessionsForCurrentWindow()
        } else {
          controller.handleGatewayEvent("users.prefs.changed", """{"keys":["ui.railShortcuts"]}""")
        }
        runCurrent()
        assertEquals(afterWake, requireNotNull(matchingRows.await()).single().pinned)
        assertEquals(archived, controller.sessions.value)
      }
      val windows = gateway.calls.map { json.parseToJsonElement(requireNotNull(it.paramsJson)).jsonObject }.filter { it["search"] == null }
      assertEquals(3, windows.size)
      assertTrue(windows.all { it["archived"] == JsonPrimitive(true) && it["limit"] == JsonPrimitive(7) })
    }

  @Test
  fun deletingAnArchivedRowInvalidatesItsSeparateListWithoutEvictingActiveDrawerRows() =
    runTest {
      val gateway = ScriptedGateway(json)
      var archived = true
      gateway.respond("sessions.list") { raw ->
        val params = json.parseToJsonElement(requireNotNull(raw)).jsonObject
        if (params["archived"] == JsonPrimitive(true)) {
          if (archived) """{"sessions":[{"key":"retired","archived":true}]}""" else """{"sessions":[]}"""
        } else {
          """{"sessions":[{"key":"saved","pinned":true},{"key":"recent"}]}"""
        }
      }
      val controller = controller(this, gateway)
      controller.refreshSessions(limit = 7)
      runCurrent()
      assertEquals(listOf("retired"), requireNotNull(controller.fetchSessionList(null, archived = true)).map { it.key })
      val before = controller.sessionBrowserRevision.value
      val refreshed =
        async {
          controller.sessionBrowserRevision.first { it != before }
          controller.fetchSessionList(null, archived = true)
        }
      archived = false
      controller.handleGatewayEvent("sessions.changed", """{"reason":"delete","sessionKey":"retired","agentId":"main"}""")
      assertTrue(requireNotNull(refreshed.await()).isEmpty())
      val active = controller.sessions.value
      assertEquals(listOf("saved", "recent"), active.map { it.key })
      assertEquals(true, active.first().pinned)
    }

  @Test
  fun snoozeAndWakeRequireDurableSessionIdentity() =
    runTest {
      val gateway = ScriptedGateway(json)
      val controller = controller(this, gateway)

      for (sessionId in listOf(null, " ")) {
        for (clearSnooze in listOf(false, true)) {
          assertFalse(
            controller.patchSession(
              ChatSessionPatch(
                key = "custom",
                ownerAgentId = "main",
                expectedSessionId = sessionId,
                snoozedUntil = if (clearSnooze) null else 1_800_003_600_000L,
                clearSnooze = clearSnooze,
              ),
            ),
          )
          assertEquals("Session lifecycle action requires a durable session identity.", controller.errorText.value)
        }
      }
      assertEquals(0, gateway.callCount("sessions.patch"))
      assertEquals(0, gateway.callCount("sessions.list"))
    }

  @Test
  fun rosterTimestampSchedulesSnoozeRefreshOnBothFastAndSlowHandsets() =
    runTest {
      val gateway = ScriptedGateway(json)
      val controller = controller(this, gateway)
      for (skew in listOf(-300_000L, 300_000L)) {
        val beforeRead = System.currentTimeMillis()
        val serverNow = beforeRead + skew
        val rawDeadline = serverNow + 5000L
        gateway.respondWith("sessions.list", """{"ts":$serverNow,"sessions":[{"key":"custom","snoozedUntil":$rawDeadline,"pinned":false}]}""")
        controller.refreshSessions()
        runCurrent()
        val row = controller.sessions.value.single()
        val afterRead = System.currentTimeMillis()
        assertEquals(rawDeadline, row.snoozedUntil)
        val wake = requireNotNull(SessionSnooze.nextWakeMs(listOf(row), beforeRead))
        assertTrue(wake in (beforeRead + 5000L)..(afterRead + 5000L))
        assertTrue(row.isSnoozed(wake - 1L))
        assertFalse(row.isSnoozed(wake))
        assertNull(SessionSnooze.nextWakeMs(listOf(row), wake))
      }
    }

  @Test
  fun wholeWindowExpiryRestoresAnOffPagePinOnceAfterTheServerCutoff() =
    runTest {
      for (skew in listOf(-300_000L, 300_000L)) {
        val gateway = ScriptedGateway(json)
        val rows = (1..200).map { """{"key":"recent-$it"}""" }
        val before = System.currentTimeMillis()
        val ts = before + skew
        val cutoff = ts + 999
        gateway.respondWith("sessions.list", """{"ts":$ts,"activityExpiresAt":$cutoff,"sessions":[${rows.joinToString(",")}],"totalCount":201}""")
        val controller = controller(this, gateway)
        controller.refreshSessions(limit = 200)
        runCurrent()
        val after = System.currentTimeMillis()
        assertEquals(200, controller.sessions.value.size)
        assertNull(SessionSnooze.nextWakeMs(controller.sessions.value, before))
        val wake = requireNotNull(SessionSnooze.nextWake(controller.sessions.value, before, controller.sessionWindowWake.value))
        assertEquals(cutoff + 1, wake.serverMs)
        assertTrue(wake.localMs in (before + 1_000)..(after + 1_000))

        gateway.respondWith("sessions.list", """{"ts":${cutoff + 1},"sessions":[{"key":"old-pin","pinned":true},${rows.take(199).joinToString(",")}],"totalCount":201}""")
        val localAtStart = wake.localMs - 1000
        val start = testScheduler.currentTime
        repeat(2) {
          launch {
            awaitSessionStatusExpiry(wake.localMs, nowMs = { localAtStart + testScheduler.currentTime - start })
            controller.refreshSessionsAfterWake(wake)
          }
        }
        testScheduler.advanceTimeBy(999)
        runCurrent()
        assertEquals(1, gateway.callCount("sessions.list"))
        testScheduler.advanceTimeBy(1)
        runCurrent()
        assertEquals(2, gateway.callCount("sessions.list"))
        assertEquals(
          "old-pin",
          controller.sessions.value
            .first()
            .key,
        )
        assertEquals(
          true,
          controller.sessions.value
            .first()
            .pinned,
        )
        assertNull(controller.sessionWindowWake.value)
      }
    }

  @Test
  fun sessionListParsesSnoozeAndEventsPreserveOmissionsButApplyNullClears() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith(
        "sessions.list",
        """{"sessions":[{"key":"custom","sessionId":"session-custom","snoozedUntil":1800003600000,"snoozedAt":1800000000000}]}""",
      )
      val controller = controller(this, gateway)

      controller.refreshSessions()
      runCurrent()
      val initial = controller.sessions.value.single()
      assertEquals(1_800_003_600_000L, initial.snoozedUntil)
      assertEquals(1_800_000_000_000L, initial.snoozedAt)

      controller.handleGatewayEvent(
        "sessions.changed",
        """{"sessionKey":"custom","agentId":"main","session":{"key":"custom","label":"Updated title"}}""",
      )
      runCurrent()
      val omitted = controller.sessions.value.single()
      assertEquals("Updated title", omitted.label)
      assertEquals(initial.snoozedUntil, omitted.snoozedUntil)
      assertEquals(initial.snoozedAt, omitted.snoozedAt)

      controller.handleGatewayEvent(
        "sessions.changed",
        """{"sessionKey":"custom","agentId":"main","session":{"key":"custom","snoozedUntil":null}}""",
      )
      runCurrent()
      val clearedUntil = controller.sessions.value.single()
      assertNull(clearedUntil.snoozedUntil)
      assertEquals(initial.snoozedAt, clearedUntil.snoozedAt)

      controller.handleGatewayEvent(
        "sessions.changed",
        """{"sessionKey":"custom","agentId":"main","session":{"key":"custom","snoozedAt":null}}""",
      )
      runCurrent()
      val cleared = controller.sessions.value.single()
      assertNull(cleared.snoozedUntil)
      assertNull(cleared.snoozedAt)
    }

  private inner class ArchiveFixture(
    private val scope: TestScope,
  ) {
    val gateway = ScriptedGateway(json)
    var gatewayScope = ChatCacheScope("gateway-a", 1)
    var defaultAgentId = "owner-a"
    var defaultAgentRevision = 0L
    var canonicalSessionId = "session-a"
    val routedRequests = mutableListOf<Pair<String, ScriptedGateway.Call>>()
    val controller =
      ChatController(
        scope = scope,
        commandOutbox = scope.createChatCommandOutbox(),
        json = json,
        requestGateway = gateway::request,
        requestGatewayForGateway = { gatewayId, method, params ->
          routedRequests += gatewayId to ScriptedGateway.Call(method, params)
          gateway.request(method, params)
        },
        cacheScope = { gatewayScope },
        currentDefaultAgentId = { defaultAgentId },
        currentDefaultAgentRevision = { defaultAgentRevision },
        gatewayAdvertisesCapability = { it == "session-scoped-model-catalog" },
      )
    private val archiveResponse = CompletableDeferred<String>()

    init {
      gateway.respondWith("sessions.branches.list", """{"branches":[]}""")
      gateway.respond("chat.history") { params ->
        val request = json.parseToJsonElement(params!!).jsonObject
        val key = request.getValue("sessionKey").jsonPrimitive.content
        val owner = request.getValue("agentId").jsonPrimitive.content
        historyResponse(
          sessionId = if (key == "custom") canonicalSessionId else "session-$key",
          messages = listOf(ReplayHistoryMessage("user", "${gatewayScope.gatewayId}/$owner/$key/$canonicalSessionId", 1)),
        )
      }
      gateway.respond("sessions.patch") { archiveResponse.await() }
    }

    suspend fun completeArchive(
      expectedSessionId: String = "session-a",
      ownerAgentId: String = "owner-a",
      fallsBack: Boolean = false,
      whilePending: suspend () -> Unit = {},
    ) {
      val archive =
        scope.async {
          controller.patchSession(
            ChatSessionPatch(
              key = "custom",
              ownerAgentId = ownerAgentId,
              expectedSessionId = expectedSessionId,
              archived = true,
            ),
          )
        }
      try {
        scope.runCurrent()
        assertFalse(archive.isCompleted)
        val request = json.parseToJsonElement(gateway.calls.single { it.method == "sessions.patch" }.paramsJson!!).jsonObject
        assertEquals("custom", request.getValue("key").jsonPrimitive.content)
        assertEquals(ownerAgentId, request.getValue("agentId").jsonPrimitive.content)
        assertEquals(expectedSessionId, request.getValue("expectedSessionId").jsonPrimitive.content)
        assertEquals("true", request.getValue("archived").jsonPrimitive.content)
        whilePending()
        scope.runCurrent()
        val selectedKey = controller.sessionKey.value
        val selectedOwner = controller.sessionOwnerAgentId.value
        val selectedId = controller.sessionId.value
        val selectedMessages = controller.messages.value
        assertTrue(selectedMessages.isNotEmpty())
        archiveResponse.complete("{}")
        assertTrue(archive.await())
        scope.runCurrent()
        assertNull(controller.errorText.value)
        if (fallsBack) {
          assertEquals("main", controller.sessionKey.value)
          assertEquals("session-main", controller.sessionId.value)
        } else {
          assertEquals(selectedKey, controller.sessionKey.value)
          assertEquals(selectedOwner, controller.sessionOwnerAgentId.value)
          assertEquals(selectedId, controller.sessionId.value)
          assertEquals(selectedMessages, controller.messages.value)
        }
        assertEquals("gateway-a", routedRequests.single { it.second.method == "sessions.patch" }.first)
      } finally {
        archiveResponse.complete("{}")
      }
    }
  }

  private fun TestScope.loadedArchiveFixture(ownerAgentId: String? = "owner-a"): ArchiveFixture =
    ArchiveFixture(this).also {
      it.controller.load("custom", ownerAgentId)
      runCurrent()
      assertEquals("session-a", it.controller.sessionId.value)
    }

  @Test
  fun archiveCompletionFallsBackForTheMatchingActiveOccurrence() =
    runTest {
      val fixture = loadedArchiveFixture()
      fixture.completeArchive(fallsBack = true) { fixture.controller.refresh() }
    }

  @Test
  fun archiveCompletionPreservesSameKeyCanonicalSuccessorWithoutNewSelection() =
    runTest {
      val fixture = loadedArchiveFixture()
      val selection = fixture.controller.selectionGeneration.value
      fixture.completeArchive {
        fixture.canonicalSessionId = "session-b"
        fixture.controller.refresh()
        runCurrent()
        assertEquals("session-b", fixture.controller.sessionId.value)
        assertEquals(selection, fixture.controller.selectionGeneration.value)
      }
    }

  @Test
  fun archiveCompletionPreservesSameKeyAndIdOnAnotherGateway() =
    runTest {
      val fixture = loadedArchiveFixture()
      fixture.completeArchive {
        fixture.gatewayScope = ChatCacheScope("gateway-b", 2)
        fixture.controller.onGatewayScopeChanging()
        fixture.controller.load("custom", "owner-a")
      }
    }

  @Test
  fun archiveCompletionPreservesSameKeyAndIdAfterReconnect() =
    runTest {
      val fixture = loadedArchiveFixture()
      fixture.completeArchive {
        fixture.controller.onDisconnected("reconnecting")
        fixture.gatewayScope = ChatCacheScope("gateway-a", 2)
        fixture.controller.onGatewayConnected()
      }
    }

  @Test
  fun archiveCompletionPreservesSameKeyAndIdForAnotherOwner() =
    runTest {
      val fixture = loadedArchiveFixture()
      fixture.completeArchive { fixture.controller.switchSession("custom", "owner-b") }
    }

  @Test
  fun archiveCompletionPreservesChangedDefaultOwnerWithoutNewSelection() =
    runTest {
      val fixture = loadedArchiveFixture(ownerAgentId = null)
      val selection = fixture.controller.selectionGeneration.value
      fixture.completeArchive {
        fixture.defaultAgentRevision += 1
        fixture.defaultAgentId = "owner-b"
        fixture.controller.onDefaultAgentChanged("owner-b")
        runCurrent()
        assertEquals(selection, fixture.controller.selectionGeneration.value)
      }
    }

  @Test
  fun archiveCompletionPreservesDefaultOwnerAwayAndBackToTheSameOccurrence() =
    runTest {
      val fixture = loadedArchiveFixture(ownerAgentId = null)
      val selection = fixture.controller.selectionGeneration.value
      fixture.completeArchive {
        for (owner in listOf("owner-b", "owner-a")) {
          fixture.defaultAgentRevision += 1
          fixture.defaultAgentId = owner
          fixture.controller.onDefaultAgentChanged(owner)
          runCurrent()
        }
        assertEquals(selection, fixture.controller.selectionGeneration.value)
      }
    }

  @Test
  fun archiveCompletionStillFallsBackAfterUnrelatedDefaultOwnerChange() =
    runTest {
      val fixture = loadedArchiveFixture()
      fixture.completeArchive(fallsBack = true) {
        fixture.defaultAgentRevision += 1
        fixture.defaultAgentId = "owner-b"
        fixture.controller.onDefaultAgentChanged("owner-b")
      }
    }

  @Test
  fun archiveCompletionPreservesDifferentNewerNavigation() =
    runTest {
      val fixture = loadedArchiveFixture()
      fixture.completeArchive { fixture.controller.switchSession("other", "owner-a") }
    }

  @Test
  fun archiveCompletionPreservesNavigationAwayAndBackToTheSameOccurrence() =
    runTest {
      val fixture = loadedArchiveFixture()
      fixture.completeArchive {
        fixture.controller.switchSession("other", "owner-a")
        runCurrent()
        fixture.controller.switchSession("custom", "owner-a")
      }
    }

  @Test
  fun archiveOfInactiveRowStillSucceedsWhenTheRowIsSelectedWhilePending() =
    runTest {
      val fixture = loadedArchiveFixture()
      fixture.controller.switchSession("other", "owner-a")
      runCurrent()
      fixture.completeArchive { fixture.controller.switchSession("custom", "owner-a") }
    }

  @Test
  fun archiveOfAnotherOccurrenceCannotAcquireNavigationOwnershipOnCompletion() =
    runTest {
      val fixture = loadedArchiveFixture()
      fixture.completeArchive(expectedSessionId = "session-b") {
        fixture.canonicalSessionId = "session-b"
        fixture.controller.refresh()
      }
    }

  @Test
  fun archiveOfAnotherOwnerPreservesTheActiveSameKeyOccurrence() =
    runTest {
      val fixture = loadedArchiveFixture()
      fixture.completeArchive(ownerAgentId = "owner-b")
    }

  @Test
  fun rewindReturnsEditorTextAndValidAttachmentsAndIssuesAgentScopedParams() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith(
        "sessions.rewind",
        """{"editorText":"restore me","editorAttachments":[{"mimeType":"image/png","data":"aW1hZ2U="},{"mimeType":"image/jpeg","data":"%%%"}]}""",
      )
      gateway.respondWithBranchHistory()
      val controller = controller(this, gateway)

      assertEquals(
        SessionRewindResult(
          editorText = "restore me",
          editorAttachments = listOf(SessionEditorAttachment(mimeType = "image/png", data = "aW1hZ2U=")),
        ),
        controller.rewindSessionAtEntryResult("main", "entry-user"),
      )

      val params = json.parseToJsonElement(gateway.calls.first { it.method == "sessions.rewind" }.paramsJson!!).jsonObject
      assertEquals("main", params.getValue("sessionKey").jsonPrimitive.content)
      assertEquals("main", params.getValue("agentId").jsonPrimitive.content)
      assertEquals("entry-user", params.getValue("entryId").jsonPrimitive.content)
    }

  @Test
  fun forkReturnsCreatedKeyEditorTextAndAttachmentsForLockedNativeSession() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith(
        "sessions.fork",
        """{"sessionKey":"agent:main:forked","editorText":"continue here","editorAttachments":[{"mimeType":"image/webp","data":"Zm9yaw=="}]}""",
      )
      val controller = controller(this, gateway)
      controller.handleGatewayEvent(
        "sessions.changed",
        """{"sessionKey":"main","agentId":"main","phase":"message","session":{"key":"main","modelSelectionLocked":true,"agentRuntime":{"id":"codex","source":"session"}}}""",
      )

      assertEquals(
        SessionForkResult(
          sessionKey = "agent:main:forked",
          editorText = "continue here",
          editorAttachments = listOf(SessionEditorAttachment(mimeType = "image/webp", data = "Zm9yaw==")),
        ),
        controller.forkSessionAtEntry("main", "entry-user"),
      )

      val params = json.parseToJsonElement(gateway.calls.single { it.method == "sessions.fork" }.paramsJson!!).jsonObject
      assertEquals("main", params.getValue("agentId").jsonPrimitive.content)
      assertEquals("entry-user", params.getValue("entryId").jsonPrimitive.content)
    }

  @Test
  fun refreshBranchesPublishesAllFieldsIncludingOptionalTimestamps() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith(
        "sessions.branches.list",
        """{"branches":[{"leafEntryId":"leaf-a","headline":"Earlier idea","messageCount":4,"updatedAt":"2026-07-20T12:00:00Z","active":false},{"leafEntryId":"leaf-b","headline":"Current work","messageCount":1,"updatedAt":null,"active":true}]}""",
      )
      val controller = controller(this, gateway)

      assertTrue(controller.refreshSessionBranches())
      assertEquals(
        listOf(
          SessionBranch("leaf-a", "Earlier idea", 4, "2026-07-20T12:00:00Z", active = false),
          SessionBranch("leaf-b", "Current work", 1, updatedAt = null, active = true),
        ),
        controller.sessionBranches.value,
      )
      val params = json.parseToJsonElement(gateway.calls.single().paramsJson!!).jsonObject
      assertEquals("main", params.getValue("agentId").jsonPrimitive.content)
    }

  @Test
  fun switchReturnsTrueAndRefreshesHistoryAndBranches() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith("sessions.branches.switch", "{}")
      gateway.respondWithBranchHistory()
      val controller = controller(this, gateway)

      assertTrue(controller.switchSessionBranch("main", "leaf-other"))
      assertEquals(1, gateway.callCount("sessions.branches.switch"))
      assertEquals(1, gateway.callCount("chat.history"))
      assertEquals(1, gateway.callCount("sessions.branches.list"))
    }

  @Test
  fun switchFailureReturnsFalseAndSurfacesError() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respond("sessions.branches.switch") { throw IllegalStateException("run active") }
      val controller = controller(this, gateway)

      assertFalse(controller.switchSessionBranch("main", "leaf-other"))
      assertEquals("run active", controller.errorText.value)
    }

  @Test
  fun failedBranchesRefreshRetainsTheLastKnownBranchState() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respondWith(
        "sessions.branches.list",
        """{"branches":[{"leafEntryId":"leaf-a","headline":"Known","messageCount":1,"active":true}]}""",
      )
      val controller = controller(this, gateway)

      assertTrue(controller.refreshSessionBranches())
      val known = controller.sessionBranches.value
      gateway.respondWith("sessions.branches.list", """{"branches":{}}""")

      assertFalse(controller.refreshSessionBranches())
      assertEquals(known, controller.sessionBranches.value)

      gateway.respond("sessions.branches.list") { throw IllegalStateException("offline") }
      assertFalse(controller.refreshSessionBranches())
      assertEquals(known, controller.sessionBranches.value)
    }

  @Test
  fun definitiveRewindFailureReloadsTheCurrentTranscript() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respond("sessions.rewind") { throw GatewayRequestNotEnqueued("rejected") }
      gateway.respondWith(
        "chat.history",
        historyResponse(
          sessionId = "session-main",
          messages = listOf(ReplayHistoryMessage("user", "authoritative", 1, entryId = "entry-current")),
        ),
      )
      val controller = controller(this, gateway)

      assertNull(controller.rewindSessionAtEntryResult("main", "entry-old"))
      assertEquals(1, gateway.callCount("chat.history"))
      assertEquals(
        "authoritative",
        controller.messages.value
          .single()
          .content
          .single()
          .text,
      )
    }
}
