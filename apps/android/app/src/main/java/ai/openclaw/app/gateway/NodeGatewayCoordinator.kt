package ai.openclaw.app.gateway

import android.content.Context
import ai.openclaw.app.SecurePrefs
import ai.openclaw.android.gateway.ProxyGatewayConfigPayload
import ai.openclaw.app.node.ConnectionManager
import ai.openclaw.app.node.DEFAULT_SEAM_COLOR_ARGB
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

class NodeGatewayCoordinator(
  context: Context,
  private val scope: CoroutineScope,
  private val prefs: SecurePrefs,
  private val connectionManager: ConnectionManager,
  private val identityStore: DeviceIdentityStore,
  private val callbacks: Callbacks,
  private val tlsFingerprintProbe: suspend (String, Int) -> GatewayTlsProbeResult = ::probeGatewayTlsFingerprint,
) {
  data class Callbacks(
    val onOperatorConnected: (serverName: String?, remoteAddress: String?, mainSessionKey: String?) -> Unit,
    val onOperatorDisconnected: (message: String) -> Unit,
    val onOperatorEvent: (event: String, payloadJson: String?) -> Unit,
    val onNodeConnected: () -> Unit,
    val onNodeDisconnected: (message: String) -> Unit,
    val onNodeInvoke: suspend (GatewaySession.InvokeRequest) -> GatewaySession.InvokeResult,
    val onStatusChanged: () -> Unit,
  )

  private val appContext = context.applicationContext
  private val deviceAuthStore = DeviceAuthStore(prefs)
  private val discovery = GatewayDiscovery(appContext, scope = scope)

  val gateways: StateFlow<List<GatewayEndpoint>> = discovery.gateways
  val discoveryStatusText: StateFlow<String> = discovery.statusText

  private val _isConnected = MutableStateFlow(false)
  val isConnected: StateFlow<Boolean> = _isConnected.asStateFlow()
  private val _nodeConnected = MutableStateFlow(false)
  val nodeConnected: StateFlow<Boolean> = _nodeConnected.asStateFlow()

  private val _statusText = MutableStateFlow("Offline")
  val statusText: StateFlow<String> = _statusText.asStateFlow()

  private val _operatorStatusText = MutableStateFlow("Offline")
  val operatorStatusText: StateFlow<String> = _operatorStatusText.asStateFlow()
  private var nodeStatusText: String = "Offline"

  private val _pendingGatewayTrust = MutableStateFlow<GatewayTrustPrompt?>(null)
  val pendingGatewayTrust: StateFlow<GatewayTrustPrompt?> = _pendingGatewayTrust.asStateFlow()

  private val _serverName = MutableStateFlow<String?>(null)
  val serverName: StateFlow<String?> = _serverName.asStateFlow()
  private val _remoteAddress = MutableStateFlow<String?>(null)
  val remoteAddress: StateFlow<String?> = _remoteAddress.asStateFlow()
  private val _seamColorArgb = MutableStateFlow(DEFAULT_SEAM_COLOR_ARGB)
  val seamColorArgb: StateFlow<Long> = _seamColorArgb.asStateFlow()

  private var connectedEndpoint: GatewayEndpoint? = null
  private var desiredNodeConnectAuth: GatewayConnectAuth? = null
  private var desiredOperatorConnectAuth: GatewayConnectAuth? = null
  private var shouldConnectOperator: Boolean = true
  private var didAutoConnect = false
  private var autoConnectJob: Job? = null

  val operatorSession =
    GatewaySession(
      scope = scope,
      identityStore = identityStore,
      deviceAuthStore = deviceAuthStore,
      onConnected = { name, remote, mainSessionKey ->
        _isConnected.value = true
        _operatorStatusText.value = "Connected"
        _serverName.value = name
        _remoteAddress.value = remote
        _seamColorArgb.value = DEFAULT_SEAM_COLOR_ARGB
        callbacks.onOperatorConnected(name, remote, mainSessionKey)
        updateStatus()
      },
      onDisconnected = { message ->
        _isConnected.value = false
        _operatorStatusText.value = message
        _serverName.value = null
        _remoteAddress.value = null
        _seamColorArgb.value = DEFAULT_SEAM_COLOR_ARGB
        callbacks.onOperatorDisconnected(message)
        updateStatus()
      },
      onEvent = { event, payloadJson ->
        callbacks.onOperatorEvent(event, payloadJson)
      },
    )

  val nodeSession =
    GatewaySession(
      scope = scope,
      identityStore = identityStore,
      deviceAuthStore = deviceAuthStore,
      onConnected = { _, _, _ ->
        _nodeConnected.value = true
        nodeStatusText = "Connected"
        refreshOperatorPlanAfterNodeBootstrap()
        callbacks.onNodeConnected()
        updateStatus()
      },
      onDisconnected = { message ->
        _nodeConnected.value = false
        nodeStatusText = message
        callbacks.onNodeDisconnected(message)
        updateStatus()
      },
      onEvent = { _, _ -> },
      onInvoke = { req ->
        callbacks.onNodeInvoke(req)
      },
      onTlsFingerprint = { stableId, fingerprint ->
        prefs.saveGatewayTlsFingerprint(stableId, fingerprint)
      },
    )

  fun startAutoConnect() {
    if (autoConnectJob != null) return
    autoConnectJob =
      scope.launch(Dispatchers.Default) {
        gateways.collect { list ->
          seedLastDiscoveredGateway(list)
          if (didAutoConnect) return@collect
          if (_isConnected.value) return@collect
          val target = resolveAutoConnectEndpoint(list) ?: return@collect
          didAutoConnect = true
          connect(target)
        }
      }
  }

  fun reconnectPreferredGatewayOnForeground() {
    if (_isConnected.value) return
    if (_pendingGatewayTrust.value != null) return
    if (connectedEndpoint != null) {
      refreshConnection()
      return
    }
    resolvePreferredGatewayEndpoint()?.let(::connect)
  }

  fun refreshConnection() {
    val endpoint =
      connectedEndpoint ?: run {
        _statusText.value = "Failed: no cached gateway endpoint"
        return
      }
    val connectPlan = resolveConnectPlan(auth = null)
    desiredNodeConnectAuth = connectPlan.nodeAuth
    desiredOperatorConnectAuth = connectPlan.operatorAuth
    shouldConnectOperator = connectPlan.connectOperator
    _operatorStatusText.value = if (connectPlan.connectOperator) "Connecting…" else "Offline"
    nodeStatusText = "Connecting…"
    updateStatus()
    val tls = connectionManager.resolveTlsParams(endpoint)
    connectSessions(endpoint, tls, reconnect = true)
  }

  fun connect(
    endpoint: GatewayEndpoint,
    auth: GatewayConnectAuth? = null,
  ) {
    val connectPlan = resolveConnectPlan(auth)
    desiredNodeConnectAuth = connectPlan.nodeAuth
    desiredOperatorConnectAuth = connectPlan.operatorAuth
    shouldConnectOperator = connectPlan.connectOperator
    val tls = connectionManager.resolveTlsParams(endpoint)
    if (tls?.required == true && tls.expectedFingerprint.isNullOrBlank()) {
      // First-time TLS: capture fingerprint, ask user to verify out-of-band, then store and connect.
      _statusText.value = "Verify gateway TLS fingerprint…"
      scope.launch {
        val probe = tlsFingerprintProbe(endpoint.host, endpoint.port)
        val fp = probe.fingerprintSha256
        if (fp.isNullOrBlank()) {
          _pendingGatewayTrust.value = null
          _statusText.value = gatewayTlsProbeFailureMessage(probe.failure)
          return@launch
        }
        _pendingGatewayTrust.value =
          GatewayTrustPrompt(
            endpoint = endpoint,
            fingerprintSha256 = fp,
            auth = connectPlan.nodeAuth,
          )
      }
      return
    }

    connectedEndpoint = endpoint
    _operatorStatusText.value = if (connectPlan.connectOperator) "Connecting…" else "Offline"
    nodeStatusText = "Connecting…"
    updateStatus()
    connectSessions(endpoint, tls, reconnect = false)
  }

  fun connectManual() {
    val host = prefs.manualHost.value.trim()
    val port = prefs.manualPort.value
    if (host.isEmpty() || port <= 0 || port > 65535) {
      _statusText.value = "Failed: invalid manual host/port"
      return
    }
    connect(GatewayEndpoint.manual(host = host, port = port))
  }

  fun disconnect() {
    connectedEndpoint = null
    desiredNodeConnectAuth = null
    desiredOperatorConnectAuth = null
    shouldConnectOperator = true
    _pendingGatewayTrust.value = null
    operatorSession.disconnect()
    nodeSession.disconnect()
  }

  fun clearStoredDeviceTokens(deviceId: String) {
    deviceAuthStore.clearToken(deviceId, "node")
    deviceAuthStore.clearToken(deviceId, "operator")
  }

  fun acceptGatewayTrustPrompt() {
    val prompt = _pendingGatewayTrust.value ?: return
    _pendingGatewayTrust.value = null
    prefs.saveGatewayTlsFingerprint(prompt.endpoint.stableId, prompt.fingerprintSha256)
    connect(prompt.endpoint, prompt.auth)
  }

  fun declineGatewayTrustPrompt() {
    _pendingGatewayTrust.value = null
    _statusText.value = "Offline"
  }

  fun buildWearProxyGatewayConfig(): ProxyGatewayConfigPayload? {
    val endpoint = resolveWearProxyGatewayEndpoint() ?: return null
    return buildWearProxyGatewayConfig(endpoint)
  }

  internal fun buildWearProxyGatewayConfig(endpoint: GatewayEndpoint): ProxyGatewayConfigPayload? {
    val tls = connectionManager.resolveTlsParams(endpoint)
    val token =
      prefs.loadGatewayToken()?.trim()?.takeIf { it.isNotEmpty() }
        ?: loadStoredOperatorToken()?.trim()?.takeIf { it.isNotEmpty() }
    val bootstrapToken = prefs.loadGatewayBootstrapToken()?.trim()?.takeIf { it.isNotEmpty() }
    val password = prefs.loadGatewayPassword()?.trim()?.takeIf { it.isNotEmpty() }
    val fingerprint = prefs.loadGatewayTlsFingerprint(endpoint.stableId)?.trim()?.takeIf { it.isNotEmpty() }

    if (tls?.required == true && fingerprint.isNullOrBlank()) {
      // Only hand Wear a direct TLS fallback once the phone has a pinned fingerprint.
      return null
    }

    return ProxyGatewayConfigPayload(
      host = endpoint.host,
      port = endpoint.port,
      useTls = tls?.required == true,
      token = token,
      bootstrapToken = bootstrapToken,
      password = password,
      tlsFingerprintSha256 = fingerprint,
    )
  }

  fun updateSeamColorArgb(value: Long) {
    _seamColorArgb.value = value
  }

  private fun seedLastDiscoveredGateway(list: List<GatewayEndpoint>) {
    if (list.isEmpty()) return
    if (prefs.lastDiscoveredStableId.value.trim().isNotEmpty()) return
    // Security: don't let an unauthenticated discovery feed continuously steer autoconnect.
    // UX parity with iOS: only set once when unset.
    prefs.setLastDiscoveredStableId(list.first().stableId)
  }

  private fun resolvePreferredGatewayEndpoint(): GatewayEndpoint? {
    if (prefs.manualEnabled.value) {
      val host = prefs.manualHost.value.trim()
      val port = prefs.manualPort.value
      if (host.isEmpty() || port !in 1..65535) return null
      return GatewayEndpoint.manual(host = host, port = port)
    }

    val targetStableId = prefs.lastDiscoveredStableId.value.trim()
    if (targetStableId.isEmpty()) return null
    val endpoint = gateways.value.firstOrNull { it.stableId == targetStableId } ?: return null
    val storedFingerprint = prefs.loadGatewayTlsFingerprint(endpoint.stableId)?.trim().orEmpty()
    if (storedFingerprint.isEmpty()) return null
    return endpoint
  }

  private fun resolveAutoConnectEndpoint(list: List<GatewayEndpoint>): GatewayEndpoint? {
    if (prefs.manualEnabled.value) {
      val host = prefs.manualHost.value.trim()
      val port = prefs.manualPort.value
      if (host.isEmpty() || port !in 1..65535) return null
      // Security: autoconnect only to previously trusted TLS endpoints.
      if (!prefs.manualTls.value) return null
      val endpoint = GatewayEndpoint.manual(host = host, port = port)
      val storedFingerprint = prefs.loadGatewayTlsFingerprint(endpoint.stableId)?.trim().orEmpty()
      if (storedFingerprint.isEmpty()) return null
      return endpoint
    }

    val targetStableId = prefs.lastDiscoveredStableId.value.trim()
    if (targetStableId.isEmpty()) return null
    val endpoint = list.firstOrNull { it.stableId == targetStableId } ?: return null
    val storedFingerprint = prefs.loadGatewayTlsFingerprint(endpoint.stableId)?.trim().orEmpty()
    if (storedFingerprint.isEmpty()) return null
    return endpoint
  }

  private fun connectSessions(endpoint: GatewayEndpoint, tls: GatewayTlsParams?, reconnect: Boolean) {
    val nodeAuth = desiredNodeConnectAuth ?: loadConfiguredGatewayConnectAuth()
    val operatorAuth = desiredOperatorConnectAuth
    if (shouldConnectOperator) {
      operatorSession.connect(
        endpoint,
        operatorAuth?.token,
        operatorAuth?.bootstrapToken,
        operatorAuth?.password,
        connectionManager.buildOperatorConnectOptions(),
        tls,
      )
    } else {
      operatorSession.disconnect()
    }
    nodeSession.connect(
      endpoint,
      nodeAuth.token,
      nodeAuth.bootstrapToken,
      nodeAuth.password,
      connectionManager.buildNodeConnectOptions(),
      tls,
    )
    if (reconnect) {
      operatorSession.reconnect()
      nodeSession.reconnect()
    }
  }

  internal fun refreshOperatorPlanAfterNodeBootstrap() {
    val endpoint = connectedEndpoint ?: return
    val connectPlan = resolveConnectPlan(desiredNodeConnectAuth)
    desiredNodeConnectAuth = connectPlan.nodeAuth
    desiredOperatorConnectAuth = connectPlan.operatorAuth
    shouldConnectOperator = connectPlan.connectOperator
    if (!connectPlan.connectOperator || _isConnected.value) {
      return
    }

    _operatorStatusText.value = "Connecting…"
    val tls = connectionManager.resolveTlsParams(endpoint)
    val operatorAuth = connectPlan.operatorAuth
    operatorSession.connect(
      endpoint,
      operatorAuth?.token,
      operatorAuth?.bootstrapToken,
      operatorAuth?.password,
      connectionManager.buildOperatorConnectOptions(),
      tls,
    )
  }

  private fun updateStatus() {
    val operator = _operatorStatusText.value.trim()
    val node = nodeStatusText.trim()
    _statusText.value =
      when {
        _isConnected.value && _nodeConnected.value -> "Connected"
        _isConnected.value && !_nodeConnected.value -> "Connected (node offline)"
        !_isConnected.value && _nodeConnected.value ->
          if (operator.isNotEmpty() && operator != "Offline") {
            "Connected (operator: $operator)"
          } else {
            "Connected (operator offline)"
          }
        operator.isNotBlank() && operator != "Offline" -> operator
        else -> node
      }
    // Keep derived status centralized so home canvas and UI stay in sync.
    callbacks.onStatusChanged()
  }

  private fun resolveWearProxyGatewayEndpoint(): GatewayEndpoint? {
    connectedEndpoint?.let { return it }

    if (prefs.manualEnabled.value) {
      val host = prefs.manualHost.value.trim()
      val port = prefs.manualPort.value
      if (host.isNotEmpty() && port in 1..65535) {
        return GatewayEndpoint.manual(host = host, port = port)
      }
    }

    resolvePreferredGatewayEndpoint()?.let { return it }

    val targetStableId = prefs.lastDiscoveredStableId.value.trim()
    if (targetStableId.isEmpty()) return null
    return gateways.value.firstOrNull { it.stableId == targetStableId }
  }

  private data class ConnectPlan(
    val nodeAuth: GatewayConnectAuth,
    val operatorAuth: GatewayConnectAuth?,
    val connectOperator: Boolean,
  )

  private fun resolveConnectPlan(auth: GatewayConnectAuth?): ConnectPlan {
    val nodeAuth = auth ?: loadConfiguredGatewayConnectAuth()
    val storedOperatorToken =
      if (nodeAuth.token.isNullOrBlank() && nodeAuth.password.isNullOrBlank()) {
        loadStoredOperatorToken()
      } else {
        null
      }
    val operatorAuth = resolveOperatorSessionConnectAuth(nodeAuth, storedOperatorToken)
    return ConnectPlan(
      nodeAuth = nodeAuth,
      operatorAuth = operatorAuth,
      connectOperator = operatorAuth != null,
    )
  }

  private fun loadConfiguredGatewayConnectAuth(): GatewayConnectAuth {
    return GatewayConnectAuth(
      token = prefs.loadGatewayToken(),
      bootstrapToken = prefs.loadGatewayBootstrapToken(),
      password = prefs.loadGatewayPassword(),
    )
  }

  private fun loadStoredOperatorToken(): String? {
    return runCatching {
      val deviceId = identityStore.loadOrCreate().deviceId
      deviceAuthStore.loadToken(deviceId, role = "operator")
    }.getOrNull()
  }

  private fun gatewayTlsProbeFailureMessage(failure: GatewayTlsProbeFailure?): String {
    return when (failure) {
      GatewayTlsProbeFailure.TLS_UNAVAILABLE ->
        "Failed: this host requires wss:// or Tailscale Serve. No TLS endpoint detected."
      GatewayTlsProbeFailure.ENDPOINT_UNREACHABLE, null ->
        "Failed: couldn't reach the secure gateway endpoint for this host."
    }
  }
}
