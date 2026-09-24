package ai.openclaw.app.chat

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class ChatControllerSessionSearchTest {
  private val json = Json { ignoreUnknownKeys = true }

  private fun TestScope.newController(gateway: ScriptedGateway): ChatController = ChatController(scope = this, commandOutbox = this.createChatCommandOutbox(), cacheScope = { ChatCacheScope("gateway-test", 1L) }, json = json, requestGateway = gateway::request)

  private fun sessionRowJson(
    key: String,
    updatedAt: Long,
    displayName: String? = null,
    autoLabel: String? = null,
    archived: Boolean = false,
  ) = buildJsonObject {
    put("key", JsonPrimitive(key))
    put("updatedAt", JsonPrimitive(updatedAt))
    if (displayName != null) put("displayName", JsonPrimitive(displayName))
    if (autoLabel != null) put("autoLabel", JsonPrimitive(autoLabel))
    if (archived) put("archived", JsonPrimitive(true))
  }

  private fun sessionsListJson(vararg rows: kotlinx.serialization.json.JsonObject): String = buildJsonObject { put("sessions", JsonArray(rows.toList())) }.toString()

  private fun paramField(
    paramsJson: String?,
    field: String,
  ): String? =
    paramsJson
      ?.let { json.parseToJsonElement(it).jsonObject[field] }
      ?.jsonPrimitive
      ?.content

  @Test
  fun filterSessionEntriesMatchesDisplayNameLabelCategoryKeyAndLocalTitle() {
    val sessions =
      listOf(
        ChatSessionEntry(key = "agent:main:topic-a", updatedAtMs = 2, displayName = "Trip planning"),
        ChatSessionEntry(key = "agent:main:topic-b", updatedAtMs = 1, displayName = "Groceries", category = "Team Planning"),
        ChatSessionEntry(key = "agent:main:trip-notes", updatedAtMs = 3, displayName = "Notes"),
        ChatSessionEntry(key = "agent:main:topic-c", updatedAtMs = 4, localFallbackTitle = "Device A"),
      )
    assertEquals(
      listOf("agent:main:topic-a", "agent:main:trip-notes"),
      filterSessionEntries(sessions, "TRIP").map { it.key },
    )
    assertEquals(listOf("agent:main:topic-b"), filterSessionEntries(sessions, "TEAM PLANNING").map { it.key })
    assertEquals(listOf("agent:main:topic-c"), filterSessionEntries(sessions, "  DEVICE A  ").map { it.key })
    assertEquals(sessions, filterSessionEntries(sessions, "  "))
  }

  @Test
  fun localDeviceTitleFollowsBindingAcrossSearchReconnectAndGatewayChanges() =
    runTest {
      val key = "agent:main:node-device"
      var cacheScope = ChatCacheScope("gateway-a", 1)
      var offline = false
      val gateway = ScriptedGateway(json)
      gateway.respond("sessions.list") { params ->
        if (offline) error("offline")
        val query = paramField(params, "search")
        if (query == null || key.contains(query, ignoreCase = true)) {
          sessionsListJson(sessionRowJson(key, updatedAt = 1))
        } else {
          sessionsListJson()
        }
      }
      gateway.respondWith("chat.history", """{"sessionId":"device-session","messages":[]}""")
      val controller =
        backgroundScope.createChatController(
          requestGateway = gateway::request,
          requestGatewayForGateway = { _, method, params -> gateway.request(method, params) },
          cacheScope = { cacheScope },
        )
      controller.prepareMainSessionKey(key)
      controller.onGatewayConnected(MainSessionBinding(key, "Device A"))
      runCurrent()
      controller.refreshSessions()
      runCurrent()
      assertEquals(
        "Device A",
        controller.sessions.value
          .single()
          .localFallbackTitle,
      )
      val searched = controller.fetchSessionList(search = "node-device", archived = false).single()
      assertEquals("Device A", searched.localFallbackTitle)
      assertNull(searched.autoLabel)
      assertNull(searched.displayName)

      offline = true
      val offlineMatches = controller.fetchSessionList(search = "  dEvIcE a  ", archived = false)
      assertEquals(listOf(key), offlineMatches.map { it.key })
      assertEquals("Device A", offlineMatches.single().localFallbackTitle)
      assertNull(offlineMatches.single().autoLabel)
      assertNull(offlineMatches.single().displayName)
      assertTrue(controller.fetchSessionList(search = "Device A", archived = true).isEmpty())
      assertTrue(controller.fetchSessionList(search = "Device B", archived = false).isEmpty())
      assertEquals("Device A", controller.fetchSessionList(search = "node-device", archived = false).single().localFallbackTitle)
      controller.onGatewayConnected(MainSessionBinding(key, "Renamed device A"))
      assertEquals(
        "Renamed device A",
        controller.sessions.value
          .single()
          .localFallbackTitle,
      )
      runCurrent()
      assertEquals(listOf(key), controller.fetchSessionList(search = "Renamed device A", archived = false).map { it.key })

      controller.onGatewayScopeChanging()
      cacheScope = ChatCacheScope("gateway-b", 2)
      assertTrue(controller.sessions.value.isEmpty())
      offline = false
      assertNull(controller.fetchSessionList(search = null, archived = false).single().localFallbackTitle)
      controller.prepareMainSessionKey(key)
      controller.onGatewayConnected(MainSessionBinding(key, "Device B"))
      runCurrent()
      controller.refreshSessions()
      runCurrent()
      assertEquals(
        "Device B",
        controller.sessions.value
          .single()
          .localFallbackTitle,
      )
      assertEquals("Device B", controller.fetchSessionList(search = null, archived = false).single().localFallbackTitle)
      offline = true
      assertTrue(controller.fetchSessionList(search = "Device A", archived = false).isEmpty())
      assertEquals(listOf(key), controller.fetchSessionList(search = "Device B", archived = false).map { it.key })
    }

  @Test
  fun fetchSessionListSendsSearchAndArchivedParams() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respond("sessions.list") { paramsJson ->
        val params = json.parseToJsonElement(paramsJson.orEmpty()).jsonObject
        if (params["archived"]?.jsonPrimitive?.content == "true") {
          sessionsListJson(sessionRowJson(key = "agent:main:old", updatedAt = 10, archived = true))
        } else {
          sessionsListJson(sessionRowJson(key = "agent:main:topic-a", updatedAt = 100))
        }
      }
      val controller = newController(gateway)

      val archivedRows = controller.fetchSessionList(search = null, archived = true)
      assertEquals(listOf("agent:main:old"), archivedRows.map { it.key })
      assertTrue(archivedRows.single().archived == true)

      controller.fetchSessionList(search = "  trip  ", archived = false)
      val searchCall = gateway.calls.last { it.method == "sessions.list" }
      assertEquals("trip", paramField(searchCall.paramsJson, "search"))
      assertEquals("200", paramField(searchCall.paramsJson, "limit"))
    }

  @Test
  fun fetchSessionListPreservesGatewayClassificationFacts() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respond("sessions.list") {
        buildJsonObject {
          put(
            "sessions",
            JsonArray(
              listOf(
                buildJsonObject {
                  put("key", JsonPrimitive("agent:main:telegram:main:direct:491234567890"))
                  put("updatedAt", JsonPrimitive(100))
                  put("agentId", JsonPrimitive("main"))
                  put("classification", JsonPrimitive("direct"))
                  put("accountId", JsonPrimitive("main"))
                  put("peerKind", JsonPrimitive("direct"))
                  put("isMain", JsonPrimitive(false))
                  put("isBackground", JsonPrimitive(false))
                },
              ),
            ),
          )
        }.toString()
      }
      val controller = newController(gateway)

      val row = controller.fetchSessionList(search = null, archived = false).single()
      assertEquals("main", row.ownerAgentId)
      assertEquals("direct", row.classification)
      assertEquals("main", row.accountId)
      assertEquals("direct", row.peerKind)
      assertEquals(false, row.isMain)
      assertEquals(false, row.isBackground)
    }

  @Test
  fun pagedSessionRefreshKeepsActiveSettingsAndItsQueryLimit() =
    runTest {
      val activeKey = "agent:main:older"
      val gateway = ScriptedGateway(json)
      gateway.respondWith(
        "chat.history",
        """{"sessionId":"older-id","messages":[],"sessionInfo":{"key":"$activeKey","modelProvider":"openai","model":"reasoner"}}""",
      )
      gateway.respond("sessions.list") { params ->
        val limit = requireNotNull(paramField(params, "limit")).toInt()
        val rows = (1..limit).map { sessionRowJson("agent:main:recent-$it", updatedAt = 500L - it) }
        buildJsonObject {
          put("sessions", JsonArray(rows))
          put("totalCount", JsonPrimitive(500))
          put("hasMore", JsonPrimitive(true))
        }.toString()
      }
      val controller = newController(gateway)
      controller.load(activeKey)
      advanceUntilIdle()
      assertEquals("openai/reasoner", controller.selectedModelRef.value)

      // Lifecycle snapshots intentionally omit catalog-backed model fields.
      controller.handleGatewayEvent(
        "sessions.changed",
        """{"sessionKey":"$activeKey","agentId":"main","phase":"start","runId":"remote-run","session":{"key":"$activeKey","sessionId":"older-id","hasActiveRun":true,"activeRunIds":["remote-run"],"permissionMode":null,"permissionModePending":false}}""",
      )
      assertEquals("openai/reasoner", controller.selectedModelRef.value)

      controller.refreshSessions(limit = 2)
      advanceUntilIdle()
      repeat(2) {
        controller.handleGatewayEvent(
          "sessions.changed",
          """{"sessionKey":"agent:main:roster-invalidated","agentId":"main"}""",
        )
        advanceUntilIdle()
        assertEquals("2", paramField(gateway.calls.last { it.method == "sessions.list" }.paramsJson, "limit"))
        assertEquals("openai/reasoner", controller.selectedModelRef.value)
      }
    }

  @Test
  fun fetchSessionListFallsBackToLocalFilterWhenOffline() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respond("sessions.list") { paramsJson ->
        val params = json.parseToJsonElement(paramsJson.orEmpty()).jsonObject
        if ("search" in params || "archived" in params) error("offline")
        sessionsListJson(
          sessionRowJson(key = "agent:main:topic-a", updatedAt = 2, displayName = "Trip planning"),
          sessionRowJson(key = "agent:main:topic-b", updatedAt = 1, displayName = "Groceries"),
          sessionRowJson(key = "agent:main:topic-c", updatedAt = 3, autoLabel = "Remote device"),
        )
      }
      val controller = newController(gateway)
      controller.refreshSessions()
      advanceUntilIdle()

      val filtered = controller.fetchSessionList(search = "trip", archived = false)
      assertEquals(listOf("agent:main:topic-a"), filtered.map { it.key })
      val automaticallyNamed = controller.fetchSessionList(search = "REMOTE DEVICE", archived = false)
      assertEquals(listOf("agent:main:topic-c"), automaticallyNamed.map { it.key })
      assertNull(automaticallyNamed.single().displayName)
      // Archived rows exist only server-side, so offline archived search is empty.
      assertTrue(controller.fetchSessionList(search = null, archived = true).isEmpty())
    }

  @Test
  fun fetchSessionListDoesNotGuessMainWhileDefaultOwnerIsUnknown() =
    runTest {
      val gateway = ScriptedGateway(json)
      val controller =
        ChatController(
          scope = this,
          commandOutbox = this.createChatCommandOutbox(),
          cacheScope = { ChatCacheScope("gateway-test", 1L) },
          json = json,
          requestGateway = gateway::request,
          currentDefaultAgentId = { null },
        )

      assertTrue(controller.fetchSessionList(search = "trip", archived = false).isEmpty())
      assertTrue(controller.fetchSessionList(search = null, archived = true).isEmpty())
      assertTrue(gateway.calls.isEmpty())
    }

  @Test
  fun fetchSessionListRethrowsCancellationInsteadOfFallingBack() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respond("sessions.list") { _ -> throw CancellationException("superseded") }
      val controller = newController(gateway)

      try {
        controller.fetchSessionList(search = "trip", archived = false)
        fail("expected CancellationException to propagate")
      } catch (_: CancellationException) {
        // A superseded search must cancel, not repaint stale fallback rows.
      }
    }

  @Test
  fun fetchSessionListDropsAResponseAfterOwnerOrGatewayChanges() =
    runTest {
      var defaultAgentId = "agent-a"
      var defaultAgentRevision = 1L
      var cacheScope = ChatCacheScope(gatewayId = "gateway-a", connectionGeneration = 1)
      val requestStarted = CompletableDeferred<Unit>()
      val releaseResponse = CompletableDeferred<String>()
      val gateway = ScriptedGateway(json)
      gateway.respond("sessions.list") {
        requestStarted.complete(Unit)
        releaseResponse.await()
      }
      val controller =
        ChatController(
          scope = this,
          commandOutbox = this.createChatCommandOutbox(),
          json = json,
          requestGateway = gateway::request,
          cacheScope = { cacheScope },
          currentDefaultAgentId = { defaultAgentId },
          currentDefaultAgentRevision = { defaultAgentRevision },
        )

      val pending = async { controller.fetchSessionList(search = "trip", archived = false) }
      runCurrent()
      requestStarted.await()
      defaultAgentId = "agent-b"
      defaultAgentRevision += 1
      cacheScope = ChatCacheScope(gatewayId = "gateway-b", connectionGeneration = 2)
      releaseResponse.complete(sessionsListJson(sessionRowJson(key = "agent:agent-a:old", updatedAt = 10)))

      assertTrue(pending.await().isEmpty())
    }

  @Test
  fun fetchSessionSelectionCandidatesQueriesRequestedOwnerWithoutChangingVisibleOwner() =
    runTest {
      val cacheScope = ChatCacheScope(gatewayId = "gateway-a", connectionGeneration = 1)
      val gateway = ScriptedGateway(json)
      gateway.respond("sessions.list") {
        sessionsListJson(sessionRowJson(key = "agent:scout:topic", updatedAt = 100))
      }
      val controller =
        ChatController(
          scope = this,
          commandOutbox = this.createChatCommandOutbox(),
          json = json,
          requestGateway = gateway::request,
          cacheScope = { cacheScope },
        )

      val candidates = controller.fetchSessionSelectionCandidates("scout").orEmpty()

      assertEquals(listOf("agent:scout:topic"), candidates.map { it.key })
      assertEquals(listOf("scout"), candidates.map { it.ownerAgentId })
      assertEquals("scout", paramField(gateway.calls.single().paramsJson, "agentId"))
      assertEquals("main", controller.sessionKey.value)
    }

  @Test
  fun fetchSessionSelectionCandidatesDropsLateResponseAfterGatewaySwitch() =
    runTest {
      var cacheScope = ChatCacheScope(gatewayId = "gateway-a", connectionGeneration = 1)
      val requestStarted = CompletableDeferred<Unit>()
      val releaseResponse = CompletableDeferred<String>()
      val gateway = ScriptedGateway(json)
      gateway.respond("sessions.list") {
        requestStarted.complete(Unit)
        releaseResponse.await()
      }
      val controller =
        ChatController(
          scope = this,
          commandOutbox = this.createChatCommandOutbox(),
          json = json,
          requestGateway = gateway::request,
          cacheScope = { cacheScope },
        )

      val pending = async { controller.fetchSessionSelectionCandidates("scout") }
      runCurrent()
      requestStarted.await()
      cacheScope = ChatCacheScope(gatewayId = "gateway-b", connectionGeneration = 2)
      releaseResponse.complete(sessionsListJson(sessionRowJson(key = "agent:scout:old", updatedAt = 10)))

      assertNull(pending.await())
    }

  @Test
  fun rememberedUnscopedSelectionUsesCapturedOwnerOutsideRecentPage() =
    runTest {
      val owner = ChatAgentSessionSelectionOwner("gateway-a", "scout")
      val gateway = ScriptedGateway(json)
      gateway.respond("chat.history") { params ->
        val key = requireNotNull(paramField(params, "sessionKey"))
        val agentId = requireNotNull(paramField(params, "agentId"))
        """{"sessionId":"$agentId-session","messages":[],"sessionInfo":{"key":"$key","sessionId":"$agentId-session","agentId":"$agentId","archived":false}}"""
      }
      gateway.respondWith("sessions.list", sessionsListJson(sessionRowJson("agent:scout:newer", updatedAt = 100)))
      val controller =
        ChatController(
          scope = this,
          commandOutbox = this.createChatCommandOutbox(),
          json = json,
          requestGateway = gateway::request,
          cacheScope = { ChatCacheScope("gateway-a", 1) },
        )
      controller.switchSession("global", "scout")
      runCurrent()
      assertEquals("scout-session", controller.sessionId.value)
      controller.switchSession("agent:writer:other", "writer", rememberSelection = false)
      runCurrent()
      val historyCalls = gateway.calls.count { it.method == "chat.history" }

      val selection = requireNotNull(controller.resolveSessionSelection(owner, "agent:scout:main"))

      assertEquals("global", selection.targetSessionKey)
      assertEquals("agent:writer:other", controller.sessionKey.value)
      assertEquals("writer", controller.sessionOwnerAgentId.value)
      val lookup =
        gateway.calls
          .filter { it.method == "chat.history" }
          .drop(historyCalls)
          .single()
      assertEquals("global", paramField(lookup.paramsJson, "sessionKey"))
      assertEquals("scout", paramField(lookup.paramsJson, "agentId"))
      assertEquals("1", paramField(lookup.paramsJson, "limit"))

      controller.restoreSessionSelection(owner, selection, "agent:scout:main")
      runCurrent()
      assertEquals("global", controller.sessionKey.value)
      assertEquals("scout", controller.sessionOwnerAgentId.value)
      assertEquals("scout-session", controller.sessionId.value)
    }

  @Test
  fun rememberedSelectionRejectsArchiveHistoryPredatingObservedSuccessor() =
    runTest {
      val chosenKey = "agent:scout:chosen"
      val mainKey = "agent:scout:main"
      val owner = ChatAgentSessionSelectionOwner("gateway-a", "scout")
      val scope = ChatCacheScope("gateway-a", 1)
      var sessionId = "session-before"
      val descriptionStarted = CompletableDeferred<Unit>()
      val releaseDescription = CompletableDeferred<Unit>()
      var lookupArchived = true
      val gateway = ScriptedGateway(json)
      gateway.respond("chat.history") { params ->
        if (paramField(params, "limit") == "1") {
          assertEquals(chosenKey, paramField(params, "sessionKey"))
          assertEquals("scout", paramField(params, "agentId"))
          val response = """{"sessionId":"$sessionId","messages":[],"sessionInfo":{"key":"$chosenKey","sessionId":"$sessionId","agentId":"scout","archived":$lookupArchived}}"""
          descriptionStarted.complete(Unit)
          releaseDescription.await()
          response
        } else {
          historyResponse(sessionId, listOf(ReplayHistoryMessage("user", sessionId, 1)))
        }
      }
      gateway.respondWith("sessions.list", sessionsListJson(sessionRowJson("agent:scout:newer", updatedAt = 100)))
      val controller =
        ChatController(
          scope = this,
          commandOutbox = this.createChatCommandOutbox(),
          json = json,
          requestGateway = gateway::request,
          cacheScope = { scope },
        )
      controller.switchSession(chosenKey, "scout")
      runCurrent()
      assertEquals("session-before", controller.sessionId.value)
      val selectionGeneration = controller.selectionGeneration.value
      val selection = async { controller.resolveSessionSelection(owner, mainKey) }
      try {
        runCurrent()
        descriptionStarted.await()
        sessionId = "session-successor"
        controller.refresh()
        runCurrent()
        assertEquals(sessionId, controller.sessionId.value)
        assertEquals(selectionGeneration, controller.selectionGeneration.value)

        releaseDescription.complete(Unit)
        controller.restoreSessionSelection(owner, requireNotNull(selection.await()), mainKey)
        assertEquals("An older archive lookup must not replace live successor history", chosenKey, controller.sessionKey.value)

        // The rejected result must not silently retire the remembered intent either.
        controller.switchSession("agent:writer:other", "writer", rememberSelection = false)
        runCurrent()
        lookupArchived = false
        val next = requireNotNull(controller.resolveSessionSelection(owner, mainKey))
        controller.restoreSessionSelection(owner, next, mainKey)
        runCurrent()
        assertEquals(chosenKey, controller.sessionKey.value)
        assertEquals("session-successor", controller.sessionId.value)
      } finally {
        releaseDescription.complete(Unit)
      }
    }

  @Test
  fun fetchSessionSelectionCandidatesRethrowsCancellation() =
    runTest {
      val gateway = ScriptedGateway(json)
      gateway.respond("sessions.list") { throw CancellationException("superseded") }
      val controller =
        ChatController(
          scope = this,
          commandOutbox = this.createChatCommandOutbox(),
          json = json,
          requestGateway = gateway::request,
          cacheScope = { ChatCacheScope(gatewayId = "gateway-a", connectionGeneration = 1) },
        )

      try {
        controller.fetchSessionSelectionCandidates("scout")
        fail("expected CancellationException to propagate")
      } catch (_: CancellationException) {
        // A superseded owner lookup must cancel instead of restoring stale state.
      }
    }
}
