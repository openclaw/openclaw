package ai.openclaw.wear

import ai.openclaw.app.gateway.GatewayEndpoint
import android.content.Context
import android.content.SharedPreferences
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.joinAll
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestCoroutineScheduler
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.yield
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.lang.management.ManagementFactory
import java.util.Base64
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class WearDirectRuntimeTest {
  @Test
  fun certificatePersistenceCannotFollowCompletedIntentRetirement() = verifyCertificateRetirement(concurrent = true)

  @Test
  fun certificateAcceptanceAfterRetirementCannotMutatePin() = verifyCertificateRetirement(concurrent = false)

  private fun verifyCertificateRetirement(concurrent: Boolean) =
    runBlocking {
      val context = RuntimeEnvironment.getApplication()
      val backing = context.getSharedPreferences("pin-retirement-${UUID.randomUUID()}", Context.MODE_PRIVATE)
      val endpoint = GatewayEndpoint.manual("gateway.example", 443, true)
      val pinKey = "gateway.tls.${endpoint.stableId}"
      val oldPin = "a".repeat(64)
      val acceptedPin = "b".repeat(64)
      val gateArmed = AtomicBoolean(false)
      val pinRead = CountDownLatch(1)
      val releasePin = CountDownLatch(1)
      val retired = CountDownLatch(1)
      val acceptanceThread = AtomicReference<Thread>()
      val pinMutated = AtomicBoolean(false)
      val mutatedAfterRetirement = AtomicBoolean(false)
      val prefs =
        object : SharedPreferences by backing {
          override fun getString(
            key: String?,
            defValue: String?,
          ): String? {
            if (key == pinKey && gateArmed.compareAndSet(true, false)) {
              acceptanceThread.set(Thread.currentThread())
              pinRead.countDown()
              check(releasePin.await(8, TimeUnit.SECONDS)) { "Pin persistence gate timed out" }
            }
            return backing.getString(key, defValue)
          }

          override fun edit(): SharedPreferences.Editor {
            val edit = backing.edit()
            return object : SharedPreferences.Editor by edit {
              override fun putString(
                key: String?,
                value: String?,
              ): SharedPreferences.Editor {
                if (key == pinKey && value == acceptedPin) {
                  pinMutated.set(true)
                  if (retired.count == 0L) mutatedAfterRetirement.set(true)
                }
                edit.putString(key, value)
                return this
              }
            }
          }
        }
      val store = WearGatewayStore(prefs)
      store.replace(WearGatewaySetup(endpoint, "watch-bootstrap"), "watch-device")
      assertTrue(store.putStringSynchronously(pinKey, oldPin))
      val job = SupervisorJob()
      val scope = CoroutineScope(job + Dispatchers.Default)
      val runtime = WearDirectRuntime(context, scope, store)
      val generation =
        runtime.javaClass.getDeclaredField("generation").run {
          isAccessible = true
          getLong(runtime)
        }
      val prompt = WearTrustPrompt(generation, acceptedPin, oldPin)

      // This stages the persistence owner's prompt, not a TLS handshake or certificate proof.
      @Suppress("UNCHECKED_CAST")
      val mutableState =
        runtime.javaClass.getDeclaredField("mutableState").run {
          isAccessible = true
          get(runtime) as MutableStateFlow<WearDirectState>
        }
      mutableState.value = mutableState.value.copy(trust = prompt)
      val monitor =
        runtime.javaClass.getDeclaredField("lock").run {
          isAccessible = true
          get(runtime)
        }
      var retiringThread: Thread? = null
      try {
        if (concurrent) {
          gateArmed.set(true)
          runtime.acceptCertificate(prompt)
          assertTrue("Acceptance did not reach the pin read", pinRead.await(8, TimeUnit.SECONDS))
          val retiring =
            thread(name = "wear-intent-retirement", isDaemon = true) {
              runtime.disconnect()
              retired.countDown()
            }
          retiringThread = retiring
          val threads = ManagementFactory.getThreadMXBean()
          withTimeout(8000) {
            while (retired.count != 0L) {
              val info = threads.getThreadInfo(retiring.threadId())
              if (info != null && info.threadState == Thread.State.BLOCKED &&
                info.lockInfo?.identityHashCode == System.identityHashCode(monitor) &&
                info.lockOwnerId == acceptanceThread.get().threadId()
              ) {
                break
              }
              yield()
            }
          }
          releasePin.countDown()
          assertTrue("Retirement did not finish", retired.await(8, TimeUnit.SECONDS))
        } else {
          runtime.disconnect()
          retired.countDown()
          runtime.acceptCertificate(prompt)
        }
        withTimeout(8000) { job.children.toList().joinAll() }
        assertEquals(concurrent, pinMutated.get())
        assertEquals(if (concurrent) acceptedPin else oldPin, backing.getString(pinKey, null))
        assertFalse("Certificate pin mutated after the intent retired", mutatedAfterRetirement.get())
      } finally {
        releasePin.countDown()
        retiringThread?.join(8000)
        withTimeout(8000) { job.cancelAndJoin() }
        assertFalse("Retirement thread leaked", retiringThread?.isAlive == true)
      }
    }

  @Test
  fun firstSetupFailureRemainsVisibleUntilExplicitCancellation() =
    runBlocking {
      val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
      val runtime = runtime(scope)
      try {
        assertTrue(runtime.isPhoneProxySelected())
        runtime.setup("not-a-setup-code")
        assertEquals(null, runtime.state.value.selected)
        assertTrue(runtime.state.value.connectionManagementRequired)
        assertTrue(runtime.state.value.error != null)
        assertFalse(runtime.isPhoneProxySelected())
        runtime.cancelSetup()
        withTimeout(8000) { runtime.state.first { !it.busy && !it.connectionManagementRequired } }
        assertTrue(runtime.isPhoneProxySelected())
      } finally {
        scope.cancel()
      }
    }

  @Test
  fun bootstrapConnectsWithoutPhoneAndLoadsCanonicalSessionApprovalUnion() =
    runBlocking {
      val gateway = Gateway()
      val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
      val runtime = runtime(scope)
      try {
        runtime.setVisible(true)
        runtime.setup(gateway.setupCode())
        val state = withTimeout(8000) { runtime.state.first { it.connected && it.approvalsReady } }
        assertEquals(setOf("exec", "plugin", "system-agent"), state.approvals.map { it.kind }.toSet())
        val node = withTimeout(8000) { gateway.connects.receive() }
        val operator = withTimeout(8000) { gateway.connects.receive() }
        assertEquals("node", node.text("role"))
        assertTrue((node["scopes"] as? JsonArray).isNullOrEmpty())
        assertEquals("operator", operator.text("role"))
        assertEquals(wearOperatorScopePolicy.requestedScopes, (operator["scopes"] as JsonArray).map { it.toString().trim('"') }.toSet())
        assertFalse(runtime.isPhoneProxySelected())
        assertEquals("agent:main:main", state.sessionKey)
      } finally {
        runtime.disconnect()
        runtime.setVisible(false)
        scope.cancel()
        gateway.server.shutdown()
      }
    }

  @Test
  fun inputCallbackBeforeReconnectReadyRetainsOneUnsentAttemptUntilExplicitRetry() = verifyInputCallbackBeforeReady(restartBeforeCallback = false)

  @Test
  fun inputCallbackDuringOperatorHelloRetainsOneUnsentAttemptUntilExplicitRetry() = verifyInputCallbackBeforeReady(restartBeforeCallback = true)

  private fun verifyInputCallbackBeforeReady(restartBeforeCallback: Boolean) =
    runBlocking {
      val gateway = Gateway()
      val job = SupervisorJob()
      val scope = CoroutineScope(job + Dispatchers.Default)
      val runtime = runtime(scope)
      var releaseHello: (() -> Unit)? = null
      try {
        runtime.setVisible(true)
        runtime.setup(gateway.setupCode())
        withTimeout(8000) { runtime.state.first { it.connected && it.approvalsReady } }
        val input = runtime.inputOwner()
        runtime.setVisible(false)
        withTimeout(8000) { runtime.state.first { !it.busy } }

        gateway.holdOperatorHello = true
        if (restartBeforeCallback) {
          runtime.setVisible(true)
          releaseHello = withTimeout(8000) { gateway.operatorHellos.receive() }
        }
        assertEquals(null, runtime.state.value.pendingSend)
        runtime.send("A returned dictation", input)
        val pending = runtime.state.value.pendingSend
        assertNotNull("Input returned before reconnect readiness must remain pending", pending)
        assertEquals("A returned dictation", pending?.message)
        assertEquals("agent:main:main", pending?.sessionKey)
        assertFalse(runtime.state.value.connected)
        assertFalse(runtime.state.value.sending)
        assertFalse(runtime.state.value.sendUnknown)
        assertTrue(gateway.sends.tryReceive().isFailure)
        runtime.send("Do not replace the returned dictation", input)
        assertEquals(pending, runtime.state.value.pendingSend)

        if (!restartBeforeCallback) {
          runtime.setVisible(true)
          releaseHello = withTimeout(8000) { gateway.operatorHellos.receive() }
        }
        runtime.refresh()
        runtime.retrySend()
        runtime.send("Do not replace while connecting", runtime.inputOwner())
        assertFalse(runtime.state.value.connected)
        assertFalse(runtime.state.value.sending)
        assertFalse(runtime.state.value.sendUnknown)
        assertEquals(pending, runtime.state.value.pendingSend)
        assertTrue(gateway.sends.tryReceive().isFailure)

        gateway.historyMessage = "History after reconnect"
        gateway.holdOperatorHello = false
        checkNotNull(releaseHello).invoke()
        releaseHello = null
        withTimeout(8000) {
          runtime.state.first {
            it.connected && it.approvalsReady && it.messages.singleOrNull()?.text == "History after reconnect"
          }
        }
        runtime.send("Do not replace after reconnect", runtime.inputOwner())
        assertEquals(pending, runtime.state.value.pendingSend)
        gateway.historyMessage = "Explicit history refresh"
        runtime.refresh()
        withTimeout(8000) { runtime.state.first { it.messages.singleOrNull()?.text == "Explicit history refresh" } }
        assertFalse(runtime.state.value.sending)
        assertFalse(runtime.state.value.sendUnknown)
        assertEquals(pending, runtime.state.value.pendingSend)
        assertTrue("Reconnect and refresh must not send retained input", gateway.sends.tryReceive().isFailure)

        runtime.retrySend()
        val sent = withTimeout(8000) { gateway.sends.receive() }
        assertEquals(pending?.key, sent.text("idempotencyKey"))
        assertEquals(pending?.message, sent.text("message"))
        assertEquals(pending?.sessionKey, sent.text("sessionKey"))
        assertEquals(false, sent.flag("deliver"))
        withTimeout(8000) { runtime.state.first { !it.sending && it.pendingSend == null } }
        runtime.retrySend()
        gateway.historyMessage = "History after retry"
        runtime.refresh()
        withTimeout(8000) { runtime.state.first { it.messages.singleOrNull()?.text == "History after retry" } }
        assertFalse(runtime.state.value.sendUnknown)
        assertTrue("The retained attempt must be sent only once", gateway.sends.tryReceive().isFailure)
      } finally {
        releaseHello?.invoke()
        runtime.disconnect()
        runtime.setVisible(false)
        withTimeout(8000) { job.cancelAndJoin() }
        gateway.server.shutdown()
      }
    }

  @Test
  fun inputCallbackFromRetiredSelectionCannotCreatePendingSend() =
    runBlocking {
      val gateway = Gateway()
      val job = SupervisorJob()
      val scope = CoroutineScope(job + Dispatchers.Default)
      val runtime = runtime(scope)
      try {
        runtime.setVisible(true)
        runtime.setup(gateway.setupCode())
        withTimeout(8000) { runtime.state.first { it.connected && it.approvalsReady } }
        val input = runtime.inputOwner()
        runtime.setVisible(false)
        runtime.disconnect()
        withTimeout(8000) { runtime.state.first { !it.busy } }
        runtime.send("Retired input while paused", input)
        assertEquals(null, runtime.state.value.pendingSend)
        assertFalse(runtime.state.value.sending)
        assertFalse(runtime.state.value.sendUnknown)
        assertTrue(gateway.sends.tryReceive().isFailure)

        runtime.setVisible(true)
        runtime.reconnect()
        withTimeout(8000) { runtime.state.first { it.connected && it.approvalsReady } }
        runtime.send("Retired input after reconnect", input)
        assertEquals(null, runtime.state.value.pendingSend)
        assertTrue(gateway.sends.tryReceive().isFailure)
        runtime.send("Current input", runtime.inputOwner())
        val sent = withTimeout(8000) { gateway.sends.receive() }
        assertEquals("Current input", sent.text("message"))
        withTimeout(8000) { runtime.state.first { !it.sending && it.pendingSend == null } }
        assertTrue(gateway.sends.tryReceive().isFailure)
      } finally {
        runtime.disconnect()
        runtime.setVisible(false)
        withTimeout(8000) { job.cancelAndJoin() }
        gateway.server.shutdown()
      }
    }

  @Test
  fun discardBeforeReadinessNeverSendsAndStaleDiscardPreservesReplacement() =
    runBlocking {
      val gateway = Gateway()
      val job = SupervisorJob()
      val scope = CoroutineScope(job + Dispatchers.Default)
      val runtime = runtime(scope)
      var releaseHello: (() -> Unit)? = null
      try {
        runtime.setVisible(true)
        runtime.setup(gateway.setupCode())
        withTimeout(8000) { runtime.state.first { it.connected && it.approvalsReady } }
        val input = runtime.inputOwner()
        runtime.setVisible(false)
        withTimeout(8000) { runtime.state.first { !it.busy } }
        runtime.send("Discard while paused", input)
        val first = checkNotNull(runtime.state.value.pendingSend)
        runtime.discardPendingSend(first)
        assertEquals(null, runtime.state.value.pendingSend)
        runtime.send("A replacement message", input)
        val replacement = checkNotNull(runtime.state.value.pendingSend)
        assertFalse(first.key == replacement.key)
        runtime.discardPendingSend(first)
        assertEquals(replacement, runtime.state.value.pendingSend)

        gateway.holdOperatorHello = true
        runtime.setVisible(true)
        releaseHello = withTimeout(8000) { gateway.operatorHellos.receive() }
        runtime.discardPendingSend(replacement)
        assertEquals(null, runtime.state.value.pendingSend)
        assertFalse(runtime.state.value.sending)
        assertFalse(runtime.state.value.sendUnknown)
        runtime.retrySend()
        gateway.historyMessage = "History after discard"
        gateway.holdOperatorHello = false
        releaseHello.invoke()
        releaseHello = null
        withTimeout(8000) {
          runtime.state.first {
            it.connected && it.approvalsReady && it.messages.singleOrNull()?.text == "History after discard"
          }
        }
        runtime.retrySend()
        gateway.historyMessage = "Refresh after discard"
        runtime.refresh()
        withTimeout(8000) { runtime.state.first { it.messages.singleOrNull()?.text == "Refresh after discard" } }
        assertEquals(null, runtime.state.value.pendingSend)
        assertTrue("Discarded input must never be sent", gateway.sends.tryReceive().isFailure)
      } finally {
        releaseHello?.invoke()
        runtime.disconnect()
        runtime.setVisible(false)
        withTimeout(8000) { job.cancelAndJoin() }
        gateway.server.shutdown()
      }
    }

  @Test
  fun discardDefinitivelyRejectedMessagePreservesErrorAndAllowsNewInput() =
    runBlocking {
      val gateway = Gateway()
      gateway.rejectSend = true
      val job = SupervisorJob()
      val scope = CoroutineScope(job + Dispatchers.Default)
      val runtime = runtime(scope)
      try {
        runtime.setVisible(true)
        runtime.setup(gateway.setupCode())
        withTimeout(8000) { runtime.state.first { it.connected && it.approvalsReady } }
        runtime.send("Rejected message", runtime.inputOwner())
        val rejected = withTimeout(8000) { gateway.sends.receive() }
        val state = withTimeout(8000) { runtime.state.first { it.pendingSend != null && !it.sending } }
        assertFalse(state.sendUnknown)
        assertNotNull(state.error)
        runtime.discardPendingSend(checkNotNull(state.pendingSend))
        assertEquals(null, runtime.state.value.pendingSend)
        assertEquals(state.error, runtime.state.value.error)
        assertTrue(runtime.state.value.connected)

        gateway.rejectSend = false
        runtime.send("New input after rejection", runtime.inputOwner())
        val sent = withTimeout(8000) { gateway.sends.receive() }
        assertEquals("New input after rejection", sent.text("message"))
        assertFalse(rejected.text("idempotencyKey") == sent.text("idempotencyKey"))
        withTimeout(8000) { runtime.state.first { !it.sending && it.pendingSend == null } }
        assertTrue(gateway.sends.tryReceive().isFailure)
      } finally {
        runtime.disconnect()
        runtime.setVisible(false)
        withTimeout(8000) { job.cancelAndJoin() }
        gateway.server.shutdown()
      }
    }

  @Test
  fun lostChatAcknowledgementRequiresExplicitRetryWithTheSameAttemptKey() = verifyLostAcknowledgement(peerClosed = false)

  @Test
  fun peerClosedChatAcknowledgementRequiresExplicitRetryWithTheSameAttemptKey() = verifyLostAcknowledgement(peerClosed = true)

  private fun verifyLostAcknowledgement(peerClosed: Boolean) =
    runBlocking {
      val gateway = Gateway()
      gateway.answerSend = false
      val job = SupervisorJob()
      val scope = CoroutineScope(job + Dispatchers.Default)
      val runtime = runtime(scope)
      var releaseHello: (() -> Unit)? = null
      try {
        runtime.setVisible(true)
        runtime.setup(gateway.setupCode())
        withTimeout(8000) { runtime.state.first { it.connected && it.approvalsReady } }
        runtime.send("A watch message", runtime.inputOwner())
        val sent = withTimeout(8000) { gateway.sends.receive() }
        assertEquals(false, sent.flag("deliver"))
        val pending = checkNotNull(runtime.state.value.pendingSend)
        runtime.send("Do not replace an in-flight message", runtime.inputOwner())
        runtime.retrySend()
        runtime.discardPendingSend(pending)
        assertEquals(pending, runtime.state.value.pendingSend)
        if (peerClosed) {
          gateway.holdOperatorHello = true
          val socket = withTimeout(8000) { gateway.operatorSockets.receive() }
          assertTrue(socket.close(1000, "Fixture peer disconnected"))
          releaseHello = withTimeout(8000) { gateway.operatorHellos.receive() }
        } else {
          runtime.disconnect()
          withTimeout(8000) { runtime.state.first { !it.busy } }
        }
        assertFalse(runtime.state.value.connected)
        assertFalse(runtime.state.value.sending)
        assertTrue(runtime.state.value.sendUnknown)
        runtime.discardPendingSend(pending)
        assertEquals(pending, runtime.state.value.pendingSend)
        assertTrue(runtime.state.value.sendUnknown)
        gateway.answerSend = true
        if (peerClosed) {
          gateway.holdOperatorHello = false
          checkNotNull(releaseHello).invoke()
          releaseHello = null
        } else {
          runtime.reconnect()
        }
        withTimeout(8000) { runtime.state.first { it.connected && it.approvalsReady } }
        runtime.send("Do not replace an unconfirmed message", runtime.inputOwner())
        assertEquals(pending, runtime.state.value.pendingSend)
        assertTrue(gateway.sends.tryReceive().isFailure)
        runtime.retrySend()
        val retried = withTimeout(8000) { gateway.sends.receive() }
        assertEquals(sent.text("idempotencyKey"), retried.text("idempotencyKey"))
        withTimeout(8000) { runtime.state.first { !it.sending && it.pendingSend == null } }
        assertFalse(runtime.state.value.sendUnknown)
      } finally {
        releaseHello?.invoke()
        runtime.disconnect()
        runtime.setVisible(false)
        withTimeout(8000) { job.cancelAndJoin() }
        gateway.server.shutdown()
      }
    }

  @Test
  fun historyRestoresRegularAndEmbeddedRunsAndClearsAbsentRunWithoutActiveIdFallback() =
    conversationTest {
      for ((run, text) in listOf("regular-run" to "x".repeat(5000), "embedded-run" to "")) {
        val historyWork = operation(runtime::refresh)
        next(gateway.histories).reply(history("Recovered $run", run, text, sessionAbortable = run == "embedded-run"))
        finish(historyWork)
        assertEquals(run, runtime.state.value.runId)
        assertEquals(text.take(4000), runtime.state.value.streamText)
        assertEquals(
          "Recovered $run",
          runtime.state.value.messages
            .single()
            .text,
        )
        assertEquals(null, runtime.state.value.pendingSend)
        assertFalse(runtime.state.value.sending)
        assertFalse(runtime.state.value.sendUnknown)

        val stopWork = operation(runtime::abort)
        val stop = next(gateway.stops)
        assertEquals("sessions.abort", stop.frame.text("method"))
        assertEquals(
          buildJsonObject {
            put("key", "agent:main:main")
            put("runId", run)
          },
          stop.params,
        )
        stop.reply(
          buildJsonObject {
            put("ok", true)
            put("abortedRunId", run)
            put("status", "aborted")
          },
        )
        next(gateway.histories).reply(
          buildJsonObject {
            put("messages", JsonArray(emptyList()))
            put("sessionInfo", buildJsonObject { put("activeRunIds", JsonArray(listOf(Json.parseToJsonElement("\"not-an-in-flight-snapshot\"")))) })
          },
        )
        finish(stopWork)
        assertEquals(null, runtime.state.value.runId)
        assertEquals(null, runtime.state.value.streamText)
        assertTrue(
          runtime.state.value.messages
            .isEmpty(),
        )
      }
    }

  @Test
  fun newerHistoryOwnsSnapshotWhenOlderHistoryCompletesLast() =
    conversationTest {
      val oldWork = operation(runtime::refresh)
      val old = next(gateway.histories)
      val newWork = operation(runtime::refresh)
      next(gateway.histories).reply(history("New history", "new-run", "New stream"))
      finish(newWork)
      old.reply(history("Stale history", "old-run", "Old stream"))
      finish(oldWork)
      assertEquals(
        "New history",
        runtime.state.value.messages
          .single()
          .text,
      )
      assertEquals("new-run", runtime.state.value.runId)
      assertEquals("New stream", runtime.state.value.streamText)
    }

  @Test
  fun liveChatAndSessionMessageEventsFenceOlderHistory() =
    conversationTest {
      val oldWork = operation(runtime::refresh)
      val old = next(gateway.histories)
      gateway.chat("live-run", "Live text")
      await { runtime.state.value.takeIf { it.streamText == "Live text" } }
      old.reply(history("Stale before chat", "old-run", "Old text"))
      finish(oldWork)
      assertEquals(
        "Initial history",
        runtime.state.value.messages
          .single()
          .text,
      )
      assertEquals("live-run", runtime.state.value.runId)
      assertEquals("Live text", runtime.state.value.streamText)

      val beforeMessageWork = operation(runtime::refresh)
      val beforeMessage = next(gateway.histories)
      gateway.event("session.message", buildJsonObject { put("sessionKey", "agent:main:main") })
      val messageHistory = next(gateway.histories)
      beforeMessage.reply(history("Stale before session message"))
      finish(beforeMessageWork)
      assertEquals(
        "Initial history",
        runtime.state.value.messages
          .single()
          .text,
      )
      messageHistory.reply(history("Session message history", "live-run", "Live text"))
      await { runtime.state.value.takeIf { it.messages.singleOrNull()?.text == "Session message history" } }
      assertEquals("live-run", runtime.state.value.runId)

      val beforeTerminalWork = operation(runtime::refresh)
      val beforeTerminal = next(gateway.histories)
      gateway.chat("live-run", "Final text", state = "final")
      val terminalHistory = next(gateway.histories)
      beforeTerminal.reply(history("Stale before terminal", "live-run", "Old stream"))
      finish(beforeTerminalWork)
      assertEquals(
        "Final text",
        runtime.state.value.messages
          .last()
          .text,
      )
      assertEquals(null, runtime.state.value.runId)
      assertEquals(null, runtime.state.value.streamText)
      terminalHistory.reply(history("Persisted final text"))
      await { runtime.state.value.takeIf { it.messages.singleOrNull()?.text == "Persisted final text" } }
      assertEquals(null, runtime.state.value.runId)
    }

  @Test
  fun sendAdmissionFencesOlderHistoryWithoutChangingPendingAttempt() = verifySendFencesHistory(historyAfterSend = false)

  @Test
  fun sendAcknowledgementFencesHistoryAdmittedDuringSend() = verifySendFencesHistory(historyAfterSend = true)

  @Test
  fun wireAcknowledgementBeforeFinalCannotResurrectCompletedRun() = verifyTerminalAcknowledgement("final", ackFirst = true)

  @Test
  fun wireAcknowledgementBeforeAbortedCannotResurrectCompletedRun() = verifyTerminalAcknowledgement("aborted", ackFirst = true)

  @Test
  fun wireAcknowledgementBeforeErrorCannotResurrectCompletedRun() = verifyTerminalAcknowledgement("error", ackFirst = true)

  @Test
  fun terminalHistoryAlreadyPendingSurvivesDelayedAcknowledgement() = verifyTerminalAcknowledgement("final", ackFirst = false)

  private fun verifyTerminalAcknowledgement(
    terminal: String,
    ackFirst: Boolean,
  ) = conversationTest {
    val (sendWork, send) = beginSend()
    val run = checkNotNull(send.params.text("idempotencyKey"))
    if (ackFirst) send.acknowledge("started")
    // Same-socket wire order completes the ACK deferred, but its consumer remains paused.
    gateway.chat(run, "Terminal $terminal", state = terminal)
    await(runTasks = false) { runtime.state.value.takeIf { it.messages.lastOrNull()?.text == "Terminal $terminal" } }
    assertTrue(runtime.state.value.sending)
    val pendingHistory = if (ackFirst) null else next(gateway.histories)
    if (!ackFirst) send.acknowledge("started")
    finish(sendWork)
    assertSettledSend()
    assertEquals("A delayed ACK must not restore a $terminal run", null, runtime.state.value.runId)
    assertEquals(null, runtime.state.value.streamText)
    (pendingHistory ?: next(gateway.histories)).reply(history("Persisted $terminal"))
    await { runtime.state.value.takeIf { it.messages.singleOrNull()?.text == "Persisted $terminal" } }
    assertEquals(null, runtime.state.value.runId)
    assertTrue("The terminal event owns reconciliation; ACK must not add another load", gateway.histories.tryReceive().isFailure)
  }

  @Test
  fun chatEventsSupersedeAcknowledgementsWithoutReplacingLiveRunOrText() =
    conversationTest {
      for ((status, newerRun) in listOf("started" to false, "in_flight" to true, "ok" to true)) {
        val (sendWork, send) = beginSend()
        val run = if (newerRun) "newer-$status" else checkNotNull(send.params.text("idempotencyKey"))
        send.acknowledge(status)
        gateway.chat(run, "Live $status")
        await(runTasks = false) { runtime.state.value.takeIf { it.streamText == "Live $status" } }
        finish(sendWork)
        assertSettledSend()
        assertEquals("Chat events must retain the live run after $status ACK", run, runtime.state.value.runId)
        assertEquals("Live $status", runtime.state.value.streamText)
        assertEquals(
          "Initial history",
          runtime.state.value.messages
            .single()
            .text,
        )
        assertTrue("Superseded ACK must not request another history", gateway.histories.tryReceive().isFailure)
      }
    }

  @Test
  fun activeAcknowledgementsIgnoreForeignChatAndUnrelatedHistory() =
    conversationTest {
      for ((status, historyApplied) in listOf("started" to false, "in_flight" to true)) {
        val (sendWork, send) = beginSend()
        val refreshWork = operation(runtime::refresh)
        val refresh = next(gateway.histories)
        if (historyApplied) {
          refresh.reply(history("Unrelated refreshed history"))
          finish(refreshWork)
        }
        gateway.chat("foreign-run", "Foreign text", sessionKey = "agent:other:main")
        send.acknowledge(status)
        finish(sendWork)
        assertSettledSend()
        assertEquals(send.params.text("idempotencyKey"), runtime.state.value.runId)
        assertEquals(null, runtime.state.value.streamText)
        if (!historyApplied) {
          refresh.reply(history("Stale refresh", "stale-run", "Stale text"))
          finish(refreshWork)
        }
        assertEquals(send.params.text("idempotencyKey"), runtime.state.value.runId)
        assertEquals(
          if (historyApplied) "Unrelated refreshed history" else "Initial history",
          runtime.state.value.messages
            .single()
            .text,
        )
        assertTrue(gateway.histories.tryReceive().isFailure)
      }
    }

  @Test
  fun okAcknowledgementReconcilesBothActiveDurableClaimAndTerminalHistory() =
    conversationTest {
      for (active in listOf(true, false)) {
        gateway.chat("previous-run", "Previous text")
        await { runtime.state.value.takeIf { it.streamText == "Previous text" } }
        val (sendWork, send) = beginSend()
        send.acknowledge("ok")
        val reconciliation = historyWhileSending(sendWork)
        assertSettledSend()
        val run = if (active) checkNotNull(send.params.text("idempotencyKey")) else null
        reconciliation.reply(history("Canonical accepted history", run, "Recovered stream"))
        finish(sendWork)
        assertEquals(run, runtime.state.value.runId)
        assertEquals(if (active) "Recovered stream" else null, runtime.state.value.streamText)
        assertEquals(
          "Canonical accepted history",
          runtime.state.value.messages
            .single()
            .text,
        )
        assertSettledSend()
        assertTrue(gateway.histories.tryReceive().isFailure)
      }
    }

  @Test
  fun failedAcknowledgementReconciliationDoesNotMakeAcceptedDeliveryUnknown() =
    conversationTest {
      val (sendWork, send) = beginSend()
      send.acknowledge("ok")
      val reconciliation = historyWhileSending(sendWork)
      assertSettledSend()
      reconciliation.reply(
        buildJsonObject {
          put("code", "UNAVAILABLE")
          put("message", "Fixture history unavailable")
        },
        ok = false,
      )
      finish(sendWork)
      assertSettledSend()
      assertNotNull("History failure must remain visible", runtime.state.value.error)
      assertFalse(
        runtime.state.value.error
          .orEmpty()
          .contains("unconfirmed"),
      )
      runtime.retrySend()
      assertTrue("An acknowledged attempt cannot be resent", gateway.sends.tryReceive().isFailure)
    }

  private fun verifySendFencesHistory(historyAfterSend: Boolean) =
    conversationTest {
      gateway.answerSend = false
      val oldWork = if (!historyAfterSend) operation(runtime::refresh) else null
      val old = if (oldWork != null) next(gateway.histories) else null
      val sendWork = operation { runtime.send("Current input", runtime.inputOwner()) }
      val send = next(gateway.sendReplies)
      val pending = checkNotNull(runtime.state.value.pendingSend)
      val historyWork = oldWork ?: operation(runtime::refresh)
      val snapshot = old ?: next(gateway.histories)
      if (historyAfterSend) {
        send.reply(
          buildJsonObject {
            put("runId", "acknowledged-run")
            put("status", "started")
          },
        )
        finish(sendWork)
      }
      snapshot.reply(history("History captured before send acknowledgement"))
      finish(historyWork)
      assertEquals(
        "Initial history",
        runtime.state.value.messages
          .single()
          .text,
      )
      if (!historyAfterSend) {
        assertEquals(pending, runtime.state.value.pendingSend)
        assertTrue(runtime.state.value.sending)
        assertFalse(runtime.state.value.sendUnknown)
        send.reply(
          buildJsonObject {
            put("runId", "acknowledged-run")
            put("status", "started")
          },
        )
        finish(sendWork)
      }
      assertEquals("acknowledged-run", runtime.state.value.runId)
      assertEquals(null, runtime.state.value.pendingSend)
      assertFalse(runtime.state.value.sending)
      assertFalse(runtime.state.value.sendUnknown)
    }

  @Test
  fun queuedStopKeepsCapturedRunInsteadOfStoppingNewerLiveRun() =
    conversationTest {
      gateway.chat("captured-run", "First run")
      await { runtime.state.value.takeIf { it.runId == "captured-run" } }
      val stopWork = operation(runtime::abort)
      gateway.chat("newer-run", "Second run")
      await(runTasks = false) { runtime.state.value.takeIf { it.runId == "newer-run" } }
      val stop = next(gateway.stops)
      assertEquals("sessions.abort", stop.frame.text("method"))
      assertEquals(
        buildJsonObject {
          put("key", "agent:main:main")
          put("runId", "captured-run")
        },
        stop.params,
      )
      stop.reply(
        buildJsonObject {
          put("ok", true)
          put("status", "no-active-run")
        },
      )
      next(gateway.histories).reply(history("Newer run survives", "newer-run", "Second run"))
      finish(stopWork)
      assertEquals("newer-run", runtime.state.value.runId)
    }

  @Test
  fun queuedStopFromRetiredSelectionNeverEnqueuesOnReplacement() = verifyQueuedStopRetirement(peerClosed = false)

  @Test
  fun queuedStopFromRetiredPhysicalSocketNeverEnqueuesOrReplays() = verifyQueuedStopRetirement(peerClosed = true)

  private fun verifyQueuedStopRetirement(peerClosed: Boolean) =
    conversationTest {
      gateway.chat("retired-run", "Old run")
      await { runtime.state.value.takeIf { it.runId == "retired-run" } }
      val socket = next(gateway.operatorSockets)
      val stopWork = operation(runtime::abort)
      val key = if (peerClosed) "agent:main:main" else "agent:main:replacement"
      if (peerClosed) {
        assertTrue(socket.close(1000, "Fixture peer disconnected"))
        await(runTasks = false) { runtime.state.value.takeIf { !it.connected } }
      } else {
        runtime.selectSession(key)
      }
      val replacement = next(gateway.histories)
      assertEquals(key, replacement.params.text("sessionKey"))
      finish(stopWork)
      replacement.reply(history("Replacement history"))
      await { runtime.state.value.takeIf { it.messages.singleOrNull()?.text == "Replacement history" } }
      assertEquals(key, runtime.state.value.sessionKey)
      assertEquals(null, runtime.state.value.error)
      assertTrue("A retired Stop must not enqueue on either socket", gateway.stops.tryReceive().isFailure)
    }

  private fun conversationTest(block: suspend Conversation.() -> Unit) =
    runBlocking {
      val conversation = Conversation()
      try {
        conversation.gateway.holdHistory = true
        conversation.runtime.setVisible(true)
        conversation.runtime.setup(conversation.gateway.setupCode())
        conversation.next(conversation.gateway.histories).reply(history("Initial history"))
        conversation.await {
          conversation.runtime.state.value
            .takeIf { it.connected && it.approvalsReady && it.messages.singleOrNull()?.text == "Initial history" }
        }
        conversation.block()
      } finally {
        conversation.close()
      }
    }

  @OptIn(ExperimentalCoroutinesApi::class)
  private inner class Conversation {
    val gateway = Gateway()
    private val job = SupervisorJob()
    private val scheduler = TestCoroutineScheduler()
    val runtime = runtime(CoroutineScope(job + StandardTestDispatcher(scheduler)))

    fun operation(action: () -> Unit): List<Job> {
      val existing = job.children.toSet()
      action()
      // Hold the caller's continuation, then join it after the controlled wire response.
      return job.children.filter { it !in existing }.toList()
    }

    suspend fun <T : Any> await(
      runTasks: Boolean = true,
      read: () -> T?,
    ): T =
      withTimeout(8000) {
        var value: T?
        do {
          if (runTasks) scheduler.runCurrent()
          value = read()
          if (value == null) yield()
        } while (value == null)
        value
      }

    suspend fun <T : Any> next(channel: Channel<T>): T = await { channel.tryReceive().getOrNull() }

    suspend fun beginSend(): Pair<List<Job>, HeldRequest> {
      gateway.answerSend = false
      val work = operation { runtime.send("Current input", runtime.inputOwner()) }
      next(gateway.sends)
      return work to next(gateway.sendReplies)
    }

    suspend fun historyWhileSending(work: List<Job>): HeldRequest {
      val result = await { gateway.histories.tryReceive().takeIf { it.isSuccess || work.all { job -> job.isCompleted } } }
      return checkNotNull(result.getOrNull()) { "A non-active ACK must reconcile canonical history before completing" }
    }

    fun assertSettledSend() {
      assertEquals(null, runtime.state.value.pendingSend)
      assertFalse(runtime.state.value.sending)
      assertFalse(runtime.state.value.sendUnknown)
    }

    suspend fun finish(work: List<Job>) {
      await { work.takeIf { jobs -> jobs.all { it.isCompleted } } }
      work.joinAll()
    }

    suspend fun close() {
      try {
        runtime.disconnect()
        runtime.setVisible(false)
        job.cancel()
        finish(listOf(job))
      } finally {
        gateway.server.shutdown()
      }
    }
  }

  private fun history(
    message: String,
    run: String? = null,
    text: String = "",
    sessionAbortable: Boolean = false,
  ): JsonObject =
    buildJsonObject {
      put(
        "messages",
        JsonArray(
          listOf(
            buildJsonObject {
              put("role", "assistant")
              put("content", message)
            },
          ),
        ),
      )
      if (run != null) {
        put(
          "inFlightRun",
          buildJsonObject {
            put("runId", run)
            put("text", text)
            if (sessionAbortable) put("sessionAbortable", true)
          },
        )
      }
    }

  private fun runtime(scope: CoroutineScope): WearDirectRuntime {
    val context = RuntimeEnvironment.getApplication()
    return WearDirectRuntime(context, scope, WearGatewayStore(context.getSharedPreferences("direct-${UUID.randomUUID()}", Context.MODE_PRIVATE)))
  }

  private class Gateway {
    val connects = Channel<JsonObject>(Channel.UNLIMITED)
    val sends = Channel<JsonObject>(Channel.UNLIMITED)
    val operatorHellos = Channel<() -> Unit>(Channel.UNLIMITED)
    val operatorSockets = Channel<WebSocket>(Channel.UNLIMITED)
    val histories = Channel<HeldRequest>(Channel.UNLIMITED)
    val sendReplies = Channel<HeldRequest>(Channel.UNLIMITED)
    val stops = Channel<HeldRequest>(Channel.UNLIMITED)
    private val operatorSocket = AtomicReference<WebSocket>()

    @Volatile var answerSend = true

    @Volatile var rejectSend = false

    @Volatile var holdOperatorHello = false

    @Volatile var holdHistory = false

    @Volatile var historyMessage: String? = null
    val server =
      MockWebServer().apply {
        dispatcher =
          object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse =
              MockResponse().withWebSocketUpgrade(
                object : WebSocketListener() {
                  override fun onOpen(
                    webSocket: WebSocket,
                    response: Response,
                  ) {
                    webSocket.send("""{"type":"event","event":"connect.challenge","payload":{"nonce":"watch-runtime","ts":1700000000123}}""")
                  }

                  override fun onMessage(
                    webSocket: WebSocket,
                    text: String,
                  ) {
                    val frame = Json.parseToJsonElement(text).jsonObject
                    val params = frame["params"] as? JsonObject ?: buildJsonObject {}
                    val held = HeldRequest(frame, webSocket)
                    val result =
                      when (frame.text("method")) {
                        "connect" -> {
                          connects.trySend(params)
                          val node = params.text("role") == "node"
                          if (!node) {
                            operatorSocket.set(webSocket)
                            operatorSockets.trySend(webSocket)
                          }
                          Json.parseToJsonElement(
                            if (node) {
                              """{"auth":{"role":"node","deviceToken":"watch-node","scopes":[],"deviceTokens":[{"role":"operator","deviceToken":"watch-operator","scopes":["operator.read","operator.write","operator.approvals","operator.questions","operator.talk.secrets"]}]},"snapshot":{"sessionDefaults":{"mainSessionKey":"agent:main:main"}}}"""
                            } else {
                              """{"auth":{"role":"operator","deviceToken":"watch-operator","scopes":["operator.read","operator.write","operator.approvals"]},"snapshot":{"sessionDefaults":{"mainSessionKey":"agent:main:main"}}}"""
                            },
                          )
                        }

                        "sessions.list" -> {
                          Json.parseToJsonElement("""{"sessions":[{"key":"agent:main:main","displayName":"Main"}]}""")
                        }

                        "sessions.messages.subscribe" -> {
                          buildJsonObject {
                            put("subscribed", true)
                            put("key", params.text("key") ?: "agent:main:main")
                            put(
                              "approvalReplay",
                              buildJsonObject {
                                put("sessionKey", params.text("key") ?: "agent:main:main")
                                put("updatedAtMs", 1)
                                put("truncated", false)
                                put("approvals", JsonArray(listOf("exec", "plugin", "system-agent").map(::approval)))
                              },
                            )
                          }
                        }

                        "chat.history" -> {
                          if (holdHistory) {
                            histories.trySend(held)
                            return
                          }
                          buildJsonObject {
                            put(
                              "messages",
                              JsonArray(
                                listOfNotNull(
                                  historyMessage?.let { message ->
                                    buildJsonObject {
                                      put("role", "assistant")
                                      put("content", message)
                                    }
                                  },
                                ),
                              ),
                            )
                          }
                        }

                        "chat.send" -> {
                          sends.trySend(params)
                          if (!answerSend) {
                            sendReplies.trySend(held)
                            return
                          }
                          Json.parseToJsonElement("""{"runId":"watch-run","status":"started"}""")
                        }

                        "chat.abort", "sessions.abort" -> {
                          stops.trySend(held)
                          return
                        }

                        else -> {
                          buildJsonObject {}
                        }
                      }
                    val rejected = frame.text("method") == "chat.send" && rejectSend
                    val response =
                      buildJsonObject {
                        put("type", "res")
                        put("id", frame["id"]!!)
                        put("ok", !rejected)
                        if (rejected) {
                          put(
                            "error",
                            buildJsonObject {
                              put("code", "INVALID_REQUEST")
                              put("message", "Rejected fixture message")
                            },
                          )
                        } else {
                          put("payload", result)
                        }
                      }.toString()
                    if (frame.text("method") == "connect" && params.text("role") == "operator" && holdOperatorHello) {
                      operatorHellos.trySend { webSocket.send(response) }
                    } else {
                      webSocket.send(response)
                    }
                  }

                  override fun onClosing(
                    webSocket: WebSocket,
                    code: Int,
                    reason: String,
                  ) {
                    webSocket.close(code, reason)
                  }
                },
              )
          }
        start()
      }

    fun chat(
      run: String,
      text: String,
      state: String = "delta",
      sessionKey: String = "agent:main:main",
    ) = event(
      "chat",
      buildJsonObject {
        put("sessionKey", sessionKey)
        put("runId", run)
        put("state", state)
        put(
          "message",
          buildJsonObject {
            put("role", "assistant")
            put("content", text)
          },
        )
      },
    )

    fun event(
      name: String,
      payload: JsonObject,
    ) {
      check(
        operatorSocket.get().send(
          buildJsonObject {
            put("type", "event")
            put("event", name)
            put("payload", payload)
          }.toString(),
        ),
      )
    }

    fun setupCode(): String =
      Base64.getUrlEncoder().withoutPadding().encodeToString(
        buildJsonObject {
          put("url", "http://127.0.0.1:${server.port}")
          put("bootstrapToken", "watch-bootstrap")
        }.toString().toByteArray(),
      )

    private fun approval(kind: String): JsonObject =
      buildJsonObject {
        put("id", kind)
        put("status", "pending")
        put("createdAtMs", 1)
        put("expiresAtMs", 9_000_000_000_000)
        put("urlPath", "/approvals/$kind")
        put(
          "presentation",
          buildJsonObject {
            put("kind", kind)
            put("allowedDecisions", Json.parseToJsonElement("""["allow-once","deny"]"""))
            when (kind) {
              "exec" -> {
                put("commandText", "printf watch")
              }

              "plugin" -> {
                put("title", "Plugin")
                put("description", "Publish watch fixture")
                put("severity", "warning")
              }

              else -> {
                put("title", "System")
                put("description", "Apply watch fixture")
                put("proposalHash", "a".repeat(64))
              }
            }
          },
        )
      }
  }

  private class HeldRequest(
    val frame: JsonObject,
    private val socket: WebSocket,
  ) {
    val params = frame["params"]!!.jsonObject

    fun acknowledge(status: String) =
      reply(
        buildJsonObject {
          put("runId", checkNotNull(params.text("idempotencyKey")))
          put("status", status)
        },
      )

    fun reply(
      payload: JsonObject,
      ok: Boolean = true,
    ) {
      check(
        socket.send(
          buildJsonObject {
            put("type", "res")
            put("id", frame["id"]!!)
            put("ok", ok)
            put(if (ok) "payload" else "error", payload)
          }.toString(),
        ),
      )
    }
  }
}
