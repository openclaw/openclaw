package ai.openclaw.app.chat

import ai.openclaw.app.gateway.GatewaySession
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class ChatControllerReactionsTest {
  private val writer = ChatReactionAccess(role = "operator", scopes = setOf("operator.write"), viewerId = "riley")

  private fun gateway(sharingRole: String = "owner"): ScriptedGateway =
    ScriptedGateway(chatControllerTestJson).apply {
      respond("chat.history") { params ->
        val key = sessionKeyOf(params) ?: "main"
        val history =
          chatControllerTestJson
            .parseToJsonElement(
              historyResponse(
                "session-$key",
                listOf(
                  ReplayHistoryMessage("user", "Saved prompt", 1, entryId = "prompt"),
                  ReplayHistoryMessage("assistant", "Saved reply", 2, entryId = "reply"),
                  ReplayHistoryMessage("user", "Unsaved prompt", 3),
                ),
              ),
            ).jsonObject
        JsonObject(
          history +
            (
              "sessionInfo" to
                buildJsonObject {
                  put("key", JsonPrimitive(key))
                  put("sessionId", JsonPrimitive("session-$key"))
                  put("agentId", JsonPrimitive("main"))
                  put("sharingRole", JsonPrimitive(sharingRole))
                  put("visibility", JsonPrimitive("shared"))
                }
            ),
        ).toString()
      }
      respondWith("sessions.list", """{"sessions":[]}""")
      respond("session.reactions.list") { params -> listResponse(sessionKeyOf(params) ?: "main") }
      respondWith("session.reactions.set", """{"messageId":"prompt","reactions":[]}""")
    }

  private fun TestScope.controller(
    gateway: ScriptedGateway,
    access: ChatReactionAccess = writer,
    captureRequestLease: ((ChatCacheScope?) -> GatewaySession.RequestLease?)? = null,
  ): ChatController =
    backgroundScope
      .createChatController(
        requestGateway = gateway::request,
        gatewayAdvertisesMethod = { true },
        captureRequestLease = captureRequestLease,
      ).also { it.setReactionAccess(access) }

  private fun reactions(count: Int = 1): String = """[{"emoji":"👍","count":$count,"identities":[{"id":"riley","label":"Riley"}${if (count > 1) ",{\"id\":\"sam\",\"label\":\"Sam\"}" else ""}]}]"""

  private fun listResponse(key: String = "main"): String = """{"sessionId":"session-$key","reactions":{"prompt":${reactions()}}}"""

  private fun event(
    key: String = "main",
    agentId: String = "main",
    sessionId: String = "session-$key",
    count: Int = 2,
  ): String = """{"sessionKey":"$key","agentId":"$agentId","sessionId":"$sessionId","messageId":"prompt","emoji":"👍","action":"added","actor":{"type":"human","id":"sam","label":"Sam"},"reactions":${reactions(count)}}"""

  @Test
  fun loadsOnHistoryAndSessionSwitchForReadOnlyViewers() =
    runTest {
      val gateway = gateway(sharingRole = "viewer")
      val controller = controller(gateway, writer.copy(sessionCap = "view"))
      controller.load("main")
      runCurrent()

      assertEquals(
        1,
        controller.messageReactions.value
          .getValue("prompt")
          .single()
          .count,
      )
      assertFalse(controller.canReact.value)
      controller.setMessageReaction("prompt", "👍", false)
      runCurrent()
      assertEquals(0, gateway.callCount("session.reactions.set"))

      controller.switchSession("other")
      assertTrue(controller.messageReactions.value.isEmpty())
      runCurrent()
      assertEquals(2, gateway.callCount("session.reactions.list"))
      assertEquals(
        1,
        controller.messageReactions.value
          .getValue("prompt")
          .single()
          .count,
      )
      val request = gateway.calls.last { it.method == "session.reactions.list" }
      assertEquals("other", gateway.sessionKeyOf(request.paramsJson))
      assertEquals(
        "main",
        chatControllerTestJson
          .parseToJsonElement(requireNotNull(request.paramsJson))
          .jsonObject
          .getValue("agentId")
          .jsonPrimitive.content,
      )
    }

  @Test
  fun eventsOutrankPendingListAndRejectOtherSessionInstancesAndAgents() =
    runTest {
      val gateway = gateway()
      val pendingList = CompletableDeferred<String>()
      gateway.respond("session.reactions.list") { pendingList.await() }
      val controller = controller(gateway)
      controller.load("main")
      runCurrent()
      assertEquals(1, gateway.callCount("session.reactions.list"))

      controller.handleGatewayEvent("session.reaction", event(key = "agent:main:main", sessionId = "session-main"))
      controller.handleGatewayEvent("session.reaction", event(agentId = "research", count = 7))
      controller.handleGatewayEvent("session.reaction", event(sessionId = "retired-session", count = 8))
      controller.handleGatewayEvent("session.reaction", event(key = "other", count = 9))
      gateway.respondWith("session.reactions.set", """{"messageId":"reply","reactions":${reactions()}}""")
      controller.setMessageReaction("reply", "👍", false)
      runCurrent()
      pendingList.complete(listResponse())
      runCurrent()

      assertEquals(
        2,
        controller.messageReactions.value
          .getValue("prompt")
          .single()
          .count,
      )
      assertEquals(
        listOf("Riley", "Sam"),
        controller.messageReactions.value
          .getValue("prompt")
          .single()
          .identities
          .map { it.label },
      )
      assertEquals(
        1,
        controller.messageReactions.value
          .getValue("reply")
          .single()
          .count,
      )
    }

  @Test
  fun writesOnlyCanonicalMessagesAndKeepsNewerEventsOverSetResponse() =
    runTest {
      val gateway = gateway()
      val pendingSet = CompletableDeferred<String>()
      gateway.respond("session.reactions.set") { pendingSet.await() }
      val controller = controller(gateway)
      controller.load("main")
      runCurrent()
      assertTrue(controller.canReact.value)
      controller.handleGatewayEvent("session.message", """{"session":{"key":"main","agentId":"main","label":"Renamed"}}""")
      assertTrue(controller.canReact.value)
      controller.setMessageReaction(
        controller.messages.value
          .first()
          .id,
        "👍",
        false,
      )
      controller.setMessageReaction(
        controller.messages.value
          .last()
          .id,
        "👍",
        false,
      )
      controller.setMessageReaction("prompt", "not emoji", false)
      controller.setMessageReaction("prompt", "👍", true)
      runCurrent()
      assertEquals(1, gateway.callCount("session.reactions.set"))
      val request = chatControllerTestJson.parseToJsonElement(requireNotNull(gateway.calls.last { it.method == "session.reactions.set" }.paramsJson)).jsonObject
      assertEquals("prompt", request.getValue("messageId").jsonPrimitive.content)
      assertEquals(JsonPrimitive(true), request["remove"])

      controller.handleGatewayEvent("session.reaction", event())
      pendingSet.complete("""{"messageId":"prompt","reactions":[]}""")
      runCurrent()
      assertEquals(
        2,
        controller.messageReactions.value
          .getValue("prompt")
          .single()
          .count,
      )
      controller.handleGatewayEvent("session.message", """{"session":{"key":"main","agentId":"main","sharingRole":"viewer","visibility":"read-only"}}""")
      assertFalse(controller.canReact.value)
      controller.setMessageReaction("prompt", "👍", true)
      runCurrent()
      assertEquals(1, gateway.callCount("session.reactions.set"))
    }

  @Test
  fun queuesDifferentEmojiRemovalsInMessageOrder() =
    runTest {
      val gateway = gateway()
      val firstResponse = CompletableDeferred<String>()
      gateway.respondWith(
        "session.reactions.list",
        """{"sessionId":"session-main","reactions":{"prompt":[{"emoji":"👍","count":1,"identities":[{"id":"riley"}]},{"emoji":"👀","count":1,"identities":[{"id":"riley"}]}]}}""",
      )
      gateway.respond("session.reactions.set") { params ->
        val emoji =
          chatControllerTestJson
            .parseToJsonElement(requireNotNull(params))
            .jsonObject
            .getValue("emoji")
            .jsonPrimitive.content
        if (emoji == "👍") firstResponse.await() else """{"messageId":"prompt","reactions":[]}"""
      }
      val controller = controller(gateway)
      controller.load("main")
      runCurrent()

      fun removals(): List<String> =
        gateway.calls.filter { it.method == "session.reactions.set" }.map {
          val params = chatControllerTestJson.parseToJsonElement(requireNotNull(it.paramsJson)).jsonObject
          assertEquals("prompt", params.getValue("messageId").jsonPrimitive.content)
          assertEquals(JsonPrimitive(true), params["remove"])
          params.getValue("emoji").jsonPrimitive.content
        }

      controller.setMessageReaction("prompt", "👍", true)
      controller.setMessageReaction("prompt", "👀", true)
      runCurrent()
      assertEquals(listOf("👍"), removals())

      controller.handleGatewayEvent(
        "session.reaction",
        """{"sessionKey":"main","agentId":"main","sessionId":"session-main","messageId":"prompt","emoji":"👍","action":"removed","actor":{"type":"human","id":"riley"},"reactions":[{"emoji":"👀","count":1,"identities":[{"id":"riley"}]}]}""",
      )
      firstResponse.complete("""{"messageId":"prompt","reactions":[{"emoji":"👀","count":1,"identities":[{"id":"riley"}]}]}""")
      runCurrent()
      assertEquals(listOf("👍", "👀"), removals())
      assertTrue(
        controller.messageReactions.value
          .getValue("prompt")
          .isEmpty(),
      )
    }

  @Test
  fun refreshedListOutranksAnInflightSetResponse() =
    runTest {
      val gateway = gateway()
      val pendingSet = CompletableDeferred<String>()
      gateway.respond("session.reactions.set") { pendingSet.await() }
      val controller = controller(gateway)
      controller.load("main")
      runCurrent()
      controller.setMessageReaction("prompt", "👍", true)
      runCurrent()
      assertEquals(1, gateway.callCount("session.reactions.set"))

      gateway.respondWith("session.reactions.list", """{"sessionId":"session-main","reactions":{}}""")
      controller.handleGatewayEvent("seqGap", null)
      runCurrent()
      assertEquals(2, gateway.callCount("session.reactions.list"))
      assertTrue(controller.messageReactions.value.isEmpty())

      pendingSet.complete("""{"messageId":"prompt","reactions":${reactions(2)}}""")
      runCurrent()
      assertTrue(controller.messageReactions.value.isEmpty())
    }

  @Test
  fun ignoresDelayedSetAndListAfterSwitchingSessions() =
    runTest {
      val gateway = gateway()
      val pendingSet = CompletableDeferred<String>()
      gateway.respond("session.reactions.set") { pendingSet.await() }
      val controller = controller(gateway)
      controller.load("main")
      runCurrent()
      controller.setMessageReaction("prompt", "👍", true)
      runCurrent()
      controller.switchSession("other")
      runCurrent()
      pendingSet.complete("""{"messageId":"prompt","reactions":[]}""")
      runCurrent()
      assertEquals(
        1,
        controller.messageReactions.value
          .getValue("prompt")
          .single()
          .count,
      )

      val pendingList = CompletableDeferred<String>()
      gateway.respond("session.reactions.list") { params ->
        if (gateway.sessionKeyOf(params) == "third") pendingList.await() else listResponse(gateway.sessionKeyOf(params) ?: "main")
      }
      controller.switchSession("third")
      runCurrent()
      controller.switchSession("other")
      runCurrent()
      pendingList.complete("""{"sessionId":"session-third","reactions":{}}""")
      runCurrent()
      assertEquals(
        1,
        controller.messageReactions.value
          .getValue("prompt")
          .single()
          .count,
      )
    }

  @Test
  fun revalidatesPermissionAtEnqueueAndRetiresDisconnectedResponses() =
    runTest {
      val gateway = gateway()
      var beforeEnqueue: (() -> Unit)? = null
      var physicalConnection = 1
      val pendingSet = CompletableDeferred<String>()
      gateway.respond("session.reactions.set") { pendingSet.await() }
      val controller =
        controller(gateway) { cacheScope ->
          val connection = physicalConnection
          GatewaySession.RequestLease(
            endpointStableId = requireNotNull(cacheScope).gatewayId,
            isCurrentImpl = { connection == physicalConnection },
          ) { method, params, _, enqueue ->
            if (method == "session.reactions.set") beforeEnqueue?.invoke()
            enqueue {}
            gateway.request(method, params)
          }
        }
      controller.load("main")
      runCurrent()
      beforeEnqueue = { controller.setReactionAccess(writer.copy(sessionCap = "none")) }
      controller.setMessageReaction("prompt", "👍", true)
      runCurrent()
      assertEquals(0, gateway.callCount("session.reactions.set"))
      assertFalse(controller.canReact.value)

      beforeEnqueue = null
      controller.setReactionAccess(writer)
      runCurrent()
      controller.setMessageReaction("prompt", "👍", true)
      runCurrent()
      assertEquals(1, gateway.callCount("session.reactions.set"))
      physicalConnection += 1
      pendingSet.complete("""{"messageId":"prompt","reactions":[]}""")
      runCurrent()
      assertEquals(
        1,
        controller.messageReactions.value
          .getValue("prompt")
          .single()
          .count,
      )
      controller.onDisconnected("offline")
      assertFalse(controller.canReact.value)
      assertTrue(controller.messageReactions.value.isEmpty())
    }

  @Test
  fun permissionsMatchTheControlUiTable() {
    data class Case(
      val role: String,
      val visibility: String,
      val cap: String?,
      val allowed: Boolean,
    )
    val cases =
      listOf(
        Case("owner", "shared", null, true),
        Case("admin", "draft", "write", true),
        Case("owner", "draft", "view", true),
        Case("member", "draft", null, false),
        Case("member", "read-only", "view", true),
        Case("viewer", "shared", null, true),
        Case("viewer", "shared", "write", true),
        Case("viewer", "shared", "suggest", false),
        Case("viewer", "shared", "view", false),
        Case("viewer", "suggest", "suggest", true),
        Case("viewer", "suggest", null, true),
        Case("viewer", "suggest", "view", false),
        Case("viewer", "read-only", "write", false),
        Case("viewer", "draft", "write", false),
        Case("owner", "shared", "none", false),
        Case("admin", "draft", "none", false),
      )
    val session = ChatSessionEntry(key = "main", updatedAtMs = null, sharingRole = "owner")

    fun allowed(
      access: ChatReactionAccess = writer,
      row: ChatSessionEntry? = session,
      connected: Boolean = true,
      advertised: Boolean = true,
      catalog: Boolean = false,
    ): Boolean = canReactToSession(access, row, connected, advertised, catalog)
    for (case in cases) {
      assertEquals(case.toString(), case.allowed, allowed(writer.copy(sessionCap = case.cap), session.copy(sharingRole = case.role, visibility = case.visibility)))
    }
    assertTrue(allowed(writer.copy(scopes = setOf("operator.admin"))))
    assertFalse(allowed(writer.copy(scopes = setOf("operator.read"))))
    assertFalse(allowed(writer.copy(scopes = setOf("operator.sessions.write"))))
    assertFalse(allowed(writer.copy(role = "node")))
    assertFalse(allowed(connected = false))
    assertFalse(allowed(advertised = false))
    assertFalse(allowed(catalog = true))
    assertFalse(allowed(row = session.copy(archived = true)))
    assertFalse(allowed(row = session.copy(sharingRole = null)))
    assertFalse(allowed(row = null))
  }

  @Test
  fun validatesOneEmojiGraphemeUsingTheGatewayAdmissionGrammar() {
    for (emoji in listOf("👍", "❤️", "🎉", "👀", "🚀", "😂", "👍🏽", "👩🏽‍💻", "👨‍👩‍👧‍👦", "🇦🇹", "1️⃣", "#⃣", "🏴\uDB40\uDC67\uDB40\uDC62\uDB40\uDC65\uDB40\uDC6E\uDB40\uDC67\uDB40\uDC7F")) {
      assertTrue(emoji, isReactionEmoji(emoji))
    }
    for (value in listOf("", "a", "1", "👍👍", " 👍", "👍 ", "🇦", "🏽", "👍‍", "❤︎", "a\u0301", "👨‍".repeat(17) + "👨")) {
      assertFalse(value, isReactionEmoji(value))
    }
  }
}
