package ai.openclaw.app

import ai.openclaw.app.gateway.DeviceAuthStore
import ai.openclaw.app.gateway.DeviceIdentityStore
import ai.openclaw.app.gateway.GatewayConnectErrorDetails
import ai.openclaw.app.gateway.GatewayEndpoint
import ai.openclaw.app.gateway.GatewaySession
import ai.openclaw.app.gateway.GatewayTlsProbeFailure
import ai.openclaw.app.gateway.GatewayTlsProbeResult
import ai.openclaw.app.node.ConnectionManager
import ai.openclaw.app.node.InvokeDispatcher
import ai.openclaw.app.protocol.OpenClawTalkCommand
import ai.openclaw.app.voice.TalkModeManager
import android.Manifest
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.lang.reflect.Field
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class GatewayBootstrapAuthTest {
  @Test
  fun standaloneStatusPreservesLiveOperatorConnection() {
    val runtime = NodeRuntime(RuntimeEnvironment.getApplication())
    writeField(runtime, "operatorConnected", true)
    val method = runtime.javaClass.getDeclaredMethod("setStandaloneGatewayStatus", String::class.java)
    method.isAccessible = true

    method.invoke(runtime, "Verify gateway TLS fingerprint…")

    assertTrue(runtime.gatewayConnectionDisplay.value.isConnected)
    assertEquals("Verify gateway TLS fingerprint…", runtime.gatewayConnectionDisplay.value.statusText)
    assertNull(runtime.gatewayConnectionDisplay.value.problem)
  }

  @Test
  fun unstructuredRetryClearsEarlierOperatorAuthProblem() {
    val runtime = NodeRuntime(RuntimeEnvironment.getApplication())
    val session = readField<GatewaySession>(runtime, "operatorSession")
    val onDisconnected = readField<(String) -> Unit>(session, "onDisconnected")
    val onConnectFailure = readField<(GatewaySession.ErrorShape, Boolean) -> Unit>(session, "onConnectFailure")

    onDisconnected("Gateway error: unauthorized")
    onConnectFailure(
      GatewaySession.ErrorShape(
        code = "UNAUTHORIZED",
        message = "unauthorized",
        details =
          GatewayConnectErrorDetails(
            code = "AUTH_TOKEN_MISSING",
            canRetryWithDeviceToken = false,
            recommendedNextStep = "provide_token",
          ),
      ),
      true,
    )
    val problemCode =
      runtime.gatewayConnectionDisplay.value.problem
        ?.code
    assertEquals(
      "AUTH_TOKEN_MISSING",
      problemCode,
    )

    onDisconnected("Reconnecting…")
    assertEquals("Reconnecting…", runtime.gatewayConnectionDisplay.value.statusText)
    assertNull(runtime.gatewayConnectionDisplay.value.problem)

    onDisconnected("Gateway error: timeout")
    assertEquals("Gateway error: timeout", runtime.gatewayConnectionDisplay.value.statusText)
    assertNull(runtime.gatewayConnectionDisplay.value.problem)
  }

  @Test
  fun retryableNodePairingProblemSurvivesReconnectStatus() {
    val runtime = NodeRuntime(RuntimeEnvironment.getApplication())
    val session = readField<GatewaySession>(runtime, "nodeSession")
    val onDisconnected = readField<(String) -> Unit>(session, "onDisconnected")
    val onConnectFailure = readField<(GatewaySession.ErrorShape, Boolean) -> Unit>(session, "onConnectFailure")

    onDisconnected("Gateway error: pairing required")
    onConnectFailure(
      GatewaySession.ErrorShape(
        code = "NOT_PAIRED",
        message = "pairing required",
        details =
          GatewayConnectErrorDetails(
            code = "PAIRING_REQUIRED",
            canRetryWithDeviceToken = false,
            recommendedNextStep = "wait_then_retry",
            reason = "not-paired",
            requestId = "request-1",
            retryable = true,
          ),
      ),
      false,
    )

    onDisconnected("Reconnecting…")

    val reconnectDisplay = runtime.gatewayConnectionDisplay.value
    assertEquals("Reconnecting…", reconnectDisplay.statusText)
    assertEquals("PAIRING_REQUIRED", reconnectDisplay.problem?.code)
    assertEquals("request-1", reconnectDisplay.problem?.requestId)

    onDisconnected("Gateway error: timeout")
    assertNull(runtime.gatewayConnectionDisplay.value.problem)
  }

  @Test
  fun doesNotConnectOperatorSessionWhenOnlyBootstrapAuthExists() {
    assertFalse(
      resolveOperatorSessionConnectAuth(
        NodeRuntime.GatewayConnectAuth(token = "", bootstrapToken = "bootstrap-1", password = ""),
        storedOperatorToken = "",
      ) != null,
    )
    assertFalse(
      resolveOperatorSessionConnectAuth(
        NodeRuntime.GatewayConnectAuth(token = null, bootstrapToken = "bootstrap-1", password = null),
        storedOperatorToken = null,
      ) != null,
    )
  }

  @Test
  fun connectsOperatorSessionWhenSharedPasswordOrStoredAuthExists() {
    assertTrue(
      resolveOperatorSessionConnectAuth(
        NodeRuntime.GatewayConnectAuth(token = "shared-token", bootstrapToken = "bootstrap-1", password = null),
        storedOperatorToken = null,
      ) != null,
    )
    assertTrue(
      resolveOperatorSessionConnectAuth(
        NodeRuntime.GatewayConnectAuth(token = null, bootstrapToken = "bootstrap-1", password = "shared-password"),
        storedOperatorToken = null,
      ) != null,
    )
    assertTrue(
      resolveOperatorSessionConnectAuth(
        NodeRuntime.GatewayConnectAuth(token = null, bootstrapToken = "bootstrap-1", password = null),
        storedOperatorToken = "stored-token",
      ) != null,
    )
    assertTrue(
      resolveOperatorSessionConnectAuth(
        NodeRuntime.GatewayConnectAuth(token = null, bootstrapToken = "", password = null),
        storedOperatorToken = null,
      ) != null,
    )
  }

  @Test
  fun resolveOperatorSessionConnectAuthUsesStoredTokenPathAfterBootstrapHandoff() {
    val resolved =
      resolveOperatorSessionConnectAuth(
        auth = NodeRuntime.GatewayConnectAuth(token = null, bootstrapToken = "bootstrap-1", password = null),
        storedOperatorToken = "stored-token",
      )

    assertEquals(NodeRuntime.GatewayConnectAuth(token = null, bootstrapToken = null, password = null), resolved)
  }

  @Test
  fun resolveOperatorSessionConnectAuthIgnoresBootstrapWhenNoStoredOperatorTokenExists() {
    val resolved =
      resolveOperatorSessionConnectAuth(
        auth = NodeRuntime.GatewayConnectAuth(token = null, bootstrapToken = "bootstrap-1", password = null),
        storedOperatorToken = null,
      )

    assertNull(resolved)
  }

  @Test
  fun resolveOperatorSessionConnectAuthUsesNoAuthWhenGatewayHasNoAuth() {
    val resolved =
      resolveOperatorSessionConnectAuth(
        auth = NodeRuntime.GatewayConnectAuth(token = null, bootstrapToken = null, password = null),
        storedOperatorToken = null,
      )

    assertEquals(NodeRuntime.GatewayConnectAuth(token = null, bootstrapToken = null, password = null), resolved)
  }

  @Test
  fun resolveOperatorSessionConnectAuthPrefersExplicitSharedAuth() {
    val resolved =
      resolveOperatorSessionConnectAuth(
        auth = NodeRuntime.GatewayConnectAuth(token = "shared-token", bootstrapToken = "bootstrap-1", password = "shared-password"),
        storedOperatorToken = "stored-token",
      )

    assertEquals(
      NodeRuntime.GatewayConnectAuth(token = "shared-token", bootstrapToken = null, password = null),
      resolved,
    )
  }

  @Test
  fun resolveGatewayControlPageAuthFallsBackToStoredOperatorToken() {
    val resolved =
      resolveGatewayControlPageAuth(
        auth = NodeRuntime.GatewayConnectAuth(token = null, bootstrapToken = "bootstrap-1", password = null),
        storedOperatorToken = " stored-token ",
      )

    assertEquals(
      NodeRuntime.GatewayConnectAuth(token = "stored-token", bootstrapToken = null, password = null),
      resolved,
    )
  }

  @Test
  fun resolveGatewayControlPageAuthPrefersExplicitSharedAuth() {
    assertEquals(
      NodeRuntime.GatewayConnectAuth(token = "shared-token", bootstrapToken = null, password = null),
      resolveGatewayControlPageAuth(
        auth =
          NodeRuntime.GatewayConnectAuth(
            token = " shared-token ",
            bootstrapToken = "bootstrap-1",
            password = "shared-password",
          ),
        storedOperatorToken = "stored-token",
      ),
    )
    assertEquals(
      NodeRuntime.GatewayConnectAuth(token = null, bootstrapToken = null, password = "shared-password"),
      resolveGatewayControlPageAuth(
        auth =
          NodeRuntime.GatewayConnectAuth(
            token = null,
            bootstrapToken = "bootstrap-1",
            password = " shared-password ",
          ),
        storedOperatorToken = "stored-token",
      ),
    )
  }

  @Test
  fun operatorConnectScopesForAuthUsesNativeScopesWhenNoStoredOperatorMetadata() {
    assertEquals(
      ConnectionManager.nativeClientOperatorScopes,
      operatorConnectScopesForAuth(
        usesStoredDeviceToken = false,
        storedOperatorScopes = null,
      ),
    )
  }

  @Test
  fun operatorConnectScopesForAuthPreservesStoredScopesForReconnects() {
    val storedScopes = listOf("operator.approvals", "operator.read", "operator.write")

    assertEquals(
      storedScopes,
      operatorConnectScopesForAuth(
        usesStoredDeviceToken = true,
        storedOperatorScopes = storedScopes,
      ),
    )
  }

  @Test
  fun operatorConnectScopesForAuthFallsBackToLegacyScopesForOldStoredDeviceTokens() {
    assertEquals(
      ConnectionManager.legacyOperatorScopes,
      operatorConnectScopesForAuth(
        usesStoredDeviceToken = true,
        storedOperatorScopes = emptyList(),
      ),
    )
  }

  @Test
  fun operatorConnectScopesForAuthUsesNativeScopesForExplicitReauth() {
    assertEquals(
      ConnectionManager.nativeClientOperatorScopes,
      operatorConnectScopesForAuth(
        usesStoredDeviceToken = false,
        storedOperatorScopes = listOf("operator.approvals", "operator.read", "operator.write"),
      ),
    )
  }

  @Test
  fun operatorSessionUsesStoredDeviceTokenOnlyWithoutExplicitSharedAuth() {
    assertTrue(
      operatorSessionUsesStoredDeviceToken(
        auth = NodeRuntime.GatewayConnectAuth(token = null, bootstrapToken = "bootstrap-1", password = null),
        storedOperatorToken = "stored-token",
      ),
    )
    assertFalse(
      operatorSessionUsesStoredDeviceToken(
        auth = NodeRuntime.GatewayConnectAuth(token = "shared-token", bootstrapToken = null, password = null),
        storedOperatorToken = "stored-token",
      ),
    )
    assertFalse(
      operatorSessionUsesStoredDeviceToken(
        auth = NodeRuntime.GatewayConnectAuth(token = null, bootstrapToken = null, password = "password"),
        storedOperatorToken = "stored-token",
      ),
    )
  }

  @Test
  fun nodeConnectStartsOperatorAfterBootstrapHandoffWhenOperatorWasConnecting() {
    val app = RuntimeEnvironment.getApplication()
    val securePrefs =
      app.getSharedPreferences(
        "openclaw.node.secure.test.${UUID.randomUUID()}",
        android.content.Context.MODE_PRIVATE,
      )
    val prefs = SecurePrefs(app, securePrefsOverride = securePrefs)
    val runtime = NodeRuntime(app, prefs)
    val deviceId = DeviceIdentityStore(app).loadOrCreate().deviceId
    DeviceAuthStore(prefs).saveToken(deviceId, "operator", "bootstrap-operator-token")

    writeField(runtime, "operatorStatusText", "Connecting…")
    invokeMaybeStartOperatorSessionAfterNodeConnect(
      runtime = runtime,
      endpoint = GatewayEndpoint.manual(host = "127.0.0.1", port = 18789),
      auth = NodeRuntime.GatewayConnectAuth(token = null, bootstrapToken = "setup-bootstrap-token", password = null),
    )

    val desired = desiredConnection(runtime, "operatorSession")
    assertNotNull(desired)
    assertNull(readField<String?>(desired!!, "bootstrapToken"))
  }

  @Test
  fun resolveGatewayConnectAuth_prefersExplicitSetupAuthOverStoredPrefs() {
    val app = RuntimeEnvironment.getApplication()
    val securePrefs =
      app.getSharedPreferences(
        "openclaw.node.secure.test.${UUID.randomUUID()}",
        android.content.Context.MODE_PRIVATE,
      )
    val prefs = SecurePrefs(app, securePrefsOverride = securePrefs)
    prefs.setGatewayToken("stale-shared-token")
    prefs.setGatewayBootstrapToken("")
    prefs.setGatewayPassword("stale-password")
    val runtime = NodeRuntime(app, prefs)

    val auth =
      runtime.resolveGatewayConnectAuth(
        NodeRuntime.GatewayConnectAuth(
          token = null,
          bootstrapToken = "setup-bootstrap-token",
          password = null,
        ),
      )

    assertNull(auth.token)
    assertEquals("setup-bootstrap-token", auth.bootstrapToken)
    assertNull(auth.password)
  }

  @Test
  fun acceptGatewayTrustPrompt_preservesExplicitSetupAuth() =
    runBlocking {
      val app = RuntimeEnvironment.getApplication()
      val securePrefs =
        app.getSharedPreferences(
          "openclaw.node.secure.test.${UUID.randomUUID()}",
          android.content.Context.MODE_PRIVATE,
        )
      val prefs = SecurePrefs(app, securePrefsOverride = securePrefs)
      prefs.setGatewayToken("stale-shared-token")
      prefs.setGatewayBootstrapToken("")
      prefs.setGatewayPassword("stale-password")
      val runtime =
        NodeRuntime(
          app,
          prefs,
          tlsFingerprintProbe = { _, _ -> GatewayTlsProbeResult(fingerprintSha256 = "fp:1") },
        )
      val endpoint = GatewayEndpoint.manual(host = "gateway.example", port = 18789)
      val explicitAuth =
        NodeRuntime.GatewayConnectAuth(
          token = null,
          bootstrapToken = "setup-bootstrap-token",
          password = null,
        )

      runtime.connect(endpoint, explicitAuth)
      val prompt = waitForGatewayTrustPrompt(runtime)
      assertEquals("setup-bootstrap-token", prompt.auth.bootstrapToken)

      runtime.acceptGatewayTrustPrompt()

      assertEquals("f1", prefs.loadGatewayTlsFingerprint(endpoint.stableId))
      assertEquals("setup-bootstrap-token", waitForDesiredBootstrapToken(runtime, "nodeSession"))
      assertNull(desiredBootstrapToken(runtime, "operatorSession"))
    }

  @Test
  fun connect_promptsBeforeReplacingChangedTlsFingerprint() =
    runBlocking {
      val app = RuntimeEnvironment.getApplication()
      val securePrefs =
        app.getSharedPreferences(
          "openclaw.node.secure.test.${UUID.randomUUID()}",
          android.content.Context.MODE_PRIVATE,
        )
      val prefs = SecurePrefs(app, securePrefsOverride = securePrefs)
      val endpoint = GatewayEndpoint.manual(host = "gateway.example", port = 18789)
      prefs.saveGatewayTlsFingerprint(endpoint.stableId, "sha256:aa:aa:aa:aa")
      val runtime =
        NodeRuntime(
          app,
          prefs,
          tlsFingerprintProbe = { _, _ -> GatewayTlsProbeResult(fingerprintSha256 = "sha256:bb:bb:bb:bb") },
        )

      runtime.connect(
        endpoint,
        NodeRuntime.GatewayConnectAuth(token = "shared-token", bootstrapToken = null, password = null),
      )

      val prompt = waitForGatewayTrustPrompt(runtime)
      assertEquals("aaaaaaaa", prompt.previousFingerprintSha256)
      assertEquals("bbbbbbbb", prompt.fingerprintSha256)
      assertEquals("sha256:aa:aa:aa:aa", prefs.loadGatewayTlsFingerprint(endpoint.stableId))

      runtime.declineGatewayTrustPrompt()

      assertEquals("sha256:aa:aa:aa:aa", prefs.loadGatewayTlsFingerprint(endpoint.stableId))

      runtime.connect(
        endpoint,
        NodeRuntime.GatewayConnectAuth(token = "shared-token", bootstrapToken = null, password = null),
      )
      waitForGatewayTrustPrompt(runtime)
      runtime.acceptGatewayTrustPrompt()

      assertEquals("bbbbbbbb", prefs.loadGatewayTlsFingerprint(endpoint.stableId))
    }

  @Test
  fun connect_ignoresStaleTlsProbeAfterDisconnect() =
    runBlocking {
      val app = RuntimeEnvironment.getApplication()
      val securePrefs =
        app.getSharedPreferences(
          "openclaw.node.secure.test.${UUID.randomUUID()}",
          android.content.Context.MODE_PRIVATE,
        )
      val prefs = SecurePrefs(app, securePrefsOverride = securePrefs)
      val endpoint = GatewayEndpoint.manual(host = "gateway.example", port = 18789)
      prefs.saveGatewayTlsFingerprint(endpoint.stableId, "aaaaaaaa")
      val probeStarted = CompletableDeferred<Unit>()
      val probeResult = CompletableDeferred<GatewayTlsProbeResult>()
      val runtime =
        NodeRuntime(
          app,
          prefs,
          tlsFingerprintProbe = { _, _ ->
            probeStarted.complete(Unit)
            probeResult.await()
          },
        )
      val runtimeScope = readField<CoroutineScope>(runtime, "scope")
      val existingJobs =
        runtimeScope.coroutineContext[Job]
          ?.children
          ?.toSet()
          .orEmpty()

      runtime.connect(
        endpoint,
        NodeRuntime.GatewayConnectAuth(token = "shared-token", bootstrapToken = null, password = null),
      )
      probeStarted.await()
      val probeJob =
        runtimeScope.coroutineContext[Job]
          ?.children
          ?.singleOrNull { it !in existingJobs }
          ?: error("Expected one TLS probe job")

      runtime.disconnect()
      probeResult.complete(GatewayTlsProbeResult(fingerprintSha256 = "aaaaaaaa"))
      // Join the owning coroutine so assertions run after its stale-attempt guard.
      probeJob.join()

      assertNull(runtime.pendingGatewayTrust.value)
      assertNull(desiredBootstrapToken(runtime, "nodeSession"))
      assertEquals("aaaaaaaa", prefs.loadGatewayTlsFingerprint(endpoint.stableId))
    }

  @Test
  fun refreshGatewayConnection_reconnectsSavedManualEndpointAfterDisconnect() {
    val app = RuntimeEnvironment.getApplication()
    val securePrefs =
      app.getSharedPreferences(
        "openclaw.node.secure.test.${UUID.randomUUID()}",
        android.content.Context.MODE_PRIVATE,
      )
    val prefs = SecurePrefs(app, securePrefsOverride = securePrefs)
    prefs.setManualEnabled(true)
    prefs.setManualHost("127.0.0.1")
    prefs.setManualPort(18789)
    prefs.setManualTls(false)
    prefs.setGatewayToken("shared-token")
    val runtime = NodeRuntime(app, prefs)

    runtime.connect(
      GatewayEndpoint.manual(host = "127.0.0.1", port = 18789),
      NodeRuntime.GatewayConnectAuth(token = "initial-token", bootstrapToken = null, password = null),
    )
    runtime.disconnect()
    assertNull(desiredConnection(runtime, "nodeSession"))

    runtime.refreshGatewayConnection()

    val desired = desiredConnection(runtime, "nodeSession") ?: error("Expected desired node connection")
    val endpoint = readField<GatewayEndpoint>(desired, "endpoint")
    assertEquals("127.0.0.1", endpoint.host)
    assertEquals(18789, endpoint.port)
    assertEquals("shared-token", readField<String?>(desired, "token"))
  }

  @Test
  fun connect_showsSecureEndpointGuidanceWhenTlsProbeFails() {
    val app = RuntimeEnvironment.getApplication()
    val runtime =
      NodeRuntime(
        app,
        tlsFingerprintProbe = { _, _ ->
          GatewayTlsProbeResult(failure = GatewayTlsProbeFailure.TLS_UNAVAILABLE)
        },
      )

    runtime.connect(
      GatewayEndpoint.manual(host = "gateway.example", port = 18789),
      NodeRuntime.GatewayConnectAuth(token = "shared-token", bootstrapToken = null, password = null),
    )

    assertEquals(
      "Failed: this host requires wss:// or Tailscale Serve. No TLS endpoint detected.",
      waitForStatusText(runtime),
    )
    assertNull(runtime.pendingGatewayTrust.value)
  }

  @Test
  fun connect_showsTlsTimeoutGuidanceWhenFingerprintProbeTimesOut() {
    val app = RuntimeEnvironment.getApplication()
    val runtime =
      NodeRuntime(
        app,
        tlsFingerprintProbe = { _, _ ->
          GatewayTlsProbeResult(failure = GatewayTlsProbeFailure.TLS_HANDSHAKE_TIMEOUT)
        },
      )

    runtime.connect(
      GatewayEndpoint.manual(host = "gateway.example", port = 18789),
      NodeRuntime.GatewayConnectAuth(token = "shared-token", bootstrapToken = null, password = null),
    )

    assertEquals(
      "Failed: secure endpoint reached, but TLS fingerprint verification timed out. Check Tailscale Serve or gateway TLS and retry.",
      waitForStatusText(runtime),
    )
    assertNull(runtime.pendingGatewayTrust.value)
  }

  @Test
  fun resetGatewaySetupAuth_clearsStoredGatewayAndDeviceTokens() {
    val app = RuntimeEnvironment.getApplication()
    val securePrefs =
      app.getSharedPreferences(
        "openclaw.node.secure.test.${UUID.randomUUID()}",
        android.content.Context.MODE_PRIVATE,
      )
    val prefs = SecurePrefs(app, securePrefsOverride = securePrefs)
    val runtime = NodeRuntime(app, prefs)
    val deviceId = DeviceIdentityStore(app).loadOrCreate().deviceId
    val authStore = DeviceAuthStore(prefs)
    prefs.setGatewayToken("stale-shared-token")
    prefs.setGatewayBootstrapToken("stale-bootstrap-token")
    prefs.setGatewayPassword("stale-password")
    authStore.saveToken(deviceId, "node", "stale-node-token")
    authStore.saveToken(deviceId, "operator", "stale-operator-token")

    runtime.resetGatewaySetupAuth()

    assertNull(prefs.loadGatewayToken())
    assertNull(prefs.loadGatewayBootstrapToken())
    assertNull(prefs.loadGatewayPassword())
    assertNull(authStore.loadToken(deviceId, "node"))
    assertNull(authStore.loadToken(deviceId, "operator"))
  }

  @Test
  fun restoredManualMicWithoutRecordAudioClearsStalePreference() {
    val app = RuntimeEnvironment.getApplication()
    shadowOf(app).denyPermissions(Manifest.permission.RECORD_AUDIO)
    val securePrefs =
      app.getSharedPreferences(
        "openclaw.node.secure.test.${UUID.randomUUID()}",
        android.content.Context.MODE_PRIVATE,
      )
    val prefs = SecurePrefs(app, securePrefsOverride = securePrefs)
    prefs.setVoiceMicEnabled(true)

    val runtime = NodeRuntime(app, prefs)

    assertEquals(VoiceCaptureMode.Off, runtime.voiceCaptureMode.value)
    assertFalse(prefs.voiceMicEnabled.value)
    assertFalse(readField<MutableStateFlow<Boolean>>(runtime, "externalAudioCaptureActive").value)
  }

  @Test
  fun talkPttStart_cleansPreparedCaptureWhenBeginFails() =
    runBlocking {
      val app = RuntimeEnvironment.getApplication()
      shadowOf(app).grantPermissions(Manifest.permission.RECORD_AUDIO)
      val runtime = NodeRuntime(app)
      val dispatcher = readField<InvokeDispatcher>(runtime, "invokeDispatcher")

      val result = dispatcher.handleInvoke(OpenClawTalkCommand.PttStart.rawValue, null)

      assertEquals("UNAVAILABLE", result.error?.code)
      assertEquals(VoiceCaptureMode.Off, runtime.voiceCaptureMode.value)
      assertFalse(readField<MutableStateFlow<Boolean>>(runtime, "externalAudioCaptureActive").value)
      val talkMode = readField<Lazy<TalkModeManager>>(runtime, "talkMode\$delegate").value
      assertFalse(talkMode.ttsOnAllResponses)
    }

  @Test
  fun talkPttStart_rejectsNewCaptureWhenBackgrounded() =
    runBlocking {
      val app = RuntimeEnvironment.getApplication()
      shadowOf(app).grantPermissions(Manifest.permission.RECORD_AUDIO)
      val runtime = NodeRuntime(app)
      runtime.setForeground(false)
      val dispatcher = readField<InvokeDispatcher>(runtime, "invokeDispatcher")

      val result = dispatcher.handleInvoke(OpenClawTalkCommand.PttStart.rawValue, null)

      assertEquals("NODE_BACKGROUND_UNAVAILABLE", result.error?.code)
      assertEquals("NODE_BACKGROUND_UNAVAILABLE: command requires foreground", result.error?.message)
      assertEquals(VoiceCaptureMode.Off, runtime.voiceCaptureMode.value)
      assertFalse(readField<MutableStateFlow<Boolean>>(runtime, "externalAudioCaptureActive").value)
    }

  private fun waitForGatewayTrustPrompt(runtime: NodeRuntime): NodeRuntime.GatewayTrustPrompt {
    repeat(50) {
      runtime.pendingGatewayTrust.value?.let { return it }
      Thread.sleep(10)
    }
    error("Expected pending gateway trust prompt")
  }

  private fun waitForStatusText(runtime: NodeRuntime): String {
    repeat(50) {
      val status = runtime.statusText.value
      if (status != "Verify gateway TLS fingerprint…") {
        return status
      }
      Thread.sleep(10)
    }
    error("Expected status text update")
  }

  private fun desiredBootstrapToken(
    runtime: NodeRuntime,
    sessionFieldName: String,
  ): String? {
    val desired = desiredConnection(runtime, sessionFieldName) ?: return null
    return readField(desired, "bootstrapToken")
  }

  private fun desiredConnection(
    runtime: NodeRuntime,
    sessionFieldName: String,
  ): Any? {
    val session = readField<GatewaySession>(runtime, sessionFieldName)
    return readField(session, "desired")
  }

  private fun invokeMaybeStartOperatorSessionAfterNodeConnect(
    runtime: NodeRuntime,
    endpoint: GatewayEndpoint,
    auth: NodeRuntime.GatewayConnectAuth,
  ) {
    val method =
      runtime.javaClass.getDeclaredMethod(
        "maybeStartOperatorSessionAfterNodeConnect",
        GatewayEndpoint::class.java,
        NodeRuntime.GatewayConnectAuth::class.java,
      )
    method.isAccessible = true
    method.invoke(runtime, endpoint, auth)
  }

  private fun writeField(
    target: Any,
    name: String,
    value: Any?,
  ) {
    var type: Class<*>? = target.javaClass
    while (type != null) {
      try {
        val field: Field = type.getDeclaredField(name)
        field.isAccessible = true
        field.set(target, value)
        return
      } catch (_: NoSuchFieldException) {
        type = type.superclass
      }
    }
    error("Field $name not found on ${target.javaClass.name}")
  }

  private fun waitForDesiredBootstrapToken(
    runtime: NodeRuntime,
    sessionFieldName: String,
  ): String {
    var lastObserved: String? = null
    repeat(50) {
      desiredBootstrapToken(runtime, sessionFieldName)?.let { token ->
        lastObserved = token
        return token
      }
      Thread.sleep(10)
    }
    error("Expected desired bootstrap token for $sessionFieldName; last observed=$lastObserved")
  }

  private fun <T> readField(
    target: Any,
    name: String,
  ): T {
    var type: Class<*>? = target.javaClass
    while (type != null) {
      try {
        val field: Field = type.getDeclaredField(name)
        field.isAccessible = true
        @Suppress("UNCHECKED_CAST")
        return field.get(target) as T
      } catch (_: NoSuchFieldException) {
        type = type.superclass
      }
    }
    error("Field $name not found on ${target.javaClass.name}")
  }
}
