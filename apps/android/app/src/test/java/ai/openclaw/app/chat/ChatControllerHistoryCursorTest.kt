package ai.openclaw.app.chat

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class ChatControllerHistoryCursorTest {
  private val key = "agent:main:cursor"

  private fun row(
    id: String,
    text: String = id,
    role: String = "assistant",
  ) = """{"role":"$role","content":"$text","__openclaw":{"id":"$id"}}"""

  private fun page(
    rows: String,
    fields: String = "",
    sid: String = "physical",
  ) = """{"sessionId":"$sid","messages":[$rows],"defaults":{"modelProvider":"test","model":"model"}$fields}"""

  private fun event(message: String) = """{"sessionKey":"$key","agentId":"main","message":$message}"""

  private fun delta(
    rows: String,
    cursor: String = "d2",
    fields: String = "",
  ) = """{"kind":"delta","messages":[$rows],"deltaCursor":"$cursor","sessionInfo":{"sessionId":"physical","activeLeafEntryId":"tip"}$fields}"""

  private fun ChatController.invalidate() = handleGatewayEvent("sessions.changed", """{"sessionKey":"$key","agentId":"main","phase":"message"}""")

  @Test
  fun snapshotWithoutOlderCursorDoesNotProveOldestBoundary() =
    runTest {
      var response = page(row("bounded-tail"))
      val controller =
        backgroundScope.createChatController { method, _ ->
          if (method == "chat.history") response else emptyChatGatewayResponse(method)
        }
      controller.load(key)
      runCurrent()
      assertEquals(listOf("bounded-tail"), controller.messages.value.map { it.entryId })
      assertFalse(controller.historyPaging.value.hasOlder)
      assertFalse(controller.historyPaging.value.olderComplete)
      response = page(row("bounded-tail"), """, "hasMore":true, "totalMessages":500""")
      controller.refresh()
      runCurrent()
      assertFalse(controller.historyPaging.value.olderComplete)
      response = page(row("entire-history"), """, "hasMore":false, "deltaCursor":"d1"""")
      controller.refresh()
      runCurrent()
      assertTrue(controller.historyPaging.value.olderComplete)
      response = delta("")
      controller.invalidate()
      runCurrent()
      assertTrue(controller.historyPaging.value.olderComplete)
      controller.onDisconnected("test")
      assertFalse(controller.historyPaging.value.olderComplete)
    }

  @Test
  fun configInvalidationCannotRestoreDefaultModelFromDeltaWindow() =
    runTest {
      val fullRead = CompletableDeferred<String>()
      val cursors = mutableListOf<String?>()
      var configChanged = false
      val controller =
        backgroundScope.createChatController { method, params ->
          if (method != "chat.history") {
            emptyChatGatewayResponse(method)
          } else {
            val cursor =
              chatControllerTestJson
                .parseToJsonElement(requireNotNull(params))
                .jsonObject["cursor"]
                ?.jsonPrimitive
                ?.content
            cursors += cursor
            when {
              !configChanged -> page(row("a"), """, "deltaCursor":"old-cursor"""")
              cursor != null -> delta("", "next-cursor")
              else -> fullRead.await()
            }
          }
        }
      controller.load(key)
      runCurrent()
      assertEquals("test/model", controller.defaultModelRef.value)
      configChanged = true
      controller.handleGatewayEvent("config.changed", "{}")
      runCurrent()
      assertEquals(null, controller.defaultModelRef.value)
      assertEquals(listOf(null, null), cursors)
      fullRead.complete(page(row("a"), """, "deltaCursor":"fresh-cursor"""").replace("test", "updated-provider"))
      runCurrent()
      assertEquals("updated-provider/model", controller.defaultModelRef.value)
      controller.invalidate()
      runCurrent()
      assertEquals("updated-provider/model", controller.defaultModelRef.value)
      assertEquals(listOf(null, null, "fresh-cursor"), cursors)
    }

  @Test
  fun deltaRetainsSnapshotRowsIdentityDefaultsAndEmptyMetadata() =
    runTest {
      val requests = mutableListOf<JsonObject>()
      var response = page(row("a"), """, "deltaCursor":"d1", "olderCursor":"o1"""")
      val controller =
        backgroundScope.createChatController { method, params ->
          if (method != "chat.history") {
            emptyChatGatewayResponse(method)
          } else {
            requests += chatControllerTestJson.parseToJsonElement(requireNotNull(params)).jsonObject
            response
          }
        }
      controller.load(key)
      runCurrent()
      val id =
        controller.messages.value
          .single()
          .id
      assertNotEquals(
        controller.messages.value
          .single()
          .entryId,
        id,
      )
      response = delta("", fields = """, "inFlightRun":{"runId":"remote","text":"still working"}""")
      controller.refresh()
      runCurrent()
      assertEquals(listOf("a"), controller.messages.value.map { it.entryId })
      assertEquals(
        id,
        controller.messages.value
          .single()
          .id,
      )
      assertEquals("physical", controller.sessionId.value)
      assertEquals("test/model", controller.defaultModelRef.value)
      assertEquals("still working", controller.streamingAssistantText.value)
      assertTrue(controller.historyPaging.value.hasOlder)
      response = delta(listOf(event(row("a", "updated")), event(row("b"))).joinToString(","), "d3")
      controller.invalidate()
      runCurrent()
      assertEquals(listOf("a", "b"), controller.messages.value.map { it.entryId })
      assertEquals(
        "updated",
        controller.messages.value
          .first()
          .content
          .single()
          .text,
      )
      assertEquals(
        id,
        controller.messages.value
          .first()
          .id,
      )
      assertEquals(listOf(null, "d1", "d2"), requests.map { it["cursor"]?.jsonPrimitive?.content })
    }

  @Test
  fun deltaRunReconciliationPreservesConfirmedThinkingLevel() =
    runTest {
      for ((thinkingMetadata, reconciledLevel) in listOf("high" to "high", null to "high", "medium" to "medium")) {
        val thinkingField = thinkingMetadata?.let { ",\"thinkingLevel\":\"$it\"" }.orEmpty()
        val cursors = mutableListOf<String?>()
        val sentThinkingLevels = mutableListOf<String>()
        var sentMessage: JsonObject? = null
        val controller =
          backgroundScope.createChatController { method, params ->
            when (method) {
              "sessions.patch" -> {
                val patch = chatControllerTestJson.parseToJsonElement(requireNotNull(params)).jsonObject
                assertEquals("high", patch["thinkingLevel"]?.jsonPrimitive?.content)
                """{"resolved":{"thinkingLevel":"high"}}"""
              }

              "chat.send" -> {
                val message = chatControllerTestJson.parseToJsonElement(requireNotNull(params)).jsonObject
                sentMessage = message
                sentThinkingLevels += message.getValue("thinking").jsonPrimitive.content
                """{"runId":${message["idempotencyKey"]},"status":"ok"}"""
              }

              "chat.history" -> {
                val cursor =
                  chatControllerTestJson
                    .parseToJsonElement(requireNotNull(params))
                    .jsonObject["cursor"]
                    ?.jsonPrimitive
                    ?.content
                cursors += cursor
                if (cursor == null) {
                  page(row("initial"), """, "thinkingLevel":"off", "deltaCursor":"d1"""")
                } else {
                  val message = checkNotNull(sentMessage)
                  val id = message.getValue("idempotencyKey").jsonPrimitive.content
                  val entry = "turn-${sentThinkingLevels.size}"
                  val persisted = """{"role":"user","content":${message["message"]},"idempotencyKey":"$id:user","__openclaw":{"id":"$entry"}}"""
                  """{"kind":"delta","messages":[${event(persisted)}],"deltaCursor":"d${cursors.size}","sessionInfo":{"sessionId":"physical","activeLeafEntryId":"$entry"$thinkingField}}"""
                }
              }

              else -> {
                emptyChatGatewayResponse(method)
              }
            }
          }
        controller.load(key)
        runCurrent()
        assertEquals("off", controller.thinkingLevel.value)
        controller.setThinkingLevel("high")
        runCurrent()
        assertEquals("high", controller.thinkingLevel.value)
        assertTrue(controller.pendingSessionSettingsKeys.value.isEmpty())

        repeat(2) { turn ->
          assertTrue(controller.sendMessageAwaitAcceptance("turn $turn", controller.thinkingLevel.value, emptyList()))
          runCurrent()
          assertEquals("delta metadata: $thinkingMetadata", reconciledLevel, controller.thinkingLevel.value)
          assertEquals(
            reconciledLevel,
            controller.sessions.value
              .single { it.key == key }
              .thinkingLevel,
          )
        }
        assertEquals(listOf(null, "d1", "d2"), cursors)
        assertEquals(listOf("high", reconciledLevel), sentThinkingLevels)
      }
    }

  @Test
  fun olderHiddenPagesPrependWithoutLosingLiveTailAndRetryKeepsBoundary() =
    runTest {
      val requests = mutableListOf<String?>()
      var fail = true
      val controller =
        backgroundScope.createChatController { method, params ->
          if (method != "chat.history") {
            emptyChatGatewayResponse(method)
          } else {
            val cursor =
              chatControllerTestJson
                .parseToJsonElement(requireNotNull(params))
                .jsonObject["cursor"]
                ?.jsonPrimitive
                ?.content
            requests += cursor
            when (cursor) {
              null -> page(row("c"), """, "deltaCursor":"d1", "olderCursor":"o1"""")
              "o1" -> if (fail) error("offline") else page("", """, "olderCursor":"o2"""")
              "o2" -> page(listOf(row("a"), row("b"), row("c")).joinToString(","), """, "newerCursor":"reverse-page-only"""")
              "d1" -> delta(event(row("d")))
              else -> error("unexpected cursor $cursor")
            }
          }
        }
      controller.load(key)
      runCurrent()
      val anchor =
        controller.messages.value
          .single()
          .id
      controller.loadHistoryPage(older = true)
      runCurrent()
      assertTrue(controller.historyPaging.value.failed)
      assertFalse(controller.historyPaging.value.loading)
      assertFalse(controller.historyPaging.value.olderComplete)
      assertEquals(listOf("c"), controller.messages.value.map { it.entryId })
      fail = false
      controller.loadHistoryPage(older = true)
      runCurrent()
      assertTrue(controller.historyPaging.value.olderComplete)
      controller.invalidate()
      runCurrent()
      assertEquals(listOf("a", "b", "c", "d"), controller.messages.value.map { it.entryId })
      assertEquals(anchor, controller.messages.value[2].id)
      assertFalse(controller.historyPaging.value.hasOlder)
      assertFalse(controller.historyPaging.value.hasNewer)
      assertTrue(controller.historyPaging.value.olderComplete)
      assertEquals(listOf(null, "o1", "o1", "o2", "d1"), requests)
    }

  @Test
  fun newerContinuationWalksEmptyPagesAndDeduplicatesOverlaps() =
    runTest {
      val controller =
        backgroundScope.createChatController { method, params ->
          if (method != "chat.history") {
            emptyChatGatewayResponse(method)
          } else {
            when (
              chatControllerTestJson
                .parseToJsonElement(requireNotNull(params))
                .jsonObject["cursor"]
                ?.jsonPrimitive
                ?.content
            ) {
              null -> page(row("a"), """, "newerCursor":"n1"""")
              "n1" -> page("", """, "newerCursor":"n2"""")
              "n2" -> page(listOf(row("a"), row("b")).joinToString(","), """, "deltaCursor":"d1"""")
              else -> error("unexpected request")
            }
          }
        }
      controller.load(key)
      runCurrent()
      assertEquals(listOf("a", "b"), controller.messages.value.map { it.entryId })
      assertFalse(controller.historyPaging.value.hasNewer)
      assertFalse(controller.historyPaging.value.loading)
      assertFalse(controller.historyPaging.value.olderComplete)
    }

  @Test
  fun resetMalformedAndWindowResetReopenWithoutPublishingPartialRows() =
    runTest {
      for (invalid in listOf(
        """{"kind":"reset"}""",
        delta(event(row("partial")) + ",{}", "bad"),
        delta("", "bad").replace("[]", "{}"),
        """{"messages":[],"windowReset":true}""",
      )) {
        var reads = 0
        val cursors = mutableListOf<String?>()
        val controller =
          backgroundScope.createChatController { method, params ->
            if (method != "chat.history") {
              emptyChatGatewayResponse(method)
            } else {
              cursors +=
                chatControllerTestJson
                  .parseToJsonElement(requireNotNull(params))
                  .jsonObject["cursor"]
                  ?.jsonPrimitive
                  ?.content
              when (reads++) {
                0 -> page(row("old"), """, "deltaCursor":"d1"""")
                1 -> invalid
                else -> page(row("replacement"), """, "deltaCursor":"fresh"""")
              }
            }
          }
        controller.load(key)
        runCurrent()
        controller.invalidate()
        runCurrent()
        assertEquals(listOf("replacement"), controller.messages.value.map { it.entryId })
        assertEquals(listOf(null, "d1", null), cursors)
      }
    }

  @Test
  fun stalePageCannotCrossSessionResetReconnectOrBranchSelection() =
    runTest {
      for (change in listOf("session", "reset", "reconnect", "branch", "agent", "gateway")) {
        var gateway = ChatCacheScope("gateway-test", 1L)
        var agent = "main"
        val delayed = CompletableDeferred<String>()
        var tails = 0
        val controller =
          backgroundScope.createChatController(cacheScope = { gateway }, currentDefaultAgentId = { agent }) { method, params ->
            if (method != "chat.history") {
              emptyChatGatewayResponse(method)
            } else {
              val request = chatControllerTestJson.parseToJsonElement(requireNotNull(params)).jsonObject
              if (request["cursor"] == JsonPrimitive("o1")) {
                delayed.await()
              } else {
                tails++
                page(row(if (tails == 1) "old" else "current"), """, "olderCursor":"o1", "deltaCursor":"d1"""")
              }
            }
          }
        val selected = if (change == "agent") "global" else key
        controller.load(selected)
        runCurrent()
        controller.loadHistoryPage(older = true)
        runCurrent()
        assertTrue(controller.historyPaging.value.loading)
        when (change) {
          "session" -> {
            controller.load("agent:main:other")
          }

          "reset" -> {
            controller.handleGatewayEvent("sessions.changed", """{"sessionKey":"$key","agentId":"main","reason":"reset"}""")
          }

          "branch" -> {
            controller.handleGatewayEvent("sessions.changed", """{"sessionKey":"$key","agentId":"main","reason":"branch-switch"}""")
          }

          "agent" -> {
            agent = "other"
            controller.onDefaultAgentChanged(agent)
          }

          "gateway" -> {
            controller.onGatewayScopeChanging()
            gateway = ChatCacheScope("gateway-other", 1L)
            controller.load(key)
          }

          else -> {
            controller.onDisconnected("test")
            gateway = gateway.copy(connectionGeneration = 2)
            controller.onGatewayConnected()
          }
        }
        runCurrent()
        delayed.complete(page(row("stale")))
        runCurrent()
        assertEquals(change, listOf("current"), controller.messages.value.map { it.entryId })
        assertFalse(change, controller.historyPaging.value.loading)
      }
    }

  @Test
  fun staleDeltaCannotReplaceNewerRefreshAndLiveRowCannotSkipPredecessor() =
    runTest {
      val delayed = CompletableDeferred<String>()
      var deltaReads = 0
      val controller =
        backgroundScope.createChatController { method, params ->
          if (method != "chat.history") {
            emptyChatGatewayResponse(method)
          } else {
            val cursor =
              chatControllerTestJson
                .parseToJsonElement(requireNotNull(params))
                .jsonObject["cursor"]
                ?.jsonPrimitive
                ?.content
            if (cursor == null) {
              page(row("a"), """, "deltaCursor":"d1"""")
            } else {
              if (deltaReads++ == 0) delayed.await() else delta(listOf(event(row("b")), event(row("c"))).joinToString(","), "d3")
            }
          }
        }
      controller.load(key)
      runCurrent()
      controller.handleGatewayEvent("session.message", event(row("c")))
      runCurrent()
      assertEquals(listOf("a", "c"), controller.messages.value.map { it.entryId })
      controller.refresh()
      runCurrent()
      assertEquals(listOf("a", "b", "c"), controller.messages.value.map { it.entryId })
      delayed.complete(delta(event(row("stale")), "old"))
      runCurrent()
      assertEquals(listOf("a", "b", "c"), controller.messages.value.map { it.entryId })
    }

  @Test
  fun concurrentDeltasUseAcceptedCursorAndLiveReplayUpdatesOneCanonicalRow() =
    runTest {
      val delayed = CompletableDeferred<String>()
      val cursors = mutableListOf<String?>()
      val controller =
        backgroundScope.createChatController { method, params ->
          if (method != "chat.history") {
            emptyChatGatewayResponse(method)
          } else {
            val cursor =
              chatControllerTestJson
                .parseToJsonElement(requireNotNull(params))
                .jsonObject["cursor"]
                ?.jsonPrimitive
                ?.content
            cursors += cursor
            when (cursor) {
              null -> page(row("a"), """, "deltaCursor":"d1"""")
              "d1" -> delayed.await()
              "d2" -> delta(event(row("b", "final")), "d3")
              else -> delta("", "d4")
            }
          }
        }
      controller.load(key)
      runCurrent()
      controller.invalidate()
      runCurrent()
      controller.handleGatewayEvent("session.message", event(row("b", "live")))
      runCurrent()
      assertEquals(listOf(null, "d1"), cursors)
      delayed.complete(delta(event(row("b", "first"))))
      runCurrent()
      assertEquals(listOf("a", "b"), controller.messages.value.map { it.entryId })
      assertEquals(
        "final",
        controller.messages.value
          .last()
          .content
          .single()
          .text,
      )
      assertEquals(listOf(null, "d1", "d2"), cursors)
    }
}
