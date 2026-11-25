package ai.openclaw.app.chat

import ai.openclaw.app.gateway.GatewayRequestOutcomeUnknown
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** Real controller and Room outbox; delayed Gateway I/O is scripted, not device proof. */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class ChatControllerSteeringRecoveryTest {
  private class Fixture(
    test: TestScope,
  ) {
    val gateway = ScriptedGateway(chatControllerTestJson)
    val sendStarted = CompletableDeferred<Unit>()
    val sendResult = CompletableDeferred<String>()
    var gatewayScope = ChatCacheScope("gateway-test", 1L)
    val controller =
      test.backgroundScope.createChatController(
        cacheScope = { gatewayScope },
        requestGateway = gateway::request,
      )

    init {
      gateway.respondWith("chat.history", historyResponse("session-1", emptyList(), "original" to "Working"))
      gateway.respond("chat.send") {
        sendStarted.complete(Unit)
        sendResult.await()
      }
      controller.load("agent:main:steering")
    }

    fun finishOriginal() {
      gateway.respondWith("chat.history", historyResponse("session-1", emptyList(), hasActiveRun = false, activeRunIds = emptyList()))
      controller.handleGatewayEvent("chat", chatTerminalPayload("agent:main:steering", "original", seq = 2, state = "aborted"))
    }

    fun delta() {
      controller.handleGatewayEvent("chat", chatDeltaPayload("agent:main:steering", "steer", 1, "Follow-up", "Follow-up"))
    }

    fun acknowledge() {
      sendResult.complete("""{"runId":"steer","status":"started"}""")
    }
  }

  @Test
  fun idleRecoveryWhileSteerAckIsPendingKeepsStreamingOwnership() =
    runTest {
      val f = Fixture(this)
      runCurrent()
      assertEquals("Working", f.controller.streamingAssistantText.value)
      val send = async { f.controller.sendMessageAwaitAcceptance("Follow-up input", "off", emptyList(), idempotencyKey = "steer") }
      f.sendStarted.await()
      val pendingAfterSend = f.controller.pendingRunCount.value
      f.finishOriginal()
      runCurrent()
      val pendingAfterOriginalStopped = f.controller.pendingRunCount.value

      // A missed-event refresh sees the old turn stopped before the new admission resolves.
      f.controller.handleGatewayEvent("seqGap", null)
      runCurrent()
      val pendingDuringRecovery = f.controller.pendingRunCount.value
      f.acknowledge()
      assertTrue(send.await())
      assertEquals(2, pendingAfterSend)
      assertEquals(1, pendingAfterOriginalStopped)
      assertEquals("Idle history cannot settle the outstanding submission", 1, pendingDuringRecovery)
      f.delta()
      assertEquals("Follow-up", f.controller.streamingAssistantText.value)
      assertEquals(
        ChatOutboxStatus.Accepted,
        f.controller.outboxItems.value
          .single()
          .status,
      )
      assertEquals(
        "steer",
        f.controller.outboxItems.value
          .single()
          .id,
      )
      assertEquals(1, f.gateway.callCount("chat.send"))

      // Opposite control: once acknowledged, idle history retains its existing settlement rule.
      f.controller.refresh()
      runCurrent()
      assertEquals(0, f.controller.pendingRunCount.value)
      assertNull(f.controller.streamingAssistantText.value)
    }

  @Test
  fun reconnectBeforeLostSteerAckSettlesPreservesOriginalRequestWithoutReplay() =
    runTest {
      val f = Fixture(this)
      runCurrent()
      val send = async { f.controller.sendMessageAwaitAcceptance("Follow-up input", "off", emptyList(), idempotencyKey = "steer") }
      f.sendStarted.await()
      f.finishOriginal()
      runCurrent()
      f.controller.onDisconnected("Reconnecting")
      f.gatewayScope = f.gatewayScope.copy(connectionGeneration = 2L)
      f.controller.onGatewayConnected()
      runCurrent()
      val pendingDuringRecovery = f.controller.pendingRunCount.value

      f.sendResult.completeExceptionally(GatewayRequestOutcomeUnknown("ACK lost"))
      assertTrue(send.await())
      assertEquals("Reconnect must preserve the request still awaiting its transport result", 1, pendingDuringRecovery)
      runCurrent()
      f.delta()
      assertEquals("Follow-up", f.controller.streamingAssistantText.value)
      assertEquals(
        "steer",
        f.controller.outboxItems.value
          .single()
          .id,
      )
      assertEquals(
        ChatOutboxStatus.Accepted,
        f.controller.outboxItems.value
          .single()
          .status,
      )
      assertEquals(1, f.gateway.callCount("chat.send"))
      assertNull(f.controller.errorText.value)
    }

  @Test
  fun explicitSteerCancellationBeforeAckStillRetiresOwnership() =
    runTest {
      val f = Fixture(this)
      runCurrent()
      val send = async { f.controller.sendMessageAwaitAcceptance("Follow-up input", "off", emptyList(), idempotencyKey = "steer") }
      f.sendStarted.await()
      f.finishOriginal()
      f.controller.handleGatewayEvent("chat", chatTerminalPayload("agent:main:steering", "steer", seq = 2, state = "aborted"))
      runCurrent()
      val pendingAfterCancellation = f.controller.pendingRunCount.value

      f.acknowledge()
      assertTrue(send.await())
      assertEquals(0, pendingAfterCancellation)
      f.delta()
      assertEquals(0, f.controller.pendingRunCount.value)
      assertNull(f.controller.streamingAssistantText.value)
      assertEquals(1, f.gateway.callCount("chat.send"))
    }
}
