package ai.openclaw.wear

import ai.openclaw.wear.shared.WearDecodeResult
import ai.openclaw.wear.shared.WearEventType
import ai.openclaw.wear.shared.WearMessage
import ai.openclaw.wear.shared.WearProtocol
import ai.openclaw.wear.shared.WearProtocolCodec
import ai.openclaw.wear.shared.WearRealtimeTalkCodec
import ai.openclaw.wear.shared.WearRealtimeTalkSnapshot
import ai.openclaw.wear.shared.WearRpcError
import ai.openclaw.wear.shared.WearRpcMethod
import android.app.NotificationManager
import android.content.Intent
import android.os.Looper
import android.os.Parcel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.ViewModelStoreOwner
import com.google.android.gms.wearable.ChannelClient
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestCoroutineScheduler
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import kotlin.coroutines.Continuation
import kotlin.coroutines.resume
import kotlin.coroutines.suspendCoroutine

@RunWith(RobolectricTestRunner::class)
@Config(application = WearApplication::class, sdk = [35])
class WearConversationContextTest {
  @Test
  fun correlatedTerminalRetiresRetryIdentityWithoutSendAcknowledgement() {
    for (outcome in listOf("final", "error", "aborted")) {
      withFlow { flow ->
        flow.holdSendResponses = true
        assertTrue(flow.vm.sendReply("Same message"))
        flow.idle()
        val completedRun = flow.sentRunIds.single()
        flow.emitChatTerminal(outcome, completedRun)
        assertEquals(completedRun, flow.state.replyTerminal?.runId)
        flow.emitConnection(false)
        flow.emitConnection(true)
        flow.idle()
        assertTrue(flow.vm.sendReply("Same message"))
        flow.idle()
        assertNotEquals("A terminal proves the original request completed", completedRun, flow.sentRunIds.last())
      }
    }
  }

  @Test
  fun terminalHistoryAfterReconnectRetiresUnacknowledgedRetryIdentity() {
    for (suffix in listOf("", ":settled-finalization-fallback", ":assistant", ":terminal-error")) {
      withFlow { flow ->
        flow.holdSendResponses = true
        assertTrue(flow.vm.sendReply("Same message"))
        flow.idle()
        val completedRun = flow.sentRunIds.single()
        flow.historyIdempotencyKey = completedRun + suffix
        flow.emitConnection(false)
        flow.emitConnection(true)
        flow.idle()
        assertTrue(flow.vm.sendReply("Same message"))
        flow.idle()
        assertNotEquals("Canonical terminal history proves completion after the UI pending state was revoked", completedRun, flow.sentRunIds.last())
      }
    }
  }

  @Test
  fun foreignTerminalDoesNotRetireUnresolvedRetryIdentity() =
    withFlow { flow ->
      flow.holdSendResponses = true
      assertTrue(flow.vm.sendReply("Same message"))
      flow.idle()
      val unresolvedRun = flow.sentRunIds.single()
      flow.emitChatTerminal("final", "foreign-run")
      flow.historyIdempotencyKey = "foreign-run"
      flow.emitConnection(false)
      flow.emitConnection(true)
      flow.idle()
      assertTrue(flow.vm.sendReply("Same message"))
      flow.idle()
      assertEquals(unresolvedRun, flow.sentRunIds.last())
    }

  @Test
  fun failedOldPhoneStopCannotRejectAValidNewPhoneNotification() =
    withFlow { flow ->
      flow.installControlledTalkChannel()
      flow.rejectStop = true
      flow.vm.stopRealtimeTalk()
      flow.idle()
      flow.changePhone("phone-b")
      flow.vm.openNotification(WearConversationTarget("agent:alpha:shared", "phone-b"))
      flow.idle()
      assertEquals("phone-b", flow.state.phoneNodeId)
      assertEquals("agent:alpha:shared", flow.state.selectedSession?.key)
      assertNull(flow.state.failure)
      assertEquals("No old-phone Stop is rerouted to the new owner", listOf("talk-beta"), flow.stoppedAttempts)
    }

  @Test
  fun samePhoneNotificationStillObservesAnUnsettledFailedStop() =
    withFlow { flow ->
      flow.installControlledTalkChannel()
      flow.rejectStop = true
      flow.vm.stopRealtimeTalk()
      flow.idle()
      flow.vm.openNotification(WearConversationTarget("agent:alpha:shared", "phone-a"))
      flow.idle()
      assertNull(flow.state.selectedSession)
      assertEquals(WearConversationFailure.ACTION_REJECTED, flow.state.failure)
      assertEquals(listOf("talk-beta", "talk-beta"), flow.stoppedAttempts)
    }

  @Test
  fun newPhoneNotificationRecoversAfterJoiningAnOldPhonePendingStop() =
    withFlow { flow ->
      flow.installControlledTalkChannel()
      val gate = CompletableDeferred<Unit>()
      flow.stopGate = gate
      flow.vm.stopRealtimeTalk()
      flow.idle()
      flow.changePhone("phone-b")
      flow.vm.openNotification(WearConversationTarget("agent:alpha:shared", "phone-b"))
      flow.idle()
      gate.complete(Unit)
      flow.idle()
      assertEquals("phone-b", flow.state.phoneNodeId)
      assertEquals("agent:alpha:shared", flow.state.selectedSession?.key)
      assertFalse(flow.state.loading)
      assertNull(flow.state.failure)
      assertEquals(listOf("talk-beta"), flow.stoppedAttempts)
    }

  @OptIn(ExperimentalCoroutinesApi::class)
  @Test
  fun newPhoneNotificationOpensAfterOldPhoneStopTimeout() =
    runTest {
      for (retryUnsettled in listOf(false, true)) {
        withFlow(testScheduler) { flow ->
          flow.installControlledTalkChannel()
          if (retryUnsettled) {
            flow.rejectStop = true
            flow.vm.stopRealtimeTalk()
            flow.idle()
            flow.rejectStop = false
          }
          // The send succeeds but no response is delivered: the real requester owns the deadline.
          flow.holdStopResponses = true
          flow.vm.stopRealtimeTalk()
          flow.idle()
          flow.changePhone("phone-b")
          flow.vm.openNotification(WearConversationTarget("agent:alpha:shared", "phone-b"))
          flow.idle()
          assertTrue(flow.state.talkBusy)
          assertTrue(flow.historyKeys.none { it == "agent:alpha:shared" })
          assertNull(flow.talkClient.talkTestField("activeAttempt"))
          testScheduler.advanceTimeBy(WearProtocol.RPC_REQUEST_TIMEOUT_MILLIS - 1)
          flow.idle()
          assertTrue("New phone must still wait for the original Stop", flow.state.talkBusy)
          assertTrue(flow.historyKeys.none { it == "agent:alpha:shared" })
          testScheduler.advanceTimeBy(1)
          flow.idle()
          assertEquals("phone-b", flow.state.selectedSession?.phoneNodeId)
          assertEquals("agent:alpha:shared", flow.state.selectedSession?.key)
          assertEquals(
            "Alpha reply",
            flow.state.messages
              .single()
              .text,
          )
          assertFalse(flow.state.loading)
          assertFalse(flow.state.talkBusy)
          assertFalse(flow.talkClient.isCapturing.value)
          assertNull(flow.state.failure)
          assertEquals(List(if (retryUnsettled) 2 else 1) { "talk-beta" }, flow.stoppedAttempts)
          assertTrue(flow.stoppedPhones.all { it == "phone-a" })
        }
      }
    }

  @OptIn(ExperimentalCoroutinesApi::class)
  @Test
  fun newPhoneNotificationOpensAfterOldPhoneStopTransportFailure() =
    runTest {
      withFlow(testScheduler) { flow ->
        flow.installControlledTalkChannel()
        val gate = CompletableDeferred<Unit>()
        flow.stopGate = gate
        flow.failStopTransport = true
        flow.vm.stopRealtimeTalk()
        flow.idle()
        val samePhone = async { runCatching { flow.talkClient.stop("phone-a") } }
        val unknownPhone = async { runCatching { flow.talkClient.stop() } }
        flow.idle()
        flow.changePhone("phone-b")
        flow.vm.openNotification(WearConversationTarget("agent:alpha:shared", "phone-b"))
        flow.idle()
        assertFalse(samePhone.isCompleted)
        assertTrue(flow.state.talkBusy)
        assertTrue(flow.historyKeys.none { it == "agent:alpha:shared" })
        gate.complete(Unit)
        flow.idle()
        assertEquals("phone_unavailable", (samePhone.getCompleted().exceptionOrNull() as WearProxyException).code)
        assertEquals("phone_unavailable", (unknownPhone.getCompleted().exceptionOrNull() as WearProxyException).code)
        assertEquals("phone-b", flow.state.selectedSession?.phoneNodeId)
        assertEquals("agent:alpha:shared", flow.state.selectedSession?.key)
        assertNull(flow.state.failure)
        assertFalse(flow.state.loading)
        assertFalse(flow.state.talkBusy)
        assertEquals(listOf("talk-beta"), flow.stoppedAttempts)
        assertEquals(listOf("phone-a"), flow.stoppedPhones)
      }
    }

  @Test
  fun replacementNotificationOpensAfterOriginalPhoneStopTimeout() = assertReplacementNotificationAfterStop(transportFailure = false)

  @Test
  fun replacementNotificationOpensAfterOriginalPhoneStopTransportFailure() = assertReplacementNotificationAfterStop(transportFailure = true)

  @OptIn(ExperimentalCoroutinesApi::class)
  private fun assertReplacementNotificationAfterStop(transportFailure: Boolean) =
    runTest {
      withFlow(testScheduler) { flow ->
        flow.installControlledTalkChannel()
        val gate = CompletableDeferred<Unit>()
        flow.stopGate = gate
        flow.holdStopResponses = !transportFailure
        flow.failStopTransport = transportFailure
        // This notification owns Stop; its replacement does not call stop again.
        flow.vm.openNotification(WearConversationTarget("agent:beta:shared", "phone-a"))
        flow.idle()
        assertEquals(listOf("phone-a"), flow.stoppedPhones)
        flow.changePhone("phone-b")
        flow.vm.openNotification(WearConversationTarget("agent:alpha:shared", "phone-b"))
        flow.idle()
        assertTrue(flow.state.talkBusy)
        assertTrue(flow.historyKeys.none { it == "agent:alpha:shared" })
        gate.complete(Unit)
        flow.idle()
        if (!transportFailure) {
          testScheduler.advanceTimeBy(WearProtocol.RPC_REQUEST_TIMEOUT_MILLIS - 1)
          flow.idle()
          assertTrue("Replacement still waits for original cleanup", flow.state.talkBusy)
          assertTrue(flow.historyKeys.none { it == "agent:alpha:shared" })
          testScheduler.advanceTimeBy(1)
          flow.idle()
        }
        assertEquals("phone-b", flow.state.selectedSession?.phoneNodeId)
        assertEquals("agent:alpha:shared", flow.state.selectedSession?.key)
        assertNull(flow.state.failure)
        assertFalse(flow.state.loading)
        assertFalse(flow.state.talkBusy)
        assertFalse(flow.talkClient.isCapturing.value)
        assertEquals(listOf("talk-beta"), flow.stoppedAttempts)
        assertEquals(listOf("phone-a"), flow.stoppedPhones)
      }
    }

  @OptIn(ExperimentalCoroutinesApi::class)
  @Test
  fun samePhoneReplacementRetainsOriginalStopTimeout() =
    runTest {
      withFlow(testScheduler) { flow ->
        flow.installControlledTalkChannel()
        flow.holdStopResponses = true
        flow.vm.openNotification(WearConversationTarget("agent:beta:shared", "phone-a"))
        flow.idle()
        flow.vm.openNotification(WearConversationTarget("agent:alpha:shared", "phone-a"))
        flow.idle()
        testScheduler.advanceTimeBy(WearProtocol.RPC_REQUEST_TIMEOUT_MILLIS)
        flow.idle()
        assertNull(flow.state.selectedSession)
        assertNotNull(flow.state.failure)
        assertFalse(flow.state.talkBusy)
        assertTrue(flow.historyKeys.none { it == "agent:alpha:shared" })
        testScheduler.advanceTimeBy(WearProtocol.RPC_REQUEST_TIMEOUT_MILLIS * 2)
        flow.idle()
        assertEquals("Discovery cannot retry failed cleanup automatically", listOf("phone-a"), flow.stoppedPhones)
        assertNull(flow.state.selectedSession)
        flow.holdStopResponses = false
        flow.vm.refresh()
        flow.idle()
        assertEquals("agent:alpha:shared", flow.state.selectedSession?.key)
        assertNull(flow.state.failure)
        assertEquals("Explicit refresh retains canonical recovery without another Stop RPC", listOf("phone-a"), flow.stoppedPhones)
      }
    }

  @OptIn(ExperimentalCoroutinesApi::class)
  @Test
  fun replacementNotificationMustMatchRediscoveredPhoneAfterStopFailure() =
    runTest {
      withFlow(testScheduler) { flow ->
        flow.installControlledTalkChannel()
        flow.holdStopResponses = true
        flow.vm.openNotification(WearConversationTarget("agent:beta:shared", "phone-a"))
        flow.idle()
        // The requested destination alone is not evidence that phone B is preferred.
        flow.vm.openNotification(WearConversationTarget("agent:alpha:shared", "phone-b"))
        flow.idle()
        testScheduler.advanceTimeBy(WearProtocol.RPC_REQUEST_TIMEOUT_MILLIS)
        flow.idle()
        assertNull(flow.state.selectedSession)
        assertEquals(WearConversationFailure.ACTION_REJECTED, flow.state.failure)
        assertTrue(flow.historyKeys.none { it == "agent:alpha:shared" })
        assertEquals(listOf("phone-a"), flow.stoppedPhones)
      }
    }

  @OptIn(ExperimentalCoroutinesApi::class)
  @Test
  fun samePhoneAndUnknownRouteRetainSharedStopTimeout() =
    runTest {
      for (currentPhone in listOf("phone-a", null)) {
        withFlow(testScheduler) { flow ->
          flow.installControlledTalkChannel()
          flow.holdStopResponses = true
          val owner = async { runCatching { flow.talkClient.stop("phone-a") } }
          flow.idle()
          val joined = async { runCatching { flow.talkClient.stop(currentPhone) } }
          flow.idle()
          assertFalse(joined.isCompleted)
          assertNull(flow.talkClient.talkTestField("activeAttempt"))
          testScheduler.advanceTimeBy(WearProtocol.RPC_REQUEST_TIMEOUT_MILLIS)
          flow.idle()
          assertEquals("timeout", (owner.getCompleted().exceptionOrNull() as WearProxyException).code)
          assertEquals("timeout", (joined.getCompleted().exceptionOrNull() as WearProxyException).code)
          assertEquals(listOf("talk-beta"), flow.stoppedAttempts)
          // Only explicit same-owner cleanup retries the unsettled attempt.
          flow.holdStopResponses = false
          val retry = async { flow.talkClient.stop(currentPhone) }
          flow.idle()
          assertEquals("talk-beta", retry.getCompleted().attemptId)
          assertEquals(listOf("talk-beta", "talk-beta"), flow.stoppedAttempts)
          assertEquals(listOf("phone-a", "phone-a"), flow.stoppedPhones)
        }
      }
    }

  @OptIn(ExperimentalCoroutinesApi::class)
  @Test
  fun sharedStopUsesPhoneResolvedAfterLifecycleLock() =
    runTest {
      withFlow(testScheduler) { flow ->
        flow.installControlledTalkChannel()
        flow.holdStopResponses = true
        val lock = flow.talkClient.talkTestField("lifecycleLock") as Mutex
        val lockOwner = Any()
        assertTrue(lock.tryLock(lockOwner))
        try {
          // The caller's unknown route is not the eventual Stop target.
          val owner = async { runCatching { flow.talkClient.stop() } }
          val joined = async { runCatching { flow.talkClient.stop("phone-b") } }
          flow.idle()
          assertTrue(flow.stoppedAttempts.isEmpty())
          assertFalse(joined.isCompleted)
          lock.unlock(lockOwner)
          flow.idle()
          assertEquals(listOf("phone-a"), flow.stoppedPhones)
          flow.changePhone("phone-b")
          testScheduler.advanceTimeBy(WearProtocol.RPC_REQUEST_TIMEOUT_MILLIS)
          flow.idle()
          assertEquals("timeout", (owner.getCompleted().exceptionOrNull() as WearProxyException).code)
          assertEquals(WearRealtimeTalkSnapshot(), joined.getCompleted().getOrThrow())
          assertEquals(listOf("talk-beta"), flow.stoppedAttempts)
        } finally {
          if (lock.holdsLock(lockOwner)) lock.unlock(lockOwner)
        }
      }
    }

  @OptIn(ExperimentalCoroutinesApi::class)
  @Test
  fun oldPhoneStopCancellationDoesNotCancelNewPhoneJoiner() =
    runTest {
      withFlow(testScheduler) { flow ->
        flow.installControlledTalkChannel()
        flow.holdStopResponses = true
        val owner = async { flow.talkClient.stop("phone-a") }
        flow.idle()
        flow.changePhone("phone-b")
        val joined = async { runCatching { flow.talkClient.stop("phone-b") } }
        val samePhone = async { runCatching { flow.talkClient.stop("phone-a") } }
        val unknownPhone = async { runCatching { flow.talkClient.stop() } }
        flow.idle()
        assertFalse(joined.isCompleted)
        owner.cancel()
        flow.idle()
        assertTrue(owner.isCancelled)
        assertTrue(samePhone.getCompleted().exceptionOrNull() is CancellationException)
        assertTrue(unknownPhone.getCompleted().exceptionOrNull() is CancellationException)
        assertEquals(WearRealtimeTalkSnapshot(), joined.getCompleted().getOrThrow())
        assertEquals(listOf("phone-a"), flow.stoppedPhones)
        assertFalse(flow.talkClient.isCapturing.value)
      }
    }

  @OptIn(ExperimentalCoroutinesApi::class)
  @Test
  fun cancelingNewPhoneStopJoinerDoesNotSucceedOrCancelOwner() =
    runTest {
      withFlow(testScheduler) { flow ->
        flow.installControlledTalkChannel()
        flow.holdStopResponses = true
        val owner = async { runCatching { flow.talkClient.stop("phone-a") } }
        flow.idle()
        flow.changePhone("phone-b")
        var returned = false
        val joined =
          async {
            flow.talkClient.stop("phone-b")
            returned = true
          }
        flow.idle()
        joined.cancel()
        flow.idle()
        assertTrue(joined.isCancelled)
        assertFalse(returned)
        assertFalse(owner.isCompleted)
        testScheduler.advanceTimeBy(WearProtocol.RPC_REQUEST_TIMEOUT_MILLIS)
        flow.idle()
        assertEquals("timeout", (owner.getCompleted().exceptionOrNull() as WearProxyException).code)
        assertFalse(returned)
        assertEquals(listOf("talk-beta"), flow.stoppedAttempts)
      }
    }

  @OptIn(ExperimentalCoroutinesApi::class)
  @Test
  fun unknownStopSourceCannotDiscardCancellationBeforeLifecycleLock() =
    runTest {
      withFlow(testScheduler) { flow ->
        flow.installControlledTalkChannel()
        val lock = flow.talkClient.talkTestField("lifecycleLock") as Mutex
        val lockOwner = Any()
        assertTrue(lock.tryLock(lockOwner))
        try {
          val owner = async { flow.talkClient.stop("phone-a") }
          val joined = async { runCatching { flow.talkClient.stop("phone-b") } }
          flow.idle()
          owner.cancel()
          flow.idle()
          assertTrue(owner.isCancelled)
          assertTrue(joined.getCompleted().exceptionOrNull() is CancellationException)
          assertTrue("No source was resolved and no Stop was sent", flow.stoppedAttempts.isEmpty())
          assertNotNull(flow.talkClient.talkTestField("activeAttempt"))
          lock.unlock(lockOwner)
          val cleanup = async { flow.talkClient.stop("phone-a") }
          flow.idle()
          assertEquals("talk-beta", cleanup.getCompleted().attemptId)
          assertEquals(listOf("phone-a"), flow.stoppedPhones)
        } finally {
          if (lock.holdsLock(lockOwner)) lock.unlock(lockOwner)
        }
      }
    }

  @Test
  fun notificationCannotTreatFailedStartupCleanupAsAnEmptySuccessfulStop() =
    withFlow { flow ->
      val app = RuntimeEnvironment.getApplication() as WearApplication
      val client = flow.vm.talkTestField("realtimeTalkClient") as WearRealtimeTalkClient
      var reply: Continuation<WearRealtimeTalkSnapshot>? = null
      var attemptId: String? = null
      val fixture =
        WearTalkTestFixture(app, client) { id ->
          attemptId = id
          suspendCoroutine { reply = it }
        }
      fixture.rpcReply.completeExceptionally(WearProxyException("action_rejected", "Controlled cleanup rejection"))
      try {
        flow.vm.startRealtimeTalk()
        flow.idle()
        assertNotNull(reply)
        flow.vm.openNotification(WearConversationTarget("agent:alpha:shared", "phone-a"))
        flow.idle()
        reply!!.resume(WearRealtimeTalkSnapshot(attemptId = attemptId, active = true))
        reply = null
        flow.idle()
        assertTrue(fixture.rpcEntered.isCompleted)
        assertNull("Failed startup cleanup cannot authorize notification navigation", flow.state.selectedSession)
        assertEquals(WearConversationFailure.ACTION_REJECTED, flow.state.failure)
        assertTrue(flow.historyKeys.none { it == "agent:alpha:shared" })
        assertFalse(client.isCapturing.value)
        assertEquals(1, fixture.input.closes.get())
      } finally {
        reply?.resume(WearRealtimeTalkSnapshot(attemptId = attemptId))
        flow.idle()
        client.shutdown()
      }
    }

  @Test
  fun notificationMustObserveFailureOfAnAlreadyPendingManualStop() =
    withFlow { flow ->
      flow.installControlledTalkChannel()
      val gate = CompletableDeferred<Unit>()
      flow.stopGate = gate
      flow.rejectStop = true
      flow.vm.stopRealtimeTalk()
      flow.idle()
      flow.vm.openNotification(WearConversationTarget("agent:alpha:shared", "phone-a"))
      flow.idle()
      gate.complete(Unit)
      flow.idle()
      assertNull("A failed original Stop cannot authorize another conversation", flow.state.selectedSession)
      assertEquals(WearConversationFailure.ACTION_REJECTED, flow.state.failure)
      assertTrue(flow.historyKeys.none { it == "agent:alpha:shared" })
      assertEquals(listOf("talk-beta"), flow.stoppedAttempts)
    }

  @Test
  fun phoneRediscoveryCannotBypassNotificationStopOwner() =
    withFlow { flow ->
      flow.installControlledTalkChannel()
      val gate = CompletableDeferred<Unit>()
      flow.stopGate = gate
      flow.vm.openNotification(WearConversationTarget("agent:alpha:shared", "phone-a"))
      flow.idle()
      assertEquals(listOf("talk-beta"), flow.stoppedAttempts)
      flow.invalidatePreferredPhone()
      assertTrue("No target history before Stop resolves", flow.historyKeys.none { it == "agent:alpha:shared" })
      assertFalse(flow.vm.sendReply("Before stop"))
      gate.complete(Unit)
      flow.idle()
      assertEquals("agent:alpha:shared", flow.state.selectedSession?.key)
      assertTrue(flow.vm.sendReply("After stop"))
      flow.idle()
      assertEquals(listOf("agent:alpha:shared"), flow.sentKeys)
    }

  @Test
  fun openedNotificationTargetSurvivesUncertainSamePhoneRediscovery() {
    for (key in listOf("agent:alpha:shared", "shared")) {
      withFlow { flow ->
        flow.vm.openNotification(WearConversationTarget(key, "phone-a"))
        flow.idle()
        val staleContext = flow.vm.captureConversationContext()
        val gate = CompletableDeferred<Unit>()
        flow.statusGate = gate
        flow.invalidatePreferredPhone()
        assertFalse(flow.vm.sendReply("Stale", staleContext))
        assertNull(flow.vm.captureConversationContext())
        gate.complete(Unit)
        flow.idle()
        assertEquals(key, flow.state.selectedSession?.key)
        assertFalse(flow.vm.sendReply("Stale", staleContext))
        assertTrue(flow.vm.sendReply("Fresh"))
        flow.idle()
        assertEquals(listOf(key), flow.sentKeys)
      }
    }
  }

  @Test
  fun notificationRediscoveryHonorsDeletedSameAgentLookup() =
    withFlow { flow ->
      flow.vm.openNotification(WearConversationTarget("agent:beta:shared", "phone-a"))
      flow.idle()
      flow.supportsSelectionLookup = true
      flow.listedSession = "agent:beta:replacement"
      flow.invalidatePreferredPhone()
      assertEquals("agent:beta:replacement", flow.state.selectedSession?.key)
    }

  @Test
  fun notificationSelectionDoesNotCrossARealPhoneChange() =
    withFlow { flow ->
      flow.vm.openNotification(WearConversationTarget("agent:alpha:shared", "phone-a"))
      flow.idle()
      flow.changePhone("phone-b")
      assertEquals("phone-b", flow.state.phoneNodeId)
      assertEquals("agent:beta:shared", flow.state.selectedSession?.key)
    }

  @Test
  fun explicitNavigationRetiresRetainedNotificationSelection() =
    withFlow { flow ->
      flow.vm.openNotification(WearConversationTarget("agent:alpha:shared", "phone-a"))
      flow.idle()
      flow.vm.openSession(WearSession("agent:beta:shared", null, null, false, "phone-a"))
      flow.idle()
      flow.invalidatePreferredPhone()
      assertEquals("agent:beta:shared", flow.state.selectedSession?.key)
    }

  @Test
  fun bareNotificationTargetSurvivesBoundedRefreshAndGatewayReconnect() {
    for (lookupSupported in listOf(false, true)) {
      for (key in listOf("main", "shared")) {
        withFlow { flow ->
          flow.supportsSelectionLookup = lookupSupported
          flow.vm.openNotification(WearConversationTarget(key, "phone-a"))
          flow.idle()
          assertEquals(key, flow.state.selectedSession?.key)
          flow.vm.refresh()
          flow.idle()
          assertEquals("Agent-scoped lookup cannot reject a bare Gateway-owned alias", key, flow.state.selectedSession?.key)
          flow.emitConnection(false)
          flow.emitConnection(true)
          flow.idle()
          assertEquals(key, flow.state.selectedSession?.key)
          assertTrue(flow.vm.sendReply("Captured alias"))
          flow.idle()
          assertEquals(listOf(key), flow.sentKeys)
        }
      }
    }
  }

  @Test
  fun notificationWaitsForOriginalTalkStopAndRejectsLateAttemptEvents() =
    withFlow { flow ->
      flow.installControlledTalkChannel()
      val gate = CompletableDeferred<Unit>()
      flow.stopGate = gate
      flow.vm.openNotification(WearConversationTarget("agent:alpha:shared", "phone-a"))
      flow.idle()
      assertEquals("agent:beta:shared", flow.state.selectedSession?.key)
      assertEquals(listOf("talk-beta"), flow.stoppedAttempts)
      assertTrue(flow.state.talkBusy)
      flow.vm.refresh()
      flow.idle()
      assertEquals("Refresh must not select A before original Talk stops", "agent:beta:shared", flow.state.selectedSession?.key)
      gate.complete(Unit)
      flow.idle()
      assertEquals("agent:alpha:shared", flow.state.selectedSession?.key)
      assertFalse(flow.state.realtimeTalk.active)
      flow.emitTalk()
      assertFalse(flow.state.realtimeTalk.active)
      assertEquals("agent:alpha:shared", flow.state.selectedSession?.key)
    }

  @Test
  fun notificationStopKeepsLocalTeardownAndRefreshFenceAcrossForegroundExit() =
    withFlow { flow ->
      val app = RuntimeEnvironment.getApplication() as WearApplication
      val client = flow.vm.talkTestField("realtimeTalkClient") as WearRealtimeTalkClient
      val fixture = WearTalkTestFixture(app, client)
      fixture.activate()
      flow.vm.setTalkTestField("talkAttemptId", "attempt-1")
      @Suppress("UNCHECKED_CAST")
      val state = flow.vm.talkTestField("mutableState") as kotlinx.coroutines.flow.MutableStateFlow<WearUiState>
      state.value = state.value.copy(realtimeTalk = WearRealtimeTalkSnapshot(attemptId = "attempt-1", active = true, listening = true))
      flow.vm.openNotification(WearConversationTarget("agent:alpha:shared", "phone-a"))
      flow.idle()
      assertTrue(fixture.rpcEntered.isCompleted)
      assertFalse(fixture.rpcReply.isCompleted)
      assertEquals(1, fixture.input.closes.get())
      assertEquals(1, fixture.output.closes.get())
      assertEquals(1, fixture.channelCloses.get())
      assertTrue(state.value.talkStopping)
      assertFalse(state.value.realtimeTalk.active)
      assertFalse(state.value.realtimeTalk.listening)
      flow.vm.suspendRealtimeTalk()
      flow.vm.refresh()
      flow.idle()
      assertTrue(state.value.talkBusy)
      assertTrue(state.value.talkStopping)
      assertEquals("agent:beta:shared", state.value.selectedSession?.key)
      fixture.rpcReply.complete(Unit)
      flow.idle()
      assertEquals("agent:alpha:shared", state.value.selectedSession?.key)
      assertFalse(state.value.talkBusy)
      assertFalse(state.value.talkStopping)
      assertEquals(1, fixture.input.closes.get())
    }

  @Test
  fun rejectedTalkStopCannotLeaveOldConversationAvailableForReply() =
    withFlow { flow ->
      flow.installControlledTalkChannel()
      flow.rejectStop = true
      flow.vm.openNotification(WearConversationTarget("agent:alpha:shared", "phone-a"))
      flow.idle()
      assertNull(flow.state.selectedSession)
      assertEquals(WearConversationFailure.ACTION_REJECTED, flow.state.failure)
      assertTrue(flow.state.messages.isEmpty())
      assertTrue(flow.historyKeys.none { it == "agent:alpha:shared" })
      assertFalse(flow.vm.sendReply("Do not send to old B", flow.vm.captureConversationContext()))
      assertTrue(flow.sentKeys.isEmpty())
      flow.vm.refresh()
      flow.idle()
      assertEquals("Recovery retains notification A, not later Phone B", "agent:alpha:shared", flow.state.selectedSession?.key)
    }

  @Test
  fun notificationOpenRetainsAOutsideLaterPhoneBListAndRefresh() =
    withFlow { flow ->
      flow.vm.openNotification(WearConversationTarget("agent:alpha:shared", "phone-a"))
      flow.idle()
      assertEquals("agent:alpha:shared", flow.state.selectedSession?.key)
      assertEquals("alpha", flow.state.toConversationSnapshot()?.conversationAgentId)
      assertEquals("beta", flow.state.activeAgentId)
      assertEquals(
        "Alpha reply",
        flow.state.messages
          .single()
          .text,
      )
      flow.vm.refresh()
      flow.idle()
      assertEquals("agent:alpha:shared", flow.state.selectedSession?.key)
      flow.vm.sendReply("Reply to A")
      flow.idle()
      assertEquals("agent:alpha:shared", flow.sentKeys.single())
    }

  @Test
  fun phoneChangeDuringNotificationLoadCannotRetargetItsSession() =
    withFlow { flow ->
      val gate = CompletableDeferred<Unit>()
      flow.statusGate = gate
      flow.vm.openNotification(WearConversationTarget("agent:alpha:shared", "phone-a"))
      flow.idle()
      flow.changePhone("phone-b")
      gate.complete(Unit)
      flow.idle()
      assertNull(flow.state.selectedSession)
      assertEquals(WearConversationFailure.ACTION_REJECTED, flow.state.failure)
      assertTrue(flow.historyKeys.none { it == "agent:alpha:shared" })
      assertTrue(flow.sentKeys.isEmpty())
    }

  @Test
  fun changedPhoneCannotReceiveNotificationHistoryOrReply() =
    withFlow { flow ->
      flow.vm.openNotification(WearConversationTarget("agent:alpha:shared", "old-phone"))
      flow.idle()
      assertNull(flow.state.selectedSession)
      assertEquals(WearConversationFailure.ACTION_REJECTED, flow.state.failure)
      assertFalse(flow.state.talkBusy)
      assertFalse(flow.vm.sendReply("Wrong phone", null))
      assertTrue(flow.sentKeys.isEmpty())
      assertTrue(flow.historyKeys.none { it == "agent:alpha:shared" })
    }

  @Test
  fun reconnectDoesNotAuthorizeAnOldInputForTheSameNamedSession() =
    withFlow { flow ->
      val context = flow.vm.captureConversationContext()
      flow.emitConnection(false)
      flow.emitConnection(true)
      assertTrue(flow.state.connected)
      assertFalse(flow.vm.sendReply("Old input", context))
      assertTrue(flow.sentKeys.isEmpty())
    }

  @Test
  fun callbacksRejectBothChangedConversationAndReturnToSameConversation() =
    withFlow { flow ->
      val captured = flow.vm.captureConversationContext()
      val b = checkNotNull(flow.state.selectedSession)
      flow.vm.openSession(b.copy(key = "agent:alpha:shared"))
      flow.idle()
      assertFalse(flow.vm.sendReply("Stale B", captured))
      flow.vm.openSession(b)
      flow.idle()
      assertFalse(flow.vm.sendReply("Stale B after A-B", captured))
      flow.vm.startRealtimeTalk(captured)
      assertEquals(WearConversationFailure.ACTION_REJECTED, flow.state.failure)
      assertFalse(flow.state.talkBusy)
      assertTrue(flow.sentKeys.isEmpty())
    }

  @Test
  fun oldSendCompletionCannotSettleNewAttemptAfterAtoBtoA() =
    withFlow { flow ->
      val original = checkNotNull(flow.state.selectedSession)
      val oldGate = CompletableDeferred<Unit>()
      flow.sendGate = oldGate
      flow.vm.sendReply("First")
      flow.idle()
      val first = flow.state.pendingReply
      flow.vm.openSession(original.copy(key = "agent:alpha:shared"))
      flow.idle()
      flow.vm.openSession(original)
      flow.idle()
      val newGate = CompletableDeferred<Unit>()
      flow.sendGate = newGate
      flow.vm.sendReply("Second")
      flow.idle()
      val second = flow.state.pendingReply
      assertNotEquals(first, second)
      oldGate.complete(Unit)
      flow.idle()
      assertTrue(flow.state.sending)
      assertEquals(second, flow.state.pendingReply)
      newGate.complete(Unit)
      flow.idle()
      assertFalse(flow.state.sending)
    }

  @Test
  fun lateAmbiguousAttemptCannotReplaceCurrentRetryIdentity() {
    var id = 0
    val tracker = WearSendAttemptTracker { (++id).toString() }
    val old = tracker.begin("agent:alpha:shared", "Reply", "phone")
    tracker.reset()
    val current = tracker.begin("agent:beta:shared", "Reply", "phone")
    tracker.markAmbiguous(current)
    tracker.markAmbiguous(old)
    assertEquals(current, tracker.begin("agent:beta:shared", "Reply", "phone"))
  }

  @Test
  fun notificationTargetExtrasAreConsumedTogetherWithoutGuessingMissingPhone() {
    val intent = Intent().putExtra(EXTRA_SESSION_KEY, "agent:alpha:shared").putExtra(EXTRA_PHONE_NODE_ID, "phone")
    assertEquals(WearConversationTarget("agent:alpha:shared", "phone"), consumeWearConversationTarget(intent))
    assertNull(consumeWearConversationTarget(intent))
    assertNull(consumeWearConversationTarget(Intent().putExtra(EXTRA_SESSION_KEY, "shared")))
  }

  @Test
  fun replyFailureAndPhoneChangedNotificationsKeepOriginalOpenTarget() {
    val app = RuntimeEnvironment.getApplication() as WearApplication
    shadowOf(app).grantPermissions(android.Manifest.permission.POST_NOTIFICATIONS)
    val notifier = WearReplyNotifier(app)
    val manager = app.getSystemService(NotificationManager::class.java)
    try {
      notifier.showReplyFailure("agent:alpha:shared", "b2-failure", "phone-a")
      notifier.showPreferredPhoneChanged("agent:beta:shared", "b2-changed", "phone-b")
      val pending = manager.activeNotifications.map { it.notification.contentIntent }
      assertEquals(2, pending.size)
      assertNotEquals(pending[0], pending[1])
      val targets = pending.map { consumeWearConversationTarget(shadowOf(it).savedIntent) }
      assertTrue(WearConversationTarget("agent:alpha:shared", "phone-a") in targets)
      assertTrue(WearConversationTarget("agent:beta:shared", "phone-b") in targets)
    } finally {
      manager.cancel("b2-failure", 7301)
      manager.cancel("b2-changed", 7301)
    }
  }

  @Test
  fun notificationWaitsForAnAlreadyPendingStop() =
    withFlow { flow ->
      flow.installControlledTalkChannel()
      val gate = CompletableDeferred<Unit>()
      flow.stopGate = gate
      flow.vm.stopRealtimeTalk()
      flow.idle()
      assertTrue(flow.state.talkStopping)
      assertEquals(listOf("talk-beta"), flow.stoppedAttempts)
      flow.vm.openNotification(WearConversationTarget("agent:alpha:shared", "phone-a"))
      flow.idle()
      assertEquals("agent:beta:shared", flow.state.selectedSession?.key)
      gate.complete(Unit)
      flow.idle()
      assertEquals("agent:alpha:shared", flow.state.selectedSession?.key)
      assertFalse(flow.state.loading)
    }

  @Test
  fun notificationIgnoresOldSessionTerminalWhileStopIsPending() =
    withFlow { flow ->
      flow.installControlledTalkChannel()
      val gate = CompletableDeferred<Unit>()
      flow.stopGate = gate
      flow.vm.openNotification(WearConversationTarget("agent:alpha:shared", "phone-a"))
      flow.idle()
      assertTrue(flow.state.talkBusy)
      flow.emitChatError()
      gate.complete(Unit)
      flow.idle()
      assertEquals("agent:alpha:shared", flow.state.selectedSession?.key)
      assertFalse(flow.state.loading)
    }

  @Test
  fun disconnectDuringSendCannotLeaveSendingLatchedAcrossReconnect() =
    withFlow { flow ->
      val gate = CompletableDeferred<Unit>()
      flow.sendGate = gate
      flow.sendFailureCode = "action_rejected"
      flow.vm.sendReply("First")
      flow.idle()
      assertTrue(flow.state.sending)
      flow.emitConnection(false)
      gate.complete(Unit)
      flow.idle()
      flow.emitConnection(true)
      flow.vm.refresh()
      flow.idle()
      assertTrue(flow.state.connected)
      assertFalse("Old send must not remain latched after connection generation changes", flow.state.sending)
      flow.sendFailureCode = null
      assertTrue(flow.vm.sendReply("After reconnect", flow.vm.captureConversationContext()))
      flow.idle()
      assertEquals(listOf("agent:beta:shared", "agent:beta:shared"), flow.sentKeys)
      assertFalse(flow.state.sending)
    }

  @Test
  fun oldSendCompletionAfterReconnectCannotSettleNewSendOrReplaceItsRetryIdentity() {
    for (oldFailure in listOf(null, "action_rejected")) {
      withFlow { flow ->
        val oldGate = CompletableDeferred<Unit>()
        flow.sendGate = oldGate
        flow.sendFailureCode = oldFailure
        flow.vm.sendReply("First")
        flow.idle()
        val first = checkNotNull(flow.state.pendingReply)
        flow.emitConnection(false)
        flow.emitConnection(true)
        flow.vm.refresh()
        flow.idle()
        assertFalse(flow.state.sending)
        assertEquals("Reconnect must not retry automatically", 1, flow.sentKeys.size)
        val newGate = CompletableDeferred<Unit>()
        flow.sendGate = newGate
        flow.sendFailureCode = "internal_error"
        assertTrue(flow.vm.sendReply("Second", flow.vm.captureConversationContext()))
        flow.idle()
        val second = checkNotNull(flow.state.pendingReply)
        assertNotEquals(first.runId, second.runId)
        val historyBeforeCompletion = flow.historyKeys.toList()
        oldGate.complete(Unit)
        flow.idle()
        assertTrue(flow.state.sending)
        assertEquals(second, flow.state.pendingReply)
        assertNull(flow.state.failure)
        assertEquals(historyBeforeCompletion, flow.historyKeys)
        newGate.complete(Unit)
        flow.idle()
        assertFalse(flow.state.sending)
        assertEquals(WearConversationFailure.INTERNAL_ERROR, flow.state.failure)
        assertEquals(2, flow.sentKeys.size)
        flow.sendFailureCode = null
        assertTrue(flow.vm.sendReply("Second", flow.vm.captureConversationContext()))
        flow.idle()
        assertEquals(listOf(first.runId, second.runId, second.runId), flow.sentRunIds)
        assertEquals(listOf("phone-a", "phone-a", "phone-a"), flow.sentPhones)
        assertEquals(List(3) { "agent:beta:shared" }, flow.sentKeys)
        assertFalse(flow.state.sending)
        assertNull(flow.state.failure)
      }
    }
  }

  @Test
  fun refreshMustDropExplicitlyDeletedSameAgentSession() =
    withFlow { flow ->
      val oldContext = flow.vm.captureConversationContext()
      flow.supportsSelectionLookup = true
      flow.listedSession = "agent:beta:replacement"
      flow.vm.refresh()
      flow.idle()
      assertEquals("agent:beta:shared", flow.lookupKeys.last())
      assertEquals("An explicit failed selected-session lookup should allow fallback", "agent:beta:replacement", flow.state.selectedSession?.key)
      assertEquals("agent:beta:replacement", flow.historyKeys.last())
      assertTrue(flow.state.sessions.none { it.key == "agent:beta:shared" })
      assertFalse(flow.vm.sendReply("Old input", oldContext))
      assertTrue(flow.sentKeys.isEmpty())
      assertTrue(flow.vm.sendReply("Replacement input", flow.vm.captureConversationContext()))
      flow.idle()
      assertEquals(listOf("agent:beta:replacement"), flow.sentKeys)
    }

  @Test
  fun refreshRetainsSameAgentSessionWithPositiveLookupOutsideTheBoundedList() =
    withFlow { flow ->
      flow.supportsSelectionLookup = true
      flow.selectedSessionValid = true
      flow.listedSession = "agent:beta:replacement"
      flow.vm.refresh()
      flow.idle()
      assertEquals("agent:beta:shared", flow.lookupKeys.last())
      assertEquals("agent:beta:shared", flow.state.selectedSession?.key)
    }

  @Test
  fun olderPhoneWithoutLookupRetainsQualifiedSessionOutsideTheBoundedList() =
    withFlow { flow ->
      flow.listedSession = "agent:beta:replacement"
      flow.vm.refresh()
      flow.idle()
      assertNull(flow.lookupKeys.last())
      assertEquals("agent:beta:shared", flow.state.selectedSession?.key)
    }

  @Test
  fun sameAgentLookupCannotInvalidateCrossAgentNotificationConversation() =
    withFlow { flow ->
      flow.supportsSelectionLookup = true
      flow.vm.openNotification(WearConversationTarget("agent:alpha:shared", "phone-a"))
      flow.idle()
      flow.vm.refresh()
      flow.idle()
      assertEquals("agent:alpha:shared", flow.lookupKeys.last())
      assertEquals("agent:alpha:shared", flow.state.selectedSession?.key)
      assertEquals("beta", flow.state.activeAgentId)
      assertEquals("alpha", flow.state.selectedSession?.conversationAgentId)
      flow.vm.sendReply("Alpha reply")
      flow.idle()
      assertEquals(listOf("agent:alpha:shared"), flow.sentKeys)
    }

  @Test
  fun unknownSendRetainsIdentityAcrossReconnectUntilExplicitSameMessageRetry() =
    withFlow { flow ->
      flow.holdSendResponses = true
      val oldInput = flow.vm.captureConversationContext()
      flow.vm.sendReply("Same message")
      flow.idle()
      val originalId = flow.sentRunIds.single()
      reconnectForExplicitRetry(flow)
      assertFalse(flow.vm.sendReply("Same message", oldInput))
      assertEquals("Reconnect must revoke stale input without sending", 1, flow.sentRunIds.size)
      assertTrue(flow.vm.sendReply("Same message", flow.vm.captureConversationContext()))
      flow.idle()
      assertTrue("The original response has not arrived", flow.deliveredSendResponses.isEmpty())
      assertEquals(listOf(originalId, originalId), flow.sentRunIds)
      assertEquals(2, flow.sentRequestIds.distinct().size)
      assertEquals(listOf("phone-a", "phone-a"), flow.sentPhones)
      assertEquals(List(2) { "agent:beta:shared" }, flow.sentKeys)
      assertTrue(flow.state.sending)
    }

  @Test
  fun ambiguousSendRetainsIdentityAcrossSamePhoneSessionReconnect() = assertAmbiguousRetry(reconnect = true)

  @Test
  fun ambiguousSendWithoutDisconnectReusesIdentityControl() = assertAmbiguousRetry(reconnect = false)

  private fun assertAmbiguousRetry(reconnect: Boolean) =
    withFlow { flow ->
      flow.sendFailureCode = "internal_error"
      flow.vm.sendReply("Same message")
      flow.idle()
      val originalId = flow.sentRunIds.single()
      assertFalse(flow.state.sending)
      assertEquals(WearConversationFailure.INTERNAL_ERROR, flow.state.failure)
      if (reconnect) reconnectForExplicitRetry(flow)
      assertEquals("No automatic retry", 1, flow.sentRunIds.size)
      flow.sendFailureCode = null
      assertTrue(flow.vm.sendReply("Same message", flow.vm.captureConversationContext()))
      flow.idle()
      assertEquals(listOf(originalId, originalId), flow.sentRunIds)
      assertEquals(listOf("phone-a", "phone-a"), flow.sentPhones)
      assertFalse(flow.state.sending)
      assertNull(flow.state.failure)
    }

  @Test
  fun lateOriginalSuccessCannotSettlePendingSameLogicalRetry() = assertLateOriginalDuringRetry(oldFailure = null)

  @Test
  fun lateOriginalErrorCannotSettlePendingSameLogicalRetry() = assertLateOriginalDuringRetry(oldFailure = "internal_error")

  private fun assertLateOriginalDuringRetry(oldFailure: String?) =
    withFlow { flow ->
      flow.holdSendResponses = true
      flow.sendFailureCode = oldFailure
      flow.vm.sendReply("Same message")
      flow.idle()
      val originalId = flow.sentRunIds.single()
      reconnectForExplicitRetry(flow)
      flow.sendFailureCode = "internal_error"
      assertTrue(flow.vm.sendReply("Same message", flow.vm.captureConversationContext()))
      flow.idle()
      val retryState = flow.state
      val historyBefore = flow.historyKeys.toList()
      flow.deliverSendResponse(0)
      assertEquals("Old callback must not settle the retry's UI", retryState, flow.state)
      assertEquals(historyBefore, flow.historyKeys)
      assertTrue(flow.state.sending)
      assertEquals(setOf(0), flow.deliveredSendResponses)
      // Retry B is still pending when another disconnect releases its UI ownership.
      // A's callback must not erase B's next explicit retry identity.
      reconnectForExplicitRetry(flow)
      flow.sendFailureCode = null
      assertTrue(flow.vm.sendReply("Same message", flow.vm.captureConversationContext()))
      flow.idle()
      val nextRetryState = flow.state
      flow.deliverSendResponse(1)
      assertEquals(nextRetryState, flow.state)
      assertEquals(List(3) { originalId }, flow.sentRunIds)
      assertEquals(List(3) { "phone-a" }, flow.sentPhones)
      assertEquals(List(3) { "agent:beta:shared" }, flow.sentKeys)
      flow.deliverSendResponse(2)
      assertFalse(flow.state.sending)
      assertNull(flow.state.failure)
    }

  @Test
  fun lateOriginalSuccessCannotEraseAlreadyAmbiguousSameLogicalRetry() =
    withFlow { flow ->
      flow.holdSendResponses = true
      flow.vm.sendReply("Same message")
      flow.idle()
      val originalId = flow.sentRunIds.single()
      reconnectForExplicitRetry(flow)
      flow.sendFailureCode = "internal_error"
      flow.vm.sendReply("Same message")
      flow.idle()
      flow.deliverSendResponse(1)
      assertEquals(WearConversationFailure.INTERNAL_ERROR, flow.state.failure)
      val retryState = flow.state
      flow.deliverSendResponse(0)
      assertEquals(retryState, flow.state)
      flow.sendFailureCode = null
      flow.vm.sendReply("Same message")
      flow.idle()
      assertEquals(List(3) { originalId }, flow.sentRunIds)
    }

  @Test
  fun lateOriginalErrorCannotResurrectCompletedSameLogicalRetry() =
    withFlow { flow ->
      flow.holdSendResponses = true
      flow.sendFailureCode = "internal_error"
      flow.vm.sendReply("Same message")
      flow.idle()
      val originalId = flow.sentRunIds.single()
      reconnectForExplicitRetry(flow)
      flow.sendFailureCode = null
      flow.vm.sendReply("Same message")
      flow.idle()
      flow.deliverSendResponse(1)
      assertEquals(listOf(originalId, originalId), flow.sentRunIds)
      assertFalse(flow.state.sending)
      val confirmedState = flow.state
      flow.deliverSendResponse(0)
      assertEquals(confirmedState, flow.state)
      flow.emitChatTerminal("final", originalId)
      assertNull(flow.state.pendingReply)
      reconnectForExplicitRetry(flow)
      flow.vm.sendReply("Same message")
      flow.idle()
      assertNotEquals(originalId, flow.sentRunIds.last())
    }

  @Test
  fun completedTerminalBeforeDisconnectStartsANewIntentionalSameMessageSend() =
    withFlow { flow ->
      flow.vm.sendReply("Same message")
      flow.idle()
      val originalId = flow.sentRunIds.single()
      assertFalse(flow.state.sending)
      assertNull(flow.state.failure)
      flow.emitChatTerminal("final", originalId)
      assertNull(flow.state.pendingReply)
      reconnectForExplicitRetry(flow)
      flow.vm.sendReply("Same message")
      flow.idle()
      assertEquals(2, flow.sentRunIds.size)
      assertNotEquals(originalId, flow.sentRunIds.last())
    }

  @Test
  fun originalAcknowledgmentAfterDisconnectCannotCompleteItsLogicalRequest() =
    withFlow { flow ->
      flow.holdSendResponses = true
      flow.vm.sendReply("Same message")
      flow.idle()
      val originalId = flow.sentRunIds.single()
      flow.emitConnection(false)
      val disconnectedState = flow.state
      flow.deliverSendResponse(0)
      assertEquals("An old acknowledgment cannot restore callback authority or prove completion", disconnectedState, flow.state)
      flow.emitConnection(true)
      assertEquals(1, flow.sentRunIds.size)
      flow.vm.sendReply("Same message")
      flow.idle()
      assertEquals(listOf(originalId, originalId), flow.sentRunIds)
      assertTrue(flow.state.sending)
      flow.deliverSendResponse(1)
      flow.emitChatTerminal("final", originalId)
      assertNull(flow.state.pendingReply)
      flow.vm.sendReply("Same message")
      flow.idle()
      assertNotEquals(originalId, flow.sentRunIds.last())
    }

  @Test
  fun sameMessageAfterSessionRoundTripDoesNotReuseOldRequestOrAcceptOldCallbacks() = assertSameMessageAfterNavigation(changePhone = false)

  @Test
  fun sameMessageAfterPhoneRoundTripDoesNotReuseOldRequestOrAcceptOldCallbacks() = assertSameMessageAfterNavigation(changePhone = true)

  private fun assertSameMessageAfterNavigation(changePhone: Boolean) {
    for (oldFailure in listOf(null, "internal_error")) {
      withFlow { flow ->
        flow.holdSendResponses = true
        flow.sendFailureCode = oldFailure
        val originalSession = checkNotNull(flow.state.selectedSession)
        val oldInput = flow.vm.captureConversationContext()
        flow.vm.sendReply("Same message")
        flow.idle()
        val originalId = flow.sentRunIds.single()
        reconnectForExplicitRetry(flow)
        if (changePhone) {
          flow.changePhone("phone-b")
          assertEquals("phone-b", flow.state.selectedSession?.phoneNodeId)
          flow.changePhone("phone-a")
        } else {
          flow.vm.openSession(originalSession.copy(key = "agent:alpha:shared"))
          flow.idle()
          flow.vm.openSession(originalSession)
          flow.idle()
        }
        assertEquals(originalSession.key, flow.state.selectedSession?.key)
        assertEquals(originalSession.phoneNodeId, flow.state.selectedSession?.phoneNodeId)
        assertFalse(flow.vm.sendReply("Same message", oldInput))
        assertEquals(1, flow.sentRunIds.size)
        flow.sendFailureCode = "internal_error"
        flow.vm.sendReply("Same message")
        flow.idle()
        val newId = flow.sentRunIds.last()
        assertNotEquals(originalId, newId)
        val newState = flow.state
        val historyBefore = flow.historyKeys.toList()
        flow.deliverSendResponse(0)
        assertEquals(newState, flow.state)
        assertEquals(historyBefore, flow.historyKeys)
        flow.deliverSendResponse(1)
        assertEquals(WearConversationFailure.INTERNAL_ERROR, flow.state.failure)
        flow.sendFailureCode = null
        flow.vm.sendReply("Same message")
        flow.idle()
        assertEquals(listOf(originalId, newId, newId), flow.sentRunIds)
        assertEquals(List(3) { "phone-a" }, flow.sentPhones)
      }
    }
  }

  private fun reconnectForExplicitRetry(flow: Flow) {
    val sendsBefore = flow.sentRunIds.size
    flow.emitConnection(false)
    flow.emitConnection(true)
    flow.vm.refresh()
    flow.idle()
    assertTrue(flow.state.connected)
    assertFalse(flow.state.loading)
    assertFalse(flow.state.sending)
    assertNull(flow.state.activeRunId)
    assertNull(flow.state.streamText)
    assertEquals("Reconnect and empty active-run history must not retry automatically", sendsBefore, flow.sentRunIds.size)
  }

  @Test
  fun secondNotificationMustNotAbandonOriginalTalkStop() =
    withFlow { flow ->
      flow.installControlledTalkChannel()
      val gate = CompletableDeferred<Unit>()
      flow.stopGate = gate
      flow.vm.openNotification(WearConversationTarget("agent:alpha:shared", "phone-a"))
      flow.idle()
      assertEquals("agent:beta:shared", flow.state.selectedSession?.key)
      assertEquals(listOf("talk-beta"), flow.stoppedAttempts)
      flow.vm.openNotification(WearConversationTarget("agent:gamma:shared", "phone-a"))
      flow.idle()
      assertEquals("Second notification must wait for original Stop", "agent:beta:shared", flow.state.selectedSession?.key)
      assertTrue(flow.state.talkBusy)
      gate.complete(Unit)
      flow.idle()
      assertEquals("agent:gamma:shared", flow.state.selectedSession?.key)
      assertEquals(listOf("talk-beta"), flow.stoppedAttempts)
    }

  @Test
  fun repeatedNotificationStillRejectsNavigationWhenOriginalStopFails() =
    withFlow { flow ->
      flow.installControlledTalkChannel()
      val gate = CompletableDeferred<Unit>()
      flow.stopGate = gate
      flow.rejectStop = true
      flow.vm.openNotification(WearConversationTarget("agent:alpha:shared", "phone-a"))
      flow.idle()
      flow.vm.openNotification(WearConversationTarget("agent:gamma:shared", "phone-a"))
      flow.idle()
      gate.complete(Unit)
      flow.idle()
      assertNull(flow.state.selectedSession)
      assertFalse(flow.state.talkBusy)
      assertTrue(flow.state.failure != null)
      assertEquals(listOf("talk-beta"), flow.stoppedAttempts)
    }

  @Test
  fun transientPreferredPhoneInvalidationMustKeepSameTargetRetryIdentity() =
    withFlow { flow ->
      flow.holdSendResponses = true
      val originalContext = flow.vm.captureConversationContext()
      flow.vm.sendReply("Same message")
      flow.idle()
      val originalId = flow.sentRunIds.single()
      flow.invalidatePreferredPhone()
      assertTrue(flow.state.connected)
      assertEquals("phone-a", flow.state.phoneNodeId)
      assertEquals("agent:beta:shared", flow.state.selectedSession?.key)
      assertFalse(flow.vm.sendReply("Same message", originalContext))
      assertEquals(1, flow.sentRunIds.size)
      assertTrue(flow.vm.sendReply("Same message", flow.vm.captureConversationContext()))
      flow.idle()
      assertEquals(listOf(originalId, originalId), flow.sentRunIds)
    }

  @Test
  fun uncertainPhoneRouteDoesNotAuthorizeInputBeforeRediscovery() =
    withFlow { flow ->
      flow.holdSendResponses = true
      val oldContext = flow.vm.captureConversationContext()
      flow.vm.sendReply("Same message")
      flow.idle()
      val original = flow.sentRunIds.single()
      val gate = CompletableDeferred<Unit>()
      flow.statusGate = gate
      flow.invalidatePreferredPhone()
      assertFalse(flow.vm.sendReply("Same message", oldContext))
      assertFalse(flow.vm.sendReply("Same message", flow.vm.captureConversationContext()))
      assertEquals(listOf(original), flow.sentRunIds)
      gate.complete(Unit)
      flow.idle()
      assertTrue(flow.vm.sendReply("Same message", flow.vm.captureConversationContext()))
      flow.idle()
      assertEquals(listOf(original, original), flow.sentRunIds)
    }

  @Test
  fun differentPhoneDiscoveredAfterInvalidationRetiresOldRetryIdentity() =
    withFlow { flow ->
      flow.holdSendResponses = true
      flow.vm.sendReply("Same message")
      flow.idle()
      val original = flow.sentRunIds.single()
      val gate = CompletableDeferred<Unit>()
      flow.statusGate = gate
      flow.invalidatePreferredPhone()
      flow.changePhone("phone-b")
      gate.complete(Unit)
      flow.idle()
      assertEquals("phone-b", flow.state.phoneNodeId)
      assertTrue(flow.vm.sendReply("Same message", flow.vm.captureConversationContext()))
      flow.idle()
      assertNotEquals(original, flow.sentRunIds.last())
      assertEquals(listOf("phone-a", "phone-b"), flow.sentPhones)
    }

  @Test
  fun differentSessionRediscoveryRetiresOldRetryIdentity() =
    withFlow { flow ->
      flow.holdSendResponses = true
      flow.vm.sendReply("Same message")
      flow.idle()
      val original = flow.sentRunIds.single()
      flow.listedSession = "agent:gamma:new"
      flow.invalidatePreferredPhone()
      assertEquals("agent:gamma:new", flow.state.selectedSession?.key)
      assertTrue(flow.vm.sendReply("Same message", flow.vm.captureConversationContext()))
      flow.idle()
      assertNotEquals(original, flow.sentRunIds.last())
    }

  @Test
  fun completedTerminalBeforePhoneInvalidationStartsANewIntent() =
    withFlow { flow ->
      flow.vm.sendReply("Same message")
      flow.idle()
      val original = flow.sentRunIds.single()
      flow.emitChatTerminal("final", original)
      assertNull(flow.state.pendingReply)
      flow.invalidatePreferredPhone()
      assertTrue(flow.vm.sendReply("Same message", flow.vm.captureConversationContext()))
      flow.idle()
      assertNotEquals(original, flow.sentRunIds.last())
    }

  @Test
  fun obsoleteSuccessCannotRetireRetryAfterPhoneRediscovery() =
    withFlow { flow ->
      flow.holdSendResponses = true
      flow.vm.sendReply("Same message")
      flow.idle()
      val original = flow.sentRunIds.single()
      flow.invalidatePreferredPhone()
      assertTrue(flow.vm.sendReply("Same message", flow.vm.captureConversationContext()))
      flow.idle()
      flow.deliverSendResponse(0)
      assertTrue(flow.state.sending)
      flow.invalidatePreferredPhone()
      assertTrue(flow.vm.sendReply("Same message", flow.vm.captureConversationContext()))
      flow.idle()
      assertEquals(listOf(original, original, original), flow.sentRunIds)
    }

  @OptIn(ExperimentalCoroutinesApi::class)
  private fun withFlow(
    scheduler: TestCoroutineScheduler? = null,
    block: (Flow) -> Unit,
  ) {
    if (scheduler != null) Dispatchers.setMain(StandardTestDispatcher(scheduler))
    try {
      val flow = Flow(scheduler)
      try {
        block(flow)
      } finally {
        flow.close()
      }
    } finally {
      if (scheduler != null) Dispatchers.resetMain()
    }
  }

  private class Flow(
    private val scheduler: TestCoroutineScheduler?,
  ) {
    private val app = RuntimeEnvironment.getApplication() as WearApplication
    private val owner =
      object : ViewModelStoreOwner {
        override val viewModelStore = ViewModelStore()
      }
    private val clientField = WearApplication::class.java.getDeclaredField("proxyClient\$delegate").apply { isAccessible = true }
    private val repositoryField = WearApplication::class.java.getDeclaredField("gatewayRepository\$delegate").apply { isAccessible = true }
    private val previousClient = clientField.get(app)
    private val previousRepository = repositoryField.get(app)
    var sendGate: CompletableDeferred<Unit>? = null
    var holdSendResponses = false
    private val heldSendResponses = mutableListOf<Pair<String, WearMessage.Response>>()
    val deliveredSendResponses = mutableSetOf<Int>()
    val sentRequestIds = mutableListOf<String>()
    var stopGate: CompletableDeferred<Unit>? = null
    var holdStopResponses = false
    var failStopTransport = false
    var rejectStop = false
    var sendFailureCode: String? = null
    var supportsSelectionLookup = false
    var selectedSessionValid = false
    var listedSession = "agent:beta:shared"
    var historyIdempotencyKey: String? = null
    val lookupKeys = mutableListOf<String?>()
    val sentRunIds = mutableListOf<String>()
    val sentPhones = mutableListOf<String>()
    var statusGate: CompletableDeferred<Unit>? = null
    private var phoneNode = "phone-a"
    val stoppedAttempts = mutableListOf<String>()
    val stoppedPhones = mutableListOf<String>()
    private var sequence = 0L
    val sentKeys = mutableListOf<String>()
    val historyKeys = mutableListOf<String>()
    private val client =
      WearProxyClient.createForTests(
        nodeResolver = WearNodeResolver { phoneNode },
        transport = WearMessageTransport { node, _, bytes -> respond(node, bytes) },
      )
    val vm: WearViewModel
    val state: WearUiState get() = vm.state.value
    val talkClient: WearRealtimeTalkClient get() = vm.talkTestField("realtimeTalkClient") as WearRealtimeTalkClient

    init {
      clientField.set(app, lazyOf(client))
      repositoryField.set(app, lazyOf(WearGatewayRepository(client)))
      vm = ViewModelProvider(owner, ViewModelProvider.AndroidViewModelFactory(app))[WearViewModel::class.java]
      idle()
      assertTrue(state.connected)
    }

    @OptIn(ExperimentalCoroutinesApi::class)
    fun idle() {
      scheduler?.runCurrent()
      shadowOf(Looper.getMainLooper()).idle()
    }

    // Controlled external Data Layer resource at the established client IO owner.
    // This is stop/routing unit proof, not microphone/provider acceptance.
    fun installControlledTalkChannel() {
      val channel =
        object : ChannelClient.Channel {
          override fun getNodeId() = "phone-a"

          override fun getPath() = WearProtocol.LEGACY_REALTIME_AUDIO_CHANNEL_PATH

          override fun describeContents() = 0

          override fun writeToParcel(
            dest: Parcel,
            flags: Int,
          ) = Unit
        }
      val talkClient =
        WearViewModel::class.java
          .getDeclaredField("realtimeTalkClient")
          .apply { isAccessible = true }
          .get(vm) as WearRealtimeTalkClient
      val resources = WearRealtimeTalkClient.ChannelResources(channel, ByteArrayInputStream(byteArrayOf()), ByteArrayOutputStream())
      WearRealtimeTalkClient::class.java.getDeclaredField("activeAttempt").apply { isAccessible = true }.set(
        talkClient,
        WearRealtimeTalkClient.ActiveAttempt("phone-a", "talk-beta", 1, resources),
      )
      WearViewModel::class.java
        .getDeclaredField("talkAttemptId")
        .apply { isAccessible = true }
        .set(vm, "talk-beta")
      emitTalk()
      assertTrue(state.realtimeTalk.active)
    }

    fun emitConnection(connected: Boolean) {
      sequence += 1
      runBlocking {
        client.handleMessage(
          "phone-a",
          WearProtocol.EVENT_PATH,
          WearProtocolCodec.encode(
            WearMessage.Event(sequence = sequence, event = WearEventType.Connection, streamId = "epoch-a", payload = buildJsonObject { put("connected", connected) }),
          ),
        )
      }
      idle()
    }

    fun emitChatError() = emitChatTerminal("error", "old-chat")

    fun emitChatTerminal(
      outcome: String,
      runId: String,
    ) {
      sequence += 1
      runBlocking {
        client.handleMessage(
          "phone-a",
          WearProtocol.EVENT_PATH,
          WearProtocolCodec.encode(
            WearMessage.Event(
              sequence = sequence,
              event = WearEventType.Chat,
              streamId = "epoch-a",
              payload =
                buildJsonObject {
                  put("sessionKey", "agent:beta:shared")
                  put("state", outcome)
                  put("runId", runId)
                },
            ),
          ),
        )
      }
      idle()
    }

    fun emitTalk() {
      sequence += 1
      runBlocking {
        client.handleMessage(
          "phone-a",
          WearProtocol.EVENT_PATH,
          WearProtocolCodec.encode(
            WearMessage.Event(sequence = sequence, event = WearEventType.Talk, streamId = "epoch-a", payload = WearRealtimeTalkCodec.encode(WearRealtimeTalkSnapshot(attemptId = "talk-beta", active = true))),
          ),
        )
      }
      idle()
    }

    fun invalidatePreferredPhone() {
      client.invalidatePreferredPhoneNode()
      idle()
    }

    fun changePhone(node: String) {
      phoneNode = node
      client.updatePreferredPhoneNodeId(node)
      idle()
    }

    private suspend fun respond(
      node: String,
      bytes: ByteArray,
    ) {
      val request = (WearProtocolCodec.decode(bytes) as WearDecodeResult.Success).message as WearMessage.Request
      val key =
        request.params["sessionKey"]
          ?.jsonPrimitive
          ?.content
          .orEmpty()
      val reply = if (key.contains("alpha")) "Alpha reply" else "Beta reply"
      // Capture each response before its gate: old and new sends can finish in either order.
      val failureCode =
        when (request.method) {
          WearRpcMethod.ChatSend -> sendFailureCode
          WearRpcMethod.TalkStop -> "action_rejected".takeIf { rejectStop }
          else -> null
        }
      val result =
        when (request.method) {
          WearRpcMethod.ProxyStatus -> {
            statusGate?.await()
            val capabilities = if (supportsSelectionLookup) "[\"session-selection-lookup\"]" else "[]"
            Json.parseToJsonElement("""{"connected":true,"capabilities":$capabilities,"activeAgentId":"beta","activeSessionKey":"$listedSession"}""")
          }

          WearRpcMethod.SessionsList -> {
            lookupKeys += request.params["selectedSessionKey"]?.jsonPrimitive?.content
            val validity = if (supportsSelectionLookup) ",\"selectedSessionValid\":$selectedSessionValid" else ""
            Json.parseToJsonElement("""{"activeAgentId":"beta"$validity,"sessions":[{"key":"$listedSession","displayName":"Beta","agentId":"beta"}]}""")
          }

          WearRpcMethod.ChatHistory -> {
            historyKeys += key
            Json.parseToJsonElement("""{"sessionKey":"$key","messages":[{"id":"$key","idempotencyKey":"${historyIdempotencyKey ?: "existing-history"}","role":"assistant","content":"$reply"}]}""")
          }

          WearRpcMethod.ChatSend -> {
            sentKeys += key
            sentRunIds +=
              request.params
                .getValue("idempotencyKey")
                .jsonPrimitive.content
            sentPhones += node
            sentRequestIds += request.requestId
            sendGate?.await()
            buildJsonObject { put("status", "started") }
          }

          WearRpcMethod.TalkStop -> {
            stoppedPhones += node
            stoppedAttempts +=
              request.params
                .getValue("attemptId")
                .jsonPrimitive.content
            stopGate?.await()
            if (failStopTransport) error("Controlled Stop transport failure")
            if (holdStopResponses) return
            WearRealtimeTalkCodec.encode(WearRealtimeTalkSnapshot(attemptId = "talk-beta"))
          }

          else -> {
            error("Unexpected IO: " + request.method)
          }
        }
      val response =
        WearMessage.Response(
          requestId = request.requestId,
          ok = failureCode == null,
          result = result.takeIf { failureCode == null },
          error = failureCode?.let { WearRpcError(it, "Controlled rejection") },
          eventStreamId = "epoch-a",
          eventSequence = sequence,
        )
      if (request.method == WearRpcMethod.ChatSend && holdSendResponses) {
        // The phone handler has returned; only its Data Layer response is delayed.
        // Connection/history traffic can proceed while the real client awaits it.
        heldSendResponses += node to response
      } else {
        deliverResponse(node, response)
      }
    }

    fun deliverSendResponse(index: Int) {
      check(deliveredSendResponses.add(index))
      val (node, response) = heldSendResponses[index]
      runBlocking { deliverResponse(node, response) }
      idle()
    }

    private suspend fun deliverResponse(
      node: String,
      response: WearMessage.Response,
    ) {
      client.handleMessage(node, WearProtocol.RESPONSE_PATH, WearProtocolCodec.encode(response))
    }

    fun close() {
      owner.viewModelStore.clear()
      idle()
      clientField.set(app, previousClient)
      repositoryField.set(app, previousRepository)
    }
  }
}
