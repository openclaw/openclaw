package ai.openclaw.app.chat

import ai.openclaw.app.gateway.GatewayErrorDetails
import ai.openclaw.app.gateway.GatewayRequestRejected
import ai.openclaw.app.gateway.GatewaySession
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class ChatTranscriptHistoryRefreshTest {
  private fun refusal() =
    GatewayRequestRejected(
      GatewaySession.ErrorShape("UNAVAILABLE", "busy", GatewayErrorDetails(null, false, null, retryable = true)),
    )

  @Test
  fun obsoleteInvalidationCannotCancelTheCurrentOwnersRecovery() =
    runTest {
      val refresh = ChatTranscriptHistoryRefresh(backgroundScope, 750)
      val current = ChatTranscriptHistoryRefresh.Owner("current", 2, ChatCacheScope("gateway", 1), "main")
      val obsolete = current.copy(sessionKey = "old", generation = 1)
      var reads = 0
      refresh.request(current, isCurrent = { true }, refresh = { if (++reads == 1) throw refusal() })
      runCurrent()
      refresh.request(obsolete, isCurrent = { false }, refresh = { error("obsolete owner read") })
      advanceTimeBy(750)
      runCurrent()
      assertEquals(2, reads)
    }

  @Test
  fun refusalsDuringRecoveryRequireOneTrailingRead() =
    runTest {
      val refresh = ChatTranscriptHistoryRefresh(backgroundScope, 750)
      val owner = ChatTranscriptHistoryRefresh.Owner("main", 1, ChatCacheScope("gateway", 1), "main")
      val firstRecovery = CompletableDeferred<Unit>()
      var recoveryReads = 0
      var first = true
      refresh.request(owner, isCurrent = { true }, refresh = {
        if (first) {
          first = false
          throw refusal()
        }
        recoveryReads += 1
        if (recoveryReads == 1) firstRecovery.await()
      })
      runCurrent()
      advanceTimeBy(750)
      runCurrent()
      assertEquals(1, recoveryReads)
      repeat(3) { refresh.request(owner, isCurrent = { true }, refresh = { throw refusal() }) }
      runCurrent()
      assertEquals(1, recoveryReads)
      firstRecovery.complete(Unit)
      runCurrent()
      advanceTimeBy(750)
      runCurrent()
      assertEquals(2, recoveryReads)
      advanceTimeBy(750)
      runCurrent()
      assertEquals(2, recoveryReads)
    }

  @Test
  fun overlappingNormalSuccessDoesNotDiscardQueuedRecovery() =
    runTest {
      val refresh = ChatTranscriptHistoryRefresh(backgroundScope, 750)
      val owner = ChatTranscriptHistoryRefresh.Owner("main", 1, ChatCacheScope("gateway", 1), "main")
      var refusedReads = 0
      var successfulReads = 0
      refresh.request(owner, isCurrent = { true }, refresh = { if (++refusedReads == 1) throw refusal() })
      runCurrent()
      refresh.request(owner, isCurrent = { true }, refresh = { successfulReads += 1 })
      runCurrent()
      assertEquals(1, successfulReads)
      assertEquals(1, refusedReads)
      advanceTimeBy(750)
      runCurrent()
      assertEquals(2, refusedReads)
    }
}
