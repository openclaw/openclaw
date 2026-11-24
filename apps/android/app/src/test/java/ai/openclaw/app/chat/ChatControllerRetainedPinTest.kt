package ai.openclaw.app.chat

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class ChatControllerRetainedPinTest {
  private val gateway = ScriptedGateway(chatControllerTestJson)
  private var personalPins = true
  private var connection = ChatCacheScope("test", 1)
  private val offPage = """{"sessions":[{"key":"elm","pinned":true},{"key":"ash","pinned":false}],"totalCount":4,"nextOffset":2}"""

  private fun description(
    pinned: Boolean,
    id: String = "cedar-id",
  ) = """{"session":{"key":"cedar","agentId":"ops","sessionId":"$id","label":"Not a roster snapshot","pinned":$pinned}}"""

  private fun ChatController.cedar() = sessions.value.single { it.key == "cedar" }

  private fun ChatController.openMessage() =
    messages.value
      .single()
      .content
      .single()
      .text

  private fun TestScope.openPinnedThread(): ChatController {
    gateway.respondWith("sessions.list", """{"sessions":[{"key":"cedar","sessionId":"cedar-id","label":"Cedar","category":"Forest","pinned":true},{"key":"elm"}],"totalCount":4}""")
    gateway.respond("chat.history") { params ->
      val key = requireNotNull(gateway.sessionKeyOf(params))
      historyResponse("$key-id", listOf(ReplayHistoryMessage("user", "$key context", 1)))
    }
    val controller = createChatController(cacheScope = { connection }, gatewayAdvertisesCapability = { it == "personal-session-pins" && personalPins }, requestGateway = gateway::request)
    controller.switchSession("cedar", "ops")
    controller.refreshSessions(limit = 2)
    runCurrent()
    assertEquals(true, controller.cedar().pinned)
    assertEquals("cedar context", controller.openMessage())
    assertEquals(0, gateway.callCount("sessions.describe"))
    return controller
  }

  private fun ChatController.preferenceChanged() = handleGatewayEvent("users.prefs.changed", """{"keys":["ui.railShortcuts"]}""")

  @Test
  fun peerUnpinReconcilesOnlyTheSelectedPinOutsideTheReturnedPage() =
    runTest {
      val controller = openPinnedThread()
      val selected = controller.cedar()
      val messages = controller.messages.value
      gateway.respondWith("sessions.list", offPage)
      gateway.respondWith("sessions.describe", description(false))
      controller.preferenceChanged()
      runCurrent()
      assertEquals(listOf("elm", "ash", "cedar"), controller.sessions.value.map { it.key })
      assertEquals(selected.copy(pinned = false), controller.sessions.value.last())
      assertEquals("cedar", controller.sessionKey.value)
      assertEquals("cedar-id", controller.sessionId.value)
      assertEquals(messages, controller.messages.value)
      val exact = gateway.calls.single { it.method == "sessions.describe" }
      assertEquals(mapOf("key" to JsonPrimitive("cedar"), "agentId" to JsonPrimitive("ops")), chatControllerTestJson.parseToJsonElement(exact.paramsJson!!).jsonObject.toMap())

      // Absence alone cannot clear a pin: two earlier saved pins can fill the entire window.
      gateway.respondWith("sessions.list", """{"sessions":[{"key":"ash","pinned":true},{"key":"elm","pinned":true}],"totalCount":4,"nextOffset":2}""")
      gateway.respondWith("sessions.describe", description(true))
      controller.preferenceChanged()
      runCurrent()
      assertEquals(listOf("ash", "elm", "cedar"), controller.sessions.value.map { it.key })
      assertEquals(selected, controller.sessions.value.last())
      gateway.respondWith("sessions.list", """{"sessions":[{"key":"cedar","sessionId":"cedar-id","pinned":true},{"key":"birch"}],"hasMore":false}""")
      assertTrue(controller.loadMoreSessions())
      val cursor = chatControllerTestJson.parseToJsonElement(gateway.calls.last { it.method == "sessions.list" }.paramsJson!!).jsonObject
      assertEquals(JsonPrimitive(2), cursor["limit"])
      assertEquals(JsonPrimitive(2), cursor["offset"])
      assertEquals(listOf("ash", "elm", "cedar", "birch"), controller.sessions.value.map { it.key })
      assertEquals(2, gateway.callCount("sessions.describe"))
    }

  @Test
  fun failedReadsAndUnmatchedDescriptionsDoNotUnpinTheSelectionOrDiscardAnAcceptedPage() =
    runTest {
      val controller = openPinnedThread()
      val initial = controller.sessions.value
      gateway.respond("sessions.list") { error("offline") }
      controller.preferenceChanged()
      runCurrent()
      assertEquals(initial, controller.sessions.value)
      gateway.respondWith("sessions.list", offPage)
      gateway.respond("sessions.describe") { error("not readable") }
      controller.preferenceChanged()
      runCurrent()
      val accepted = controller.sessions.value
      assertEquals(listOf("elm", "ash", "cedar"), accepted.map { it.key })
      assertEquals(initial.first(), accepted.last())
      val unmatched =
        listOf(
          description(false, "successor"),
          """{"session":{"key":"cedar","agentId":"other","sessionId":"cedar-id","pinned":false}}""",
          """{"session":null}""",
        )
      for (other in unmatched) {
        gateway.respondWith("sessions.describe", other)
        controller.preferenceChanged()
        runCurrent()
        assertEquals(accepted, controller.sessions.value)
      }
      // A legacy connection has shared pin semantics; never ask it for a personal projection.
      personalPins = false
      val reads = gateway.callCount("sessions.describe")
      assertEquals(1 + unmatched.size, reads)
      gateway.respondWith("sessions.describe", description(false))
      controller.preferenceChanged()
      runCurrent()
      assertEquals(reads, gateway.callCount("sessions.describe"))
      assertEquals(accepted, controller.sessions.value)
    }

  private fun TestScope.holdPinRead(controller: ChatController): CompletableDeferred<String> {
    gateway.respondWith("sessions.list", offPage)
    val reply = CompletableDeferred<String>()
    gateway.respond("sessions.describe") { reply.await() }
    controller.preferenceChanged()
    runCurrent()
    assertEquals(1, gateway.callCount("sessions.describe"))
    return reply
  }

  @Test
  fun anExactReplyCannotFollowTheSelectionAwayAndBack() =
    runTest {
      val controller = openPinnedThread()
      val reply = holdPinRead(controller)
      controller.switchSession("elm", "ops")
      runCurrent()
      controller.switchSession("cedar", "ops")
      runCurrent()
      reply.complete(description(false))
      runCurrent()
      assertEquals(true, controller.cedar().pinned)
      assertEquals("cedar context", controller.openMessage())
    }

  @Test
  fun anExactReplyCannotUnpinANewerIncarnationOfTheSameSelectedKey() =
    runTest {
      val controller = openPinnedThread()
      val reply = holdPinRead(controller)
      controller.handleGatewayEvent("sessions.changed", """{"agentId":"ops","session":{"key":"cedar","sessionId":"new-id","label":"New Cedar","pinned":true}}""")
      reply.complete(description(false))
      runCurrent()
      val row = controller.cedar()
      assertEquals("new-id", row.sessionId)
      assertEquals("New Cedar", row.label)
      assertEquals(true, row.pinned)
    }

  @Test
  fun reconnectDiscardsBothTheOldPageAndItsPendingPinRead() =
    runTest {
      val controller = openPinnedThread()
      val before = controller.sessions.value
      val reply = holdPinRead(controller)
      connection = ChatCacheScope("test", 2)
      reply.complete(description(false))
      runCurrent()
      assertEquals(before, controller.sessions.value)
    }
}
