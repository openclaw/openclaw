package ai.openclaw.app.chat

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class ChatControllerCatalogTest {
  @Test
  fun healthObservationsDoNotSupersedeInFlightCatalogSuccess() =
    runTest {
      val firstResponse = CompletableDeferred<String>()
      val laterResponse = CompletableDeferred<String>()
      var catalogReads = 0
      val controller =
        createScriptedChatController {
          respond("models.list") {
            if (++catalogReads == 1) firstResponse.await() else laterResponse.await()
          }
        }
      try {
        controller.handleGatewayEvent("health", null)
        runCurrent()
        assertEquals(1, catalogReads)
        repeat(3) {
          controller.handleGatewayEvent("health", null)
          runCurrent()
        }
        firstResponse.complete("""{"models":[{"id":"current","name":"Current","provider":"fixture"}]}""")
        runCurrent()

        assertEquals("Health observations cannot retire a successful same-scope read", listOf("current"), controller.modelCatalog.value.map { it.id })
        assertEquals("Health joins the pending read rather than starting duplicate catalogs", 1, catalogReads)
      } finally {
        firstResponse.complete("""{"models":[]}""")
        laterResponse.complete("""{"models":[]}""")
        advanceUntilIdle()
      }
    }

  @Test
  fun catalogStatusSettlementPreservesInFlightSuccessAndCoalescesCatchUp() =
    runTest {
      val firstResponse = CompletableDeferred<String>()
      val catchUpResponse = CompletableDeferred<String>()
      var catalogReads = 0
      val controller =
        createScriptedChatController {
          respond("models.list") {
            if (++catalogReads == 1) firstResponse.await() else catchUpResponse.await()
          }
        }
      try {
        controller.handleGatewayEvent("health", null)
        runCurrent()
        assertEquals(1, catalogReads)
        repeat(3) {
          controller.handleGatewayEvent(
            "chat.metadata.changed",
            """{"agentId":"main","modelCatalogChanged":false,"modelCatalogStatusChanged":true,"authChanged":false,"commandsChanged":false}""",
          )
          runCurrent()
        }
        firstResponse.complete("""{"models":[{"id":"current","name":"Current","provider":"fixture"}],"pendingProviders":["fixture"]}""")
        runCurrent()

        assertEquals("Status-only settlement cannot starve unchanged model choices", listOf("current"), controller.modelCatalog.value.map { it.id })
        assertEquals("Intervening settlement notifications need one catch-up read", 2, catalogReads)
        catchUpResponse.complete("""{"models":[{"id":"current","name":"Current","provider":"fixture"}]}""")
        advanceUntilIdle()
        assertEquals(null, controller.errorText.value)
      } finally {
        firstResponse.complete("""{"models":[]}""")
        catchUpResponse.complete("""{"models":[]}""")
        advanceUntilIdle()
      }
    }

  @Test
  fun cleanCatalogResponseAbsorbsStatusSettlementWithoutAnotherRead() =
    runTest {
      val response = CompletableDeferred<String>()
      var catalogReads = 0
      val controller =
        createScriptedChatController {
          respond("models.list") {
            catalogReads += 1
            response.await()
          }
        }
      controller.handleGatewayEvent("health", null)
      runCurrent()
      repeat(3) {
        controller.handleGatewayEvent(
          "chat.metadata.changed",
          """{"modelCatalogChanged":false,"modelCatalogStatusChanged":true,"authChanged":false,"commandsChanged":false}""",
        )
        runCurrent()
      }
      response.complete("""{"models":[{"id":"current","name":"Current","provider":"fixture"}]}""")
      advanceUntilIdle()
      controller.handleGatewayEvent(
        "chat.metadata.changed",
        """{"modelCatalogChanged":false,"modelCatalogStatusChanged":true,"authChanged":false,"commandsChanged":false}""",
      )
      advanceUntilIdle()

      assertEquals(listOf("current"), controller.modelCatalog.value.map { it.id })
      assertEquals("A settled catalog must not renew itself on its own status publication", 1, catalogReads)
    }

  @Test
  fun metadataEventsRefreshOnlyTheSelectedAgentsChangedCatalogOrCommands() =
    runTest {
      val (controller, requests) =
        chatControllerTestSetup {
          respond("chat.metadata", """{"commands":[]}""")
          respond("models.list", """{"models":[{"id":"chat","name":"Chat","provider":"fixture"}]}""")
        }
      controller.load("agent:main:work")
      advanceUntilIdle()
      assertEquals(listOf("chat"), controller.modelCatalog.value.map { it.id })
      requests.clear()

      for (payload in listOf(
        """{"agentId":"main","modelCatalogChanged":false,"authChanged":false,"commandsChanged":false}""",
        """{"agentId":"other","modelCatalogChanged":true,"authChanged":true}""",
        """{"agentId":"main","modelCatalogChanged":false,"modelCatalogStatusChanged":true,"authChanged":false,"commandsChanged":false}""",
      )) {
        controller.handleGatewayEvent("chat.metadata.changed", payload)
        advanceUntilIdle()
      }
      assertFalse(requests.any { it.first == "chat.metadata" || it.first == "models.list" })
      assertEquals(listOf("chat"), controller.modelCatalog.value.map { it.id })

      for (payload in listOf(
        """{"agentId":" MAIN ","modelCatalogChanged":true,"commandsChanged":false}""",
        """{"agentId":"main","modelCatalogChanged":false,"authChanged":true,"commandsChanged":false}""",
        """{"agentId":"main","modelCatalogChanged":false,"commandsChanged":true}""",
        """{"modelSelectionChanged":true,"modelCatalogChanged":false,"commandsChanged":false}""",
        "{}",
      )) {
        requests.clear()
        controller.handleGatewayEvent("chat.metadata.changed", payload)
        advanceUntilIdle()
        assertEquals(payload, 1, requests.count { it.first == "chat.metadata" })
        assertEquals(payload, 1, requests.count { it.first == "models.list" })
      }
    }

  @Test
  fun olderGatewayKeepsCommandsAndExplainsMissingCatalogCapability() =
    runTest {
      val (controller, requests) =
        chatControllerTestSetup {
          gatewayAdvertisesCapability = { false }
          respond("chat.metadata", """{"commands":[{"name":"new","textAliases":["/new"]}]}""")
        }
      controller.handleGatewayEvent("health", null)
      advanceUntilIdle()
      assertEquals(listOf("new"), controller.commands.value.map { it.name })
      assertFalse(requests.any { it.first == "models.list" })
      assertEquals("Update your Gateway to use session model choices.", controller.errorText.value)
    }

  @Test
  fun sessionCatalogOwnsChoicesAndEmptySuccessDoesNotRetry() =
    runTest {
      var empty = false
      val (controller, requests) =
        chatControllerTestSetup {
          respond("chat.history", """{"messages":[],"sessionInfo":{"key":"agent:main:work","modelProvider":"fixture","model":"chat"}}""")
          respond("chat.metadata", """{"commands":[],"models":[{"id":"obsolete","provider":"other"}]}""")
          respond("models.list") {
            if (empty) {
              """{"models":[]}"""
            } else {
              """{"models":[{
          "id":"chat","name":"Chat","provider":"fixture","supportsFastMode":false,
          "thinkingLevels":[{"id":"off","label":"Off"},{"id":"deep","label":"Deep"}],
          "thinkingDefault":"deep","input":["text","image"]
        }]}"""
            }
          }
        }
      controller.load("agent:main:work")
      advanceUntilIdle()

      assertEquals(listOf("chat"), controller.modelCatalog.value.map { it.id })
      assertEquals(
        listOf("off", "deep"),
        controller.thinkingLevelSelection.value.options
          .map { it.id },
      )
      assertEquals("deep", controller.thinkingLevel.value)
      val params = chatControllerTestJson.parseToJsonElement(requests.single { it.first == "models.list" }.second!!).jsonObject
      assertEquals(JsonPrimitive("agent:main:work"), params["sessionKey"])
      assertEquals(JsonPrimitive("main"), params["agentId"])
      assertEquals(JsonPrimitive("configured"), params["view"])
      assertFalse("authProfileId" in params)

      empty = true
      controller.handleGatewayEvent("chat.metadata.changed", "{}")
      advanceUntilIdle()
      assertEquals(emptyList<String>(), controller.modelCatalog.value.map { it.id })
      val reads = requests.count { it.first == "models.list" }
      controller.handleGatewayEvent("health", null)
      advanceUntilIdle()
      assertEquals(reads, requests.count { it.first == "models.list" })
    }

  @Test
  fun catalogReadPreservesOrderAndEmptyFoldersButRetiresAnOldGatewayResponse() =
    runTest {
      var owner = ChatCacheScope("first", 1)
      val late = CompletableDeferred<String>()
      var delayRead = false
      val (controller, requests) =
        chatControllerTestSetup {
          cacheScope = { owner }
          respond("sessions.groups.list") {
            if (delayRead) {
              late.await()
            } else {
              """{"groups":[{"name":"Empty","position":1},{"name":"Work","position":0}],"sectionOrder":["category:Empty","ungrouped","category:Work"]}"""
            }
          }
        }
      controller.handleGatewayEvent("sessions.changed", """{"reason":"groups"}""")
      advanceUntilIdle()
      assertTrue(requests.any { it.first == "sessions.groups.list" })
      assertEquals(listOf("Work", "Empty"), controller.sessionGroupCatalog.value.names)
      assertEquals(listOf("category:Empty", "ungrouped", "category:Work"), controller.sessionGroupCatalog.value.sectionOrder)
      delayRead = true
      controller.refreshSessionGroups()
      runCurrent()
      controller.onGatewayScopeChanging()
      owner = ChatCacheScope("second", 2)
      late.complete("""{"groups":[{"name":"Stale","position":0}]}""")
      advanceUntilIdle()
      assertEquals(emptyList<String>(), controller.sessionGroupCatalog.value.names)
      assertTrue(requests.all { !it.first.startsWith("sessions.groups.") || it.first == "sessions.groups.list" })
    }

  @Test
  fun rosterPagesAndRefreshRetainMembersBeyondTheFirstWindow() =
    runTest {
      var unavailable = false
      val (controller, requests) =
        chatControllerTestSetup {
          respond("sessions.list") { raw ->
            if (unavailable) error("UNAVAILABLE")
            val params = chatControllerTestJson.parseToJsonElement(raw!!).jsonObject
            val offset = params["offset"]?.toString()?.toInt() ?: 0
            val limit = params["limit"]?.toString()?.toInt() ?: 200
            val end = minOf(offset + limit, 205)
            val rows = (offset until end).joinToString(",") { """{"key":"agent:main:item-$it","category":"Work"}""" }
            """{"sessions":[$rows],"hasMore":${end < 205},"nextOffset":$end,"totalCount":205}"""
          }
        }
      controller.refreshSessions(limit = 200)
      advanceUntilIdle()
      assertEquals(200, controller.sessions.value.size)
      assertTrue(controller.sessionRosterHasMore.value)
      unavailable = true
      assertFalse(controller.loadMoreSessions())
      assertTrue(controller.sessionRosterLoadFailed.value)
      assertFalse(controller.sessionRosterLoadingMore.value)
      assertEquals(200, controller.sessions.value.size)
      assertTrue(controller.sessionRosterHasMore.value)
      unavailable = false
      assertTrue(controller.loadMoreSessions())
      assertFalse(controller.sessionRosterLoadFailed.value)
      assertEquals(205, controller.sessions.value.size)
      assertFalse(controller.sessionRosterHasMore.value)
      controller.refreshSessions(limit = 200)
      advanceUntilIdle()
      assertEquals(205, controller.sessions.value.size)
      val last = requests.last { it.first == "sessions.list" }.second!!
      assertEquals(JsonPrimitive(400), chatControllerTestJson.parseToJsonElement(last).jsonObject["limit"])
    }
}
