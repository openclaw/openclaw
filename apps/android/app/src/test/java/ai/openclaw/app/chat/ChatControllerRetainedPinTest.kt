package ai.openclaw.app.chat

import ai.openclaw.app.gateway.GatewaySession
import androidx.room3.Room
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
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
import org.robolectric.RuntimeEnvironment

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

  private fun TestScope.openPinnedThread(
    cache: ChatTranscriptCache? = null,
    captureLease: ((ChatCacheScope?) -> GatewaySession.RequestLease?)? = null,
  ): ChatController {
    gateway.respondWith("sessions.list", """{"ts":100,"activityExpiresAt":199,"sessions":[{"key":"cedar","sessionId":"cedar-id","label":"Cedar","category":"Forest","pinned":true},{"key":"elm"}]}""")
    gateway.respond("chat.history") { params ->
      val key = requireNotNull(gateway.sessionKeyOf(params))
      historyResponse("$key-id", listOf(ReplayHistoryMessage("user", "$key context", 1)))
    }
    val controller =
      createChatController(
        cacheScope = { connection },
        transcriptCache = cache,
        captureRequestLease = captureLease,
        gatewayAdvertisesCapability = { it == "personal-session-pins" && personalPins },
        requestGateway = gateway::request,
      )
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
      gateway.respondWith("sessions.list", """{"sessions":[{"key":"birch","pinned":true},{"key":"cedar","sessionId":"cedar-id","pinned":true}],"hasMore":false}""")
      assertTrue(controller.loadMoreSessions())
      val cursor = chatControllerTestJson.parseToJsonElement(gateway.calls.last { it.method == "sessions.list" }.paramsJson!!).jsonObject
      assertEquals(JsonPrimitive(2), cursor["limit"])
      assertEquals(JsonPrimitive(2), cursor["offset"])
      assertEquals(listOf("ash", "elm", "birch", "cedar"), controller.sessions.value.map { it.key })
      assertEquals(2, gateway.callCount("sessions.describe"))
    }

  @Test
  fun aSelectedMemberOfTheRankedPrefixKeepsItsSlotIfTheCursorOverlapsIt() =
    runTest {
      val controller = openPinnedThread()
      gateway.respondWith("sessions.list", """{"sessions":[{"key":"cedar","sessionId":"cedar-id","pinned":true},{"key":"elm","pinned":true}],"nextOffset":2,"totalCount":3}""")
      controller.preferenceChanged()
      runCurrent()
      gateway.respondWith("sessions.list", """{"sessions":[{"key":"ash","pinned":true},{"key":"cedar","sessionId":"cedar-id","pinned":true,"label":"New Cedar"}]}""")
      assertTrue(controller.loadMoreSessions())
      assertEquals(listOf("cedar", "elm", "ash"), controller.sessions.value.map { it.key })
      assertEquals("New Cedar", controller.cedar().label)
      assertEquals("cedar context", controller.openMessage())
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

  private fun TestScope.holdPinRead(
    controller: ChatController,
    refresh: () -> Unit = { controller.preferenceChanged() },
  ): CompletableDeferred<String> {
    gateway.respondWith("sessions.list", offPage)
    val reply = CompletableDeferred<String>()
    gateway.respond("sessions.describe") { reply.await() }
    refresh()
    runCurrent()
    assertEquals(1, gateway.callCount("sessions.describe"))
    return reply
  }

  @Test
  fun heldPinReadDoesNotDelayRowsCacheOrCursorAndOnlyUpdatesTheLiveSelectedPin() =
    runTest {
      val db =
        Room
          .inMemoryDatabaseBuilder(RuntimeEnvironment.getApplication(), GatewayCacheDatabase::class.java)
          .setQueryCoroutineContext(coroutineContext.minusKey(Job))
          .build()
      try {
        val cache = RoomChatTranscriptCache(db)
        val controller = openPinnedThread(cache)
        val reply = holdPinRead(controller)
        val page = listOf("elm", "ash", "cedar")
        assertEquals(page, controller.sessions.value.map { it.key })
        assertTrue(controller.sessionRosterHasMore.value)
        assertEquals(page, cache.loadSessions("test", "ops").map { it.key })
        gateway.respondWith("sessions.list", """{"sessions":[{"key":"birch"}],"hasMore":false}""")
        val append = async { controller.loadMoreSessions() }
        runCurrent()
        assertTrue("pagination must finish while the optional reply is held", append.isCompleted && append.await())
        val extended = listOf("elm", "ash", "birch", "cedar")
        assertEquals(extended, controller.sessions.value.map { it.key })
        assertEquals(false, controller.sessionRosterHasMore.value)
        controller.handleGatewayEvent("sessions.changed", """{"agentId":"ops","session":{"key":"cedar","label":"Cedar renamed"}}""")
        val renamed = controller.cedar()
        assertEquals("Cedar renamed", renamed.label)
        assertEquals(true, renamed.pinned)
        reply.complete(description(false))
        runCurrent()
        assertEquals(extended, controller.sessions.value.map { it.key })
        assertEquals(renamed.copy(pinned = false), controller.cedar())
        assertEquals("cedar context", controller.openMessage())
        assertEquals(extended, cache.loadSessions("test", "ops").map { it.key })
      } finally {
        db.close()
      }
    }

  @Test
  fun aNewerFirstPageOwnsTheSelectedPin() = checkNewerPageOwnsTheSelectedPin(append = false)

  @Test
  fun aCursorThatFindsTheSelectionOwnsItsPin() = checkNewerPageOwnsTheSelectedPin(append = true)

  private fun checkNewerPageOwnsTheSelectedPin(append: Boolean) =
    runTest {
      val controller = openPinnedThread()
      val reply = holdPinRead(controller)
      gateway.respondWith("sessions.list", """{"sessions":[{"key":"cedar","sessionId":"cedar-id","label":"Pinned again","pinned":true},{"key":"willow"}]}""")
      val next = async { if (append) assertTrue(controller.loadMoreSessions()) else controller.preferenceChanged() }
      runCurrent()
      assertTrue("newer roster request blocked on detail", next.isCompleted)
      val newer = controller.sessions.value
      assertEquals(if (append) listOf("elm", "ash", "cedar", "willow") else listOf("cedar", "willow"), newer.map { it.key })
      assertEquals("Pinned again", controller.cedar().label)
      reply.complete(description(false))
      runCurrent()
      assertEquals(newer, controller.sessions.value)
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
      controller.handleGatewayEvent("sessions.changed", """{"agentId":"ops","session":{"key":"cedar","sessionId":"new-id","label":"New Cedar"}}""")
      reply.complete(description(false))
      runCurrent()
      val row = controller.cedar()
      assertEquals("new-id", row.sessionId)
      assertEquals("New Cedar", row.label)
      assertEquals(true, row.pinned)
    }

  @Test
  fun anExplicitLivePinWinsEvenWhenItsValueDidNotChange() =
    runTest {
      val controller = openPinnedThread()
      val reply = holdPinRead(controller)
      controller.handleGatewayEvent("sessions.changed", """{"agentId":"ops","session":{"key":"cedar","sessionId":"cedar-id","pinned":true}}""")
      reply.complete(description(false))
      runCurrent()
      assertEquals(true, controller.cedar().pinned)
    }

  @Test
  fun aWakePublishesItsPageButItsPinCannotOutliveThePhysicalLease() =
    runTest {
      var connected = true
      val controller =
        openPinnedThread(captureLease = {
          GatewaySession.RequestLease(connection.gatewayId, isCurrentImpl = { connected }) { method, params, _, guard ->
            guard {}
            gateway.request(method, params)
          }
        })
      val wake = requireNotNull(controller.sessionWindowWake.value)
      val before = controller.sessionBrowserRevision.value
      val reply = holdPinRead(controller) { controller.refreshSessionsAfterWake(wake) }
      assertEquals(before + 1, controller.sessionBrowserRevision.value)
      assertEquals(listOf("elm", "ash", "cedar"), controller.sessions.value.map { it.key })
      connected = false // Same logical scope and operator epoch; only this socket is retired.
      reply.complete(description(false))
      runCurrent()
      assertEquals(true, controller.cedar().pinned)
    }

  @Test
  fun reconnectKeepsTheAcceptedPageButDiscardsItsPendingPinRead() =
    runTest {
      val controller = openPinnedThread()
      val reply = holdPinRead(controller)
      val accepted = controller.sessions.value
      assertEquals(listOf("elm", "ash", "cedar"), accepted.map { it.key })
      connection = ChatCacheScope("test", 2)
      reply.complete(description(false))
      runCurrent()
      assertEquals(accepted, controller.sessions.value)
    }
}
