package ai.openclaw.wear

import ai.openclaw.wear.shared.WearDecodeResult
import ai.openclaw.wear.shared.WearEventType
import ai.openclaw.wear.shared.WearMessage
import ai.openclaw.wear.shared.WearProtocol
import ai.openclaw.wear.shared.WearProtocolCodec
import ai.openclaw.wear.shared.WearRpcError
import ai.openclaw.wear.shared.WearRpcMethod
import android.app.Activity
import android.app.RemoteInput
import android.content.Intent
import android.os.Bundle
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.view.View
import android.view.ViewGroup
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.ViewRootForTest
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.ViewModelStoreOwner
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.android.controller.ActivityController
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowTextToSpeech

@RunWith(RobolectricTestRunner::class)
@Config(application = WearApplication::class, sdk = [35])
class WearChatEventFlowTest {
  private val terminalHistoryOutcomes =
    listOf(
      "settled-finalization-fallback" to WearReplyOutcome.Final,
      "assistant" to WearReplyOutcome.Aborted,
      "terminal-error" to WearReplyOutcome.Error,
    )

  @Test
  fun acceptedSendSettlesOnRemoteErrorAndAbortWithUnchangedHistory() {
    for ((terminal, outcome) in listOf("error" to WearReplyOutcome.Error, "aborted" to WearReplyOutcome.Aborted)) {
      withFlow { flow ->
        flow.send()
        assertNotNull(flow.state.pendingReply)
        flow.emit(terminal)
        assertNull(flow.state.pendingReply)
        assertNull(flow.state.activeRunId)
        assertEquals(outcome, flow.state.replyTerminal?.outcome)
        assertTrue(flow.state.messages.isEmpty())
        flow.vm.refresh()
        flow.idle()
        assertEquals(outcome, flow.state.replyTerminal?.outcome)
        assertEquals(if (terminal == "error") WearConversationFailure.INTERNAL_ERROR else null, flow.state.conversationFailure)
      }
    }
  }

  @Test
  fun foreignAndAnonymousTerminalsCannotSettleAcceptedIdentifiedReply() =
    withFlow { flow ->
      flow.send()
      for (terminal in listOf("final", "aborted", "error")) {
        flow.emit(terminal, eventRunId = "older-run")
        assertNotNull(flow.state.pendingReply)
        assertNull(flow.state.replyTerminal)
        flow.emit(terminal, eventRunId = null)
        assertNotNull(flow.state.pendingReply)
        assertNull(flow.state.replyTerminal)
      }
      flow.emit("final")
      assertNull(flow.state.pendingReply)
      assertEquals(WearReplyOutcome.Final, flow.state.replyTerminal?.outcome)
    }

  @Test
  fun terminalBeforeSendAcknowledgmentSurvivesTheAcknowledgmentHistoryLoad() =
    withFlow { flow ->
      flow.sendGate = CompletableDeferred()
      flow.send()
      assertTrue(flow.state.sending)
      flow.emit("error")
      flow.sendGate?.complete(Unit)
      flow.idle()
      assertEquals(WearReplyOutcome.Error, flow.state.replyTerminal?.outcome)
      assertNull(flow.state.pendingReply)
      assertEquals(false, flow.state.sending)
    }

  @Test
  fun orderedCompleteProjectionsShrinkClearAndRemainUnicodeBounded() =
    withFlow { flow ->
      for (text in listOf("Hello world", "Hello", "")) {
        flow.emit("delta", text = text, complete = true)
        assertEquals(text, flow.state.streamText)
      }
      flow.emit("delta", text = "😀".repeat(2_100), complete = true)
      assertEquals("😀".repeat(2_000), flow.state.streamText)
    }

  @Test
  fun incompleteProjectionsAndSnapshotRacesStillPreservePrefixes() =
    withFlow { flow ->
      flow.emit("delta", text = "Hello world", complete = true)
      flow.emit("delta", text = "Hello", complete = false)
      assertEquals("Hello world", flow.state.streamText)
      flow.emit("delta", text = " world!", complete = false)
      assertEquals("Hello world!", flow.state.streamText)
      assertEquals("Hello world", reconcileWearStreamSnapshot("Hello world", "Hello", liveComplete = true))
      assertEquals("Hello world", reconcileWearStreamSnapshot("Hello world", "", liveComplete = true))
    }

  @Test
  fun historyCannotResurrectATerminatedRunButCanRevealANewerRun() =
    withFlow { flow ->
      flow.send()
      flow.emit("error")
      val ended = flow.state
      val stale = flow.transcript(activeRunId = flow.runId, text = "stale text")
      val reconciled = ended.copy(activeRunId = stale.activeRunId, streamText = stale.activeText).reconcileReplyHistory(stale)
      assertNull(reconciled.activeRunId)
      assertNull(reconciled.streamText)
      assertEquals(ended.replyTerminal, reconciled.replyTerminal)
      val newer = flow.transcript(activeRunId = "newer-run", text = "new text")
      val newRun = ended.copy(activeRunId = newer.activeRunId, streamText = newer.activeText).reconcileReplyHistory(newer)
      assertEquals("newer-run", newRun.activeRunId)
      assertEquals("new text", newRun.streamText)
      assertNull(newRun.replyTerminal)
      val anonymous = flow.transcript(activeRunId = null, text = "anonymous text")
      assertNull(ended.copy(streamText = anonymous.activeText).reconcileReplyHistory(anonymous).replyTerminal)
      assertNull(ended.resetForPhoneChange().replyTerminal)
      assertNull(ended.switchSessionContext(checkNotNull(ended.selectedSession).copy(key = "other")).replyTerminal)
      assertNull(ended.switchAgentContext("other").replyTerminal)
    }

  @Test
  fun canonicalOwnedAssistantCanSettleWhenATerminalWasMissed() =
    withFlow { flow ->
      flow.send()
      val reply = WearChatMessage("reply", "assistant", "Done", 1L, idempotencyKey = flow.runId)
      val transcript = flow.transcript().copy(messages = listOf(reply))
      assertNull(
        flow.state
          .copy(messages = listOf(reply))
          .reconcileReplyHistory(transcript)
          .pendingReply,
      )
      assertNotNull(flow.state.reconcileReplyHistory(flow.transcript()).pendingReply)
    }

  @Test
  fun completedRunMustNotSuppressLaterTerminalOnlyError() =
    withFlow { flow ->
      flow.emit("final", eventRunId = "completed-a")
      assertEquals(WearReplyOutcome.Final, flow.state.replyTerminal?.outcome)
      val historyBefore = flow.historyRequests
      flow.emit("error", eventRunId = "external-b")
      assertEquals("A completed run does not own future terminal-only events", WearReplyOutcome.Error, flow.state.replyTerminal?.outcome)
      assertEquals("external-b", flow.state.replyTerminal?.runId)
      assertEquals(WearConversationFailure.INTERNAL_ERROR, flow.state.conversationFailure)
      assertEquals(historyBefore + 1, flow.historyRequests)
    }

  @Test
  fun completedErrorMustClearWhenAnotherTerminalOnlyReplyCompletes() =
    withFlow { flow ->
      flow.emit("error", eventRunId = "completed-a")
      assertEquals(WearReplyOutcome.Error, flow.state.replyTerminal?.outcome)
      assertEquals(WearConversationFailure.INTERNAL_ERROR, flow.state.conversationFailure)
      val historyBefore = flow.historyRequests
      flow.historyMessages = """[{"id":"canonical-b","role":"assistant","content":"Later reply"}]"""
      flow.emit("final", eventRunId = "external-b")
      assertNull("Error from the prior completed run must not poison a later successful reply", flow.state.conversationFailure)
      assertEquals(WearReplyOutcome.Final, flow.state.replyTerminal?.outcome)
      assertEquals("external-b", flow.state.replyTerminal?.runId)
      assertEquals(historyBefore + 1, flow.historyRequests)
      assertEquals(
        "Later reply",
        flow.state.messages
          .single()
          .text,
      )
      flow.vm.refresh()
      flow.idle()
      assertNull(flow.state.conversationFailure)
    }

  @Test
  fun laterTerminalOnlyAbortReloadsCanonicalHistoryWithoutANewMessage() =
    withFlow { flow ->
      flow.emit("final", eventRunId = "completed-a")
      val historyBefore = flow.historyRequests
      flow.emit("aborted", eventRunId = "external-b")
      assertEquals(WearReplyOutcome.Aborted, flow.state.replyTerminal?.outcome)
      assertEquals("external-b", flow.state.replyTerminal?.runId)
      assertEquals(historyBefore + 1, flow.historyRequests)
      assertNull(flow.state.conversationFailure)
    }

  @Test
  fun laterFinalMessageStillReloadsTheRestOfTheCanonicalTranscript() =
    withFlow { flow ->
      flow.emit("error", eventRunId = "completed-a")
      val historyBefore = flow.historyRequests
      flow.historyMessages = """[{"id":"question-b","role":"user","content":"Question from phone"}]"""
      flow.emit(
        "final",
        eventRunId = "external-b",
        message =
          buildJsonObject {
            put("id", "reply-b")
            put("role", "assistant")
            put("content", "New reply")
          },
      )
      assertNull(flow.state.conversationFailure)
      assertEquals(historyBefore + 1, flow.historyRequests)
      assertEquals(listOf("Question from phone", "New reply"), flow.state.messages.map { it.text })
    }

  @Test
  fun delayedForeignTerminalCannotSettleANewPendingReplyAfterACompletedRun() =
    withFlow { flow ->
      flow.emit("error", eventRunId = "completed-a")
      flow.sendGate = CompletableDeferred()
      flow.send()
      val pending = checkNotNull(flow.state.pendingReply)
      val historyBefore = flow.historyRequests
      for (terminal in listOf("final", "error", "aborted")) {
        flow.emit(terminal, eventRunId = "completed-a")
        assertEquals(pending, flow.state.pendingReply)
        assertTrue(flow.state.sending)
        assertNull(flow.state.replyTerminal)
        assertNull(flow.state.conversationFailure)
        assertEquals(historyBefore, flow.historyRequests)
      }
      flow.sendGate?.complete(Unit)
      flow.idle()
      flow.emit("final")
      assertEquals(WearReplyOutcome.Final, flow.state.replyTerminal?.outcome)
      assertNull(flow.state.pendingReply)
    }

  @Test
  fun completedOutcomeStillRejectsStaleSequenceEpochPhoneAndSessionEvents() =
    withFlow { flow ->
      flow.emit("aborted", eventRunId = "completed-a")
      val completed = flow.state.replyTerminal
      flow.emit("error", eventRunId = "older-run", eventSequence = 1)
      assertEquals(completed, flow.state.replyTerminal)
      flow.emit("error", eventRunId = "older-run", eventStreamId = "old-epoch")
      assertEquals(completed, flow.state.replyTerminal)
      flow.emit("error", eventRunId = "other-phone-run", sourceNodeId = "phone-b", eventSequence = 3)
      assertEquals(completed, flow.state.replyTerminal)
      flow.emit("error", eventRunId = "other-session-run", sessionKey = "agent:main:other", eventSequence = 3)
      assertEquals(completed, flow.state.replyTerminal)
      flow.emit("final", eventRunId = "later-run")
      assertEquals("later-run", flow.state.replyTerminal?.runId)
      assertNull(flow.state.conversationFailure)
    }

  @Test
  fun matchingErrorAndAbortAfterAnonymousDeltaSettle() {
    for (terminal in listOf("error", "aborted")) {
      withFlow { flow ->
        flow.send()
        assertNotNull(flow.state.pendingReply)
        flow.emit("delta", eventRunId = null, text = "Anonymous partial reply", complete = false)
        assertNull(flow.state.activeRunId)
        assertNotNull(flow.state.streamText)
        val before = flow.historyRequests
        flow.emit(terminal)
        assertEquals(before + 1, flow.historyRequests)
        assertNull(flow.state.activeRunId)
        assertNull(flow.state.streamText)
        assertTrue(flow.state.messages.isEmpty())
        assertNull("Matching terminal and inactive canonical history must settle the pending reply", flow.state.pendingReply)
      }
    }
  }

  @Test
  fun matchingTerminalWaitsForInactiveCanonicalHistory() =
    withFlow { flow ->
      flow.send()
      flow.emit("delta", eventRunId = null, text = "Anonymous reply")
      flow.historyGate = CompletableDeferred()
      flow.emit("error")
      assertNotNull(flow.state.pendingReply)
      assertEquals("Anonymous reply", flow.state.streamText)
      assertNull(flow.state.replyTerminal)
      assertNull(flow.state.conversationFailure)
      flow.historyGate?.complete(Unit)
      flow.idle()
      assertNull(flow.state.pendingReply)
      assertNull(flow.state.streamText)
      assertEquals(WearReplyOutcome.Error, flow.state.replyTerminal?.outcome)
      assertEquals(WearConversationFailure.INTERNAL_ERROR, flow.state.conversationFailure)
      flow.vm.refresh()
      flow.idle()
      assertEquals(WearReplyOutcome.Error, flow.state.replyTerminal?.outcome)
    }

  @Test
  fun matchingTerminalDoesNotClearAnActiveHistorySnapshot() {
    for (run in listOf(null, "pending", "newer-run")) {
      for (text in listOf("New live reply", "")) {
        withFlow { flow ->
          flow.send()
          flow.emit("delta", eventRunId = null, text = "Anonymous reply")
          val activeRun = if (run == "pending") flow.runId else run
          flow.historyRun =
            buildJsonObject {
              activeRun?.let { put("runId", it) }
              put("text", text)
            }
          flow.emit("error")
          assertEquals(activeRun, flow.state.activeRunId)
          assertEquals(text, flow.state.streamText)
          assertNull(flow.state.replyTerminal)
          assertNull(flow.state.conversationFailure)
        }
      }
    }
  }

  @Test
  fun laterDeltasInvalidateATerminalAwaitingHistory() {
    for (run in listOf(null, "pending", "newer-run")) {
      withFlow { flow ->
        flow.send()
        flow.emit("delta", eventRunId = null, text = "Anonymous reply")
        flow.historyGate = CompletableDeferred()
        flow.emit("error")
        flow.emit("delta", eventRunId = if (run == "pending") flow.runId else run, text = "New live reply")
        flow.historyGate?.complete(Unit)
        flow.idle()
        assertEquals("New live reply", flow.state.streamText)
        assertNull(flow.state.replyTerminal)
        assertNull(flow.state.conversationFailure)
        flow.vm.refresh()
        flow.idle()
        assertNull("A later inactive snapshot cannot revive the superseded terminal", flow.state.replyTerminal)
      }
    }
  }

  @Test
  fun sequenceAndEpochResyncPreserveMatchedCompletionButDiscardItsConversationProjection() {
    for (changedEpoch in listOf(false, true)) {
      withFlow { flow ->
        flow.send()
        val ownRun = flow.runId
        flow.observeReplyCompletion()
        flow.emit("delta", eventRunId = null, text = "Anonymous reply")
        flow.historyGate = CompletableDeferred()
        flow.emit("error")
        flow.emit("error", eventRunId = "unrelated", eventSequence = if (changedEpoch) 3 else 4, eventStreamId = if (changedEpoch) "old-epoch" else "epoch-a")
        flow.historyGate?.complete(Unit)
        flow.idle()
        assertNull(flow.state.pendingReply)
        assertEquals(ownRun, flow.state.replyCompletion?.runId)
        assertEquals(WearReplyOutcome.Error, flow.state.replyCompletion?.outcome)
        assertEquals(listOf<WearChatMessage?>(null), flow.completedReplies)
        assertNull(flow.state.replyTerminal)
        assertNull(flow.state.conversationFailure)
      }
    }
  }

  @Test
  fun foreignAndRunlessTerminalsCannotSettleAnAnonymousPendingStream() {
    for (run in listOf(null, "foreign-run")) {
      for (terminal in listOf("final", "error", "aborted")) {
        withFlow { flow ->
          flow.send()
          val pending = flow.state.pendingReply
          flow.emit("delta", eventRunId = null, text = "Anonymous reply")
          flow.emit(terminal, eventRunId = run)
          assertEquals(pending, flow.state.pendingReply)
          assertNull(flow.state.replyTerminal)
          assertNull(flow.state.conversationFailure)
        }
      }
    }
  }

  @Test
  fun matchingTerminalSurvivesAFailedHistoryRefresh() =
    withFlow { flow ->
      flow.send()
      flow.emit("delta", eventRunId = null, text = "Anonymous reply")
      flow.historyFails = true
      flow.emit("aborted")
      assertNotNull(flow.state.pendingReply)
      assertNull(flow.state.replyTerminal)
      flow.historyFails = false
      flow.vm.refresh()
      flow.idle()
      assertNull(flow.state.pendingReply)
      assertNull(flow.state.conversationFailure)
      assertEquals(WearReplyOutcome.Aborted, flow.state.replyTerminal?.outcome)
    }

  @Test
  fun newerCanonicalReplySupersedesACompletedErrorWithoutALiveEvent() =
    withFlow { flow ->
      flow.emit("error", eventRunId = "completed-a")
      assertEquals(WearConversationFailure.INTERNAL_ERROR, flow.state.conversationFailure)
      flow.historyMessages = """[{"id":"reply-b","role":"assistant","content":"Later successful reply"}]"""
      flow.vm.refresh()
      flow.idle()
      assertEquals(listOf("Later successful reply"), flow.state.messages.map { it.text })
      assertNull("Canonical evidence of a newer reply must clear the completed error", flow.state.conversationFailure)
      assertNull(flow.state.replyTerminal)
    }

  @Test
  fun persistedOwnErrorBeforeTerminalSurvivesRefreshUntilANewerReply() {
    for (previous in listOf("", """{"id":"previous","role":"assistant","content":"Previous reply","timestamp":1},""")) {
      withFlow { flow ->
        flow.send()
        // Both runner entry points await the terminal-error append before emitting the terminal.
        val ownError = """{"id":"own-error","role":"assistant","content":"Partial failed reply","timestamp":2,"idempotencyKey":"${flow.runId}:terminal-error"}"""
        flow.historyMessages = "[$previous$ownError]"
        flow.emit("error")
        flow.vm.refresh()
        flow.idle()
        assertEquals(WearReplyOutcome.Error, flow.state.replyTerminal?.outcome)
        assertEquals(WearConversationFailure.INTERNAL_ERROR, flow.state.conversationFailure)
        flow.historyMessages = """[$previous$ownError,{"id":"newer","role":"assistant","content":"Newer reply","timestamp":3}]"""
        flow.vm.refresh()
        flow.idle()
        assertNull(flow.state.replyTerminal)
        assertNull(flow.state.conversationFailure)
      }
    }
  }

  @Test
  fun terminalOnlyFinalWaitsForHistoryToResolveItsSpeakableReply() =
    withFlow { flow ->
      flow.send()
      flow.observeReplyCompletion()
      flow.historyMessages = """[{"id":"reply","role":"assistant","content":"Ready to speak","idempotencyKey":"${flow.runId}"}]"""
      flow.historyGate = CompletableDeferred()
      flow.emit("final")
      assertEquals(WearReplyOutcome.Final, flow.state.replyTerminal?.outcome)
      assertNull("The UI must not conclude there is no reply while history is pending", flow.state.replyTerminal?.history)
      assertTrue(flow.state.messages.isEmpty())
      flow.historyGate?.complete(Unit)
      flow.idle()
      assertNotNull(flow.state.replyTerminal?.history)
      assertEquals(listOf("Ready to speak"), flow.completedReplies.map { it?.text })
    }

  @Test
  fun terminalOnlyFinalCanFinishAfterHistoryConfirmsNoAssistantReply() =
    withFlow { flow ->
      flow.send()
      flow.historyGate = CompletableDeferred()
      flow.emit("final")
      assertNull(flow.state.replyTerminal?.history)
      flow.historyGate?.complete(Unit)
      flow.idle()
      assertNotNull(flow.state.replyTerminal?.history)
      assertTrue(flow.state.messages.isEmpty())
      assertNull(flow.state.pendingReply)
    }

  @Test
  fun emptyHistoryDoesNotForgetTheCompletedOutcomesAssistantBoundary() =
    withFlow { flow ->
      val originalHistory = """[{"id":"old-reply","role":"assistant","content":"Previous reply"}]"""
      flow.historyMessages = originalHistory
      flow.emit("error", eventRunId = "failed-run")
      flow.historyMessages = "[]"
      flow.vm.refresh()
      flow.idle()
      flow.historyMessages = originalHistory
      flow.vm.refresh()
      flow.idle()
      assertEquals(WearReplyOutcome.Error, flow.state.replyTerminal?.outcome)
      assertEquals(WearConversationFailure.INTERNAL_ERROR, flow.state.conversationFailure)
    }

  @Test
  fun terminalOnlyReplyCompletionNeverSelectsAPreservedForeignFinal() =
    withFlow { flow ->
      flow.send()
      flow.observeReplyCompletion()
      flow.emit(
        "final",
        eventRunId = "foreign-run",
        message =
          buildJsonObject {
            put("id", "foreign-message")
            put("role", "assistant")
            put("content", "Foreign reply")
          },
      )
      assertEquals(listOf("Foreign reply"), flow.state.messages.map { it.text })
      assertTrue(flow.completedReplies.isEmpty())
      flow.historyMessages = """[{"id":"own-message","role":"assistant","content":"Own reply","idempotencyKey":"${flow.runId}"}]"""
      flow.historyGate = CompletableDeferred()
      flow.emit("final")
      assertTrue("The real completion effect must await canonical history, not select the foreign final", flow.completedReplies.isEmpty())
      flow.historyGate?.complete(Unit)
      flow.idle()
      assertEquals(listOf("Own reply"), flow.completedReplies.map { it?.text })
    }

  @Test
  fun foreignCanonicalHistoryCannotCompleteANewerPendingReply() =
    withFlow { flow ->
      flow.sendGate = CompletableDeferred()
      flow.send()
      flow.observeReplyCompletion()
      flow.emit(
        "final",
        eventRunId = "foreign-run",
        message =
          buildJsonObject {
            put("id", "foreign-message")
            put("role", "assistant")
            put("content", "Foreign reply")
            put("idempotencyKey", "foreign-run")
          },
      )
      flow.historyMessages = """[{"id":"foreign-message","role":"assistant","content":"Foreign reply","idempotencyKey":"foreign-run"}]"""
      flow.sendGate?.complete(Unit)
      flow.idle()
      assertNotNull("A foreign assistant in the send acknowledgment snapshot cannot settle this reply", flow.state.pendingReply)
      assertTrue(flow.completedReplies.isEmpty())
      flow.historyMessages = """[{"id":"own-message","role":"assistant","content":"Own reply","idempotencyKey":"${flow.runId}"}]"""
      flow.vm.refresh()
      flow.idle()
      assertNull(flow.state.pendingReply)
      assertEquals(listOf("Own reply"), flow.completedReplies.map { it?.text })
    }

  @Test
  fun uncorrelatedCanonicalHistoryCannotCompleteAPendingReply() =
    withFlow { flow ->
      flow.send()
      flow.observeReplyCompletion()
      flow.historyMessages = """[{"id":"unrelated","role":"assistant","content":"Uncorrelated reply"}]"""
      flow.vm.refresh()
      flow.idle()
      assertNotNull("Changed assistant content alone does not identify the pending run", flow.state.pendingReply)
      assertTrue(flow.completedReplies.isEmpty())
      flow.emit("aborted")
      assertNull(flow.state.pendingReply)
      assertEquals(WearReplyOutcome.Aborted, flow.state.replyTerminal?.outcome)
    }

  @Test
  fun terminalErrorCompletionWaitsForCanonicalHistory() =
    withFlow { flow ->
      flow.send()
      flow.observeReplyCompletion()
      flow.historyMessages = """[{"id":"own-partial","role":"assistant","content":"Own partial reply","idempotencyKey":"${flow.runId}"}]"""
      flow.historyGate = CompletableDeferred()
      flow.emit("error")
      assertEquals(WearConversationFailure.INTERNAL_ERROR, flow.state.conversationFailure)
      assertTrue("Terminal-derived errors must not bypass canonical history completion", flow.completedReplies.isEmpty())
      flow.historyGate?.complete(Unit)
      flow.idle()
      assertEquals(listOf("Own partial reply"), flow.completedReplies.map { it?.text })
      assertEquals(WearConversationFailure.INTERNAL_ERROR, flow.state.conversationFailure)
    }

  @Test
  fun rewrittenAssistantBoundaryDoesNotClearACompletedError() =
    withFlow { flow ->
      flow.historyMessages = """[{"id":"reply-a","role":"assistant","content":"Initial content","timestamp":1}]"""
      flow.emit("error", eventRunId = "failed-run")
      flow.historyMessages = """[{"id":"reply-a","role":"assistant","content":"Rewritten content","timestamp":1}]"""
      flow.vm.refresh()
      flow.idle()
      assertEquals("An in-place rewrite is not a later reply", WearReplyOutcome.Error, flow.state.replyTerminal?.outcome)
      assertEquals(WearConversationFailure.INTERNAL_ERROR, flow.state.conversationFailure)
      flow.historyMessages = """[{"id":"reply-a","role":"assistant","content":"Rewritten content","timestamp":1},{"id":"reply-b","role":"assistant","content":"Rewritten content","timestamp":1}]"""
      flow.vm.refresh()
      flow.idle()
      assertNull("A distinct later message remains a newer reply even when its text and timestamp are equal", flow.state.replyTerminal)
    }

  @Test
  fun terminalOnlyCompletionDoesNotSpeakForeignCanonicalHistory() {
    for (terminal in listOf("final", "error", "aborted")) {
      withFlow { flow ->
        flow.send()
        flow.observeReplyCompletion()
        flow.emit(
          "final",
          eventRunId = "foreign-run",
          message =
            buildJsonObject {
              put("id", "foreign-message")
              put("role", "assistant")
              put("content", "Foreign reply")
              put("idempotencyKey", "foreign-run")
            },
        )
        flow.historyMessages = """[{"id":"foreign-message","role":"assistant","content":"Foreign reply","idempotencyKey":"foreign-run"}]"""
        flow.emit(terminal)
        assertNull(flow.state.pendingReply)
        assertEquals("A terminal with no owned assistant settles without selecting foreign text", listOf<WearChatMessage?>(null), flow.completedReplies)
      }
    }
  }

  @Test
  fun terminalCompletionSelectsItsOwnedReplyBeforeAForeignCanonicalTail() =
    withFlow { flow ->
      flow.send()
      flow.observeReplyCompletion()
      flow.historyMessages = """[{"id":"owned","role":"assistant","content":"Owned reply","idempotencyKey":"${flow.runId}"},{"id":"foreign","role":"assistant","content":"Foreign tail","idempotencyKey":"foreign-run"}]"""
      flow.emit("final")
      assertEquals(listOf("Owned reply"), flow.completedReplies.map { it?.text })
    }

  @Test
  fun identifiedFinalMessageRemainsOwnedWithoutAHistoryKey() =
    withFlow { flow ->
      flow.send()
      flow.observeReplyCompletion()
      flow.emit(
        "final",
        message =
          buildJsonObject {
            put("id", "owned-event")
            put("role", "assistant")
            put("content", "Owned event reply")
          },
      )
      assertEquals(listOf("Owned event reply"), flow.completedReplies.map { it?.text })
    }

  @Test
  fun ownedCanonicalHistoryBeforeForeignTailSettlesAMissedTerminal() =
    withFlow { flow ->
      flow.send()
      flow.observeReplyCompletion()
      flow.historyMessages = """[{"id":"own","role":"assistant","content":"Owned reply","idempotencyKey":"${flow.runId}"},{"id":"foreign","role":"assistant","content":"Foreign tail","idempotencyKey":"foreign-run"}]"""
      flow.vm.refresh()
      flow.idle()
      assertNull("The owned assistant exists even when it is not the latest transcript entry", flow.state.pendingReply)
      assertEquals(listOf("Owned reply"), flow.completedReplies.map { it?.text })
    }

  @Test
  fun shorterNonemptyHistoryCannotSupersedeACompletedError() =
    withFlow { flow ->
      flow.historyMessages = """[{"id":"older","role":"assistant","content":"Older reply","timestamp":1},{"id":"boundary","role":"assistant","content":"Boundary reply","timestamp":2}]"""
      flow.emit("error", eventRunId = "failed-run")
      flow.historyMessages = """[{"id":"older","role":"assistant","content":"Older reply","timestamp":1}]"""
      flow.vm.refresh()
      flow.idle()
      assertEquals("Deleting the tail does not prove a later reply", WearReplyOutcome.Error, flow.state.replyTerminal?.outcome)
      assertEquals(WearConversationFailure.INTERNAL_ERROR, flow.state.conversationFailure)
      flow.historyMessages = """[{"id":"newer","role":"assistant","content":"Newer reply","timestamp":3}]"""
      flow.vm.refresh()
      flow.idle()
      assertNull("A timestamp after the missing boundary still proves a later reply", flow.state.replyTerminal)
    }

  @Test
  fun terminalHistoryBeforeForeignTailSettlesAMissedTerminal() {
    for ((suffix, outcome) in terminalHistoryOutcomes) {
      withFlow { flow ->
        flow.send()
        flow.observeReplyCompletion()
        flow.historyMessages = """[{"id":"owned-fallback","role":"assistant","content":"Owned fallback","idempotencyKey":"${flow.runId}:$suffix"},{"id":"foreign","role":"assistant","content":"Foreign fallback","idempotencyKey":"foreign-run:$suffix"}]"""
        flow.vm.refresh()
        flow.idle()
        assertNull(flow.state.pendingReply)
        assertEquals(outcome, flow.state.replyCompletion?.outcome)
        assertNull("The foreign canonical tail supersedes only the global outcome", flow.state.replyTerminal)
        assertEquals(
          "${flow.runId}:$suffix",
          flow.state.replyCompletion
            ?.message
            ?.idempotencyKey,
        )
        assertEquals(listOf("Owned fallback"), flow.completedReplies.map { it?.text })
        flow.vm.refresh()
        flow.idle()
        assertEquals(outcome, flow.state.replyCompletion?.outcome)
        assertNull(flow.state.replyTerminal)
        assertNull(flow.state.conversationFailure)
        assertEquals(listOf("Owned fallback"), flow.completedReplies.map { it?.text })
      }
    }
  }

  @Test
  fun terminalHistorySelectsOwnedTextWithoutReplacingTheObservedOutcome() {
    for ((suffix) in terminalHistoryOutcomes) {
      for ((terminal, outcome) in listOf("final" to WearReplyOutcome.Final, "aborted" to WearReplyOutcome.Aborted, "error" to WearReplyOutcome.Error)) {
        withFlow { flow ->
          flow.send()
          flow.observeReplyCompletion()
          flow.historyMessages = """[{"id":"owned","role":"assistant","content":"Owned fallback","idempotencyKey":"${flow.runId}:$suffix"},{"id":"foreign","role":"assistant","content":"Foreign fallback","idempotencyKey":"foreign-run:$suffix"}]"""
          flow.emit(terminal)
          assertNull(flow.state.pendingReply)
          assertEquals(outcome, flow.state.replyCompletion?.outcome)
          assertNull("A newer canonical reply does not change the owned observed outcome", flow.state.replyTerminal)
          assertEquals(listOf("Owned fallback"), flow.completedReplies.map { it?.text })
        }
      }
    }
  }

  @Test
  fun foreignAndUnrecognizedFallbackKeysCannotRecoverAMissedTerminal() =
    withFlow { flow ->
      flow.send()
      flow.observeReplyCompletion()
      for (key in listOf(
        "foreign-run:settled-finalization-fallback",
        "${flow.runId}-other:settled-finalization-fallback",
        "prefix-${flow.runId}:settled-finalization-fallback",
        "${flow.runId}:settled-finalization-fallback:extra",
        "${flow.runId}:other-fallback",
        "${flow.runId}:settled-finalization",
        "foreign-run:assistant",
        "${flow.runId}-other:assistant",
        "prefix-${flow.runId}:assistant",
        "${flow.runId}:assistant:extra",
        "foreign-run:terminal-error",
        "${flow.runId}-other:terminal-error",
        "${flow.runId}:terminal-error:extra",
        "cli-assistant:${flow.runId}",
        "hook-block:before_agent_run:user:${flow.runId}",
      )) {
        flow.historyMessages = """[{"id":"unowned","role":"assistant","content":"Unowned reply","idempotencyKey":"$key"}]"""
        flow.vm.refresh()
        flow.idle()
        assertNotNull("Only the exact runtime-owned key may settle this reply: $key", flow.state.pendingReply)
        assertNull(flow.state.replyTerminal)
        assertTrue(flow.completedReplies.isEmpty())
      }
      flow.historyMessages = """[{"id":"bare","role":"assistant","content":"Bare-key reply","idempotencyKey":"${flow.runId}"}]"""
      flow.vm.refresh()
      flow.idle()
      assertNull(flow.state.pendingReply)
      assertEquals(listOf("Bare-key reply"), flow.completedReplies.map { it?.text })
    }

  @Test
  fun nonAssistantTerminalKeysCannotRecoverAMissedTerminal() {
    for ((suffix) in terminalHistoryOutcomes) {
      withFlow { flow ->
        flow.send()
        flow.observeReplyCompletion()
        for (role in listOf("user", "system")) {
          flow.historyMessages = """[{"id":"non-assistant","role":"$role","content":"Not an assistant reply","idempotencyKey":"${flow.runId}:$suffix"}]"""
          flow.vm.refresh()
          flow.idle()
          assertNotNull(flow.state.pendingReply)
          assertNull(flow.state.replyTerminal)
          assertTrue(flow.completedReplies.isEmpty())
        }
      }
    }
  }

  @Test
  fun terminalHistoryDoesNotClearAnActiveHistorySnapshot() {
    for ((suffix) in terminalHistoryOutcomes) {
      for (run in listOf(null, "pending", "newer-run")) {
        for (text in listOf("New live reply", "")) {
          withFlow { flow ->
            flow.send()
            flow.observeReplyCompletion()
            flow.historyMessages = """[{"id":"owned-fallback","role":"assistant","content":"Owned fallback","idempotencyKey":"${flow.runId}:$suffix"}]"""
            val activeRun = if (run == "pending") flow.runId else run
            flow.historyRun =
              buildJsonObject {
                activeRun?.let { put("runId", it) }
                put("text", text)
              }
            flow.vm.refresh()
            flow.idle()
            assertEquals(activeRun, flow.state.activeRunId)
            assertEquals(text, flow.state.streamText)
            assertNull(flow.state.replyTerminal)
            assertTrue(flow.completedReplies.isEmpty())
          }
        }
      }
    }
  }

  @Test
  fun terminalHistoryWaitsForAConcurrentAnonymousDelta() {
    for ((suffix) in terminalHistoryOutcomes) {
      withFlow { flow ->
        flow.send()
        flow.observeReplyCompletion()
        flow.historyMessages = """[{"id":"owned-fallback","role":"assistant","content":"Owned fallback","idempotencyKey":"${flow.runId}:$suffix"}]"""
        flow.historyGate = CompletableDeferred()
        flow.vm.refresh()
        flow.idle()
        flow.emit("delta", eventRunId = null, text = "Unknown live reply")
        flow.historyGate?.complete(Unit)
        flow.idle()
        assertNotNull(flow.state.pendingReply)
        assertEquals("Unknown live reply", flow.state.streamText)
        assertNull(flow.state.replyTerminal)
        assertTrue(flow.completedReplies.isEmpty())
        flow.vm.refresh()
        flow.idle()
        assertNull(flow.state.pendingReply)
        assertEquals(listOf("Owned fallback"), flow.completedReplies.map { it?.text })
      }
    }
  }

  private fun withFlow(block: (Flow) -> Unit) {
    val flow = Flow()
    try {
      block(flow)
    } finally {
      flow.close()
    }
  }

  @Test
  fun foreignDeltaCannotConfirmTheWatchesPendingReply() =
    withFlow { flow ->
      flow.send()
      flow.observeReplyCompletion()
      flow.emit("delta", eventRunId = "foreign-run", text = "Foreign reply")
      flow.historyMessages = """[{"id":"foreign-message","role":"assistant","content":"Foreign reply","idempotencyKey":"foreign-run"}]"""
      flow.emit(
        "final",
        eventRunId = "foreign-run",
        message =
          buildJsonObject {
            put("id", "foreign-message")
            put("role", "assistant")
            put("content", "Foreign reply")
            put("idempotencyKey", "foreign-run")
          },
      )
      assertTrue("A foreign run must not be confirmed as this Watch reply", flow.completedReplies.all { it == null })
      assertEquals("The foreign terminal must retain Watch-send ownership", flow.runId, flow.state.pendingReply?.runId)
      assertTrue("Foreign completion must not cancel awaiting feedback", flow.completedReplies.isEmpty())
      assertEquals(listOf("Foreign reply"), flow.state.messages.map { it.text })
      assertNull(flow.state.activeRunId)
      assertNull(flow.state.streamText)
      flow.historyMessages = """[{"id":"foreign-message","role":"assistant","content":"Foreign reply","idempotencyKey":"foreign-run"},{"id":"own-message","role":"assistant","content":"Own reply","idempotencyKey":"${flow.runId}"}]"""
      flow.emit("final")
      assertNull(flow.state.pendingReply)
      assertEquals(listOf("Own reply"), flow.completedReplies.map { it?.text })
    }

  @Test
  fun foreignActiveHistoryAndTerminalsRetainThePendingWatchReply() {
    for (terminal in listOf("final", "error", "aborted")) {
      withFlow { flow ->
        flow.send()
        flow.observeReplyCompletion()
        flow.emit("delta", eventRunId = "foreign-run", text = "Foreign live text")
        flow.historyRun =
          buildJsonObject {
            put("runId", "foreign-run")
            put("text", "Foreign live text")
          }
        flow.vm.refresh()
        flow.idle()
        assertEquals("Canonical foreign live state does not own the Watch send", flow.runId, flow.state.pendingReply?.runId)
        assertEquals("foreign-run", flow.state.activeRunId)
        assertEquals("Foreign live text", flow.state.streamText)
        flow.historyRun = null
        flow.emit(terminal, eventRunId = "foreign-run")
        assertEquals(flow.runId, flow.state.pendingReply?.runId)
        assertTrue(flow.completedReplies.isEmpty())
        flow.historyMessages = """[{"id":"own-message","role":"assistant","content":"Own recovered reply","idempotencyKey":"${flow.runId}"}]"""
        flow.vm.refresh()
        flow.idle()
        assertNull(flow.state.pendingReply)
        assertEquals(listOf("Own recovered reply"), flow.completedReplies.map { it?.text })
      }
    }
  }

  @Test
  fun ownTerminalWhileForeignRunIsLiveWaitsWithoutClearingForeignText() {
    for (terminal in listOf("final", "error", "aborted")) {
      withFlow { flow ->
        flow.send()
        flow.observeReplyCompletion()
        flow.emit("delta", eventRunId = "foreign-run", text = "Foreign live text")
        flow.historyRun =
          buildJsonObject {
            put("runId", "foreign-run")
            put("text", "Foreign live text")
          }
        flow.emit(terminal)
        assertEquals(flow.runId, flow.state.pendingReply?.runId)
        assertEquals("foreign-run", flow.state.activeRunId)
        assertEquals("Foreign live text", flow.state.streamText)
        assertTrue(flow.completedReplies.isEmpty())
        flow.historyRun = null
        flow.emit("final", eventRunId = "foreign-run")
        assertNull("The recorded own terminal settles when canonical history becomes inactive", flow.state.pendingReply)
        assertEquals("foreign-run", flow.state.replyTerminal?.runId)
        assertEquals(flow.runId, flow.state.replyCompletion?.runId)
        assertEquals(listOf<WearChatMessage?>(null), flow.completedReplies)
      }
    }
  }

  @Test
  fun completingParkedWatchReplyDoesNotReplaceANewerForeignOutcome() {
    for ((foreignTerminal, foreignOutcome) in listOf("error" to WearReplyOutcome.Error, "final" to WearReplyOutcome.Final, "aborted" to WearReplyOutcome.Aborted)) {
      for (ownTerminal in listOf("final", "aborted", "error")) {
        withFlow { flow ->
          flow.send()
          flow.observeReplyCompletion()
          flow.emit("delta", eventRunId = "foreign-run", text = "Foreign live text")
          flow.historyRun =
            buildJsonObject {
              put("runId", "foreign-run")
              put("text", "Foreign live text")
            }
          flow.historyMessages = """[{"id":"own-message","role":"assistant","content":"Own reply","idempotencyKey":"${flow.runId}"}]"""
          flow.emit(ownTerminal)
          assertTrue(flow.completedReplies.isEmpty())
          flow.historyRun = null
          flow.historyMessages = """[{"id":"own-message","role":"assistant","content":"Own reply","idempotencyKey":"${flow.runId}"},{"id":"foreign-message","role":"assistant","content":"Foreign reply","idempotencyKey":"foreign-run"}]"""
          flow.emit(foreignTerminal, eventRunId = "foreign-run")
          assertEquals("The latest conversation outcome remains authoritative", foreignOutcome, flow.state.replyTerminal?.outcome)
          assertEquals("foreign-run", flow.state.replyTerminal?.runId)
          assertEquals(if (foreignOutcome == WearReplyOutcome.Error) WearConversationFailure.INTERNAL_ERROR else null, flow.state.conversationFailure)
          assertNull(flow.state.pendingReply)
          assertEquals(listOf("Own reply"), flow.completedReplies.map { it?.text })
          flow.vm.refresh()
          flow.idle()
          assertEquals(foreignOutcome, flow.state.replyTerminal?.outcome)
          assertEquals(if (foreignOutcome == WearReplyOutcome.Error) WearConversationFailure.INTERNAL_ERROR else null, flow.state.conversationFailure)
          assertEquals("Completion remains one-shot", listOf("Own reply"), flow.completedReplies.map { it?.text })
        }
      }
    }
  }

  @Test
  fun emptyActiveStreamRejectsALateInputCallback() {
    for (run in listOf("foreign-run", null)) {
      withFlow { flow ->
        flow.emit("delta", eventRunId = run, text = "", complete = true)
        flow.send()
        assertEquals("No send during an active empty stream", 0, flow.sendRequests)
      }
    }
  }

  @Test
  @Config(qualifiers = "w400dp-h800dp-mdpi")
  fun activeStreamsDisableInputAndExposeWorkingAbortInTheApp() {
    for (run in listOf(null, "identified-run")) {
      for (text in listOf("", "Live reply")) {
        withFlow { flow ->
          flow.observeApp()
          assertTrue(SemanticsProperties.Disabled !in flow.appAction("Type").config)
          flow.emit("delta", eventRunId = run, text = text)
          assertTrue("Every active stream disables input: run=$run text=$text", SemanticsProperties.Disabled in flow.appAction("Type").config)
          var accepted = false
          assertEquals(false, flow.vm.sendReply("Late input") { accepted = true })
          assertEquals(false, accepted)
          assertEquals(0, flow.sendRequests)
          val abort = flow.appAction("Abort run")
          assertTrue(SemanticsProperties.Disabled !in abort.config)
          assertEquals(true, abort.config[SemanticsActions.OnClick].action?.invoke())
          flow.idle()
          assertEquals(listOf(run), flow.abortRuns)
          assertNull(flow.state.streamText)
          assertNull(flow.state.activeRunId)
          assertTrue(SemanticsProperties.Disabled !in flow.appAction("Type").config)
          flow.send()
          assertEquals(1, flow.sendRequests)
        }
      }
    }
  }

  @Test
  fun acknowledgedPendingReplyRejectsAnotherSendUntilItCompletes() =
    withFlow { flow ->
      flow.send()
      val firstRun = flow.runId
      flow.observeReplyCompletion()
      assertEquals(false, flow.state.sending)
      assertNull(flow.state.activeRunId)
      assertNull(flow.state.streamText)
      var accepted = false
      assertEquals(false, flow.vm.sendReply("Second message") { accepted = true })
      flow.idle()
      assertEquals(false, accepted)
      assertEquals(firstRun, flow.state.pendingReply?.runId)
      assertEquals(1, flow.sendRequests)
      flow.historyMessages = """[{"id":"own","role":"assistant","content":"First reply","idempotencyKey":"$firstRun"}]"""
      flow.emit("final", eventRunId = firstRun)
      assertEquals(listOf("First reply"), flow.completedReplies.map { it?.text })
      assertEquals(true, flow.vm.sendReply("Second message"))
      flow.idle()
      assertEquals(2, flow.sendRequests)
    }

  @Test
  @Config(qualifiers = "w400dp-h800dp-mdpi")
  fun runlessStopAcknowledgmentReleasesAppInputWithoutSpeakingForeignHistory() {
    for ((command, aborted) in listOf("/stop" to false, "stop" to true)) {
      withFlow { flow ->
        flow.observeApp(autoSpeak = true)
        val speech = shadowOf(checkNotNull(ShadowTextToSpeech.getLastTextToSpeechInstance()))
        speech.onInitListener.onInit(TextToSpeech.SUCCESS)
        // Exact Phone projectAck shape: Gateway ok and runIds are not forwarded.
        flow.sendAck = buildJsonObject { put("aborted", aborted) }
        flow.sendGate = CompletableDeferred()
        flow.submitFromApp(command)
        val controlRun = flow.runId
        assertEquals(controlRun, flow.state.pendingReply?.runId)
        flow.historyMessages = """[{"id":"foreign","role":"assistant","content":"Foreign reply","idempotencyKey":"foreign-run"}]"""
        flow.sendGate?.complete(Unit)
        flow.idle()
        assertEquals(false, flow.state.sending)
        assertNull(flow.state.pendingReply)
        assertEquals(controlRun, flow.state.replyCompletion?.runId)
        assertEquals(WearReplyOutcome.Canceled, flow.state.replyCompletion?.outcome)
        assertNull(speech.lastSpokenText)
        assertTrue(SemanticsProperties.Disabled !in flow.appAction("Type").config)

        flow.sendAck = null
        flow.sendGate = null
        flow.submitFromApp("Next message")
        assertEquals(listOf(command, "Next message"), flow.sentMessages)
        assertTrue(controlRun != flow.runId)
        assertEquals(flow.runId, flow.state.pendingReply?.runId)
        flow.historyMessages = """[{"id":"next","role":"assistant","content":"Next reply","idempotencyKey":"${flow.runId}"}]"""
        flow.emit("final")
        assertNull(flow.state.pendingReply)
        assertEquals(listOf("Next reply"), speech.spokenTextList)
      }
    }
  }

  @Test
  fun runlessControlCompletionRetiresPendingAbortButPreservesForeignStream() =
    withFlow { flow ->
      flow.sendAck = buildJsonObject { put("aborted", false) }
      flow.sendGate = CompletableDeferred()
      assertEquals(true, flow.vm.sendReply("/stop"))
      flow.idle()
      val controlRun = flow.runId
      flow.observeReplyCompletion()
      flow.abortGate = CompletableDeferred()
      flow.abortAccepted = false
      flow.vm.abort()
      flow.idle()
      assertEquals(controlRun, flow.state.pendingAbortRunId)
      flow.historyRun =
        buildJsonObject {
          put("runId", "foreign-run")
          put("text", "Foreign live")
        }
      flow.emit("delta", eventRunId = "foreign-run", text = "Foreign live")
      flow.sendGate?.complete(Unit)
      flow.idle()
      assertNull(flow.state.pendingReply)
      assertNull(flow.state.replyAbort)
      assertEquals(listOf<WearChatMessage?>(null), flow.completedReplies)
      assertEquals("foreign-run", flow.state.activeRunId)
      assertEquals("Foreign live", flow.state.streamText)
      assertEquals(false, flow.vm.sendReply("Next message"))
      flow.abortGate?.complete(Unit)
      flow.idle()
      assertEquals("foreign-run", flow.state.activeRunId)
      assertEquals(WearReplyOutcome.Canceled, flow.state.replyCompletion?.outcome)
    }

  @Test
  fun ordinaryAndEmptySendAcknowledgmentsDoNotCompletePendingReply() {
    for (ack in listOf(null, JsonObject(emptyMap()))) {
      withFlow { flow ->
        flow.sendAck = ack
        flow.send()
        flow.observeReplyCompletion()
        assertEquals(false, flow.state.sending)
        assertEquals(flow.runId, flow.state.pendingReply?.runId)
        assertNull(flow.state.replyCompletion)
        assertTrue(flow.completedReplies.isEmpty())
        assertEquals(false, flow.vm.sendReply("Next message"))
      }
    }
  }

  @Test
  fun staleControlAcknowledgmentCannotEndANewerSendOrOverwriteItsTerminal() =
    withFlow { flow ->
      val oldGate = CompletableDeferred<Unit>()
      flow.sendGate = oldGate
      flow.sendAck = buildJsonObject { put("aborted", true) }
      assertEquals(true, flow.vm.sendReply("/stop"))
      flow.idle()
      val oldRun = flow.runId
      val session = checkNotNull(flow.state.selectedSession)
      flow.vm.openSession(session.copy(key = "agent:main:other"))
      flow.idle()
      flow.vm.openSession(session)
      flow.idle()
      val nextGate = CompletableDeferred<Unit>()
      flow.sendGate = nextGate
      flow.sendAck = null
      assertEquals(true, flow.vm.sendReply("Next message"))
      flow.idle()
      val nextRun = flow.runId
      assertTrue(oldRun != nextRun)
      oldGate.complete(Unit)
      flow.idle()
      assertEquals(nextRun, flow.state.pendingReply?.runId)
      assertTrue(flow.state.sending)
      assertNull(flow.state.replyCompletion)
      flow.emit("error", eventRunId = nextRun)
      nextGate.complete(Unit)
      flow.idle()
      assertNull(flow.state.pendingReply)
      assertEquals(nextRun, flow.state.replyCompletion?.runId)
      assertEquals(WearReplyOutcome.Error, flow.state.replyCompletion?.outcome)
    }

  @Test
  fun acceptedCallbackCannotReenterAndReplaceTheReservedSend() =
    withFlow { flow ->
      var nestedAccepted: Boolean? = null
      var firstRun: String? = null
      assertEquals(
        true,
        flow.vm.sendReply("First message") { runId ->
          firstRun = runId
          nestedAccepted = flow.vm.sendReply("Second message")
        },
      )
      flow.idle()
      assertEquals(false, nestedAccepted)
      assertEquals(firstRun, flow.state.pendingReply?.runId)
      assertEquals(listOf(firstRun), flow.sentRunIds)
    }

  @Test
  @Config(qualifiers = "w400dp-h800dp-mdpi")
  fun pendingOnlyAppDisablesInputButKeepsAbortAndExplicitNavigationAvailable() {
    for (navigate in listOf(false, true)) {
      withFlow { flow ->
        flow.sessionList = """[{"key":"agent:main:proof","displayName":"Test chat","hasActiveRun":false},{"key":"agent:main:other","displayName":"Other chat","hasActiveRun":false}]"""
        flow.vm.refresh()
        flow.idle()
        flow.observeApp()
        flow.send()
        val firstRun = flow.runId
        assertTrue(SemanticsProperties.Disabled in flow.appAction("Type").config)
        val context = flow.appAction("Session: Test chat")
        assertTrue("Explicit context navigation is not a new reply", SemanticsProperties.Disabled !in context.config)
        if (navigate) {
          assertEquals(true, context.config[SemanticsActions.OnClick].action?.invoke())
          assertEquals(
            true,
            flow
              .appAction("Other chat")
              .config[SemanticsActions.OnClick]
              .action
              ?.invoke(),
          )
          flow.idle()
          assertEquals("agent:main:other", flow.state.selectedSession?.key)
        } else {
          flow.abortFails = true
          assertEquals(
            true,
            flow
              .appAction("Abort run")
              .config[SemanticsActions.OnClick]
              .action
              ?.invoke(),
          )
          flow.idle()
          assertEquals("A failed Abort retains the pending owner", firstRun, flow.state.pendingReply?.runId)
          assertTrue(SemanticsProperties.Disabled in flow.appAction("Type").config)
          assertTrue(SemanticsProperties.Disabled !in flow.appAction("Abort run").config)
          flow.abortFails = false
          assertEquals(
            true,
            flow
              .appAction("Abort run")
              .config[SemanticsActions.OnClick]
              .action
              ?.invoke(),
          )
          flow.idle()
          assertEquals("Pending-only Abort targets the owned send", listOf(firstRun, firstRun), flow.abortRuns)
        }
        assertNull(flow.state.pendingReply)
        assertTrue(SemanticsProperties.Disabled !in flow.appAction("Type").config)
        assertEquals(true, flow.vm.sendReply("New message"))
        flow.idle()
        assertEquals(2, flow.sendRequests)
      }
    }
  }

  @Test
  @Config(qualifiers = "w400dp-h800dp-mdpi")
  fun ambiguousRetryRetainsItsOwnedKeyWithoutAdmittingAnotherMessage() =
    withFlow { flow ->
      flow.sendFails = true
      flow.send()
      val firstRun = flow.runId
      assertNotNull(flow.state.failure)
      flow.observeApp()
      assertTrue("Deliberate retry remains available", SemanticsProperties.Disabled !in flow.appAction("Type").config)
      flow.vm.refresh()
      flow.idle()
      assertTrue("Refresh does not discard retry authority", SemanticsProperties.Disabled !in flow.appAction("Type").config)
      assertEquals(false, flow.vm.sendReply("Different message"))
      flow.sendFails = false
      assertEquals(true, flow.vm.sendReply("  Hello  "))
      flow.idle()
      assertEquals(listOf(firstRun, firstRun), flow.sentRunIds)
      assertEquals(false, flow.vm.sendReply("Hello"))
      flow.vm.abort()
      flow.idle()
      assertNull(flow.state.pendingReply)
      assertEquals(true, flow.vm.sendReply("Hello"))
      flow.idle()
      assertTrue("An explicit abort retires the old attempt", flow.runId != firstRun)
    }

  @Test
  @Config(qualifiers = "w400dp-h800dp-mdpi")
  fun freshGatewayValidationRejectionAllowsDifferentAppInput() =
    withFlow { flow ->
      flow.observeApp()
      flow.sendFails = true
      flow.sendErrorCode = "INVALID_REQUEST"
      flow.submitFromApp("Blocked message")
      val rejectedRun = flow.runId
      assertEquals(false, flow.state.sending)
      assertNull(flow.state.pendingReply)
      assertNull(flow.state.replyCompletion)
      assertTrue(SemanticsProperties.Disabled !in flow.appAction("Type").config)

      flow.sendFails = false
      flow.submitFromApp("Corrected message")
      assertEquals(listOf("Blocked message", "Corrected message"), flow.sentMessages)
      assertTrue(rejectedRun != flow.runId)
      assertEquals(flow.runId, flow.state.pendingReply?.runId)
      assertNull(flow.state.failure)
      flow.emit("final")
      assertNull(flow.state.pendingReply)
      assertTrue(SemanticsProperties.Disabled !in flow.appAction("Type").config)
    }

  @Test
  fun rejectedRetryPreservesUncertainDeliveryAcrossFailureAndRediscovery() {
    for (code in listOf("INVALID_REQUEST", "invalid_request")) {
      for (disconnected in listOf(false, true)) {
        withFlow { flow ->
          val oldGate = if (disconnected) CompletableDeferred<Unit>() else null
          flow.sendGate = oldGate
          flow.sendFails = true
          flow.send()
          val uncertainRun = flow.runId
          if (disconnected) {
            flow.connection(false)
            flow.connection(true)
          }
          flow.sendGate = null
          flow.sendErrorCode = code
          assertEquals(true, flow.vm.sendReply("Hello"))
          flow.idle()
          oldGate?.complete(Unit)
          flow.idle()
          assertEquals(listOf(uncertainRun, uncertainRun), flow.sentRunIds)
          assertEquals(uncertainRun, flow.state.pendingReply?.runId)
          assertEquals(true, flow.state.pendingReply?.retryable)
          assertEquals(false, flow.vm.sendReply("Different message"))
          flow.vm.refresh()
          flow.idle()
          assertEquals(uncertainRun, flow.state.pendingReply?.runId)

          flow.sendFails = false
          assertEquals(true, flow.vm.sendReply("Hello"))
          flow.idle()
          assertEquals(listOf(uncertainRun, uncertainRun, uncertainRun), flow.sentRunIds)
          assertEquals(false, flow.state.pendingReply?.retryable)
        }
      }
    }
  }

  @Test
  @Config(qualifiers = "w400dp-h800dp-mdpi")
  fun phoneValidationRejectionReleasesAppInputAndRetiresOnlyRejectedSend() =
    withFlow { flow ->
      // WearProxyControllerTest.rejectsUnknownOrOversizedWatchFieldsBeforeGateway
      // proves this exact lowercase wire error for 4,001 characters without a Gateway call.
      val invalidText = "x".repeat(4_001)
      val rejectedGate = CompletableDeferred<Unit>()
      val oldAbortGate = CompletableDeferred<Unit>()
      flow.observeApp(autoSpeak = true)
      val speech = shadowOf(checkNotNull(ShadowTextToSpeech.getLastTextToSpeechInstance()))
      speech.onInitListener.onInit(TextToSpeech.SUCCESS)
      flow.sendFails = true
      flow.sendErrorCode = "invalid_request"
      flow.sendGate = rejectedGate
      flow.submitFromApp(invalidText)
      val rejectedRun = flow.runId
      assertTrue(flow.state.sending)
      flow.abortAccepted = false
      flow.abortGate = oldAbortGate
      assertEquals(
        true,
        flow
          .appAction("Abort run")
          .config[SemanticsActions.OnClick]
          .action
          ?.invoke(),
      )
      flow.idle()
      assertEquals(rejectedRun, flow.state.pendingAbortRunId)
      rejectedGate.complete(Unit)
      flow.idle()
      assertEquals(false, flow.state.sending)
      assertNull(flow.state.pendingReply)
      assertNull(flow.state.replyAbort)
      assertNull(flow.state.replyCompletion)
      assertEquals(WearConversationFailure.INTERNAL_ERROR, flow.state.conversationFailure)
      assertTrue(SemanticsProperties.Disabled !in flow.appAction("Type").config)

      flow.sendGate = null
      flow.submitFromApp(invalidText)
      assertTrue("Definite rejection retires the key even for identical input", rejectedRun != flow.runId)
      assertNull(flow.state.pendingReply)
      assertEquals(false, flow.state.sending)

      val correctedGate = CompletableDeferred<Unit>()
      flow.sendFails = false
      flow.sendGate = correctedGate
      flow.submitFromApp("Corrected message")
      val correctedRun = flow.runId
      assertEquals(listOf(invalidText, invalidText, "Corrected message"), flow.sentMessages)
      assertEquals(3, flow.sentRunIds.distinct().size)
      assertEquals(correctedRun, flow.state.pendingReply?.runId)
      assertTrue(flow.state.sending)
      assertNull(flow.state.failure)
      val historyRequests = flow.historyRequests
      oldAbortGate.complete(Unit)
      flow.idle()
      assertEquals("Retired Abort cannot reload over the corrected send", historyRequests, flow.historyRequests)
      assertEquals(correctedRun, flow.state.pendingReply?.runId)
      assertTrue(flow.state.sending)
      assertNull(flow.state.failure)
      assertTrue(SemanticsProperties.Disabled in flow.appAction("Type").config)

      correctedGate.complete(Unit)
      flow.idle()
      assertEquals(false, flow.state.sending)
      assertEquals(correctedRun, flow.state.pendingReply?.runId)
      assertTrue("Rejected sends must not speak a reply", speech.spokenTextList.isEmpty())
      flow.historyMessages = """[{"id":"corrected","role":"assistant","content":"Corrected reply","idempotencyKey":"$correctedRun"}]"""
      flow.emit("final", eventRunId = correctedRun)
      assertNull(flow.state.pendingReply)
      assertTrue(SemanticsProperties.Disabled !in flow.appAction("Type").config)
      assertEquals(listOf("Corrected reply"), speech.spokenTextList)
    }

  @Test
  fun abortingAnAmbiguousPendingSendRetiresItsRetryKey() =
    withFlow { flow ->
      flow.sendFails = true
      flow.send()
      val firstRun = flow.runId
      flow.vm.abort()
      flow.idle()
      assertNull(flow.state.pendingReply)
      flow.sendFails = false
      flow.send()
      assertTrue("Abort must retire the ambiguous request, not replay it", flow.runId != firstRun)
    }

  @Test
  fun foreignDeltasCannotEraseTheOnlyObservedOwnTerminal() {
    for ((ownTerminal, ownOutcome) in listOf("error" to WearReplyOutcome.Error, "aborted" to WearReplyOutcome.Aborted)) {
      for ((foreignTerminal, foreignOutcome) in listOf("final" to WearReplyOutcome.Final, "error" to WearReplyOutcome.Error, "aborted" to WearReplyOutcome.Aborted)) {
        withFlow { flow ->
          flow.send()
          val firstRun = flow.runId
          flow.observeReplyCompletion()
          flow.emit("delta", eventRunId = "foreign-run", text = "Foreign live text")
          flow.historyRun =
            buildJsonObject {
              put("runId", "foreign-run")
              put("text", "Foreign live text")
            }
          flow.emit(ownTerminal, eventRunId = firstRun)
          flow.emit("delta", eventRunId = "foreign-run", text = "Foreign continued")
          assertEquals("foreign-run", flow.state.activeRunId)
          assertEquals("Foreign continued", flow.state.streamText)
          assertTrue(flow.completedReplies.isEmpty())
          flow.historyRun = null
          flow.emit(foreignTerminal, eventRunId = "foreign-run")
          assertNull("The known own terminal must not be lost behind foreign deltas", flow.state.pendingReply)
          assertEquals(firstRun, flow.state.replyCompletion?.runId)
          assertEquals(ownOutcome, flow.state.replyCompletion?.outcome)
          assertEquals(foreignOutcome, flow.state.replyTerminal?.outcome)
          assertEquals(listOf<WearChatMessage?>(null), flow.completedReplies)
          flow.vm.refresh()
          flow.idle()
          assertEquals(foreignOutcome, flow.state.replyTerminal?.outcome)
          assertEquals(listOf<WearChatMessage?>(null), flow.completedReplies)
        }
      }
    }
  }

  @Test
  fun abortingForeignRunPreservesTheWatchOwnerAndItsCompletion() =
    withFlow { flow ->
      flow.send()
      val ownRun = flow.runId
      flow.observeReplyCompletion()
      flow.emit("delta", eventRunId = "foreign-run", text = "Foreign live")
      flow.vm.abort()
      flow.idle()
      assertEquals(listOf("foreign-run"), flow.abortRuns)
      assertEquals("Abort only affected the foreign run", ownRun, flow.state.pendingReply?.runId)
      assertTrue(flow.completedReplies.isEmpty())
      assertEquals(false, flow.vm.sendReply("Another send"))
      flow.historyMessages = """[{"id":"own","role":"assistant","content":"Own reply","idempotencyKey":"$ownRun"}]"""
      flow.emit("final", eventRunId = ownRun)
      assertEquals(listOf("Own reply"), flow.completedReplies.map { it?.text })
    }

  @Test
  fun suspendedRunAbortCannotClearNewerLiveOrTerminalState() {
    for (next in listOf("delta", "error", "aborted", "final")) {
      withFlow { flow ->
        flow.send()
        val ownRun = flow.runId
        flow.abortGate = CompletableDeferred()
        flow.vm.abort()
        flow.idle()
        flow.emit("delta", eventRunId = "newer-run", text = "Newer live")
        if (next != "delta") flow.emit(next, eventRunId = "newer-run")
        val before = flow.state
        val historyBefore = flow.historyRequests
        flow.abortGate?.complete(Unit)
        flow.idle()
        assertEquals(listOf(ownRun), flow.abortRuns)
        assertNull(flow.state.pendingReply)
        assertEquals(before.activeRunId, flow.state.activeRunId)
        assertEquals(before.streamText, flow.state.streamText)
        assertEquals(before.replyTerminal, flow.state.replyTerminal)
        assertEquals(before.conversationFailure, flow.state.conversationFailure)
        assertEquals("A stale Abort cannot replace newer history or stream state", historyBefore, flow.historyRequests)
        if (next == "delta") assertEquals(false, flow.vm.sendReply("Not yet"))
      }
    }
  }

  @Test
  fun anonymousAbortUsesHistoryWithoutTreatingNullRunIdsAsIdentity() {
    for (newer in listOf("none", "delta", "error")) {
      withFlow { flow ->
        flow.emit("delta", eventRunId = null, text = "")
        flow.abortGate = CompletableDeferred()
        flow.vm.abort()
        flow.idle()
        if (newer == "delta") flow.emit("delta", eventRunId = null, text = "")
        if (newer == "error") flow.emit("error", eventRunId = "newer-run")
        val before = flow.state
        val historyBefore = flow.historyRequests
        flow.abortGate?.complete(Unit)
        flow.idle()
        assertEquals(listOf<String?>(null), flow.abortRuns)
        if (newer == "none") {
          assertNull(flow.state.streamText)
          assertEquals(historyBefore + 1, flow.historyRequests)
        } else {
          assertEquals("Even identical anonymous text may be newer activity", before.streamText, flow.state.streamText)
          assertEquals(before.replyTerminal, flow.state.replyTerminal)
          assertEquals(before.conversationFailure, flow.state.conversationFailure)
          assertEquals(historyBefore, flow.historyRequests)
        }
      }
    }
  }

  @Test
  fun abortHistoryCannotClearANewerEmptyAnonymousDelta() =
    withFlow { flow ->
      flow.emit("delta", eventRunId = null, text = "Previous anonymous reply")
      flow.historyGate = CompletableDeferred()
      flow.vm.abort()
      flow.idle()
      flow.emit("delta", eventRunId = null, text = "")
      flow.historyGate?.complete(Unit)
      flow.idle()
      assertEquals("An empty live delta still owns activity over the older inactive snapshot", "", flow.state.streamText)
      assertEquals(false, flow.vm.sendReply("Not yet"))
      flow.vm.refresh()
      flow.idle()
      assertNull(flow.state.streamText)
    }

  @Test
  fun terminalRetiresAmbiguityBeforeOrAfterTheSendFailure() {
    for (terminalFirst in listOf(false, true)) {
      for (terminal in listOf("final", "error", "aborted")) {
        withFlow { flow ->
          flow.sendFails = true
          if (terminalFirst) flow.sendGate = CompletableDeferred()
          flow.send()
          val completedRun = flow.runId
          flow.emit(terminal, eventRunId = completedRun)
          val outcome = flow.state.replyTerminal
          flow.sendGate?.complete(Unit)
          flow.idle()
          assertNull("A late transport failure cannot override a known terminal", flow.state.failure)
          assertEquals(outcome, flow.state.replyTerminal)
          flow.sendFails = false
          flow.send()
          assertTrue("A completed run key must not be reused", flow.runId != completedRun)
        }
      }
    }
  }

  @Test
  fun canonicalTerminalRetiresAmbiguityIncludingAfterDisconnect() {
    for (disconnect in listOf(false, true)) {
      for (suffix in listOf("", ":terminal-error", ":assistant")) {
        withFlow { flow ->
          flow.sendFails = true
          flow.send()
          val completedRun = flow.runId
          flow.historyMessages = """[{"id":"own","role":"assistant","content":"Owned terminal","idempotencyKey":"$completedRun$suffix"}]"""
          if (disconnect) {
            flow.connection(false)
            flow.connection(true)
          } else {
            flow.vm.refresh()
            flow.idle()
          }
          flow.sendFails = false
          flow.send()
          assertTrue("Canonical completion retires retry authority", flow.runId != completedRun)
        }
      }
    }
  }

  @Test
  fun lateSendCallbacksCannotRetireOrReplaceANewerAttempt() {
    for (lateErrorCode in listOf(null, "internal_error", "invalid_request", "INVALID_REQUEST")) {
      withFlow { flow ->
        val oldGate = CompletableDeferred<Unit>()
        flow.sendGate = oldGate
        flow.sendFails = lateErrorCode != null
        flow.sendErrorCode = lateErrorCode ?: "internal_error"
        flow.send()
        val oldRun = flow.runId
        flow.emit("final", eventRunId = oldRun)
        assertEquals("A definitive terminal releases the old sending state", false, flow.state.sending)
        val newerGate = CompletableDeferred<Unit>()
        flow.sendGate = newerGate
        flow.sendFails = true
        flow.sendErrorCode = "internal_error"
        assertEquals(true, flow.vm.sendReply("New request"))
        flow.idle()
        val newerRun = flow.runId
        oldGate.complete(Unit)
        flow.idle()
        assertEquals(newerRun, flow.state.pendingReply?.runId)
        assertTrue("A retired callback cannot clear the newer sending flag", flow.state.sending)
        assertNull("A retired rejection cannot replace the newer feedback", flow.state.failure)
        newerGate.complete(Unit)
        flow.idle()
        assertTrue(checkNotNull(flow.state.pendingReply).retryable)
        flow.sendGate = null
        flow.sendFails = false
        assertEquals(true, flow.vm.sendReply("New request"))
        flow.idle()
        assertEquals(newerRun, flow.runId)
        assertEquals(listOf(oldRun, newerRun, newerRun), flow.sentRunIds)
      }
    }
  }

  @Test
  fun explicitNavigationRetiresTheOldInvocationAndRetryScope() =
    withFlow { flow ->
      val oldSession = checkNotNull(flow.state.selectedSession)
      val oldGate = CompletableDeferred<Unit>()
      flow.sendGate = oldGate
      flow.sendFails = true
      flow.send()
      val oldRun = flow.runId
      flow.vm.openSession(oldSession.copy(key = "agent:main:other"))
      flow.idle()
      assertEquals(false, flow.state.sending)
      flow.vm.openSession(oldSession)
      flow.idle()
      oldGate.complete(Unit)
      flow.idle()
      assertNull("Leaving and returning does not revive an old callback", flow.state.failure)
      flow.sendGate = null
      flow.sendFails = false
      flow.send()
      assertTrue(flow.runId != oldRun)
    }

  @Test
  fun disconnectRevokesCallbacksButKeepsTheUnresolvedIdempotentRetry() =
    withFlow { flow ->
      val oldGate = CompletableDeferred<Unit>()
      flow.sendGate = oldGate
      flow.sendFails = true
      flow.send()
      val oldRun = flow.runId
      flow.connection(false)
      assertEquals(false, flow.state.sending)
      flow.connection(true)
      flow.sendGate = null
      flow.sendFails = false
      flow.send()
      assertEquals(oldRun, flow.runId)
      oldGate.complete(Unit)
      flow.idle()
      assertNull(flow.state.failure)
      assertEquals(oldRun, flow.state.pendingReply?.runId)
      assertEquals(false, flow.vm.sendReply("Hello"))
    }

  @Test
  fun canonicalOwnCompletionRemainsKnownWhileForeignHistoryIsActive() =
    withFlow { flow ->
      flow.send()
      val ownRun = flow.runId
      flow.observeReplyCompletion()
      flow.historyMessages = """[{"id":"own","role":"assistant","content":"Owned reply","idempotencyKey":"$ownRun"}]"""
      flow.historyRun =
        buildJsonObject {
          put("runId", "foreign-run")
          put("text", "Foreign live")
        }
      flow.vm.refresh()
      flow.idle()
      assertTrue(flow.completedReplies.isEmpty())
      assertEquals("foreign-run", flow.state.activeRunId)
      flow.historyMessages = "[]"
      flow.historyRun = null
      flow.emit("final", eventRunId = "foreign-run")
      assertNull(flow.state.pendingReply)
      assertEquals(listOf("Owned reply"), flow.completedReplies.map { it?.text })
    }

  @Test
  fun noOpAbortDoesNotRetireAnUnresolvedSend() {
    for (ambiguous in listOf(false, true)) {
      withFlow { flow ->
        flow.sendFails = ambiguous
        flow.send()
        val ownRun = flow.runId
        flow.abortAccepted = false
        flow.vm.abort()
        flow.idle()
        assertEquals(ownRun, flow.state.pendingReply?.runId)
        assertEquals(ambiguous, flow.state.pendingReply?.retryable)
        assertEquals(false, flow.vm.sendReply("Another message"))
        if (ambiguous) {
          flow.sendFails = false
          flow.send()
          assertEquals("No-op Abort and empty history preserve the uncertain key", listOf(ownRun, ownRun), flow.sentRunIds)
        }
        flow.emit("aborted", eventRunId = ownRun)
        assertNull(flow.state.pendingReply)
      }
    }
  }

  @Test
  @Config(qualifiers = "w400dp-h800dp-mdpi")
  fun appAbortOfForeignRunDoesNotCancelOwnAutomaticReplySpeech() =
    withFlow { flow ->
      flow.observeApp(autoSpeak = true)
      val speech = shadowOf(checkNotNull(ShadowTextToSpeech.getLastTextToSpeechInstance()))
      speech.onInitListener.onInit(TextToSpeech.SUCCESS)
      flow.submitFromApp("Hello")
      val ownRun = flow.runId
      flow.emit("delta", eventRunId = "foreign-run", text = "Foreign live")
      assertEquals(
        true,
        flow
          .appAction("Abort run")
          .config[SemanticsActions.OnClick]
          .action
          ?.invoke(),
      )
      flow.idle()
      assertEquals(ownRun, flow.state.pendingReply?.runId)
      assertNull(speech.lastSpokenText)
      flow.historyMessages = """[{"id":"own","role":"assistant","content":"Own reply","idempotencyKey":"$ownRun"}]"""
      flow.emit("final", eventRunId = ownRun)
      assertEquals("Own reply", speech.lastSpokenText)
    }

  @Test
  @Config(qualifiers = "w400dp-h800dp-mdpi")
  fun canonicalCompletionDisablesRetiredRetryWhileHistoryRecoveryIsPending() =
    withFlow { flow ->
      flow.sendFails = true
      flow.send()
      val ownRun = flow.runId
      flow.historyMessages = """[{"id":"own","role":"assistant","content":"Owned reply","idempotencyKey":"$ownRun"}]"""
      flow.historyRun =
        buildJsonObject {
          put("runId", "foreign-run")
          put("text", "Foreign live")
        }
      flow.vm.refresh()
      flow.idle()
      flow.observeApp()
      flow.historyFails = true
      flow.vm.abort()
      flow.idle()
      assertEquals(ownRun, flow.state.pendingReply?.runId)
      assertTrue("The completed key is no longer an available retry", SemanticsProperties.Disabled in flow.appAction("Type").config)
      flow.historyFails = false
      flow.historyRun = null
      flow.vm.refresh()
      flow.idle()
      assertNull(flow.state.pendingReply)
    }

  @Test
  fun canonicalCompletionSurvivesStreamResyncAndATruncatedHistoryWindow() =
    withFlow { flow ->
      flow.send()
      val ownRun = flow.runId
      flow.observeReplyCompletion()
      flow.historyMessages = """[{"id":"own","role":"assistant","content":"Owned reply","idempotencyKey":"$ownRun"}]"""
      flow.historyRun =
        buildJsonObject {
          put("runId", "foreign-run")
          put("text", "Foreign live")
        }
      flow.vm.refresh()
      flow.idle()
      flow.historyMessages = "[]"
      flow.emit("delta", eventRunId = "foreign-run", text = "Foreign live", eventSequence = 5)
      assertEquals("foreign-run", flow.state.activeRunId)
      assertTrue(flow.completedReplies.isEmpty())
      flow.historyRun = null
      flow.emit("final", eventRunId = "foreign-run")
      assertNull("A proven terminal is not an ambiguous transport observation", flow.state.pendingReply)
      assertEquals(listOf("Owned reply"), flow.completedReplies.map { it?.text })
    }

  @Test
  fun matchedTerminalSurvivesSamePhoneResyncWithoutCanonicalAssistantText() {
    for ((terminal, outcome) in listOf("error" to WearReplyOutcome.Error, "aborted" to WearReplyOutcome.Aborted, "final" to WearReplyOutcome.Final)) {
      for (anonymous in listOf(false, true)) {
        for (epochReset in listOf(false, true)) {
          for (stillActive in listOf(false, true)) {
            withFlow { flow ->
              flow.send()
              val ownRun = flow.runId
              flow.observeReplyCompletion()
              val liveRun = "foreign-run".takeUnless { anonymous }
              flow.emit("delta", eventRunId = liveRun, text = "Other live reply")
              flow.historyRun =
                buildJsonObject {
                  liveRun?.let { put("runId", it) }
                  put("text", "Other live reply")
                }
              flow.emit(terminal, eventRunId = ownRun)
              assertTrue(flow.completedReplies.isEmpty())
              flow.historyRun =
                if (stillActive) {
                  buildJsonObject {
                    put("runId", "newer-run")
                    put("text", "Newer live reply")
                  }
                } else {
                  null
                }
              flow.emit("delta", eventRunId = "unrelated", text = "Covered by snapshot", eventSequence = if (epochReset) 3 else 5, eventStreamId = if (epochReset) "old-epoch" else "epoch-a")
              if (stillActive) {
                assertEquals("newer-run", flow.state.activeRunId)
                assertEquals("Newer live reply", flow.state.streamText)
                assertTrue(flow.completedReplies.isEmpty())
                assertEquals(false, flow.vm.sendReply("Hello"))
                flow.historyRun = null
                flow.vm.refresh()
                flow.idle()
              }
              assertNull("Same-phone resync cannot erase a matched logical completion", flow.state.pendingReply)
              assertEquals(ownRun, flow.state.replyCompletion?.runId)
              assertEquals(outcome, flow.state.replyCompletion?.outcome)
              assertEquals(listOf<WearChatMessage?>(null), flow.completedReplies)
              flow.send()
              assertTrue("The completed request is never retried", flow.runId != ownRun)
            }
          }
        }
      }
    }
  }

  @Test
  fun laterOwnAndAnonymousDeltasCannotReopenAMatchedLogicalCompletion() {
    for (laterRun in listOf("own", "foreign-run", null)) {
      withFlow { flow ->
        flow.send()
        val ownRun = flow.runId
        flow.observeReplyCompletion()
        flow.emit("delta", eventRunId = null, text = "Anonymous live reply")
        flow.historyRun = buildJsonObject { put("text", "Anonymous live reply") }
        flow.emit("error", eventRunId = ownRun)
        flow.emit("delta", eventRunId = if (laterRun == "own") ownRun else laterRun, text = "New live projection")
        assertTrue(flow.completedReplies.isEmpty())
        assertEquals(false, flow.vm.sendReply("Hello"))
        flow.historyRun = null
        flow.vm.refresh()
        flow.idle()
        assertNull(flow.state.pendingReply)
        assertEquals(ownRun, flow.state.replyCompletion?.runId)
        assertEquals(listOf<WearChatMessage?>(null), flow.completedReplies)
        assertNull("New stream activity supersedes only the conversation-status candidate", flow.state.replyTerminal)
      }
    }
  }

  @Test
  fun actualContextChangeClearsTheRetainedMatchedCompletion() =
    withFlow { flow ->
      flow.send()
      val ownRun = flow.runId
      flow.emit("delta", eventRunId = "foreign-run", text = "Foreign live")
      flow.historyRun =
        buildJsonObject {
          put("runId", "foreign-run")
          put("text", "Foreign live")
        }
      flow.emit("error", eventRunId = ownRun)
      assertEquals(ownRun, flow.state.replyCompletion?.runId)
      flow.historyRun = null
      flow.vm.openSession(checkNotNull(flow.state.selectedSession).copy(key = "agent:main:other"))
      flow.idle()
      assertNull(flow.state.pendingReply)
      assertNull(flow.state.replyCompletion)
    }

  @Test
  fun failedAbortDoesNotDiscardTheStillOwnedCompletionEffect() =
    withFlow { flow ->
      flow.send()
      val ownRun = flow.runId
      flow.observeReplyCompletion()
      flow.abortFails = true
      flow.vm.abort()
      flow.idle()
      assertNotNull(flow.state.failure)
      assertEquals(ownRun, flow.state.pendingReply?.runId)
      assertTrue("An operation failure is not a terminal for the pending send", flow.completedReplies.isEmpty())
      flow.historyMessages = """[{"id":"own","role":"assistant","content":"Own reply","idempotencyKey":"$ownRun"}]"""
      flow.emit("final", eventRunId = ownRun)
      assertEquals(listOf("Own reply"), flow.completedReplies.map { it?.text })
    }

  @Test
  @Config(qualifiers = "w400dp-h800dp-mdpi")
  fun appOwnAbortFollowsConfirmedOutcomeRatherThanTheRequest() {
    for (mode in listOf("no-op", "failed", "confirmed", "confirmed-foreign")) {
      withFlow { flow ->
        flow.observeApp(autoSpeak = true)
        val engine = checkNotNull(ShadowTextToSpeech.getLastTextToSpeechInstance())
        val speech = shadowOf(engine)
        speech.onInitListener.onInit(TextToSpeech.SUCCESS)
        flow.submitFromApp("Hello")
        val ownRun = flow.runId
        engine.speak("Existing speech", TextToSpeech.QUEUE_FLUSH, Bundle(), "existing")
        assertEquals(false, speech.isStopped)
        flow.abortAccepted = mode.startsWith("confirmed")
        flow.abortFails = mode == "failed"
        flow.abortGate = CompletableDeferred()
        assertEquals(
          true,
          flow
            .appAction("Abort run")
            .config[SemanticsActions.OnClick]
            .action
            ?.invoke(),
        )
        assertTrue("The explicit action still stops current playback immediately", speech.isStopped)
        assertEquals(ownRun, flow.state.pendingReply?.runId)
        if (mode == "confirmed-foreign") flow.emit("delta", eventRunId = "foreign-run", text = "Foreign live")
        flow.abortGate?.complete(Unit)
        flow.idle()
        if (mode.startsWith("confirmed")) {
          assertNull(flow.state.pendingReply)
        } else {
          assertEquals(ownRun, flow.state.pendingReply?.runId)
        }
        flow.historyMessages = """[{"id":"own","role":"assistant","content":"Own reply","idempotencyKey":"$ownRun"}]"""
        flow.emit("final", eventRunId = ownRun)
        if (mode == "confirmed-foreign") flow.emit("error", eventRunId = "foreign-run")
        assertEquals(if (mode.startsWith("confirmed")) "Existing speech" else "Own reply", speech.lastSpokenText)
        flow.historyMessages = "[]"
        flow.submitFromApp("Next")
        val nextRun = flow.runId
        assertTrue(nextRun != ownRun)
        flow.historyMessages = """[{"id":"next","role":"assistant","content":"Next reply","idempotencyKey":"$nextRun"}]"""
        flow.emit("final", eventRunId = nextRun)
        assertEquals("Next reply", speech.lastSpokenText)
      }
    }
  }

  @Test
  @Config(qualifiers = "w400dp-h800dp-mdpi")
  fun appAbortWaitsForRpcOutcomeWhenTerminalPrecedesAck() {
    for (mode in listOf("confirmed", "no-op", "failed")) {
      withFlow { flow ->
        flow.observeApp(autoSpeak = true)
        val speech = shadowOf(checkNotNull(ShadowTextToSpeech.getLastTextToSpeechInstance()))
        speech.onInitListener.onInit(TextToSpeech.SUCCESS)
        flow.submitFromApp("Hello")
        val ownRun = flow.runId
        flow.abortGate = CompletableDeferred()
        flow.abortAccepted = mode == "confirmed"
        flow.abortFails = mode == "failed"
        assertEquals(
          true,
          flow
            .appAction("Abort run")
            .config[SemanticsActions.OnClick]
            .action
            ?.invoke(),
        )
        flow.historyMessages = """[{"id":"partial","role":"assistant","content":"Partial reply","idempotencyKey":"$ownRun:assistant"}]"""
        // Gateway broadcasts the aborted terminal before its Abort RPC responds.
        flow.emit("aborted", eventRunId = ownRun)
        assertNull("Do not resume speech while the matching Abort outcome is unknown", speech.lastSpokenText)
        flow.abortGate?.complete(Unit)
        flow.idle()
        assertEquals(if (mode == "confirmed") null else "Partial reply", speech.lastSpokenText)
      }
    }
  }

  @Test
  @Config(qualifiers = "w400dp-h800dp-mdpi")
  fun appAmbiguousRetryCannotReplacePendingAbortAndRecoversFromEachOutcome() {
    for (terminalBeforeAck in listOf(true, false)) {
      for (mode in listOf("confirmed", "no-op", "failed")) {
        withFlow { flow ->
          flow.observeApp(autoSpeak = true)
          val speech = shadowOf(checkNotNull(ShadowTextToSpeech.getLastTextToSpeechInstance()))
          speech.onInitListener.onInit(TextToSpeech.SUCCESS)
          flow.sendFails = true
          flow.submitFromApp("Hello")
          val ownRun = flow.runId
          assertTrue(flow.state.canSubmitReply)
          flow.abortGate = CompletableDeferred()
          flow.abortAccepted = mode == "confirmed"
          flow.abortFails = mode == "failed"
          flow.vm.abort()
          flow.idle()
          flow.sendFails = false
          var accepted = false
          val admitted = flow.vm.sendReply("Hello") { accepted = true }
          flow.idle()
          if (terminalBeforeAck) {
            flow.historyMessages = """[{"id":"partial","role":"assistant","content":"Partial reply","idempotencyKey":"$ownRun:assistant"}]"""
            flow.emit("aborted", eventRunId = ownRun)
            assertNull("A retry cannot remove the terminal-before-ACK feedback fence", speech.lastSpokenText)
          }
          assertEquals("An exact retry is still a submission during an unresolved owned Abort", false, admitted)
          assertEquals(false, accepted)
          assertEquals(1, flow.sendRequests)
          assertEquals(ownRun, flow.state.pendingAbortRunId)
          assertTrue(SemanticsProperties.Disabled in flow.appAction("Type").config)
          flow.abortGate?.complete(Unit)
          flow.idle()
          assertNull(flow.state.pendingAbortRunId)
          assertEquals(if (terminalBeforeAck && mode != "confirmed") "Partial reply" else null, speech.lastSpokenText)
          assertTrue("Submission recovers when Abort has an outcome", SemanticsProperties.Disabled !in flow.appAction("Type").config)
          flow.historyMessages = "[]"
          flow.submitFromApp("Hello")
          val nextRun = flow.runId
          assertEquals(!terminalBeforeAck && mode != "confirmed", nextRun == ownRun)
          flow.historyMessages = """[{"id":"next","role":"assistant","content":"Recovered reply","idempotencyKey":"$nextRun"}]"""
          flow.emit("final", eventRunId = nextRun)
          assertEquals("Recovered reply", speech.lastSpokenText)
        }
      }
    }
  }

  @Test
  @Config(qualifiers = "w400dp-h800dp-mdpi")
  fun pendingOwnedAbortStillAllowsExplicitContextNavigation() =
    withFlow { flow ->
      flow.sessionList = """[{"key":"agent:main:proof","displayName":"Test chat","hasActiveRun":false},{"key":"agent:main:other","displayName":"Other chat","hasActiveRun":false}]"""
      flow.vm.refresh()
      flow.idle()
      flow.observeApp()
      flow.sendFails = true
      flow.submitFromApp("Hello")
      flow.abortGate = CompletableDeferred()
      flow.vm.abort()
      flow.idle()
      assertTrue(SemanticsProperties.Disabled in flow.appAction("Type").config)
      val context = flow.appAction("Session: Test chat")
      assertTrue(SemanticsProperties.Disabled !in context.config)
      assertEquals(true, context.config[SemanticsActions.OnClick].action?.invoke())
      assertEquals(
        true,
        flow
          .appAction("Other chat")
          .config[SemanticsActions.OnClick]
          .action
          ?.invoke(),
      )
      flow.idle()
      assertEquals("agent:main:other", flow.state.selectedSession?.key)
      assertNull(flow.state.pendingAbortRunId)
      assertNull(flow.state.pendingReply)
      flow.abortGate?.complete(Unit)
      flow.idle()
      assertTrue(SemanticsProperties.Disabled !in flow.appAction("Type").config)
    }

  @Test
  fun oldAbortCannotReleaseANewSameKeyAbortAfterContextRetirement() {
    val failures = mutableListOf<Throwable>()
    for (disconnect in listOf("event", "status", "discovery-error", "history-timeout")) {
      for (oldOutcome in listOf("no-op", "failed", "confirmed")) {
        try {
          withFlow { flow ->
            flow.sendFails = true
            flow.send()
            val ownRun = flow.runId
            val oldGate = CompletableDeferred<Unit>()
            flow.abortGate = oldGate
            flow.abortAccepted = oldOutcome == "confirmed"
            flow.abortFails = oldOutcome == "failed"
            flow.vm.abort()
            flow.idle()
            when (disconnect) {
              "event" -> {
                flow.connection(false)
                assertNull(flow.state.pendingAbortRunId)
                flow.connection(true)
              }

              "status" -> {
                flow.gatewayConnected = false
                flow.vm.refresh()
                flow.idle()
                assertNull(flow.state.pendingAbortRunId)
                flow.gatewayConnected = true
                flow.vm.refresh()
                flow.idle()
              }

              "discovery-error" -> {
                flow.statusFails = true
                flow.vm.refresh()
                flow.idle()
                assertNull(flow.state.pendingAbortRunId)
                flow.statusFails = false
                flow.vm.refresh()
                flow.idle()
              }

              else -> {
                flow.historyFails = true
                flow.historyErrorCode = "timeout"
                flow.vm.refresh()
                flow.idle()
                assertNull(flow.state.pendingAbortRunId)
                flow.historyFails = false
                flow.vm.refresh()
                flow.idle()
              }
            }
            flow.send()
            assertEquals("An unresolved same-target send deliberately keeps its logical key", ownRun, flow.runId)
            flow.observeReplyCompletion()
            val newGate = CompletableDeferred<Unit>()
            flow.abortGate = newGate
            flow.abortAccepted = true
            flow.abortFails = false
            flow.vm.abort()
            flow.idle()
            flow.historyMessages = """[{"id":"partial","role":"assistant","content":"Partial reply","idempotencyKey":"$ownRun:assistant"}]"""
            flow.emit("aborted", eventRunId = ownRun)
            assertTrue(flow.completedReplies.isEmpty())
            oldGate.complete(Unit)
            flow.idle()
            assertEquals("A retired Abort invocation cannot release its successor: $disconnect/$oldOutcome", ownRun, flow.state.pendingAbortRunId)
            assertTrue("The successor still awaits its own Abort ACK", flow.completedReplies.isEmpty())
            assertEquals(WearReplyOutcome.Aborted, flow.state.replyCompletion?.outcome)
            assertNull(flow.state.failure)
            newGate.complete(Unit)
            flow.idle()
            assertNull(flow.state.pendingAbortRunId)
            assertEquals(WearReplyOutcome.Canceled, flow.state.replyCompletion?.outcome)
            assertEquals(listOf<WearChatMessage?>(null), flow.completedReplies)
            flow.sendFails = false
            flow.send()
            assertTrue(flow.runId != ownRun)
          }
        } catch (failure: AssertionError) {
          failures += failure
        }
      }
    }
    org.junit.runners.model.MultipleFailureException
      .assertEmpty(failures)
  }

  @Test
  fun firstHistorySupersedesAnOlderErrorAtItsExactOwnBoundary() {
    for (suffix in listOf("", ":terminal-error", ":assistant", ":settled-finalization-fallback")) {
      for (identified in listOf(true, false)) {
        withFlow { flow ->
          flow.send()
          val ownRun = flow.runId
          flow.observeReplyCompletion()
          val ownId = if (identified) "\"id\":\"own\"," else ""
          val laterId = if (identified) "\"id\":\"later\"," else ""
          // Both records exist before the terminal-triggered first history read.
          // Equal timestamps cannot identify their order; the run keys can.
          flow.historyMessages = """[{$ownId"role":"assistant","content":"Own failed reply","timestamp":1,"idempotencyKey":"$ownRun$suffix"},{$laterId"role":"assistant","content":"Later successful reply","timestamp":1,"idempotencyKey":"$ownRun:terminal-error:extra"}]"""
          flow.historyGate = CompletableDeferred()
          flow.emit("error", eventRunId = ownRun)
          assertNull(flow.state.replyTerminal?.history)
          assertEquals(WearConversationFailure.INTERNAL_ERROR, flow.state.conversationFailure)
          assertTrue(flow.completedReplies.isEmpty())
          flow.historyGate?.complete(Unit)
          flow.idle()
          assertEquals(listOf("Own failed reply", "Later successful reply"), flow.state.messages.map { it.text })
          assertNull("The first authoritative history already proves a newer reply", flow.state.replyTerminal)
          assertNull(flow.state.conversationFailure)
          assertEquals(ownRun, flow.state.replyCompletion?.runId)
          assertEquals(WearReplyOutcome.Error, flow.state.replyCompletion?.outcome)
          assertEquals(listOf("Own failed reply"), flow.completedReplies.map { it?.text })
          flow.vm.refresh()
          flow.idle()
          assertNull(flow.state.conversationFailure)
          assertEquals("Own feedback remains one-shot and never selects the later tail", listOf("Own failed reply"), flow.completedReplies.map { it?.text })
        }
      }
    }
  }

  @Test
  fun firstHistoryKeepsTheNewestOwnedErrorUntilANewerAssistantExists() =
    withFlow { flow ->
      flow.send()
      val ownRun = flow.runId
      flow.observeReplyCompletion()
      val initial = """[{"id":"older","role":"assistant","content":"Older successful reply","timestamp":20,"idempotencyKey":"older-run"},{"id":"own","role":"assistant","content":"Newest failed reply","timestamp":10,"idempotencyKey":"$ownRun:terminal-error"},{"id":"question","role":"user","content":"Next question","timestamp":30}]"""
      flow.historyMessages = initial
      flow.emit("error", eventRunId = ownRun)
      assertEquals(ownRun, flow.state.replyTerminal?.runId)
      assertEquals(WearConversationFailure.INTERNAL_ERROR, flow.state.conversationFailure)
      assertEquals(listOf("Newest failed reply"), flow.completedReplies.map { it?.text })
      flow.vm.refresh()
      flow.idle()
      assertEquals(WearConversationFailure.INTERNAL_ERROR, flow.state.conversationFailure)
      flow.historyMessages = initial.dropLast(1) + """,{"id":"next","role":"assistant","content":"New successful reply","timestamp":10}]"""
      flow.vm.refresh()
      flow.idle()
      assertNull(flow.state.replyTerminal)
      assertNull(flow.state.conversationFailure)
      assertEquals(listOf("Newest failed reply"), flow.completedReplies.map { it?.text })
    }

  @Test
  fun firstHistoryWithoutAnOwnBoundaryRemainsConservative() =
    withFlow { flow ->
      flow.send()
      val ownRun = flow.runId
      flow.observeReplyCompletion()
      flow.historyMessages = """[{"id":"bounded-b","role":"assistant","content":"Unordered foreign reply","timestamp":100,"idempotencyKey":"$ownRun:terminal-error:extra"},{"id":"bounded-c","role":"assistant","content":"Unordered tail","timestamp":101,"idempotencyKey":"prefix-$ownRun"}]"""
      flow.emit("error", eventRunId = ownRun)
      assertEquals("A bounded window without A cannot prove whether B followed A", ownRun, flow.state.replyTerminal?.runId)
      assertEquals(WearConversationFailure.INTERNAL_ERROR, flow.state.conversationFailure)
      assertEquals(listOf<WearChatMessage?>(null), flow.completedReplies)
      flow.vm.refresh()
      flow.idle()
      assertEquals(WearConversationFailure.INTERNAL_ERROR, flow.state.conversationFailure)
      assertEquals(listOf<WearChatMessage?>(null), flow.completedReplies)
    }

  @Test
  fun firstHistoryUsesOnlyAVerifiedTerminalEventMessageBoundary() {
    for (ownMessagePresent in listOf(true, false)) {
      withFlow { flow ->
        flow.send()
        val ownRun = flow.runId
        flow.observeReplyCompletion()
        val ownRecord = if (ownMessagePresent) """{"id":"own-event","role":"assistant","content":"Own event reply","timestamp":1},""" else ""
        flow.historyMessages = """[$ownRecord{"id":"later","role":"assistant","content":"Foreign history tail","timestamp":100}]"""
        flow.emit(
          "final",
          eventRunId = ownRun,
          message =
            buildJsonObject {
              put("id", "own-event")
              put("role", "assistant")
              put("content", "Own event reply")
              put("timestamp", 1)
            },
        )
        if (ownMessagePresent) {
          assertNull("The event ID identifies a canonical boundary before the newer tail", flow.state.replyTerminal)
        } else {
          assertEquals("A missing event message is not ordered by its timestamp", ownRun, flow.state.replyTerminal?.runId)
        }
        assertEquals(listOf("Own event reply"), flow.completedReplies.map { it?.text })
        flow.vm.refresh()
        flow.idle()
        assertEquals(listOf("Own event reply"), flow.completedReplies.map { it?.text })
      }
    }
  }

  @Test
  @Config(qualifiers = "w400dp-h800dp-mdpi")
  fun appSessionWideAbortUsesOwnAbortedEvidenceAcrossBothAckOrders() {
    for (order in listOf("terminal-first", "ack-first-terminal", "ack-first-history")) {
      for (result in listOf("confirmed", "no-op", "failed")) {
        withFlow { flow ->
          flow.observeApp(autoSpeak = true)
          val engine = checkNotNull(ShadowTextToSpeech.getLastTextToSpeechInstance())
          val speech = shadowOf(engine)
          speech.onInitListener.onInit(TextToSpeech.SUCCESS)
          flow.submitFromApp("Hello")
          val ownRun = flow.runId
          flow.emit("delta", eventRunId = null, text = "Anonymous live")
          engine.speak("Existing speech", TextToSpeech.QUEUE_FLUSH, Bundle(), "existing")
          flow.abortGate = CompletableDeferred()
          flow.abortAccepted = result == "confirmed"
          flow.abortFails = result == "failed"
          assertEquals(
            true,
            flow
              .appAction("Abort run")
              .config[SemanticsActions.OnClick]
              .action
              ?.invoke(),
          )
          flow.idle()
          assertTrue(speech.isStopped)
          assertEquals("RPC scope remains session-wide", listOf<String?>(null), flow.abortRuns)
          val partial = """[{"id":"own-partial","role":"assistant","content":"Own partial","idempotencyKey":"$ownRun:assistant"}]"""
          if (order == "terminal-first") {
            flow.historyMessages = partial
            flow.emit("aborted", eventRunId = ownRun)
            assertEquals("The captured Watch reply waits even though the RPC runId is null", "Existing speech", speech.lastSpokenText)
            assertEquals(ownRun, flow.state.pendingAbortRunId)
          } else {
            // The producer persists before ACK; only delivery of the history is delayed.
            flow.historyMessages = partial
            flow.historyGate = CompletableDeferred()
          }
          flow.abortGate?.complete(Unit)
          flow.idle()
          if (order != "terminal-first") {
            assertEquals("Aggregate success alone cannot settle A", ownRun, flow.state.pendingReply?.runId)
            assertNull(flow.state.replyCompletion)
            assertNull("The RPC is no longer unresolved", flow.state.pendingAbortRunId)
            flow.historyMessages = partial
            flow.historyRun = null
            if (order == "ack-first-terminal") {
              flow.emit("aborted", eventRunId = ownRun)
            } else {
              flow.vm.refresh()
              flow.idle()
            }
            flow.historyGate?.complete(Unit)
            flow.idle()
          }
          assertNull(flow.state.pendingReply)
          assertEquals(if (result == "confirmed") WearReplyOutcome.Canceled else WearReplyOutcome.Aborted, flow.state.replyCompletion?.outcome)
          assertEquals(if (result == "confirmed") "Existing speech" else "Own partial", speech.lastSpokenText)
          flow.vm.refresh()
          flow.idle()
          assertEquals(if (result == "confirmed") 0 else 1, speech.spokenTextList.count { it == "Own partial" })
        }
      }
    }
  }

  @Test
  @Config(qualifiers = "w400dp-h800dp-mdpi")
  fun aggregateAbortCannotCancelOwnFinalOrErrorOrEraseAnotherLiveRun() {
    for ((terminal, outcome, suffix) in listOf(Triple("final", WearReplyOutcome.Final, ""), Triple("error", WearReplyOutcome.Error, ":terminal-error"), Triple("aborted", WearReplyOutcome.Canceled, ":assistant"))) {
      withFlow { flow ->
        flow.observeApp(autoSpeak = true)
        val speech = shadowOf(checkNotNull(ShadowTextToSpeech.getLastTextToSpeechInstance()))
        speech.onInitListener.onInit(TextToSpeech.SUCCESS)
        flow.submitFromApp("Hello")
        val ownRun = flow.runId
        flow.emit("delta", eventRunId = null, text = "Anonymous live")
        flow.historyMessages = """[{"id":"other-aborted","role":"assistant","content":"Other canceled reply","idempotencyKey":"other-run:assistant"}]"""
        flow.historyRun =
          buildJsonObject {
            put("runId", "foreign-live")
            put("text", "Foreign still live")
          }
        assertEquals(
          true,
          flow
            .appAction("Abort run")
            .config[SemanticsActions.OnClick]
            .action
            ?.invoke(),
        )
        flow.idle()
        assertEquals(listOf<String?>(null), flow.abortRuns)
        assertEquals(ownRun, flow.state.pendingReply?.runId)
        assertNull(flow.state.replyCompletion)
        assertEquals("foreign-live", flow.state.activeRunId)
        flow.historyMessages = """[{"id":"own","role":"assistant","content":"Own result","idempotencyKey":"$ownRun$suffix"}]"""
        flow.emit(terminal, eventRunId = ownRun)
        assertEquals("foreign-live", flow.state.activeRunId)
        assertEquals("Foreign still live", flow.state.streamText)
        assertNull(speech.lastSpokenText)
        flow.historyRun = null
        flow.historyMessages = """[{"id":"own","role":"assistant","content":"Own result","idempotencyKey":"$ownRun$suffix"},{"id":"foreign-error","role":"assistant","content":"Foreign error","idempotencyKey":"foreign-live:terminal-error"}]"""
        flow.emit("error", eventRunId = "foreign-live")
        assertEquals("foreign-live", flow.state.replyTerminal?.runId)
        assertEquals(WearConversationFailure.INTERNAL_ERROR, flow.state.conversationFailure)
        assertEquals(outcome, flow.state.replyCompletion?.outcome)
        assertEquals(if (terminal == "aborted") null else "Own result", speech.lastSpokenText)
      }
    }
  }

  @Test
  fun sessionWideSuccessWithoutOwnCompletionKeepsTargetedRecoveryAvailable() =
    withFlow { flow ->
      flow.send()
      val ownRun = flow.runId
      flow.observeReplyCompletion()
      flow.emit("delta", eventRunId = null, text = "Anonymous live")
      flow.vm.abort()
      flow.idle()
      assertEquals(listOf<String?>(null), flow.abortRuns)
      assertEquals(ownRun, flow.state.pendingReply?.runId)
      assertNull(flow.state.replyCompletion)
      assertNull(flow.state.pendingAbortRunId)
      assertTrue(flow.completedReplies.isEmpty())
      assertEquals(false, flow.vm.sendReply("Different request"))
      flow.vm.abort()
      flow.idle()
      assertEquals(listOf(null, ownRun), flow.abortRuns)
      assertNull(flow.state.pendingReply)
      assertEquals(WearReplyOutcome.Canceled, flow.state.replyCompletion?.outcome)
      assertEquals(listOf<WearChatMessage?>(null), flow.completedReplies)
    }

  @Test
  @Config(qualifiers = "w400dp-h800dp-mdpi")
  fun sessionWideSuccessWithoutOwnProofDoesNotRetireAnAmbiguousRetry() =
    withFlow { flow ->
      flow.observeApp(autoSpeak = true)
      val speech = shadowOf(checkNotNull(ShadowTextToSpeech.getLastTextToSpeechInstance()))
      speech.onInitListener.onInit(TextToSpeech.SUCCESS)
      flow.sendFails = true
      flow.submitFromApp("Hello")
      val ownRun = flow.runId
      flow.emit("delta", eventRunId = null, text = "Anonymous live")
      assertEquals(
        true,
        flow
          .appAction("Abort run")
          .config[SemanticsActions.OnClick]
          .action
          ?.invoke(),
      )
      flow.idle()
      assertEquals(ownRun, flow.state.pendingReply?.runId)
      assertNull(flow.state.replyCompletion)
      assertTrue(flow.state.canSubmitReply)
      flow.sendFails = false
      flow.submitFromApp("Hello")
      assertEquals(listOf(ownRun, ownRun), flow.sentRunIds)
      flow.historyMessages = """[{"id":"own","role":"assistant","content":"Retry partial","idempotencyKey":"$ownRun:assistant"}]"""
      flow.emit("aborted", eventRunId = ownRun)
      assertEquals("A new deliberate retry supersedes unproven old Abort intent", WearReplyOutcome.Aborted, flow.state.replyCompletion?.outcome)
      assertEquals("Retry partial", speech.lastSpokenText)
    }

  @Test
  @Config(qualifiers = "w400dp-h800dp-mdpi")
  fun sessionWideAbortDoesNotClaimAnOwnCompletionKnownBeforeTheRequest() =
    withFlow { flow ->
      flow.observeApp(autoSpeak = true)
      val speech = shadowOf(checkNotNull(ShadowTextToSpeech.getLastTextToSpeechInstance()))
      speech.onInitListener.onInit(TextToSpeech.SUCCESS)
      flow.submitFromApp("Hello")
      val ownRun = flow.runId
      flow.emit("delta", eventRunId = null, text = "Anonymous other run")
      flow.historyRun = buildJsonObject { put("text", "Anonymous other run") }
      flow.historyMessages = """[{"id":"own","role":"assistant","content":"Already completed own reply","idempotencyKey":"$ownRun:assistant"}]"""
      flow.emit("aborted", eventRunId = ownRun)
      assertEquals(WearReplyOutcome.Aborted, flow.state.replyCompletion?.outcome)
      flow.historyRun = null
      assertEquals(
        true,
        flow
          .appAction("Abort run")
          .config[SemanticsActions.OnClick]
          .action
          ?.invoke(),
      )
      flow.idle()
      assertEquals(listOf<String?>(null), flow.abortRuns)
      assertEquals(WearReplyOutcome.Aborted, flow.state.replyCompletion?.outcome)
      assertEquals("Already completed own reply", speech.lastSpokenText)
    }

  @Test
  @Config(qualifiers = "w400dp-h800dp-mdpi")
  fun repeatedAbortPreservesAnAcceptedSessionWideCancellation() {
    for (targeted in listOf(false, true)) {
      for (secondResult in listOf("no-op", "failed", "confirmed")) {
        for (proofBeforeSecondAck in listOf(false, true)) {
          withFlow { flow ->
            flow.observeApp(autoSpeak = true)
            val engine = checkNotNull(ShadowTextToSpeech.getLastTextToSpeechInstance())
            val speech = shadowOf(engine)
            speech.onInitListener.onInit(TextToSpeech.SUCCESS)
            flow.submitFromApp("Hello")
            val ownRun = flow.runId
            flow.emit("delta", eventRunId = null, text = "Anonymous live")
            engine.speak("Existing speech", TextToSpeech.QUEUE_FLUSH, Bundle(), "existing")
            val firstHistory = CompletableDeferred<Unit>()
            flow.historyGate = firstHistory
            assertEquals(
              true,
              flow
                .appAction("Abort run")
                .config[SemanticsActions.OnClick]
                .action
                ?.invoke(),
            )
            flow.idle()
            assertEquals(listOf<String?>(null), flow.abortRuns)
            assertEquals(false, flow.state.replyAbort?.awaitingAck)
            if (targeted) {
              firstHistory.complete(Unit)
              flow.idle()
              flow.historyGate = null
              assertNull(flow.state.streamText)
            }
            val secondAck = CompletableDeferred<Unit>()
            flow.abortGate = secondAck
            flow.abortAccepted = secondResult == "confirmed"
            flow.abortFails = secondResult == "failed"
            assertEquals(
              true,
              flow
                .appAction("Abort run")
                .config[SemanticsActions.OnClick]
                .action
                ?.invoke(),
            )
            flow.idle()
            assertEquals(listOf(null, ownRun.takeIf { targeted }), flow.abortRuns)
            assertEquals(ownRun, flow.state.pendingAbortRunId)
            val partial = """[{"id":"own-partial","role":"assistant","content":"Own partial","idempotencyKey":"$ownRun:assistant"}]"""
            flow.historyGate = null
            if (proofBeforeSecondAck) {
              flow.historyMessages = partial
              flow.historyRun = null
              flow.emit("aborted", eventRunId = ownRun)
              assertEquals("Existing speech", speech.lastSpokenText)
            }
            secondAck.complete(Unit)
            flow.idle()
            if (!proofBeforeSecondAck) {
              flow.historyMessages = partial
              flow.historyRun = null
              flow.emit("aborted", eventRunId = ownRun)
            }
            assertEquals("A later $secondResult must not revoke the accepted cancellation (targeted=$targeted)", WearReplyOutcome.Canceled, flow.state.replyCompletion?.outcome)
            assertNull(flow.state.pendingReply)
            assertEquals("Existing speech", speech.lastSpokenText)
            flow.vm.refresh()
            flow.idle()
            assertEquals(0, speech.spokenTextList.count { it == "Own partial" })
          }
        }
      }
    }
  }

  @Test
  @Config(qualifiers = "w400dp-h800dp-mdpi")
  fun abortedTerminalMessageSurvivesAnImmediatePrePersistenceHistory() {
    for (mode in listOf("remote", "no-op", "failed", "confirmed")) {
      withFlow { flow ->
        flow.observeApp(autoSpeak = true)
        val engine = checkNotNull(ShadowTextToSpeech.getLastTextToSpeechInstance())
        val speech = shadowOf(engine)
        speech.onInitListener.onInit(TextToSpeech.SUCCESS)
        flow.submitFromApp("Hello")
        val ownRun = flow.runId
        engine.speak("Existing speech", TextToSpeech.QUEUE_FLUSH, Bundle(), "existing")
        flow.emit(
          "aborted",
          eventRunId = "foreign-run",
          message =
            buildJsonObject {
              put("id", "foreign-event")
              put("role", "assistant")
              put("content", "Foreign partial")
            },
        )
        assertEquals("Existing speech", speech.lastSpokenText)
        if (mode != "remote") {
          flow.abortGate = CompletableDeferred()
          flow.abortAccepted = mode == "confirmed"
          flow.abortFails = mode == "failed"
          assertEquals(
            true,
            flow
              .appAction("Abort run")
              .config[SemanticsActions.OnClick]
              .action
              ?.invoke(),
          )
          flow.idle()
          assertTrue(speech.isStopped)
        }
        val historiesBeforeTerminal = flow.historyRequests
        assertEquals("The first reload precedes persistence", "[]", flow.historyMessages)
        flow.emit(
          "aborted",
          eventRunId = ownRun,
          message =
            buildJsonObject {
              put("id", "own-event")
              put("role", "assistant")
              put("content", "Own partial")
            },
        )
        assertEquals(historiesBeforeTerminal + 1, flow.historyRequests)
        assertTrue("The terminal-carried partial must survive the empty accepted history", flow.state.messages.any { it.text == "Own partial" })
        if (mode != "remote") {
          assertEquals("Existing speech", speech.lastSpokenText)
          // Persistence finishes before the Abort RPC response, without another chat event.
          flow.historyMessages = """[{"id":"own-persisted","role":"assistant","content":"Own partial","idempotencyKey":"$ownRun:assistant"}]"""
          flow.abortGate?.complete(Unit)
          flow.idle()
        }
        assertNull(flow.state.pendingReply)
        assertEquals(if (mode == "confirmed") WearReplyOutcome.Canceled else WearReplyOutcome.Aborted, flow.state.replyCompletion?.outcome)
        assertEquals(if (mode == "confirmed") "Existing speech" else "Own partial", speech.lastSpokenText)
        flow.historyMessages = """[{"id":"own-persisted","role":"assistant","content":"Own partial","idempotencyKey":"$ownRun:assistant"}]"""
        flow.vm.refresh()
        flow.idle()
        assertEquals(if (mode == "confirmed") 0 else 1, speech.spokenTextList.count { it == "Own partial" })
        assertEquals(0, speech.spokenTextList.count { it == "Foreign partial" })
      }
    }
  }

  private class Flow {
    private val app = RuntimeEnvironment.getApplication() as WearApplication
    private val owner =
      object : ViewModelStoreOwner {
        override val viewModelStore = ViewModelStore()
      }
    private val clientField = WearApplication::class.java.getDeclaredField("proxyClient\$delegate").apply { isAccessible = true }
    private val repositoryField = WearApplication::class.java.getDeclaredField("gatewayRepository\$delegate").apply { isAccessible = true }
    private val previousClient = clientField.get(app)
    private val previousRepository = repositoryField.get(app)
    private var sequence = 0L
    var runId = "stream-run"
    var historyRequests = 0
    var sendRequests = 0
    var sendFails = false
    var sendErrorCode = "internal_error"
    var sendAck: JsonObject? = null
    var gatewayConnected = true
    var statusFails = false
    var historyErrorCode = "internal_error"
    var abortFails = false
    var abortAccepted = true
    var abortGate: CompletableDeferred<Unit>? = null
    var sessionList = """[{"key":"agent:main:proof","displayName":"Test chat","hasActiveRun":false}]"""
    val sentRunIds = mutableListOf<String>()
    val sentMessages = mutableListOf<String>()
    var historyMessages = "[]"
    var historyRun: JsonObject? = null
    var historyGate: CompletableDeferred<Unit>? = null
    var historyFails = false
    var sendGate: CompletableDeferred<Unit>? = null
    val completedReplies = mutableListOf<WearChatMessage?>()
    val abortRuns = mutableListOf<String?>()
    private var replyObserver: ActivityController<ComponentActivity>? = null
    private val client =
      WearProxyClient.createForTests(
        nodeResolver = WearNodeResolver { "phone-a" },
        transport = WearMessageTransport { _, _, bytes -> respond(bytes) },
      )
    val vm: WearViewModel
    val state: WearUiState get() = vm.state.value

    init {
      clientField.set(app, lazyOf(client))
      repositoryField.set(app, lazyOf(WearGatewayRepository(client)))
      vm = ViewModelProvider(owner, ViewModelProvider.AndroidViewModelFactory(app))[WearViewModel::class.java]
      idle()
      assertTrue(state.connected)
    }

    fun send() {
      vm.sendReply("Hello")
      idle()
    }

    fun idle() = shadowOf(Looper.getMainLooper()).idle()

    fun observeReplyCompletion() {
      val sessionKey = state.selectedSession?.key
      val expectedRunId = state.pendingReply?.runId ?: state.replyTerminal?.runId
      val controller = Robolectric.buildActivity(ComponentActivity::class.java).setup()
      replyObserver = controller
      controller.get().setContent {
        val current by vm.state.collectAsState()
        var awaiting by remember { mutableStateOf(true) }
        WearReplyCompletionEffect(
          state = current,
          snapshot = current.toConversationSnapshot(),
          awaitingReply = awaiting,
          awaitingReplySessionId = sessionKey,
          expectedAssistantKey = null,
          awaitingReplyRunId = expectedRunId,
        ) { reply ->
          completedReplies += reply
          awaiting = false
        }
      }
      idle()
    }

    fun observeApp(autoSpeak: Boolean = false) {
      val controller = Robolectric.buildActivity(ComponentActivity::class.java).setup().visible()
      replyObserver = controller
      val speaker = WearReplySpeaker(app)
      val settings = WearSettingsStore(app)
      settings.writeAutoSpeak(autoSpeak)
      controller.get().setContent {
        OpenClawWearApp(vm, settings, speaker)
      }
      idle()
    }

    fun submitFromApp(text: String) {
      assertEquals(true, appAction("Type").config[SemanticsActions.OnClick].action?.invoke())
      val activity = checkNotNull(replyObserver).get()
      val launch = checkNotNull(shadowOf(activity).nextStartedActivityForResult)
      val result = Intent()
      RemoteInput.addResultsToIntent(
        arrayOf(RemoteInput.Builder(REPLY_RESULT_KEY).setLabel("Message").build()),
        result,
        Bundle().apply { putCharSequence(REPLY_RESULT_KEY, text) },
      )
      shadowOf(activity).receiveResult(launch.intent, Activity.RESULT_OK, result)
      idle()
    }

    fun appAction(label: String): SemanticsNode {
      idle()

      fun roots(view: View): List<ViewRootForTest> =
        when (view) {
          is ViewRootForTest -> listOf(view)
          is ViewGroup -> (0 until view.childCount).flatMap { roots(view.getChildAt(it)) }
          else -> emptyList()
        }

      fun nodes(node: SemanticsNode): List<SemanticsNode> = listOf(node) + node.children.flatMap(::nodes)
      val nodes =
        roots(checkNotNull(replyObserver).get().window.decorView).flatMap { root ->
          root.measureAndLayoutForTest()
          nodes(root.semanticsOwner.rootSemanticsNode)
        }
      return checkNotNull(
        nodes.firstOrNull { node ->
          SemanticsActions.OnClick in node.config &&
            node.config.getOrNull(SemanticsProperties.Text)?.any { it.text == label } == true
        },
      ) { "Missing action $label; rendered semantics: ${nodes.map { it.config }}" }
    }

    fun transcript(
      activeRunId: String? = null,
      text: String? = null,
    ) = WearTranscript(
      sessionKey = "agent:main:proof",
      messages = emptyList(),
      activeRunId = activeRunId,
      activeText = text,
      selectedModelRef = "openai/gpt-4o",
      eventSequence = sequence,
      phoneNodeId = "phone-a",
      eventStreamId = "epoch-a",
    )

    private suspend fun respond(bytes: ByteArray) {
      val request = (WearProtocolCodec.decode(bytes) as WearDecodeResult.Success).message as WearMessage.Request
      val responseSequence = sequence
      val historyError = request.method == WearRpcMethod.ChatHistory && historyFails
      val sendError = WearRpcError(sendErrorCode, "Send result unavailable").takeIf { request.method == WearRpcMethod.ChatSend && sendFails }
      val failed = historyError || sendError != null || (request.method == WearRpcMethod.ChatAbort && abortFails) || (request.method == WearRpcMethod.ProxyStatus && statusFails)
      val result =
        when (request.method) {
          WearRpcMethod.ProxyStatus -> {
            Json.parseToJsonElement("""{"connected":$gatewayConnected,"activeAgentId":"main","activeSessionKey":"agent:main:proof"}""")
          }

          WearRpcMethod.SessionsList -> {
            Json.parseToJsonElement("""{"sessions":$sessionList}""")
          }

          WearRpcMethod.ChatHistory -> {
            historyRequests += 1
            val snapshot =
              buildJsonObject {
                put("sessionKey", request.params.getValue("sessionKey"))
                put("messages", Json.parseToJsonElement(historyMessages))
                historyRun?.let { put("inFlightRun", it) }
              }
            historyGate?.await()
            snapshot
          }

          WearRpcMethod.ChatAbort -> {
            assertEquals(
              "agent:main:proof",
              request.params
                .getValue("sessionKey")
                .jsonPrimitive.content,
            )
            abortRuns += request.params["runId"]?.jsonPrimitive?.content
            val accepted = abortAccepted
            abortGate?.await()
            buildJsonObject { put("aborted", accepted) }
          }

          WearRpcMethod.ChatSend -> {
            sendRequests += 1
            val requestedRunId =
              request.params
                .getValue("idempotencyKey")
                .jsonPrimitive.content
            runId = requestedRunId
            sentRunIds += requestedRunId
            sentMessages +=
              request.params
                .getValue("message")
                .jsonPrimitive.content
            val ack =
              sendAck ?: buildJsonObject {
                put("runId", requestedRunId)
                put("status", "started")
              }
            sendGate?.await()
            ack
          }

          else -> {
            error("Unexpected " + request.method)
          }
        }
      client.handleMessage(
        "phone-a",
        WearProtocol.RESPONSE_PATH,
        WearProtocolCodec.encode(
          WearMessage.Response(
            requestId = request.requestId,
            ok = !failed,
            result = result.takeUnless { failed },
            error = sendError ?: WearRpcError(if (historyError) historyErrorCode else "internal_error", "Request unavailable").takeIf { failed },
            eventStreamId = "epoch-a",
            eventSequence = responseSequence,
          ),
        ),
      )
    }

    fun connection(connected: Boolean) {
      sequence += 1
      runBlocking {
        client.handleMessage(
          "phone-a",
          WearProtocol.EVENT_PATH,
          WearProtocolCodec.encode(
            WearMessage.Event(
              sequence = sequence,
              event = WearEventType.Connection,
              payload = buildJsonObject { put("connected", connected) },
              streamId = "epoch-a",
            ),
          ),
        )
      }
      idle()
    }

    fun emit(
      state: String,
      eventRunId: String? = runId,
      text: String? = null,
      complete: Boolean = true,
      message: JsonObject? = null,
      eventSequence: Long = sequence + 1,
      eventStreamId: String = "epoch-a",
      sourceNodeId: String = "phone-a",
      sessionKey: String = "agent:main:proof",
    ) {
      sequence = maxOf(sequence, eventSequence)
      val payload: JsonObject =
        buildJsonObject {
          put("sessionKey", sessionKey)
          eventRunId?.let { put("runId", it) }
          put("state", state)
          message?.let { put("message", it) }
          text?.let {
            put("streamText", it)
            put("streamTextComplete", complete)
          }
        }
      runBlocking {
        client.handleMessage(
          sourceNodeId,
          WearProtocol.EVENT_PATH,
          WearProtocolCodec.encode(
            WearMessage.Event(sequence = eventSequence, event = WearEventType.Chat, payload = payload, streamId = eventStreamId),
          ),
        )
      }
      idle()
    }

    fun close() {
      replyObserver?.pause()?.stop()?.destroy()
      owner.viewModelStore.clear()
      idle()
      clientField.set(app, previousClient)
      repositoryField.set(app, previousRepository)
    }
  }
}
