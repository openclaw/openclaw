package ai.openclaw.app.calls

import ai.openclaw.app.BuildConfig
import ai.openclaw.app.MainActivity
import ai.openclaw.app.NodeApp
import ai.openclaw.app.NodeRuntime
import ai.openclaw.app.gateway.GatewayEndpoint
import ai.openclaw.app.gateway.GatewayRegistryEntry
import ai.openclaw.app.gateway.GatewayRegistryEntryKind
import ai.openclaw.app.gateway.GatewaySession
import ai.openclaw.app.voice.TalkModeManager
import android.Manifest
import android.app.NotificationManager
import android.content.Intent
import android.media.AudioManager
import android.media.AudioRecordingConfiguration
import android.media.MediaRecorder
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.mockwebserver.SocketPolicy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.net.InetAddress
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

/**
 * Opt-in emulator proof for Android incoming-call consent and Gateway authority rejection
 * across invitation admission, delayed startup, and 12-second transport recovery.
 * Uses synthetic in-process loopback peers only; logs redacted symbolic identifiers only.
 */
@RunWith(AndroidJUnit4::class)
class IncomingCallAuthorityRejectionNativeTest {
  companion object {
    private const val LOG_TAG = "IncomingCallAuthProof"
  }

  private class HeldSessionCreate(
    val requestId: String,
    val relayId: String,
    val params: JsonObject,
    private val socket: WebSocket,
  ) {
    fun respondOk(sendReady: Boolean) {
      socket.send("""{"type":"res","id":"$requestId","ok":true,"payload":{"relaySessionId":"$relayId"}}""")
      if (sendReady) sendReadyEvent()
    }

    fun sendReadyEvent() {
      socket.send("""{"type":"event","event":"talk.event","payload":{"relaySessionId":"$relayId","type":"ready"}}""")
    }

    fun respondForbidden(message: String) {
      socket.send("""{"type":"res","id":"$requestId","ok":false,"error":{"code":"FORBIDDEN","message":"$message"}}""")
    }
  }

  private class SyntheticGatewayPeer(
    val symbolicName: String,
  ) : AutoCloseable {
    private val json = Json { ignoreUnknownKeys = true }
    private val sockets = CopyOnWriteArrayList<WebSocket>()
    private val latestNodeSocket = AtomicReference<WebSocket?>(null)
    private val invokeResults = ConcurrentHashMap<String, CompletableDeferred<JsonObject>>()
    val advertisedCommands = AtomicReference<Set<String>>(emptySet())
    val nodeConnectCount = AtomicInteger(0)
    val sessionCreateCount = AtomicInteger(0)
    val outageActive = AtomicBoolean(false)
    val rejectConnectCode = AtomicReference<String?>(null)
    val holdSessionCreate = AtomicBoolean(false)
    val holdRecoveryReady = AtomicBoolean(false)
    val pendingSessionCreate = AtomicReference<CompletableDeferred<HeldSessionCreate>?>(null)

    val server =
      MockWebServer().apply {
        dispatcher =
          object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
              if (outageActive.get()) {
                return MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AT_START)
              }
              return MockResponse().withWebSocketUpgrade(
                object : WebSocketListener() {
                  override fun onOpen(
                    webSocket: WebSocket,
                    response: Response,
                  ) {
                    if (outageActive.get()) {
                      webSocket.cancel()
                      return
                    }
                    sockets += webSocket
                    webSocket.send(
                      """{"type":"event","event":"connect.challenge","payload":{"nonce":"proof-nonce","ts":${System.currentTimeMillis()}}}""",
                    )
                  }

                  override fun onMessage(
                    webSocket: WebSocket,
                    text: String,
                  ) {
                    val frame = runCatching { json.parseToJsonElement(text).jsonObject }.getOrNull() ?: return
                    if (frame["type"]?.jsonPrimitive?.contentOrNull != "req") return
                    val id = frame["id"]?.jsonPrimitive?.contentOrNull ?: return
                    val method = frame["method"]?.jsonPrimitive?.contentOrNull ?: return
                    val params = frame["params"]?.jsonObject ?: JsonObject(emptyMap())
                    when (method) {
                      "connect" -> {
                        val revokedCode = rejectConnectCode.get()
                        if (revokedCode != null) {
                          webSocket.send(
                            """{"type":"res","id":"$id","ok":false,"error":{"code":"UNAUTHORIZED","message":"device pairing revoked","details":{"code":"$revokedCode","pauseReconnect":true}}}""",
                          )
                          webSocket.close(4001, "revoked")
                          return
                        }
                        val role = params["role"]?.jsonPrimitive?.contentOrNull.orEmpty()
                        if (role == "node") {
                          val commands =
                            params["commands"]
                              ?.jsonArray
                              ?.mapNotNull { it.jsonPrimitive.contentOrNull }
                              ?.toSet()
                              .orEmpty()
                          advertisedCommands.set(commands)
                          latestNodeSocket.set(webSocket)
                          nodeConnectCount.incrementAndGet()
                        }
                        webSocket.send(
                          """{"type":"res","id":"$id","ok":true,"payload":{"type":"hello-ok","server":{"host":"$symbolicName"},"features":{"methods":["agents.list","talk.catalog","talk.config","talk.session.create","talk.session.appendAudio","talk.session.close"],"capabilities":["talk-session-close-disposition"]},"snapshot":{"sessionDefaults":{"mainSessionKey":"main"}}}}""",
                        )
                      }

                      "agents.list" -> {
                        webSocket.send("""{"type":"res","id":"$id","ok":true,"payload":{"defaultId":"main","mainKey":"main","agents":[{"id":"main"}]}}""")
                      }

                      "talk.catalog" -> {
                        webSocket.send("""{"type":"res","id":"$id","ok":true,"payload":{"realtime":{"ready":true,"activeProvider":"openai","providers":[{"id":"openai","configured":true,"modes":["realtime"],"transports":["gateway-relay"],"brains":["agent-consult"]}]}}}""")
                      }

                      "talk.config" -> {
                        webSocket.send("""{"type":"res","id":"$id","ok":true,"payload":{"config":{"mode":"realtime","transport":"gateway-relay"}}}""")
                      }

                      "talk.session.create" -> {
                        val index = sessionCreateCount.incrementAndGet()
                        val relayId = "$symbolicName-relay-$index"
                        val held = HeldSessionCreate(id, relayId, params, webSocket)
                        when {
                          holdSessionCreate.get() -> {
                            pendingSessionCreate.get()?.complete(held)
                          }

                          holdRecoveryReady.get() -> {
                            held.respondOk(sendReady = false)
                            pendingSessionCreate.get()?.complete(held)
                          }

                          else -> {
                            held.respondOk(sendReady = true)
                          }
                        }
                      }

                      "node.invoke.result" -> {
                        val invokeId = params["id"]?.jsonPrimitive?.contentOrNull
                        if (invokeId != null) invokeResults.remove(invokeId)?.complete(params)
                        webSocket.send("""{"type":"res","id":"$id","ok":true,"payload":{"ok":true}}""")
                      }

                      else -> {
                        webSocket.send("""{"type":"res","id":"$id","ok":true,"payload":{}}""")
                      }
                    }
                  }
                },
              )
            }
          }
        start(InetAddress.getByName("127.0.0.1"), 0)
      }

    val endpoint: GatewayEndpoint = GatewayEndpoint.manual("127.0.0.1", server.port, tlsEnabled = false)

    fun armPendingSessionCreate(): CompletableDeferred<HeldSessionCreate> = CompletableDeferred<HeldSessionCreate>().also { pendingSessionCreate.set(it) }

    suspend fun sendNodeInvoke(
      command: String,
      paramsJson: String,
    ): JsonObject {
      val invokeId = "inv-${UUID.randomUUID()}"
      val deferred = CompletableDeferred<JsonObject>()
      invokeResults[invokeId] = deferred
      val socket = checkNotNull(latestNodeSocket.get()) { "Missing active node socket for $symbolicName" }
      val frame =
        buildJsonObject {
          put("type", "event")
          put("event", "node.invoke.request")
          put(
            "payload",
            buildJsonObject {
              put("id", invokeId)
              put("nodeId", "synthetic-node")
              put("command", command)
              put("paramsJSON", paramsJson)
              put("timeoutMs", 5_000)
            },
          )
        }.toString()
      check(socket.send(frame)) { "Node socket closed before invoke dispatch on $symbolicName" }
      return withTimeout(8_000) { deferred.await() }
    }

    fun beginOutage() {
      outageActive.set(true)
      dropSockets(1012, "synthetic outage")
    }

    fun endOutage() {
      outageActive.set(false)
    }

    fun revokeNodeOnly(code: String = "PAIRING_REQUIRED") {
      rejectConnectCode.set(code)
      latestNodeSocket.getAndSet(null)?.let { node ->
        sockets.remove(node)
        runCatching { node.close(4001, "node revoked") }
        runCatching { node.cancel() }
      }
    }

    fun revokeDeviceAuth(code: String = "PAIRING_REQUIRED") {
      rejectConnectCode.set(code)
      dropSockets(4001, "device revoked")
    }

    fun restoreDeviceAuth() {
      rejectConnectCode.set(null)
    }

    private fun dropSockets(
      code: Int,
      reason: String,
    ) {
      val active = sockets.toList()
      sockets.clear()
      latestNodeSocket.set(null)
      active.forEach { socket ->
        runCatching { socket.close(code, reason) }
        runCatching { socket.cancel() }
      }
    }

    override fun close() {
      dropSockets(1000, "test complete")
      runCatching { server.shutdown() }
    }
  }

  private class OsMicMonitor(
    private val audioManager: AudioManager,
  ) : AutoCloseable {
    private val activeCount = AtomicInteger(0)
    val phaseStarts = AtomicInteger(0)
    val phasePeak = AtomicInteger(0)

    private val callback =
      object : AudioManager.AudioRecordingCallback() {
        override fun onRecordingConfigChanged(configs: List<AudioRecordingConfiguration>) {
          observe(configs)
        }
      }

    init {
      audioManager.registerAudioRecordingCallback(callback, Handler(Looper.getMainLooper()))
      observe(audioManager.activeRecordingConfigurations)
    }

    fun sampleNow(): Int {
      observe(audioManager.activeRecordingConfigurations)
      return activeCount.get()
    }

    fun resetPhase() {
      observe(audioManager.activeRecordingConfigurations)
      phaseStarts.set(0)
      phasePeak.set(activeCount.get())
    }

    private fun observe(configs: List<AudioRecordingConfiguration>) {
      val voiceCommCount = configs.count { it.clientAudioSource == MediaRecorder.AudioSource.VOICE_COMMUNICATION }
      val previous = activeCount.getAndSet(voiceCommCount)
      if (previous == 0 && voiceCommCount > 0) phaseStarts.incrementAndGet()
      phasePeak.updateAndGet { maxOf(it, voiceCommCount) }
    }

    override fun close() {
      audioManager.unregisterAudioRecordingCallback(callback)
    }
  }

  @Test
  fun incomingCallAuthorityRejectionProof() =
    runBlocking<Unit> {
      val instrumentation = InstrumentationRegistry.getInstrumentation()
      val args = InstrumentationRegistry.getArguments()
      assumeTrue(
        "Opt-in Android authority rejection proof harness",
        args.getString("incomingAuthorityProof") == "true",
      )
      check(Build.HARDWARE in setOf("ranchu", "goldfish")) { "Disposable emulator required" }
      args.getString("candidateSha")?.let { expectedSha ->
        assertEquals("APK BuildConfig.GIT_COMMIT must match candidate commit", expectedSha, BuildConfig.GIT_COMMIT)
      }

      val context = instrumentation.targetContext
      listOf(Manifest.permission.RECORD_AUDIO, Manifest.permission.POST_NOTIFICATIONS).forEach { permission ->
        instrumentation.uiAutomation.grantRuntimePermission(context.packageName, permission)
      }
      val app = context.applicationContext as NodeApp
      val previousOnboarding = app.prefs.onboardingCompleted.value
      val previousEntries = app.prefs.gatewayRegistry.entries.value
      val previousActiveId = app.prefs.gatewayRegistry.activeStableId.value
      val previousConnectedIds = app.prefs.gatewayRegistry.connectedStableIds.value
      withContext(Dispatchers.Main) {
        app.prefs.setOnboardingCompleted(true)
        previousConnectedIds.forEach { existingId ->
          app.prefs.gatewayRegistry.setConnectionEnabled(existingId, false)
        }
      }
      val device = UiDevice.getInstance(instrumentation)
      context.startActivity(
        Intent(context, MainActivity::class.java)
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK),
      )
      assertNotNull(device.wait(Until.findObject(By.pkg(context.packageName)), 20_000))

      val runtime = app.ensureBackgroundRuntime()
      val calls = runtime.incomingCalls
      val talk =
        runtime.javaClass
          .getDeclaredField("talkMode\$delegate")
          .apply { isAccessible = true }
          .let { (it.get(runtime) as Lazy<*>).value as TalkModeManager }
      val nodeSession =
        runtime.javaClass
          .getDeclaredField("nodeSession")
          .apply { isAccessible = true }
          .get(runtime) as GatewaySession
      val operatorSession =
        runtime.javaClass
          .getDeclaredField("operatorSession")
          .apply { isAccessible = true }
          .get(runtime) as GatewaySession

      val notifications = context.getSystemService(NotificationManager::class.java)
      val audioManager = context.getSystemService(AudioManager::class.java)
      val cases = mutableListOf<JsonObject>()
      val lastRecoveryElapsedMs = AtomicLong(0L)

      fun hasCallNotification(): Boolean = notifications.activeNotifications.any { it.id == IncomingCallController.NOTIFICATION_ID }

      fun inviteJson(callId: String): String =
        buildJsonObject {
          put("callId", callId)
          put("sessionKey", "agent:assistant:synthetic-authority-proof")
          put("callerName", "Assistant · synthetic proof")
          put("topic", "Synthetic authority proof")
          put("expiresAtMs", System.currentTimeMillis() + 60_000)
        }.toString()

      suspend fun awaitCondition(
        description: String,
        timeoutMs: Long = 12_000L,
        predicate: () -> Boolean,
      ) {
        val deadline = SystemClock.elapsedRealtime() + timeoutMs
        while (!predicate()) {
          check(SystemClock.elapsedRealtime() < deadline) { "Timed out waiting for $description" }
          delay(40L)
        }
      }

      suspend fun connectAndAwaitReady(
        peer: SyntheticGatewayPeer,
        token: String,
      ) {
        val beforeConnects = peer.nodeConnectCount.get()
        withContext(Dispatchers.Main) {
          app.prefs.gatewayRegistry.upsert(
            GatewayRegistryEntry(
              stableId = peer.endpoint.stableId,
              kind = GatewayRegistryEntryKind.MANUAL,
              name = peer.symbolicName,
              host = peer.endpoint.host,
              port = peer.endpoint.port,
              tls = false,
            ),
          )
          app.prefs.saveGatewayCredentials(peer.endpoint.stableId, token = token, password = null)
          runtime.connect(
            peer.endpoint,
            NodeRuntime.GatewayConnectAuth(token = token, bootstrapToken = null, password = null),
          )
        }
        awaitCondition("Gateway ${peer.symbolicName} node+operator ready", timeoutMs = 15_000L) {
          runtime.gatewayConnectionDisplay.value.isConnected &&
            runtime.nodeConnected.value &&
            nodeSession.isReady() &&
            operatorSession.isReady() &&
            app.prefs.gatewayRegistry.activeStableId.value == peer.endpoint.stableId &&
            peer.nodeConnectCount.get() > beforeConnects
        }
      }

      suspend fun setConsentAndAwaitRefresh(
        peer: SyntheticGatewayPeer,
        enabled: Boolean,
      ) {
        val beforeConnects = peer.nodeConnectCount.get()
        withContext(Dispatchers.Main) {
          runtime.setIncomingCallsEnabled(enabled)
        }
        awaitCondition("Gateway ${peer.symbolicName} consent=$enabled refresh", timeoutMs = 15_000L) {
          app.prefs.incomingCallsEnabled.value == enabled &&
            runtime.gatewayConnectionDisplay.value.isConnected &&
            runtime.nodeConnected.value &&
            nodeSession.isReady() &&
            operatorSession.isReady() &&
            peer.nodeConnectCount.get() > beforeConnects &&
            ("talk.incoming" in peer.advertisedCommands.get()) == enabled
        }
      }

      fun recordCase(
        caseId: String,
        gateway: String,
        gate: String,
        telecomRinging: Boolean,
        finalStatus: String,
        osMicStarts: Int,
        osMicPeak: Int,
        extra: Map<String, JsonPrimitive> = emptyMap(),
      ) {
        val entry =
          buildJsonObject {
            put("caseId", caseId)
            put("commitSha", BuildConfig.GIT_COMMIT)
            put("gateway", gateway)
            put("gate", gate)
            put("telecomRinging", telecomRinging)
            put("finalCallStatus", finalStatus)
            put("talkListening", talk.isListening.value)
            put("osMicStarts", osMicStarts)
            put("osMicPeak", osMicPeak)
            extra.forEach { (key, value) -> put(key, value) }
            put("passed", true)
          }
        cases += entry
        Log.i(
          LOG_TAG,
          "CASE case=$caseId sha=${BuildConfig.GIT_COMMIT} gw=$gateway gate=$gate ringing=$telecomRinging status=$finalStatus talkListening=${talk.isListening.value} osMicStarts=$osMicStarts osMicPeak=$osMicPeak extra=$extra",
        )
      }

      OsMicMonitor(audioManager).use { mic ->
        SyntheticGatewayPeer("gw-alpha").use { alpha ->
          SyntheticGatewayPeer("gw-beta").use { beta ->
            try {
              // 1. absent_consent: fresh Gateway connection defaults to incomingCallsEnabled=false.
              app.prefs.gatewayRegistry.remove(alpha.endpoint.stableId)
              app.prefs.gatewayRegistry.remove(beta.endpoint.stableId)
              connectAndAwaitReady(alpha, "synthetic-alpha-token")
              assertFalse(app.prefs.incomingCallsEnabled.value)
              assertFalse("talk.incoming" in alpha.advertisedCommands.get())
              mic.resetPhase()
              val absentBeforeCreates = alpha.sessionCreateCount.get()
              val absentInvoke = alpha.sendNodeInvoke("talk.incoming", inviteJson(UUID.randomUUID().toString()))
              assertEquals(false, absentInvoke["ok"]?.jsonPrimitive?.booleanOrNull)
              val absentCode =
                absentInvoke["error"]
                  ?.jsonObject
                  ?.get("code")
                  ?.jsonPrimitive
                  ?.contentOrNull
                  .orEmpty()
              assertEquals("CALL_DISABLED", absentCode)
              delay(300L)
              assertFalse(hasCallNotification())
              assertEquals(absentBeforeCreates, alpha.sessionCreateCount.get())
              assertEquals(0, mic.phaseStarts.get())
              assertEquals(0, mic.sampleNow())
              recordCase(
                caseId = "absent_consent",
                gateway = alpha.symbolicName,
                gate = "invoke_dispatcher_before_ringing",
                telecomRinging = false,
                finalStatus =
                  calls.state.value
                    ?.status
                    ?.name
                    ?.lowercase() ?: "idle",
                osMicStarts = mic.phaseStarts.get(),
                osMicPeak = mic.phasePeak.get(),
                extra =
                  mapOf(
                    "invokeErrorCode" to JsonPrimitive(absentCode),
                    "commandAdvertised" to JsonPrimitive(false),
                  ),
              )

              // Positive control: prove OsMicMonitor observes real AudioRecord VOICE_COMMUNICATION after Answer.
              setConsentAndAwaitRefresh(alpha, true)
              mic.resetPhase()
              val controlId = UUID.randomUUID().toString()
              val controlInvoke = alpha.sendNodeInvoke("talk.incoming", inviteJson(controlId))
              assertEquals(true, controlInvoke["ok"]?.jsonPrimitive?.booleanOrNull)
              awaitCondition("Telecom CallStyle ringing notification") {
                calls.state.value
                  ?.invite
                  ?.callId == controlId &&
                  calls.state.value?.status == IncomingCallStatus.Ringing &&
                  hasCallNotification()
              }
              assertEquals("Ringing must never open microphone", 0, mic.phaseStarts.get())
              withContext(Dispatchers.Main) { calls.answer(controlId) }
              awaitCondition("Answered control call active + OS AudioRecord started") {
                calls.state.value?.status == IncomingCallStatus.Active &&
                  talk.isListening.value &&
                  mic.sampleNow() > 0
              }
              val controlMicStarts = mic.phaseStarts.get()
              val controlMicPeak = mic.phasePeak.get()
              assertTrue("Positive control must observe real OS VOICE_COMMUNICATION capture", controlMicStarts >= 1 && controlMicPeak >= 1)
              withContext(Dispatchers.Main) { calls.end(controlId) }
              awaitCondition("Control call teardown releases OS AudioRecord") {
                calls.state.value?.status == IncomingCallStatus.Ended &&
                  !talk.isListening.value &&
                  mic.sampleNow() == 0
              }
              recordCase(
                caseId = "permitted_post_answer_control",
                gateway = alpha.symbolicName,
                gate = "authorized_baseline",
                telecomRinging = true,
                finalStatus = "ended",
                osMicStarts = controlMicStarts,
                osMicPeak = controlMicPeak,
              )

              // 2a. withdrawn_consent_before_ringing: consent revoked -> rejected before Telecom ringing and mic capture.
              setConsentAndAwaitRefresh(alpha, false)
              mic.resetPhase()
              val withdrawnPreCreates = alpha.sessionCreateCount.get()
              val withdrawnPreInvoke = alpha.sendNodeInvoke("talk.incoming", inviteJson(UUID.randomUUID().toString()))
              val withdrawnPreCode =
                withdrawnPreInvoke["error"]
                  ?.jsonObject
                  ?.get("code")
                  ?.jsonPrimitive
                  ?.contentOrNull
                  .orEmpty()
              assertEquals("CALL_DISABLED", withdrawnPreCode)
              val directDefense = calls.invoke("talk.incoming", inviteJson(UUID.randomUUID().toString()))
              assertFalse(directDefense.ok)
              assertEquals("CALL_UNAVAILABLE", directDefense.error?.code)
              delay(300L)
              assertFalse(hasCallNotification())
              assertEquals(withdrawnPreCreates, alpha.sessionCreateCount.get())
              assertEquals(0, mic.phaseStarts.get())
              assertEquals(0, mic.sampleNow())
              recordCase(
                caseId = "withdrawn_consent_before_ringing",
                gateway = alpha.symbolicName,
                gate = "invoke_and_controller_before_ringing",
                telecomRinging = false,
                finalStatus = "idle",
                osMicStarts = mic.phaseStarts.get(),
                osMicPeak = mic.phasePeak.get(),
                extra =
                  mapOf(
                    "invokeErrorCode" to JsonPrimitive(withdrawnPreCode),
                    "controllerDefenseCode" to JsonPrimitive(directDefense.error?.code.orEmpty()),
                  ),
              )

              // 2b. withdrawn_consent_delayed_startup: consent withdrawn while post-Answer talk.session.create is pending.
              setConsentAndAwaitRefresh(alpha, true)
              alpha.holdSessionCreate.set(true)
              val delayedConsentCreate = alpha.armPendingSessionCreate()
              mic.resetPhase()
              val delayedConsentId = UUID.randomUUID().toString()
              assertEquals(true, alpha.sendNodeInvoke("talk.incoming", inviteJson(delayedConsentId))["ok"]?.jsonPrimitive?.booleanOrNull)
              awaitCondition("Ringing before delayed startup withdrawal") {
                calls.state.value
                  ?.invite
                  ?.callId == delayedConsentId && calls.state.value?.status == IncomingCallStatus.Ringing
              }
              withContext(Dispatchers.Main) { calls.answer(delayedConsentId) }
              val heldConsentStartup = withTimeout(10_000L) { delayedConsentCreate.await() }
              assertEquals(IncomingCallStatus.Connecting, calls.state.value?.status)
              assertEquals(0, mic.phaseStarts.get())
              alpha.holdSessionCreate.set(false)
              withContext(Dispatchers.Main) { runtime.setIncomingCallsEnabled(false) }
              heldConsentStartup.respondOk(sendReady = true)
              awaitCondition("Delayed startup ends after consent withdrawal") {
                calls.state.value
                  ?.invite
                  ?.callId == delayedConsentId &&
                  calls.state.value?.status == IncomingCallStatus.Ended &&
                  !talk.isListening.value
              }
              delay(400L)
              assertEquals(0, mic.phaseStarts.get())
              assertEquals(0, mic.sampleNow())
              awaitCondition("Gateway reconnect settles after consent withdrawal") {
                runtime.gatewayConnectionDisplay.value.isConnected && runtime.nodeConnected.value
              }
              recordCase(
                caseId = "withdrawn_consent_delayed_startup",
                gateway = alpha.symbolicName,
                gate = "delayed_session_create_consent_withdrawn",
                telecomRinging = true,
                finalStatus =
                  calls.state.value
                    ?.status
                    ?.name
                    ?.lowercase()
                    .orEmpty(),
                osMicStarts = mic.phaseStarts.get(),
                osMicPeak = mic.phasePeak.get(),
              )

              // Helper to establish an answered active call, run a real >=12s outage, and hold recovery provider readiness.
              suspend fun enterTwelveSecondRecoveryHeldAtReady(peer: SyntheticGatewayPeer): Pair<String, HeldSessionCreate> {
                val id = UUID.randomUUID().toString()
                assertEquals(true, peer.sendNodeInvoke("talk.incoming", inviteJson(id))["ok"]?.jsonPrimitive?.booleanOrNull)
                awaitCondition("Call $id ringing") {
                  calls.state.value
                    ?.invite
                    ?.callId == id && calls.state.value?.status == IncomingCallStatus.Ringing
                }
                withContext(Dispatchers.Main) { calls.answer(id) }
                awaitCondition("Call $id active before outage") {
                  calls.state.value?.status == IncomingCallStatus.Active && mic.sampleNow() > 0
                }
                val outageStartedAt = SystemClock.elapsedRealtime()
                peer.beginOutage()
                awaitCondition("Outage stops active microphone immediately") {
                  calls.state.value?.status == IncomingCallStatus.Connecting &&
                    !talk.isListening.value &&
                    mic.sampleNow() == 0
                }
                mic.resetPhase()
                delay(12_200L)
                peer.holdRecoveryReady.set(true)
                val recoveryCreate = peer.armPendingSessionCreate()
                peer.endOutage()
                nodeSession.retryAfterNetworkRestore()
                operatorSession.retryAfterNetworkRestore()
                val heldRecovery = withTimeout(15_000L) { recoveryCreate.await() }
                peer.holdRecoveryReady.set(false)
                val reportedElapsed =
                  heldRecovery.params["recovery"]
                    ?.jsonObject
                    ?.get("interruptedForMs")
                    ?.jsonPrimitive
                    ?.longOrNull ?: 0L
                val wallElapsed = SystemClock.elapsedRealtime() - outageStartedAt
                lastRecoveryElapsedMs.set(maxOf(reportedElapsed, wallElapsed))
                assertTrue("Recovery metadata must reflect >=12s outage (got $reportedElapsed ms)", reportedElapsed >= 12_000L)
                assertEquals("Microphone must remain closed while provider ready is delayed", 0, mic.phaseStarts.get())
                assertEquals(0, mic.sampleNow())
                return id to heldRecovery
              }

              // 2c. withdrawn_consent_recovery_12s: consent withdrawn during delayed 12s recovery readiness.
              setConsentAndAwaitRefresh(alpha, true)
              val (recoveryConsentId, heldConsentRecovery) = enterTwelveSecondRecoveryHeldAtReady(alpha)
              withContext(Dispatchers.Main) { runtime.setIncomingCallsEnabled(false) }
              heldConsentRecovery.sendReadyEvent()
              awaitCondition("12s recovery ends on consent withdrawal") {
                calls.state.value
                  ?.invite
                  ?.callId == recoveryConsentId &&
                  calls.state.value?.status == IncomingCallStatus.Ended &&
                  !talk.isListening.value
              }
              delay(500L)
              assertEquals(0, mic.phaseStarts.get())
              assertEquals(0, mic.sampleNow())
              awaitCondition("Gateway reconnect settles after recovery consent withdrawal") {
                runtime.gatewayConnectionDisplay.value.isConnected && runtime.nodeConnected.value
              }
              recordCase(
                caseId = "withdrawn_consent_recovery_12s",
                gateway = alpha.symbolicName,
                gate = "recovery_delayed_ready_consent_withdrawn",
                telecomRinging = false,
                finalStatus =
                  calls.state.value
                    ?.status
                    ?.name
                    ?.lowercase()
                    .orEmpty(),
                osMicStarts = mic.phaseStarts.get(),
                osMicPeak = mic.phasePeak.get(),
                extra = mapOf("recoveryInterruptedForMs" to JsonPrimitive(lastRecoveryElapsedMs.get())),
              )

              // 3a. revoked_source_before_ringing: device auth revoked -> call admission rejected before ringing and mic capture.
              setConsentAndAwaitRefresh(alpha, true)
              mic.resetPhase()
              alpha.revokeDeviceAuth("PAIRING_REQUIRED")
              awaitCondition("Revoked source disconnects Gateway sessions") {
                !runtime.nodeConnected.value && !runtime.gatewayConnectionDisplay.value.isConnected
              }
              val revokedPreResult = calls.invoke("talk.incoming", inviteJson(UUID.randomUUID().toString()))
              assertFalse(revokedPreResult.ok)
              assertEquals("CALL_UNAVAILABLE", revokedPreResult.error?.code)
              delay(300L)
              assertFalse(hasCallNotification())
              assertEquals(0, mic.phaseStarts.get())
              assertEquals(0, mic.sampleNow())
              recordCase(
                caseId = "revoked_source_before_ringing",
                gateway = alpha.symbolicName,
                gate = "revoked_device_auth_before_ringing",
                telecomRinging = false,
                finalStatus = "idle",
                osMicStarts = mic.phaseStarts.get(),
                osMicPeak = mic.phasePeak.get(),
                extra = mapOf("rejectCode" to JsonPrimitive(revokedPreResult.error?.code.orEmpty())),
              )

              // 3b. revoked_source_delayed_startup: source authority revoked while post-Answer startup is delayed.
              alpha.restoreDeviceAuth()
              connectAndAwaitReady(alpha, "synthetic-alpha-token")
              assertTrue(app.prefs.incomingCallsEnabled.value)
              alpha.holdSessionCreate.set(true)
              val delayedRevokeCreate = alpha.armPendingSessionCreate()
              mic.resetPhase()
              val delayedRevokeId = UUID.randomUUID().toString()
              assertEquals(true, alpha.sendNodeInvoke("talk.incoming", inviteJson(delayedRevokeId))["ok"]?.jsonPrimitive?.booleanOrNull)
              awaitCondition("Ringing before delayed startup revocation") {
                calls.state.value
                  ?.invite
                  ?.callId == delayedRevokeId && calls.state.value?.status == IncomingCallStatus.Ringing
              }
              withContext(Dispatchers.Main) { calls.answer(delayedRevokeId) }
              val heldRevokeStartup = withTimeout(10_000L) { delayedRevokeCreate.await() }
              alpha.holdSessionCreate.set(false)
              assertEquals(0, mic.phaseStarts.get())
              heldRevokeStartup.respondForbidden("device authority revoked")
              alpha.revokeDeviceAuth("PAIRING_REQUIRED")
              awaitCondition("Delayed startup terminates on source revocation") {
                calls.state.value
                  ?.invite
                  ?.callId == delayedRevokeId &&
                  calls.state.value
                    ?.status
                    ?.isTerminal == true &&
                  !talk.isListening.value
              }
              delay(500L)
              assertEquals(0, mic.phaseStarts.get())
              assertEquals(0, mic.sampleNow())
              recordCase(
                caseId = "revoked_source_delayed_startup",
                gateway = alpha.symbolicName,
                gate = "delayed_session_create_source_revoked",
                telecomRinging = true,
                finalStatus =
                  calls.state.value
                    ?.status
                    ?.name
                    ?.lowercase()
                    .orEmpty(),
                osMicStarts = mic.phaseStarts.get(),
                osMicPeak = mic.phasePeak.get(),
              )

              // 3c. revoked_source_recovery_12s: source authority revoked during 12s recovery before provider ready.
              alpha.restoreDeviceAuth()
              connectAndAwaitReady(alpha, "synthetic-alpha-token")
              val (recoveryRevokeId, heldRevokeRecovery) = enterTwelveSecondRecoveryHeldAtReady(alpha)
              alpha.revokeNodeOnly("PAIRING_REQUIRED")
              awaitCondition("Node socket disconnect observed before auth-rejected reconnect") {
                !runtime.nodeConnected.value
              }
              nodeSession.retryAfterNetworkRestore()
              awaitCondition("Node auth revocation invalidates active call") {
                !runtime.nodeConnected.value &&
                  calls.state.value
                    ?.invite
                    ?.callId == recoveryRevokeId &&
                  calls.state.value
                    ?.status
                    ?.isTerminal == true
              }
              heldRevokeRecovery.sendReadyEvent()
              alpha.revokeDeviceAuth("PAIRING_REQUIRED")
              awaitCondition("Operator socket disconnect observed") {
                !runtime.gatewayConnectionDisplay.value.isConnected
              }
              operatorSession.retryAfterNetworkRestore()
              delay(600L)
              assertFalse(talk.isListening.value)
              assertEquals(0, mic.phaseStarts.get())
              assertEquals(0, mic.sampleNow())
              recordCase(
                caseId = "revoked_source_recovery_12s",
                gateway = alpha.symbolicName,
                gate = "recovery_delayed_ready_source_revoked",
                telecomRinging = false,
                finalStatus =
                  calls.state.value
                    ?.status
                    ?.name
                    ?.lowercase()
                    .orEmpty(),
                osMicStarts = mic.phaseStarts.get(),
                osMicPeak = mic.phasePeak.get(),
                extra = mapOf("recoveryInterruptedForMs" to JsonPrimitive(lastRecoveryElapsedMs.get())),
              )

              // 4a. reassigned_gateway_delayed_startup: active Gateway switched to gw-beta during delayed startup.
              alpha.restoreDeviceAuth()
              connectAndAwaitReady(alpha, "synthetic-alpha-token")
              assertTrue(app.prefs.incomingCallsEnabled.value)
              alpha.holdSessionCreate.set(true)
              val delayedReassignCreate = alpha.armPendingSessionCreate()
              mic.resetPhase()
              val delayedReassignId = UUID.randomUUID().toString()
              assertEquals(true, alpha.sendNodeInvoke("talk.incoming", inviteJson(delayedReassignId))["ok"]?.jsonPrimitive?.booleanOrNull)
              awaitCondition("Ringing before delayed Gateway reassignment") {
                calls.state.value
                  ?.invite
                  ?.callId == delayedReassignId && calls.state.value?.status == IncomingCallStatus.Ringing
              }
              withContext(Dispatchers.Main) { calls.answer(delayedReassignId) }
              val heldReassignStartup = withTimeout(10_000L) { delayedReassignCreate.await() }
              alpha.holdSessionCreate.set(false)
              assertEquals(0, mic.phaseStarts.get())
              connectAndAwaitReady(beta, "synthetic-beta-token")
              heldReassignStartup.respondOk(sendReady = true)
              awaitCondition("Reassigned Gateway ends gw-alpha call and keeps gw-beta opted out") {
                calls.state.value?.status == IncomingCallStatus.Ended &&
                  !app.prefs.incomingCallsEnabled.value &&
                  !app.prefs.isIncomingCallAllowed(beta.endpoint.stableId) &&
                  "talk.incoming" !in beta.advertisedCommands.get() &&
                  !talk.isListening.value
              }
              val betaStartupReject = beta.sendNodeInvoke("talk.incoming", inviteJson(UUID.randomUUID().toString()))
              val betaStartupCode =
                betaStartupReject["error"]
                  ?.jsonObject
                  ?.get("code")
                  ?.jsonPrimitive
                  ?.contentOrNull
                  .orEmpty()
              assertEquals("CALL_DISABLED", betaStartupCode)
              delay(400L)
              assertEquals(0, mic.phaseStarts.get())
              assertEquals(0, mic.sampleNow())
              recordCase(
                caseId = "reassigned_gateway_delayed_startup",
                gateway = "${alpha.symbolicName}->${beta.symbolicName}",
                gate = "delayed_session_create_gateway_reassigned",
                telecomRinging = true,
                finalStatus =
                  calls.state.value
                    ?.status
                    ?.name
                    ?.lowercase()
                    .orEmpty(),
                osMicStarts = mic.phaseStarts.get(),
                osMicPeak = mic.phasePeak.get(),
                extra =
                  mapOf(
                    "consentTransferredToNewGateway" to JsonPrimitive(false),
                    "newGatewayInvokeErrorCode" to JsonPrimitive(betaStartupCode),
                  ),
              )

              // 4b. reassigned_gateway_recovery_12s: active Gateway switched to gw-beta during 12s recovery before ready.
              connectAndAwaitReady(alpha, "synthetic-alpha-token")
              assertTrue("gw-alpha retains its own scoped consent", app.prefs.incomingCallsEnabled.value)
              val (recoveryReassignId, heldReassignRecovery) = enterTwelveSecondRecoveryHeldAtReady(alpha)
              connectAndAwaitReady(beta, "synthetic-beta-token")
              heldReassignRecovery.sendReadyEvent()
              awaitCondition("12s recovery ends when active Gateway switches to gw-beta") {
                calls.state.value
                  ?.invite
                  ?.callId == recoveryReassignId &&
                  calls.state.value?.status == IncomingCallStatus.Ended &&
                  !app.prefs.incomingCallsEnabled.value &&
                  "talk.incoming" !in beta.advertisedCommands.get() &&
                  !talk.isListening.value
              }
              val betaRecoveryReject = beta.sendNodeInvoke("talk.incoming", inviteJson(UUID.randomUUID().toString()))
              val betaRecoveryCode =
                betaRecoveryReject["error"]
                  ?.jsonObject
                  ?.get("code")
                  ?.jsonPrimitive
                  ?.contentOrNull
                  .orEmpty()
              assertEquals("CALL_DISABLED", betaRecoveryCode)
              delay(500L)
              assertEquals(0, mic.phaseStarts.get())
              assertEquals(0, mic.sampleNow())
              recordCase(
                caseId = "reassigned_gateway_recovery_12s",
                gateway = "${alpha.symbolicName}->${beta.symbolicName}",
                gate = "recovery_delayed_ready_gateway_reassigned",
                telecomRinging = false,
                finalStatus =
                  calls.state.value
                    ?.status
                    ?.name
                    ?.lowercase()
                    .orEmpty(),
                osMicStarts = mic.phaseStarts.get(),
                osMicPeak = mic.phasePeak.get(),
                extra =
                  mapOf(
                    "recoveryInterruptedForMs" to JsonPrimitive(lastRecoveryElapsedMs.get()),
                    "consentTransferredToNewGateway" to JsonPrimitive(false),
                    "newGatewayInvokeErrorCode" to JsonPrimitive(betaRecoveryCode),
                  ),
              )

              val summary =
                buildJsonObject {
                  put("passed", true)
                  put("commitSha", BuildConfig.GIT_COMMIT)
                  put("sdkInt", Build.VERSION.SDK_INT)
                  put("hardware", Build.HARDWARE)
                  put("caseCount", cases.size)
                  put("cases", JsonArray(cases))
                }
              File(context.filesDir, "incoming-call-authority-proof.json").writeText(summary.toString())
              Log.i(LOG_TAG, "SUMMARY commitSha=${BuildConfig.GIT_COMMIT} sdkInt=${Build.VERSION.SDK_INT} caseCount=${cases.size} passed=true")
              instrumentation.sendStatus(
                0,
                Bundle().apply {
                  putString("stream", "INCOMING_CALL_AUTHORITY_PROOF $summary\n")
                },
              )
            } finally {
              withContext(NonCancellable + Dispatchers.Main) {
                calls.invalidate()
                runtime.disconnect()
                listOf(alpha.endpoint.stableId, beta.endpoint.stableId).forEach { stableId ->
                  if (app.prefs.gatewayRegistry.entries.value
                      .any { it.stableId == stableId }
                  ) {
                    app.prefs.gatewayRegistry.setActive(stableId)
                    app.prefs.setIncomingCallsEnabled(false, stableId)
                  }
                  app.prefs.gatewayRegistry.remove(stableId)
                }
                previousEntries.forEach { app.prefs.gatewayRegistry.upsert(it) }
                previousConnectedIds.forEach { connectedId ->
                  if (app.prefs.gatewayRegistry.entries.value
                      .any { it.stableId == connectedId }
                  ) {
                    app.prefs.gatewayRegistry.setConnectionEnabled(connectedId, true)
                  }
                }
                if (previousActiveId != null &&
                  app.prefs.gatewayRegistry.entries.value
                    .any { it.stableId == previousActiveId }
                ) {
                  app.prefs.gatewayRegistry.setActive(previousActiveId)
                }
                app.prefs.setOnboardingCompleted(previousOnboarding)
              }
            }
          }
        }
      }
    }
}
