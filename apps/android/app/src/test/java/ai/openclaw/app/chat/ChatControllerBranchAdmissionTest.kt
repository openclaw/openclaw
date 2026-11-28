package ai.openclaw.app.chat

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class ChatControllerBranchAdmissionTest {
  @Test
  fun cancellingBranchReconciliationReleasesAdmissionAndAllowsRetry() =
    runTest {
      val gateway = ScriptedGateway(chatControllerTestJson)
      val outbox = createChatCommandOutbox()
      val branchScope = ChatOutboxScope("main", "main")
      val controller =
        ChatController(
          scope = this,
          json = chatControllerTestJson,
          requestGateway = gateway::request,
          cacheScope = { ChatCacheScope("gateway-test", 1L) },
          commandOutbox = outbox,
        )
      controller.outboxPresentationRestored.first { it }
      gateway.respondWith("sessions.branches.list", branches("leaf-a"))
      assertTrue(controller.refreshSessionBranches())

      // A failed switch and failed recovery leave the existing picker usable for retry.
      gateway.respond("sessions.branches.switch") { error("connection lost") }
      gateway.respond("chat.history") { error("history unavailable") }
      assertFalse(controller.switchSessionBranch("main", "leaf-b"))
      val failedState = checkNotNull(outbox.branchState("gateway-test", branchScope))
      assertTrue(failedState.needsReconciliation)
      assertFalse(controller.sessionBranchSwitching.value)
      val retainedActive = controller.sessionBranches.value.single { it.active }
      assertEquals("leaf-a", retainedActive.leafEntryId)

      val reconciliationStarted = CompletableDeferred<Unit>()
      val holdReconciliation = CompletableDeferred<Unit>()
      gateway.respond("sessions.branches.list") {
        reconciliationStarted.complete(Unit)
        holdReconciliation.await()
        branches("leaf-a")
      }
      val retry = async { controller.switchSessionBranch("main", "leaf-b") }
      reconciliationStarted.await()
      assertTrue(controller.sessionBranchSwitching.value)
      assertFalse(controller.canSwitchSessionBranch("main"))
      assertFalse(controller.switchSessionBranch("main", "leaf-b"))
      assertEquals(1, gateway.callCount("sessions.branches.switch"))

      // Models the ChatScreen composition owner disappearing during the preflight read.
      retry.cancelAndJoin()
      assertFalse(controller.sessionBranchSwitching.value)
      assertFalse(controller.sessionBranchesLoading.value)
      assertTrue(controller.canSwitchSessionBranch("main"))
      val cancelledState = checkNotNull(outbox.branchState("gateway-test", branchScope))
      assertTrue(cancelledState.needsReconciliation)
      assertNull(cancelledState.switchPendingSinceMs)
      assertEquals(1, gateway.callCount("sessions.branches.switch"))

      var activeLeaf = "leaf-a"
      gateway.respond("sessions.branches.list") { branches(activeLeaf) }
      gateway.respond("sessions.branches.switch") {
        activeLeaf = "leaf-b"
        "{}"
      }
      gateway.respondWith(
        "chat.history",
        historyResponse(
          sessionId = "session-main",
          messages = listOf(ReplayHistoryMessage("user", "Selected branch", 1, entryId = "leaf-b")),
        ),
      )
      assertTrue(controller.switchSessionBranch("main", "leaf-b"))
      assertFalse(controller.sessionBranchSwitching.value)
      assertEquals(2, gateway.callCount("sessions.branches.switch"))
      val finalActive = controller.sessionBranches.value.single { it.active }
      assertEquals("leaf-b", finalActive.leafEntryId)
      val finalState = checkNotNull(outbox.branchState("gateway-test", branchScope))
      assertFalse(finalState.needsReconciliation)
      assertNull(finalState.switchPendingSinceMs)
      assertEquals("leaf-b", finalState.lastActiveLeafEntryId)
    }

  private fun branches(activeLeaf: String): String =
    """{"branches":[
      {"leafEntryId":"leaf-a","headline":"Original branch","messageCount":1,
       "active":${activeLeaf == "leaf-a"}},
      {"leafEntryId":"leaf-b","headline":"Selected branch","messageCount":1,
       "active":${activeLeaf == "leaf-b"}}
    ]}"""
}
