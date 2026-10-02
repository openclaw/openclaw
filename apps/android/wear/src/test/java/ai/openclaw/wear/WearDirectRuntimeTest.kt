package ai.openclaw.wear

import ai.openclaw.app.gateway.DeviceIdentityStore
import ai.openclaw.app.gateway.GatewayEndpoint
import ai.openclaw.app.gateway.GatewayRegistryEntry
import ai.openclaw.app.gateway.GatewayRegistryEntryKind
import ai.openclaw.app.gateway.GatewayRegistryStore
import ai.openclaw.wear.shared.WearReplyText
import ai.openclaw.wear.shared.WearReplyTextStatus
import android.content.Context
import android.content.SharedPreferences
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
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
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
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
import org.junit.Assert.assertThrows
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
import java.util.concurrent.atomic.AtomicInteger
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
        val pendingProxy = runtime.capturePhoneProxy()
        runtime.setup("not-a-setup-code")
        assertEquals(null, runtime.state.value.selected)
        assertTrue(runtime.state.value.connectionManagementRequired)
        assertTrue(runtime.state.value.error != null)
        assertFalse(runtime.isPhoneProxySelected())
        pendingProxy {}
        runtime.cancelSetup()
        withTimeout(8000) { runtime.state.first { !it.busy && !it.connectionManagementRequired } }
        assertTrue(runtime.isPhoneProxySelected())
      } finally {
        scope.cancel()
      }
    }

  @Test
  fun phoneProxyAcknowledgmentSurvivesBackgroundAndForeground() =
    runBlocking {
      val fixture = Conversation(null)
      try {
        with(fixture) {
          runtime.setVisible(true)
          val pendingProxy = runtime.capturePhoneProxy()
          val work = operation { runtime.setVisible(false) }
          assertTrue("Phone Proxy remains available to background replies", runtime.isPhoneProxySelected())
          pendingProxy {}
          finish(work)
          pendingProxy {}
          runtime.setVisible(true)
          var acknowledged = false
          pendingProxy { acknowledged = true }
          assertTrue(acknowledged)
        }
      } finally {
        fixture.close()
      }
    }

  @Test
  fun committedDirectSelectionRetiresPriorProxyAcknowledgmentsAcrossReturn() =
    runBlocking {
      for (setup in listOf(true, false)) {
        val fixture = Conversation(null)
        try {
          with(fixture) {
            val pendingProxy = runtime.capturePhoneProxy()
            val target = parseWearGatewaySetup(gateway.setupCode()).endpoint
            store.registry.upsert(GatewayRegistryEntry(target.stableId, GatewayRegistryEntryKind.MANUAL, "Saved Gateway", target.host, target.port, false))
            finish(operation { if (setup) runtime.setup(gateway.setupCode()) else runtime.selectGateway(target.stableId) })
            assertThrows(WearProxyException::class.java) { pendingProxy {} }
            finish(operation { runtime.selectPhoneProxy() })
            assertThrows(WearProxyException::class.java) { pendingProxy {} }
            var acknowledged = false
            runtime.capturePhoneProxy().invoke { acknowledged = true }
            assertTrue(acknowledged)
          }
        } finally {
          fixture.close()
        }
      }
    }

  @Test
  fun failedGatewaySelectionFromPhoneProxyRequiresRecovery() = verifyConnectionMutationFailure(previousDirect = false, mutation = "gateway")

  @Test
  fun failedGatewaySelectionFromDirectRequiresRecovery() = verifyConnectionMutationFailure(previousDirect = true, mutation = "gateway")

  @Test
  fun failedPhoneProxySelectionFromPhoneProxyRequiresRecovery() = verifyConnectionMutationFailure(previousDirect = false, mutation = "phone")

  @Test
  fun failedPhoneProxySelectionFromDirectRequiresRecovery() = verifyConnectionMutationFailure(previousDirect = true, mutation = "phone")

  @Test
  fun failedSetupCommitFromPhoneProxyRequiresRecovery() = verifyConnectionMutationFailure(previousDirect = false, mutation = "setup")

  @Test
  fun failedSetupCommitFromDirectRequiresRecovery() = verifyConnectionMutationFailure(previousDirect = true, mutation = "setup")

  @Test
  fun failedActiveForgetRequiresRecovery() = verifyConnectionMutationFailure(previousDirect = true, mutation = "forget")

  private fun verifyConnectionMutationFailure(
    previousDirect: Boolean,
    mutation: String,
  ) = runBlocking {
    val previous = WearGatewaySetup(GatewayEndpoint.manual("saved.example", 443, true), "saved-bootstrap")
    val fixture = Conversation(previous.takeIf { previousDirect })
    try {
      with(fixture) {
        val target = GatewayEndpoint.manual("127.0.0.1", gateway.server.port, false)
        store.registry.upsert(GatewayRegistryEntry(target.stableId, GatewayRegistryEntryKind.MANUAL, "Saved Gateway", target.host, target.port, false))
        val persisted = store.getString(GatewayRegistryStore.STORAGE_KEY)
        val selected = store.registry.activeStableId.value
        val pendingProxy = if (previousDirect) null else runtime.capturePhoneProxy()
        failRegistryCommit = true
        finish(
          operation {
            when (mutation) {
              "gateway" -> runtime.selectGateway(target.stableId)
              "phone" -> runtime.selectPhoneProxy()
              "setup" -> runtime.setup(gateway.setupCode())
              "forget" -> runtime.forget(checkNotNull(selected))
              else -> error("Unknown fixture mutation")
            }
          },
        )
        await { runtime.state.value.takeIf { !it.busy } }

        assertEquals(1, rejectedRegistryCommits)
        assertEquals(persisted, store.getString(GatewayRegistryStore.STORAGE_KEY))
        assertEquals(selected, store.registry.storedActiveStableId())
        assertEquals(
          selected,
          runtime.state.value.selected
            ?.stableId,
        )
        assertNotNull(runtime.state.value.error)
        assertTrue("Failed $mutation must require visible recovery", runtime.state.value.connectionManagementRequired)
        var acknowledged = false
        pendingProxy?.invoke { acknowledged = true }
        assertEquals(!previousDirect, acknowledged)
        var enqueued = false
        assertThrows(WearProxyException::class.java) { runtime.capturePhoneProxy().invoke { enqueued = true } }
        assertFalse(enqueued)

        failRegistryCommit = false
        finish(operation { runtime.cancelSetup() })
        await { runtime.state.value.takeIf { !it.busy } }
        assertFalse(runtime.state.value.connectionManagementRequired)
        assertEquals(null, runtime.state.value.error)
        assertEquals(selected, store.registry.storedActiveStableId())
      }
    } finally {
      fixture.close()
    }
  }

  @Test
  fun bootstrapConnectsWithoutPhoneAndLoadsCanonicalSessionApprovalUnion() =
    runBlocking {
      val gateway = Gateway().apply { historyMessage = "Initial history" }
      val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
      val runtime = runtime(scope)
      try {
        runtime.setVisible(true)
        runtime.setup(gateway.setupCode())
        val state = withTimeout(8000) { runtime.state.first { it.error != null || it.messages.isNotEmpty() } }
        assertEquals(null, state.error)
        assertTrue(state.connected && state.approvalsReady)
        assertEquals("Initial history", state.messages.single().text)
        assertEquals(setOf("exec", "plugin", "system-agent"), state.approvals.map { it.kind }.toSet())
        val node = withTimeout(8000) { gateway.connects.receive() }
        val operator = withTimeout(8000) { gateway.connects.receive() }
        assertEquals("node", node.text("role"))
        assertTrue((node["scopes"] as? JsonArray).isNullOrEmpty())
        assertEquals("operator", operator.text("role"))
        assertEquals(wearOperatorScopePolicy.requestedScopes, (operator["scopes"] as JsonArray).map { it.toString().trim('"') }.toSet())
        assertFalse(runtime.isPhoneProxySelected())
        assertEquals("agent:main:main", state.sessionKey)
        assertEquals("main", state.sessionAgentId)
      } finally {
        runtime.disconnect()
        runtime.setVisible(false)
        scope.cancel()
        gateway.server.shutdown()
      }
    }

  @Test
  fun subscriptionKeepsAgentLocalRoutingForHistorySendStopAndRefresh() =
    conversationTest {
      gateway.agentId = "research"
      gateway.holdApprovalReplay = true
      val selection = operation { runtime.selectSession("global", "research") }
      val subscription = next(gateway.approvalReplays)
      assertEquals("research", subscription.params.text("agentId"))
      assertEquals(null, subscription.params.text("mode"))
      subscription.reply(gateway.approvalReplay(emptyList(), key = "global"))
      val initial = next(gateway.histories)
      assertEquals("global", initial.params.text("sessionKey"))
      assertEquals("research", initial.params.text("agentId"))
      initial.reply(history("Research history"))
      finish(selection)
      await { runtime.state.value.takeIf { it.messages.singleOrNull()?.text == "Research history" } }

      val (sendWork, send) = beginSend()
      assertEquals("global", send.params.text("sessionKey"))
      assertEquals("research", send.params.text("agentId"))
      send.acknowledge("started")
      finish(sendWork)
      val stopWork = operation(runtime::abort)
      val stop = next(gateway.stops)
      assertEquals("global", stop.params.text("key"))
      assertEquals("research", stop.params.text("agentId"))
      assertEquals(send.params.text("idempotencyKey"), stop.params.text("runId"))
      stop.reply(buildJsonObject { put("aborted", true) })
      next(gateway.histories).reply(history("Stopped research history"))
      finish(stopWork)

      val refresh = operation(runtime::refresh)
      val repeated = next(gateway.approvalReplays)
      assertEquals("global", repeated.params.text("key"))
      assertEquals("research", repeated.params.text("agentId"))
      repeated.reply(gateway.approvalReplay(emptyList(), key = "global"))
      next(gateway.histories).reply(history("Refreshed research history"))
      finish(refresh)

      // Same-socket ordering proves foreign and ownerless hints cannot refresh this agent-local key.
      for (agent in listOf(null, "other", "research")) {
        gateway.event(
          "sessions.changed",
          buildJsonObject {
            put("sessionKey", "global")
            put("phase", "message")
            agent?.let { put("agentId", it) }
          },
        )
      }
      val invalidated = next(gateway.histories)
      assertEquals("research", invalidated.params.text("agentId"))
      invalidated.reply(history("Current research message"))
      await { runtime.state.value.takeIf { it.messages.singleOrNull()?.text == "Current research message" } }
      assertTrue(gateway.histories.tryReceive().isFailure)
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
            put("agentId", "main")
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
  fun approvalReplayFromOlderRefreshCannotReplaceNewerTerminalState() =
    conversationTest {
      gateway.holdHistory = false
      gateway.holdApprovalReplay = true
      val olderWork = operation(runtime::refresh)
      val older = next(gateway.approvalReplays)
      val newerWork = operation(runtime::refresh)
      next(gateway.approvalReplays).reply(gateway.approvalReplay(listOf(gateway.approval("plugin"))))
      finish(newerWork)
      gateway.event(
        "session.approval",
        buildJsonObject {
          put("sessionKey", "agent:main:main")
          put("updatedAtMs", 10)
          put("phase", "terminal")
          put("approval", gateway.approval("plugin", status = "denied"))
        },
      )
      await { runtime.state.value.takeIf { it.approvals.singleOrNull()?.status == "denied" } }
      older.reply(gateway.approvalReplay(listOf(gateway.approval("plugin"), gateway.approval("exec"))))
      finish(olderWork)
      assertEquals(
        "Older replay must not replace the newer approval set or resurrect a terminal approval",
        listOf("plugin" to "denied"),
        runtime.state.value.approvals
          .map { it.id to it.status },
      )
      assertTrue(runtime.state.value.approvalsReady)
    }

  @Test
  fun sequenceGapRetiresApprovalReplayAndWaitsForReplacementReplay() =
    conversationTest {
      gateway.holdHistory = false
      gateway.holdApprovalReplay = true
      val olderWork = operation(runtime::refresh)
      next(gateway.approvalReplays)
      val previousSocket = next(gateway.operatorSockets)
      // Gap recovery now retires the physical lease before obtaining a fresh replay.
      gateway.event("tick", buildJsonObject {}, sequence = 1)
      gateway.event("tick", buildJsonObject {}, sequence = 3)
      assertEquals(previousSocket, next(gateway.terminatedOperatorSockets).first)
      assertTrue(previousSocket !== next(gateway.operatorSockets))
      val recovery = next(gateway.approvalReplays)
      assertFalse(runtime.state.value.approvalsReady)
      finish(olderWork)
      val readyBeforeRecovery = runtime.state.value.approvalsReady
      recovery.reply(gateway.approvalReplay(listOf(gateway.approval("plugin"))))
      await { runtime.state.value.takeIf { it.approvalsReady && it.approvals.singleOrNull()?.id == "plugin" } }
      assertFalse("A pre-gap response cannot authorize the incomplete approval feed", readyBeforeRecovery)
    }

  @Test
  fun approvalRefreshOlderSessionListCannotSupersedeNewerRefresh() = verifyOlderSessionList(fails = false)

  @Test
  fun approvalRefreshOlderSessionListErrorCannotReplaceNewerOutcome() = verifyOlderSessionList(fails = true)

  private fun verifyOlderSessionList(fails: Boolean) =
    conversationTest {
      gateway.holdHistory = false
      gateway.holdSessionList = true
      val olderWork = operation(runtime::refresh)
      val older = next(gateway.sessionLists)
      val newerWork = operation(runtime::refresh)
      next(gateway.sessionLists).reply(gateway.sessionList("Newer session title"))
      finish(newerWork)
      val afterNewer = runtime.state.value
      val subscriptions = gateway.approvalRequestCount.get()
      val histories = gateway.historyRequestCount.get()
      older.reply(
        if (fails) {
          buildJsonObject {
            put("code", "UNAVAILABLE")
            put("message", "Older fixture list failed")
          }
        } else {
          gateway.sessionList("Obsolete session title")
        },
        ok = !fails,
      )
      finish(olderWork)
      assertEquals("Older list work must not replace current sessions", afterNewer.sessions, runtime.state.value.sessions)
      assertEquals("Older list failure must not publish a current error", afterNewer.error, runtime.state.value.error)
      assertEquals("Superseded list work must not start another approval replay", subscriptions, gateway.approvalRequestCount.get())
      assertEquals("Superseded list work must not load history", histories, gateway.historyRequestCount.get())
    }

  @Test
  fun approvalReplayInvalidCurrentResultStillLoadsChatHistory() =
    conversationTest {
      gateway.holdApprovalReplay = true
      val work = operation(runtime::refresh)
      next(gateway.approvalReplays).reply(buildJsonObject { put("subscribed", false) })
      next(gateway.histories).reply(history("History with unavailable approvals"))
      finish(work)
      val state = runtime.state.value
      assertFalse(state.approvalsReady)
      assertEquals("Approval replay is unavailable. Reconnect to refresh.", state.error)
      assertEquals("History with unavailable approvals", state.messages.single().text)
    }

  @Test
  fun forgetInactiveGatewayPreservesActiveConversationAndInFlightSend() {
    val inactive = WearGatewaySetup(GatewayEndpoint.manual("inactive.example", 443, true), "inactive-bootstrap")
    conversationTest(savedGateway = inactive) {
      val activeSocket = next(gateway.operatorSockets)
      val input = runtime.inputOwner()
      val (sendWork, send) = beginSend()
      val before = runtime.state.value
      assertTrue(before.gateways.any { it.stableId == inactive.endpoint.stableId })
      val forgetWork = operation { runtime.forget(inactive.endpoint.stableId) }
      finish(forgetWork)
      val after = runtime.state.value
      assertEquals(before.selected, after.selected)
      assertTrue("Forgetting inactive B must preserve A's physical connection", after.connected)
      assertEquals(input, runtime.inputOwner())
      assertEquals(before.sessionKey, after.sessionKey)
      assertEquals(before.messages, after.messages)
      assertEquals(before.pendingSend, after.pendingSend)
      assertTrue(after.sending)
      assertFalse(after.sendUnknown)
      assertEquals(before.approvals, after.approvals)
      assertEquals(before.approvalsReady, after.approvalsReady)
      assertEquals(null, after.error)
      assertFalse(after.gateways.any { it.stableId == inactive.endpoint.stableId })
      assertEquals(null, store.bootstrap(inactive.endpoint.stableId))
      assertEquals(before.selected?.stableId, store.registry.activeStableId.value)
      send.acknowledge("started")
      finish(sendWork)
      assertSettledSend()
      assertEquals(send.params.text("idempotencyKey"), runtime.state.value.runId)
      assertTrue("Inactive removal must not create a replacement socket", gateway.operatorSockets.tryReceive().isFailure)
      assertTrue("The original server-side socket must remain writable", activeSocket.send("""{"type":"event","event":"tick","payload":{}}"""))
    }
  }

  @Test
  fun failedInactiveForgetPreservesActiveSendAndReportsStorageFailure() {
    val inactive = WearGatewaySetup(GatewayEndpoint.manual("inactive.example", 443, true), "inactive-bootstrap")
    conversationTest(savedGateway = inactive) {
      val input = runtime.inputOwner()
      val (sendWork, send) = beginSend()
      val before = runtime.state.value
      failRegistryCommit = true
      val forgetWork = operation { runtime.forget(inactive.endpoint.stableId) }
      finish(forgetWork)
      val after = runtime.state.value
      assertNotNull("Failed inactive removal must remain visible", after.error)
      assertEquals(before.gateways, store.registry.entries.value)
      assertEquals(before.selected?.stableId, store.registry.activeStableId.value)
      assertEquals(inactive.bootstrapToken, store.bootstrap(inactive.endpoint.stableId))
      assertTrue("Failed inactive removal must not retire the active socket", after.connected)
      assertEquals(input, runtime.inputOwner())
      assertEquals(before.messages, after.messages)
      assertEquals(before.sessionKey, after.sessionKey)
      assertEquals(before.pendingSend, after.pendingSend)
      assertEquals(before.approvals, after.approvals)
      assertEquals(before.approvalsReady, after.approvalsReady)
      assertTrue(after.sending)
      assertFalse(after.sendUnknown)
      send.acknowledge("started")
      finish(sendWork)
      assertSettledSend()
      assertEquals(send.params.text("idempotencyKey"), runtime.state.value.runId)
    }
  }

  @Test
  fun forgettingActiveGatewayRetiresOriginalSocketAndClearsItsConversation() {
    val inactive = WearGatewaySetup(GatewayEndpoint.manual("inactive.example", 443, true), "inactive-bootstrap")
    conversationTest(savedGateway = inactive) {
      val activeSocket = next(gateway.operatorSockets)
      val input = runtime.inputOwner()
      val (sendWork, _) = beginSend()
      val activeId = checkNotNull(runtime.state.value.selected).stableId
      val forgetWork = operation { runtime.forget(activeId) }
      finish(forgetWork)
      finish(sendWork)
      await { runtime.state.value.takeIf { !it.busy } }
      assertTrue(runtime.isPhoneProxySelected())
      val state = runtime.state.value
      assertFalse(state.connected)
      assertFalse(state.busy)
      assertEquals(null, state.error)
      assertEquals(null, state.selected)
      assertEquals(null, state.sessionKey)
      assertTrue(state.messages.isEmpty())
      assertTrue(state.approvals.isEmpty())
      assertEquals(null, state.pendingSend)
      assertFalse(state.sending)
      assertFalse(state.sendUnknown)
      assertEquals(listOf(inactive.endpoint.stableId), state.gateways.map { it.stableId })
      assertEquals(inactive.bootstrapToken, store.bootstrap(inactive.endpoint.stableId))
      assertEquals(null, store.bootstrap(activeId))
      assertEquals(null, store.registry.activeStableId.value)
      val termination = next(gateway.terminatedOperatorSockets)
      assertEquals(activeSocket, termination.first)
      println("Active Forget server terminal callback: ${termination.second}")
      runtime.send("Input from the forgotten gateway", input)
      assertEquals(null, runtime.state.value.pendingSend)
      assertTrue("Forgetting active A must not connect inactive B", gateway.operatorSockets.tryReceive().isFailure)
    }
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

      for (event in listOf("session.message", "sessions.changed")) {
        val previous = runtime.state.value.messages
        val beforeMessageWork = operation(runtime::refresh)
        val beforeMessage = next(gateway.histories)
        gateway.event(
          event,
          buildJsonObject {
            put("sessionKey", "agent:main:main")
            put("phase", "message")
          },
        )
        val messageHistory = next(gateway.histories)
        beforeMessage.reply(history("Stale before $event"))
        finish(beforeMessageWork)
        assertEquals(previous, runtime.state.value.messages)
        messageHistory.reply(history("History after $event", "live-run", "Live text"))
        await { runtime.state.value.takeIf { it.messages.singleOrNull()?.text == "History after $event" } }
        assertEquals("live-run", runtime.state.value.runId)
      }

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

  @Test
  fun terminalHistoryAlreadyPendingSurvivesDelayedTimeoutAcknowledgement() = verifyTerminalAcknowledgement("error", ackFirst = false, status = "timeout")

  @Test
  fun sessionMessageBeforeAcknowledgementReconcilesCanonicalRun() = verifyMessageAcknowledgement("session.message")

  @Test
  fun messagePhaseBeforeAcknowledgementReconcilesCanonicalRun() = verifyMessageAcknowledgement("sessions.changed")

  private fun verifyMessageAcknowledgement(event: String) =
    conversationTest {
      for ((status, historyApplied, active) in listOf(
        Triple("started", false, false),
        Triple("started", true, true),
        Triple("in_flight", true, false),
        Triple("in_flight", false, true),
      )) {
        val (sendWork, send) = beginSend()
        val run = checkNotNull(send.params.text("idempotencyKey"))
        gateway.event(
          event,
          buildJsonObject {
            put("sessionKey", "agent:main:main")
            put("phase", "message")
          },
        )
        val earlier = next(gateway.histories)
        if (historyApplied) {
          earlier.reply(history("Transcript before acknowledgment"))
          await { runtime.state.value.takeIf { it.messages.singleOrNull()?.text == "Transcript before acknowledgment" } }
        }
        send.acknowledge(status)
        val canonical = await { gateway.histories.tryReceive().takeIf { it.isSuccess || sendWork.all { job -> job.isCompleted } } }
        assertTrue("A transcript event cannot decide whether the acknowledged run is still active", canonical.isSuccess)
        if (!historyApplied) earlier.reply(history("Stale transcript", "stale-run"))
        checkNotNull(canonical.getOrNull()).reply(history("Canonical after acknowledgment", run.takeIf { active }))
        finish(sendWork)
        assertSettledSend()
        assertEquals(run.takeIf { active }, runtime.state.value.runId)
        assertEquals(
          "Canonical after acknowledgment",
          runtime.state.value.messages
            .single()
            .text,
        )
      }
    }

  private fun verifyTerminalAcknowledgement(
    terminal: String,
    ackFirst: Boolean,
    status: String = "started",
  ) = conversationTest {
    val (sendWork, send) = beginSend()
    val run = checkNotNull(send.params.text("idempotencyKey"))
    if (ackFirst) send.acknowledge(status)
    // Same-socket wire order completes the ACK deferred, but its consumer remains paused.
    gateway.chat(run, "Terminal $terminal", state = terminal)
    await(runTasks = false) { runtime.state.value.takeIf { it.messages.lastOrNull()?.text == "Terminal $terminal" } }
    assertTrue(runtime.state.value.sending)
    val pendingHistory = if (ackFirst) null else next(gateway.histories)
    if (!ackFirst) send.acknowledge(status)
    finish(sendWork)
    assertSettledSend()
    assertEquals("A superseded $status ACK must not add a terminal notice", null, runtime.state.value.error)
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
      for ((status, newerRun) in listOf("started" to false, "in_flight" to true, "ok" to true, "timeout" to true)) {
        val (sendWork, send) = beginSend()
        val run = if (newerRun) "newer-$status" else checkNotNull(send.params.text("idempotencyKey"))
        send.acknowledge(status)
        gateway.chat(run, "Live $status")
        await(runTasks = false) { runtime.state.value.takeIf { it.streamText == "Live $status" } }
        finish(sendWork)
        assertSettledSend()
        assertEquals("Chat events must retain the live run after $status ACK", run, runtime.state.value.runId)
        assertEquals("Live $status", runtime.state.value.streamText)
        assertEquals("A superseded $status ACK must not add a terminal notice", null, runtime.state.value.error)
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
        for (event in listOf("session.message", "sessions.changed")) {
          gateway.event(
            event,
            buildJsonObject {
              put("sessionKey", "agent:other:main")
              put("phase", "message")
            },
          )
        }
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
  fun foreignFinalPreservesActiveRunAndStop() = verifyForeignTerminal("final", beforeAck = false)

  @Test
  fun foreignAbortedPreservesActiveRunAndStop() = verifyForeignTerminal("aborted", beforeAck = false)

  @Test
  fun foreignErrorPreservesActiveRunAndStop() = verifyForeignTerminal("error", beforeAck = false)

  @Test
  fun foreignFinalBeforeAcknowledgementPreservesPendingRun() = verifyForeignTerminal("final", beforeAck = true)

  @Test
  fun foreignAbortedBeforeAcknowledgementPreservesPendingRun() = verifyForeignTerminal("aborted", beforeAck = true)

  @Test
  fun foreignErrorBeforeAcknowledgementPreservesPendingRun() = verifyForeignTerminal("error", beforeAck = true)

  private fun verifyForeignTerminal(
    terminal: String,
    beforeAck: Boolean,
  ) = conversationTest {
    val (sendWork, send) = beginSend()
    val run = checkNotNull(send.params.text("idempotencyKey"))
    if (!beforeAck) {
      send.acknowledge("started")
      finish(sendWork)
      gateway.chat(run, "Current stream")
      await { runtime.state.value.takeIf { it.streamText == "Current stream" } }
    }
    observeTerminal("inject-foreign", terminal)
    if (beforeAck) {
      assertEquals(
        run,
        runtime.state.value.pendingSend
          ?.key,
      )
      send.acknowledge("started")
      finish(sendWork)
    }
    assertEquals("A foreign $terminal must not retire the current run", run, runtime.state.value.runId)
    assertEquals(if (beforeAck) null else "Current stream", runtime.state.value.streamText)
    val stopWork = operation(runtime::abort)
    val stop = next(gateway.stops)
    assertEquals(run, stop.params.text("runId"))
    gateway.holdHistory = false
    stop.reply(buildJsonObject { put("ok", true) })
    finish(stopWork)
  }

  @Test
  fun previousRunTerminalFinalSettlesOnlyPreviousRun() = verifyPreviousRunTerminal("final")

  @Test
  fun previousRunTerminalAbortedSettlesOnlyPreviousRun() = verifyPreviousRunTerminal("aborted")

  @Test
  fun previousRunTerminalErrorSettlesOnlyPreviousRun() = verifyPreviousRunTerminal("error")

  private fun verifyPreviousRunTerminal(terminal: String) =
    conversationTest {
      gateway.chat("previous-run", "Previous stream")
      await { runtime.state.value.takeIf { it.streamText == "Previous stream" } }
      val (sendWork, send) = beginSend()
      val pending = runtime.state.value.pendingSend
      observeTerminal("previous-run", terminal)
      assertEquals("The matching terminal must settle A", null, runtime.state.value.runId)
      assertEquals(null, runtime.state.value.streamText)
      assertTrue(runtime.state.value.pendingSend === pending)
      send.acknowledge("started")
      finish(sendWork)
      assertSettledSend()
      assertEquals("A's terminal must not fence B's ACK", send.params.text("idempotencyKey"), runtime.state.value.runId)
    }

  @Test
  fun foreignTerminalHistoryCannotOverwriteNewerAcknowledgement() =
    conversationTest {
      val (sendWork, send) = beginSend()
      observeTerminal("inject-history", "final")
      val snapshot = next(gateway.histories)
      send.acknowledge("started")
      finish(sendWork)
      snapshot.reply(history("Persisted injected message"))
      receiveBarrier("exec")
      runCurrent()
      assertSettledSend()
      assertEquals("Transcript reconciliation cannot discard the newer ACK owner", send.params.text("idempotencyKey"), runtime.state.value.runId)
      assertEquals(
        "Observed final",
        runtime.state.value.messages
          .last()
          .text,
      )
    }

  @Test
  fun approvalPreflightRejectionReleasesAttempt() = verifyApprovalPreflightFailure("rejected")

  @Test
  fun approvalPreflightInvalidResultReleasesAttempt() = verifyApprovalPreflightFailure("invalid")

  @Test
  fun approvalPreflightTimeoutReleasesAttempt() = verifyApprovalPreflightFailure("timeout")

  @Test
  fun approvalPreflightCancellationReleasesAttempt() = verifyApprovalPreflightFailure("cancelled")

  @Test
  fun approvalPreflightPhysicalRetirementReleasesAttempt() = verifyApprovalPreflightFailure("physical")

  @Test
  fun approvalPreflightIntentRetirementReleasesAttempt() = verifyApprovalPreflightFailure("intent")

  @Test
  fun approvalPreflightRetirementAfterReadNeverSubmits() = verifyApprovalPreflightFailure("after-read")

  private fun verifyApprovalPreflightFailure(failure: String) =
    conversationTest {
      val (work, get) = beginApproval()
      when (failure) {
        "rejected" -> {
          get.reply(approvalNotFound(), ok = false)
        }

        "invalid" -> {
          get.reply(buildJsonObject {})
        }

        "timeout" -> {
          advanceRpcDeadline()
        }

        "cancelled" -> {
          work.forEach { it.cancel() }
        }

        "physical" -> {
          assertTrue(next(gateway.operatorSockets).close(1000, "Fixture preflight retirement"))
          await(runTasks = false) { runtime.state.value.takeIf { !it.connected } }
        }

        "intent", "after-read" -> {
          if (failure == "after-read") get.reply(approvalResult("pending"))
          runtime.setVisible(false)
        }

        else -> {
          error("Unknown preflight fixture")
        }
      }
      finish(work)
      assertTrue("No approval.resolve may follow a failed preflight", gateway.approvalResolves.tryReceive().isFailure)
      assertFalse("A $failure preflight must release its exact attempt", "plugin" in runtime.state.value.resolving)
      if (failure == "cancelled") assertTrue(work.all { it.isCancelled })
      if (failure in setOf("rejected", "invalid", "timeout")) {
        assertNotNull("The failed preflight must remain visible", runtime.state.value.error)
        val (retryWork, retryGet) = beginApproval()
        retryGet.reply(approvalResult("denied"))
        finish(retryWork)
        assertFalse("plugin" in runtime.state.value.resolving)
        assertTrue(gateway.approvalResolves.tryReceive().isFailure)
      }
    }

  @Test
  fun approvalEarlierAttemptFailureCannotReleaseReplacement() =
    conversationTest {
      val (oldWork, oldGet) = beginApproval()
      val refresh = operation(runtime::refresh)
      next(gateway.approvalGets).reply(approvalResult("pending"))
      next(gateway.histories).reply(history("Reconciled pending approval"))
      finish(refresh)
      val (newWork, newGet) = beginApproval()
      oldGet.reply(approvalNotFound(), ok = false)
      finish(oldWork)
      assertTrue("The old attempt cannot release its replacement", "plugin" in runtime.state.value.resolving)
      newGet.reply(approvalResult("pending"))
      next(gateway.approvalResolves).reply(approvalResult("denied", applied = true))
      finish(newWork)
      assertFalse("plugin" in runtime.state.value.resolving)
      assertEquals(
        "denied",
        runtime.state.value.approvals
          .single { it.id == "plugin" }
          .status,
      )
    }

  @Test
  fun approvalSubmittedTimeoutRetainsOwnershipUntilTerminalReadback() = verifyApprovalReconciliation("terminal")

  @Test
  fun approvalReconciliationRejectionStillLoadsHistory() = verifyApprovalReconciliation("rejected")

  @Test
  fun approvalReconciliationInvalidResultStillLoadsHistory() = verifyApprovalReconciliation("invalid")

  private fun verifyApprovalReconciliation(result: String) =
    conversationTest {
      val (work, get) = beginApproval()
      get.reply(approvalResult("pending"))
      val submitted = next(gateway.approvalResolves)
      assertEquals("plugin", submitted.params.text("id"))
      advanceRpcDeadline()
      finish(work)
      assertTrue("A wire-observed unresolved decision remains owned", "plugin" in runtime.state.value.resolving)
      assertNotNull(runtime.state.value.error)
      val refresh = operation(runtime::refresh)
      val readback = next(gateway.approvalGets)
      when (result) {
        "terminal" -> readback.reply(approvalResult("denied"))
        "rejected" -> readback.reply(approvalNotFound(), ok = false)
        "invalid" -> readback.reply(buildJsonObject {})
      }
      val loaded =
        await {
          gateway.histories.tryReceive().takeIf { it.isSuccess || refresh.all { job -> job.isCompleted } }
        }.getOrNull()
      assertNotNull("An approval readback failure must not prevent history loading", loaded)
      checkNotNull(loaded).reply(history("History after approval readback"))
      finish(refresh)
      assertEquals(
        "History after approval readback",
        runtime.state.value.messages
          .single()
          .text,
      )
      assertEquals(result != "terminal", "plugin" in runtime.state.value.resolving)
      if (result != "terminal") assertNotNull("Unconfirmed approval readback must remain visible", runtime.state.value.error)
      assertTrue("Reconciliation must not resubmit a decision", gateway.approvalResolves.tryReceive().isFailure)
    }

  @Test
  fun approvalTerminalPreflightDoesNotSubmitDecision() =
    conversationTest {
      val (work, get) = beginApproval()
      get.reply(approvalResult("expired"))
      finish(work)
      assertFalse("plugin" in runtime.state.value.resolving)
      assertEquals(
        "expired",
        runtime.state.value.approvals
          .single { it.id == "plugin" }
          .status,
      )
      assertTrue(gateway.approvalResolves.tryReceive().isFailure)
    }

  @Test
  fun approvalSuccessfulResolvePublishesCanonicalTerminal() =
    conversationTest {
      val (work, get) = beginApproval()
      get.reply(approvalResult("pending"))
      next(gateway.approvalResolves).reply(approvalResult("denied", applied = true))
      finish(work)
      assertFalse("plugin" in runtime.state.value.resolving)
      assertEquals(
        "denied",
        runtime.state.value.approvals
          .single { it.id == "plugin" }
          .status,
      )
    }

  @Test
  fun selectingCurrentSessionPreservesWireObservedSend() =
    conversationTest {
      val socket = next(gateway.operatorSockets)
      val input = runtime.inputOwner()
      val (work, send) = beginSend()
      val pending = checkNotNull(runtime.state.value.pendingSend)
      val selection = operation { runtime.selectSession(checkNotNull(runtime.state.value.sessionKey)) }
      assertTrue("Reselecting the current session must retain the exact pending send", runtime.state.value.pendingSend === pending)
      assertEquals(input, runtime.inputOwner())
      assertEquals(pending.key, send.params.text("idempotencyKey"))
      assertTrue(runtime.state.value.connected)
      assertTrue(runtime.state.value.sending)
      assertFalse(runtime.state.value.sendUnknown)
      finish(selection)

      send.acknowledge("started")
      finish(work)
      assertSettledSend()
      assertEquals(pending.key, runtime.state.value.runId)
      runtime.retrySend()
      assertTrue("The original wire send must not be resent", gateway.sends.tryReceive().isFailure)
      assertTrue("Reselection must not replace the physical socket", gateway.operatorSockets.tryReceive().isFailure)
      assertTrue(gateway.terminatedOperatorSockets.tryReceive().isFailure)
      assertTrue(socket.send("""{"type":"event","event":"tick","payload":{}}"""))
    }

  @Test
  fun selectingCurrentSessionPreservesSubmittedApprovalAttempt() =
    conversationTest {
      val socket = next(gateway.operatorSockets)
      val input = runtime.inputOwner()
      val approval =
        runtime.state.value.approvals
          .single { it.id == "plugin" }
      val (work, get) = beginApproval()
      get.reply(approvalResult("pending"))
      val submitted = next(gateway.approvalResolves)
      val attempt = checkNotNull(runtime.state.value.resolving[approval.id])
      val selection = operation { runtime.selectSession(checkNotNull(runtime.state.value.sessionKey)) }
      assertTrue("Reselecting the current session must retain the exact submitted attempt", runtime.state.value.resolving[approval.id] === attempt)
      assertEquals(input, runtime.inputOwner())
      assertEquals(approval.id, submitted.params.text("id"))
      assertTrue(runtime.state.value.connected)
      finish(selection)

      val duplicate = operation { runtime.resolve(approval, "deny") }
      finish(duplicate)
      assertTrue("A submitted decision cannot start another preflight", gateway.approvalGets.tryReceive().isFailure)
      assertTrue("A submitted decision cannot enqueue twice", gateway.approvalResolves.tryReceive().isFailure)
      submitted.reply(approvalResult("denied", applied = true))
      finish(work)
      assertFalse(approval.id in runtime.state.value.resolving)
      assertEquals(
        "denied",
        runtime.state.value.approvals
          .single { it.id == approval.id }
          .status,
      )
      assertTrue(gateway.operatorSockets.tryReceive().isFailure)
      assertTrue(gateway.terminatedOperatorSockets.tryReceive().isFailure)
      assertTrue(socket.send("""{"type":"event","event":"tick","payload":{}}"""))
    }

  @Test
  fun selectingDifferentSessionRetiresWorkAndReturningUsesFreshReplay() =
    conversationTest {
      val originalSocket = next(gateway.operatorSockets)
      val originalInput = runtime.inputOwner()
      val originalKey = checkNotNull(runtime.state.value.sessionKey)
      val (sendWork, _) = beginSend()
      val (approvalWork, get) = beginApproval()
      get.reply(approvalResult("pending"))
      next(gateway.approvalResolves)
      assertNotNull(runtime.state.value.pendingSend)
      assertTrue("plugin" in runtime.state.value.resolving)
      gateway.holdApprovalReplay = true

      suspend fun selectWithReplay(
        key: String,
        message: String,
        approvals: List<JsonObject>,
      ): WebSocket {
        val selection = operation { runtime.selectSession(key) }
        val replay = next(gateway.approvalReplays)
        assertEquals(key, replay.params.text("key"))
        replay.reply(gateway.approvalReplay(approvals, key))
        val snapshot = next(gateway.histories)
        assertEquals(key, snapshot.params.text("sessionKey"))
        snapshot.reply(history(message))
        await {
          runtime.state.value.takeIf {
            it.connected && it.approvalsReady && it.sessionKey == key && it.messages.singleOrNull()?.text == message
          }
        }
        finish(selection)
        return next(gateway.operatorSockets)
      }

      val replacementSocket = selectWithReplay("agent:main:other", "Session B history", emptyList())
      finish(sendWork)
      finish(approvalWork)
      assertFalse(originalSocket === replacementSocket)
      assertEquals(originalSocket, next(gateway.terminatedOperatorSockets).first)
      assertFalse(originalInput == runtime.inputOwner())
      assertSettledSend()
      assertTrue(
        runtime.state.value.approvals
          .isEmpty(),
      )
      assertTrue(
        runtime.state.value.resolving
          .isEmpty(),
      )
      runtime.send("Late input from session A", originalInput)
      assertEquals(null, runtime.state.value.pendingSend)
      assertTrue(gateway.sends.tryReceive().isFailure)

      val returnedSocket =
        selectWithReplay(
          originalKey,
          "Fresh session A history",
          listOf(gateway.approval("plugin", "pending")),
        )
      assertFalse(replacementSocket === returnedSocket)
      assertEquals(replacementSocket, next(gateway.terminatedOperatorSockets).first)
      assertSettledSend()
      assertTrue(
        "Returning cannot restore the old submitted attempt",
        runtime.state.value.resolving
          .isEmpty(),
      )
      assertEquals(
        "pending",
        runtime.state.value.approvals
          .single()
          .status,
      )
      runtime.retrySend()
      assertTrue("Returning cannot replay the retired send", gateway.sends.tryReceive().isFailure)
      assertTrue("Fresh replay must not restore old approval reconciliation", gateway.approvalGets.tryReceive().isFailure)
      assertTrue(gateway.approvalResolves.tryReceive().isFailure)
    }

  @Test
  fun okAcknowledgementReconcilesBothActiveDurableClaimAndTerminalHistory() = verifyNonActiveAcknowledgement("ok")

  @Test
  fun timeoutAcknowledgementReconcilesHistoryWithoutLosingTerminalNotice() = verifyNonActiveAcknowledgement("timeout")

  private fun verifyNonActiveAcknowledgement(status: String) =
    conversationTest {
      for (active in if (status == "timeout") listOf(false) else listOf(true, false)) {
        if (status != "timeout") {
          gateway.chat("previous-run", "Previous text")
          await { runtime.state.value.takeIf { it.streamText == "Previous text" } }
        }
        val before = runtime.state.value
        val (sendWork, send) = beginSend()
        send.acknowledge(status, stopReason = if (active) null else "rpc")
        val reconciliation = historyWhileSending(sendWork)
        assertSettledSend()
        assertEquals("A non-active ACK must not adopt a run", before.runId, runtime.state.value.runId)
        assertEquals(before.streamText, runtime.state.value.streamText)
        assertEquals(before.messages, runtime.state.value.messages)
        val beforeHistoryError = runtime.state.value.error
        val run = if (active) checkNotNull(send.params.text("idempotencyKey")) else null
        val historyText = if (status == "timeout") "Initial history" else "Canonical accepted history"
        reconciliation.reply(history(historyText, run, "Recovered stream"))
        finish(sendWork)
        assertEquals(run, runtime.state.value.runId)
        assertEquals(if (active) "Recovered stream" else null, runtime.state.value.streamText)
        assertEquals(
          historyText,
          runtime.state.value.messages
            .single()
            .text,
        )
        assertSettledSend()
        assertTrue(gateway.histories.tryReceive().isFailure)
        runtime.retrySend()
        assertTrue("A settled $status ACK must never retry automatically or explicitly", gateway.sends.tryReceive().isFailure)
        val notice =
          if (status == "timeout") {
            "This message's run ended or was cancelled. Check history before sending again."
          } else {
            null
          }
        assertEquals(
          "$status notice before and after successful reconciliation",
          listOf(notice, notice),
          listOf(beforeHistoryError, runtime.state.value.error),
        )
      }
    }

  @Test
  fun timeoutAcknowledgementDoesNotReplaceInterveningError() =
    conversationTest {
      val (sendWork, send) = beginSend()
      val refreshWork = operation(runtime::refresh)
      next(gateway.histories).reply(
        buildJsonObject {
          put("code", "UNAVAILABLE")
          put("message", "Fixture history unavailable")
        },
        ok = false,
      )
      finish(refreshWork)
      val error = runtime.state.value.error
      assertNotNull("The intervening history failure must be visible", error)
      send.acknowledge("timeout")
      val reconciliation = historyWhileSending(sendWork)
      assertSettledSend()
      assertEquals(error, runtime.state.value.error)
      reconciliation.reply(history("Canonical accepted history"))
      finish(sendWork)
      assertSettledSend()
      assertEquals(error, runtime.state.value.error)
      assertTrue(gateway.sends.tryReceive().isFailure)
    }

  @Test
  fun timeoutAcknowledgementFromRetiredSelectionCannotPublish() = verifyRetiredTimeoutAcknowledgement(peerClosed = false)

  @Test
  fun timeoutAcknowledgementFromRetiredPhysicalSocketCannotPublish() = verifyRetiredTimeoutAcknowledgement(peerClosed = true)

  private fun verifyRetiredTimeoutAcknowledgement(peerClosed: Boolean) =
    conversationTest {
      val (sendWork, send) = beginSend()
      val pending = runtime.state.value.pendingSend
      val socket = next(gateway.operatorSockets)
      send.acknowledge("timeout")
      receiveBarrier("plugin")
      val key = if (peerClosed) "agent:main:main" else "agent:main:replacement"
      if (peerClosed) {
        assertTrue(socket.close(1000, "Fixture peer disconnected"))
        await(runTasks = false) { runtime.state.value.takeIf { !it.connected } }
      } else {
        runtime.selectSession(key)
      }
      val replacement = next(gateway.histories)
      assertEquals(key, replacement.params.text("sessionKey"))
      replacement.reply(history("Replacement history"))
      finish(sendWork)
      await { runtime.state.value.takeIf { it.messages.singleOrNull()?.text == "Replacement history" } }
      assertEquals(key, runtime.state.value.sessionKey)
      assertEquals(null, runtime.state.value.error)
      if (peerClosed) {
        assertTrue("The retired ACK cannot settle the retained attempt", runtime.state.value.pendingSend === pending)
        assertTrue(runtime.state.value.sendUnknown)
      } else {
        assertSettledSend()
      }
      assertTrue("The retired ACK cannot create another reconciliation", gateway.histories.tryReceive().isFailure)
      assertTrue("Retirement cannot automatically retry the send", gateway.sends.tryReceive().isFailure)
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
          put("agentId", "main")
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

  @Test
  fun directReplyRecoversEveryTextPartThroughTheCanonicalMessageLookup() =
    conversationTest {
      val parts = (1..22).map { "Part $it: " + "x".repeat(240) }
      val full =
        buildJsonObject {
          put("role", "assistant")
          put("__openclaw", buildJsonObject { put("id", "stored-entry") })
          put(
            "content",
            buildJsonArray {
              parts.forEach {
                add(
                  buildJsonObject {
                    put("type", "text")
                    put("text", it)
                  },
                )
              }
            },
          )
        }
      val refresh = operation(runtime::refresh)
      next(gateway.histories).reply(buildJsonObject { put("messages", JsonArray(listOf(full))) })
      finish(refresh)
      val preview =
        runtime.state.value.messages
          .single()
      assertEquals(true, preview.textTruncated)
      assertFalse(preview.text.contains("Part 22:"))
      val reader = runtime.openReply(preview, runtime.state.value)
      var offset = 0
      var revision: String? = null
      val recovered = StringBuilder()
      do {
        val page =
          coroutineScope {
            val pending = async { reader.readPage(offset, revision) }
            val request = next(gateway.replyReads)
            assertEquals(
              buildJsonObject {
                put("sessionKey", "agent:main:main")
                put("agentId", "main")
                put("messageId", "stored-entry")
                put("maxChars", WearReplyText.MAX_TEXT_LENGTH)
              },
              request.params,
            )
            request.reply(
              buildJsonObject {
                put("ok", true)
                put("message", full)
              },
            )
            pending.await()
          }
        assertEquals(WearReplyTextStatus.Ready, page.status)
        assertTrue(page.text.length <= WearReplyText.PAGE_LENGTH)
        recovered.append(page.text)
        revision = page.revision
        offset = page.nextOffset ?: break
      } while (true)
      assertEquals(parts.joinToString("\n"), recovered.toString())
    }

  @Test
  fun directReplyCannotPublishOrRebindAfterConversationReplacement() =
    conversationTest {
      val reader = runtime.openReply(WearChatMessage("display-id", "assistant", "Preview", null, entryId = "stored-entry", textTruncated = true), runtime.state.value)
      coroutineScope {
        val pending = async { reader.readPage(0, null) }
        val held = next(gateway.replyReads)
        runtime.selectSession("agent:main:replacement")
        held.reply(
          buildJsonObject {
            put("ok", true)
            put(
              "message",
              buildJsonObject {
                put("role", "assistant")
                put("content", "Retired text")
                put("__openclaw", buildJsonObject { put("id", "stored-entry") })
              },
            )
          },
        )
        next(gateway.histories).reply(history("Replacement history"))
        assertEquals(WearReplyTextStatus.Changed, pending.await().status)
      }
      assertEquals(WearReplyTextStatus.Changed, reader.readPage(0, null).status)
      assertTrue("The old reader cannot issue a new request on the replacement", gateway.replyReads.tryReceive().isFailure)
    }

  @Test
  fun directReplyWithoutAdvertisedLookupIsExplicitlyUnsupported() =
    conversationTest {
      gateway.replyTextSupported = false
      runtime.reconnect()
      next(gateway.histories).reply(history("Reconnected"))
      await { runtime.state.value.takeIf { it.messages.singleOrNull()?.text == "Reconnected" } }
      val reader = runtime.openReply(WearChatMessage("display-id", "assistant", "Preview", null, entryId = "stored-entry", textTruncated = true), runtime.state.value)
      assertEquals(WearReplyTextStatus.Unsupported, reader.readPage(0, null).status)
      assertTrue(gateway.replyReads.tryReceive().isFailure)
    }

  @Test
  fun directReplyOpenedFromARetiredScreenCannotReadTheReplacement() =
    conversationTest {
      val selection = runtime.state.value
      val message = WearChatMessage("display-id", "assistant", "Preview", null, entryId = "stored-entry", textTruncated = true)
      runtime.selectSession("agent:main:replacement")
      next(gateway.histories).reply(history("Replacement history"))
      await { runtime.state.value.takeIf { it.messages.singleOrNull()?.text == "Replacement history" } }
      val reader = runtime.openReply(message, selection)
      assertEquals(WearReplyTextStatus.Unavailable, reader.readPage(0, null).status)
      assertTrue(gateway.replyReads.tryReceive().isFailure)
    }

  private fun conversationTest(
    savedGateway: WearGatewaySetup? = null,
    block: suspend Conversation.() -> Unit,
  ) = runBlocking {
    val conversation = Conversation(savedGateway)
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
  private inner class Conversation(
    savedGateway: WearGatewaySetup?,
  ) {
    val gateway = Gateway()
    private val job = SupervisorJob()
    private val scheduler = TestCoroutineScheduler()
    private val context = RuntimeEnvironment.getApplication()
    var failRegistryCommit = false
    var rejectedRegistryCommits = 0
      private set
    private val backing = context.getSharedPreferences("conversation-${UUID.randomUUID()}", Context.MODE_PRIVATE)
    val store =
      WearGatewayStore(
        object : SharedPreferences by backing {
          override fun edit(): SharedPreferences.Editor {
            val edit = backing.edit()
            var writesRegistry = false
            return object : SharedPreferences.Editor by edit {
              override fun putString(
                key: String?,
                value: String?,
              ): SharedPreferences.Editor {
                writesRegistry = writesRegistry || key == GatewayRegistryStore.STORAGE_KEY
                edit.putString(key, value)
                return this
              }

              override fun commit(): Boolean {
                val committed = edit.commit()
                if (failRegistryCommit && writesRegistry) {
                  rejectedRegistryCommits += 1
                  return false
                }
                return committed
              }
            }
          }
        },
      )

    init {
      savedGateway?.let { store.replace(it, DeviceIdentityStore.withPrefs(context, store).loadOrCreate().deviceId) }
    }

    val runtime = WearDirectRuntime(context, CoroutineScope(job + StandardTestDispatcher(scheduler)), store)

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

    suspend fun beginApproval(): Pair<List<Job>, HeldRequest> {
      val approval =
        runtime.state.value.approvals
          .single { it.id == "plugin" }
      val work = operation { runtime.resolve(approval, "deny") }
      return work to next(gateway.approvalGets)
    }

    fun approvalResult(
      status: String,
      applied: Boolean? = null,
    ): JsonObject =
      buildJsonObject {
        put("approval", gateway.approval("plugin", status))
        applied?.let { put("applied", it) }
      }

    fun approvalNotFound(): JsonObject =
      buildJsonObject {
        put("code", "INVALID_REQUEST")
        put("message", "Approval not found")
        put("details", buildJsonObject { put("reason", "APPROVAL_NOT_FOUND") })
      }

    fun advanceRpcDeadline() {
      // Arm the existing RPC timeout only after the server has observed its frame.
      scheduler.runCurrent()
      scheduler.advanceTimeBy(15_000)
      scheduler.runCurrent()
    }

    fun runCurrent() = scheduler.runCurrent()

    suspend fun observeTerminal(
      run: String,
      terminal: String,
    ) {
      gateway.chat(run, "Observed $terminal", state = terminal)
      receiveBarrier("plugin")
    }

    suspend fun receiveBarrier(id: String) {
      // A following same-socket event is a receive-pump barrier, not a render or history claim.
      gateway.event(
        "session.approval",
        buildJsonObject {
          put("sessionKey", "agent:main:main")
          put("phase", "terminal")
          put("updatedAtMs", 2)
          put("approval", gateway.approval(id, status = "denied"))
        },
      )
      await(runTasks = false) { runtime.state.value.takeIf { it.approvals.single { approval -> approval.id == id }.status == "denied" } }
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
    val terminatedOperatorSockets = Channel<Pair<WebSocket, String>>(Channel.UNLIMITED)
    val histories = Channel<HeldRequest>(Channel.UNLIMITED)
    val replyReads = Channel<HeldRequest>(Channel.UNLIMITED)
    val approvalReplays = Channel<HeldRequest>(Channel.UNLIMITED)
    val approvalGets = Channel<HeldRequest>(Channel.UNLIMITED)
    val approvalResolves = Channel<HeldRequest>(Channel.UNLIMITED)
    val sessionLists = Channel<HeldRequest>(Channel.UNLIMITED)
    val approvalRequestCount = AtomicInteger()
    val historyRequestCount = AtomicInteger()
    val sendReplies = Channel<HeldRequest>(Channel.UNLIMITED)
    val stops = Channel<HeldRequest>(Channel.UNLIMITED)
    private val operatorSocket = AtomicReference<WebSocket>()

    @Volatile var answerSend = true

    @Volatile var rejectSend = false

    @Volatile var holdOperatorHello = false

    @Volatile var holdHistory = false

    @Volatile var holdApprovalReplay = false

    @Volatile var holdSessionList = false

    @Volatile var historyMessage: String? = null

    @Volatile var replyTextSupported = true

    @Volatile var agentId = "main"
    val server =
      MockWebServer().apply {
        dispatcher =
          object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse =
              MockResponse().withWebSocketUpgrade(
                object : WebSocketListener() {
                  private var operator = false

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
                          operator = !node
                          if (!node) {
                            operatorSocket.set(webSocket)
                            operatorSockets.trySend(webSocket)
                          }
                          val hello =
                            Json.parseToJsonElement(
                              if (node) {
                                """{"auth":{"role":"node","deviceToken":"watch-node","scopes":[],"deviceTokens":[{"role":"operator","deviceToken":"watch-operator","scopes":["operator.read","operator.write","operator.approvals","operator.questions","operator.talk.secrets"]}]},"snapshot":{"sessionDefaults":{"mainSessionKey":"agent:main:main"}}}"""
                              } else {
                                """{"auth":{"role":"operator","deviceToken":"watch-operator","scopes":["operator.read","operator.write","operator.approvals"]},"snapshot":{"sessionDefaults":{"mainSessionKey":"agent:main:main"}}}"""
                              },
                            )
                          if (node || !replyTextSupported) {
                            hello
                          } else {
                            JsonObject(hello.jsonObject + ("features" to buildJsonObject { put("methods", JsonArray(listOf(JsonPrimitive("chat.message.get")))) }))
                          }
                        }

                        "sessions.list" -> {
                          if (holdSessionList) {
                            sessionLists.trySend(held)
                            return
                          }
                          sessionList("Main")
                        }

                        "sessions.messages.subscribe" -> {
                          approvalRequestCount.incrementAndGet()
                          if (holdApprovalReplay) {
                            approvalReplays.trySend(held)
                            return
                          }
                          approvalReplay(
                            listOf("exec", "plugin", "system-agent").map { approval(it) },
                            key = params.text("key") ?: "agent:main:main",
                          )
                        }

                        "chat.history" -> {
                          historyRequestCount.incrementAndGet()
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

                        "chat.message.get" -> {
                          replyReads.trySend(held)
                          return
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

                        "approval.get" -> {
                          approvalGets.trySend(held)
                          return
                        }

                        "approval.resolve" -> {
                          approvalResolves.trySend(held)
                          return
                        }

                        else -> {
                          held.reply(
                            buildJsonObject {
                              put("code", "INVALID_REQUEST")
                              put("message", "Unknown method")
                            },
                            ok = false,
                          )
                          return
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

                  override fun onClosed(
                    webSocket: WebSocket,
                    code: Int,
                    reason: String,
                  ) {
                    if (operator) terminatedOperatorSockets.trySend(webSocket to "onClosed")
                  }

                  override fun onFailure(
                    webSocket: WebSocket,
                    t: Throwable,
                    response: Response?,
                  ) {
                    // GatewaySession cancels its socket; peer EOF is also terminal evidence.
                    if (operator) terminatedOperatorSockets.trySend(webSocket to "onFailure:${t.javaClass.simpleName}")
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
      sequence: Long? = null,
    ) {
      check(
        operatorSocket.get().send(
          buildJsonObject {
            put("type", "event")
            put("event", name)
            put("payload", payload)
            if (sequence != null) put("seq", sequence)
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

    fun sessionList(title: String): JsonObject =
      buildJsonObject {
        put(
          "sessions",
          JsonArray(
            listOf(
              buildJsonObject {
                put("key", "agent:main:main")
                put("displayName", title)
              },
            ),
          ),
        )
      }

    fun approvalReplay(
      approvals: List<JsonObject>,
      key: String = "agent:main:main",
    ): JsonObject =
      buildJsonObject {
        put("subscribed", true)
        put("key", key)
        put("agentId", agentId)
        put(
          "approvalReplay",
          buildJsonObject {
            put("sessionKey", key)
            put("updatedAtMs", 1)
            put("truncated", false)
            put("approvals", JsonArray(approvals))
          },
        )
      }

    fun approval(
      kind: String,
      status: String = "pending",
    ): JsonObject =
      buildJsonObject {
        put("id", kind)
        put("status", status)
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

    fun acknowledge(
      status: String,
      stopReason: String? = null,
    ) = reply(
      buildJsonObject {
        put("runId", checkNotNull(params.text("idempotencyKey")))
        put("status", status)
        if (status == "timeout") {
          put("summary", "aborted")
          put("endedAt", 1_700_000_000_123L)
          stopReason?.let { put("stopReason", it) }
        }
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
