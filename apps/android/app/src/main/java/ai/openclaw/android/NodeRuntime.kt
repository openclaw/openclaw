package ai.openclaw.android

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.SystemClock
import android.util.Log
import androidx.core.content.ContextCompat
import ai.openclaw.android.chat.ChatController
import ai.openclaw.android.chat.ChatMessage
import ai.openclaw.android.chat.ChatPendingToolCall
import ai.openclaw.android.chat.ChatSessionEntry
import ai.openclaw.android.chat.OutgoingAttachment
import ai.openclaw.android.gateway.DeviceAuthStore
import ai.openclaw.android.gateway.DeviceIdentityStore
import ai.openclaw.android.gateway.GatewayDiscovery
import ai.openclaw.android.gateway.GatewayEndpoint
import ai.openclaw.android.gateway.GatewaySession
import ai.openclaw.android.gateway.probeGatewayTlsFingerprint
import ai.openclaw.android.node.*
import ai.openclaw.android.protocol.OpenClawCanvasA2UIAction
import ai.openclaw.android.voice.MicCaptureManager
import ai.openclaw.android.voice.TalkModeManager
import ai.openclaw.android.voice.VoiceConversationEntry
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import java.util.UUID
import java.util.concurrent.atomic.AtomicLong

class NodeRuntime(context: Context) {
  private val appContext = context.applicationContext
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

  val prefs = SecurePrefs(appContext)
  private val deviceAuthStore = DeviceAuthStore(prefs)
  val canvas = CanvasController()
  val camera = CameraCaptureManager(appContext)
  val location = LocationCaptureManager(appContext)
  val screenRecorder = ScreenRecordManager(appContext)
  val sms = SmsManager(appContext)
  private val json = Json { ignoreUnknownKeys = true }

  private val externalAudioCaptureActive = MutableStateFlow(false)

  private val discovery = GatewayDiscovery(appContext, scope = scope)
  val gateways: StateFlow<List<GatewayEndpoint>> = discovery.gateways
  val discoveryStatusText: StateFlow<String> = discovery.statusText

  private val identityStore = DeviceIdentityStore(appContext)
  private var connectedEndpoint: GatewayEndpoint? = null

  private val cameraHandler: CameraHandler = CameraHandler(
    appContext = appContext,
    camera = camera,
    externalAudioCaptureActive = externalAudioCaptureActive,
    showCameraHud = ::showCameraHud,
    triggerCameraFlash = ::triggerCameraFlash,
    invokeErrorFromThrowable = { invokeErrorFromThrowable(it) },
  )

  private val debugHandler: DebugHandler = DebugHandler(
    appContext = appContext,
    identityStore = identityStore,
  )

  private val appUpdateHandler: AppUpdateHandler = AppUpdateHandler(
    appContext = appContext,
    connectedEndpoint = { connectedEndpoint },
  )

  private val locationHandler: LocationHandler = LocationHandler(
    appContext = appContext,
    location = location,
    json = json,
    isForeground = { _isForeground.value },
    locationMode = { locationMode.value },
    locationPreciseEnabled = { locationPreciseEnabled.value },
  )

  private val deviceHandler: DeviceHandler = DeviceHandler(
    appContext = appContext,
  )

  private val notificationsHandler: NotificationsHandler = NotificationsHandler(
    appContext = appContext,
  )

  private val systemHandler: SystemHandler = SystemHandler(
    appContext = appContext,
  )

  private val photosHandler: PhotosHandler = PhotosHandler(
    appContext = appContext,
  )

  private val contactsHandler: ContactsHandler = ContactsHandler(
    appContext = appContext,
  )

  private val calendarHandler: CalendarHandler = CalendarHandler(
    appContext = appContext,
  )

  private val motionHandler: MotionHandler = MotionHandler(
    appContext = appContext,
  )

  private val screenHandler: ScreenHandler = ScreenHandler(
    screenRecorder = screenRecorder,
    setScreenRecordActive = { _screenRecordActive.value = it },
    invokeErrorFromThrowable = { invokeErrorFromThrowable(it) },
  )

  private val smsHandlerImpl: SmsHandler = SmsHandler(
    sms = sms,
  )

  private val a2uiHandler: A2UIHandler = A2UIHandler(
    canvas = canvas,
    json = json,
    getNodeCanvasHostUrl = { nodeSession.currentCanvasHostUrl() },
    getOperatorCanvasHostUrl = { operatorSession.currentCanvasHostUrl() },
  )

  private val connectionManager: ConnectionManager = ConnectionManager(
    prefs = prefs,
    cameraEnabled = { cameraEnabled.value },
    locationMode = { locationMode.value },
    voiceWakeMode = { VoiceWakeMode.Off },
    motionActivityAvailable = { motionHandler.isActivityAvailable() },
    motionPedometerAvailable = { motionHandler.isPedometerAvailable() },
    smsAvailable = { sms.canSendSms() },
    hasRecordAudioPermission = { hasRecordAudioPermission() },
    manualTls = { manualTls.value },
  )

  private val invokeDispatcher: InvokeDispatcher = InvokeDispatcher(
    canvas = canvas,
    cameraHandler = cameraHandler,
    locationHandler = locationHandler,
    deviceHandler = deviceHandler,
    notificationsHandler = notificationsHandler,
    systemHandler = systemHandler,
    photosHandler = photosHandler,
    contactsHandler = contactsHandler,
    calendarHandler = calendarHandler,
    motionHandler = motionHandler,
    screenHandler = screenHandler,
    smsHandler = smsHandlerImpl,
    a2uiHandler = a2uiHandler,
    debugHandler = debugHandler,
    appUpdateHandler = appUpdateHandler,
    isForeground = { _isForeground.value },
    cameraEnabled = { cameraEnabled.value },
    locationEnabled = { locationMode.value != LocationMode.Off },
    smsAvailable = { sms.canSendSms() },
    debugBuild = { BuildConfig.DEBUG },
    refreshNodeCanvasCapability = { nodeSession.refreshNodeCanvasCapability() },
    onCanvasA2uiPush = {
      _canvasA2uiHydrated.value = true
      _canvasRehydratePending.value = false
      _canvasRehydrateErrorText.value = null
    },
    onCanvasA2uiReset = { _canvasA2uiHydrated.value = false },
    motionActivityAvailable = { motionHandler.isActivityAvailable() },
    motionPedometerAvailable = { motionHandler.isPedometerAvailable() },
  )

  data class GatewayTrustPrompt(
    val endpoint: GatewayEndpoint,
    val fingerprintSha256: String,
  )

  private val _isConnected = MutableStateFlow(false)
  val isConnected: StateFlow<Boolean> = _isConnected.asStateFlow()
  private val _nodeConnected = MutableStateFlow(false)
  val nodeConnected: StateFlow<Boolean> = _nodeConnected.asStateFlow()

  private val _statusText = MutableStateFlow("Offline")
  val statusText: StateFlow<String> = _statusText.asStateFlow()

  private val _pendingGatewayTrust = MutableStateFlow<GatewayTrustPrompt?>(null)
  val pendingGatewayTrust: StateFlow<GatewayTrustPrompt?> = _pendingGatewayTrust.asStateFlow()

  private val _mainSessionKey = MutableStateFlow("main")
  val mainSessionKey: StateFlow<String> = _mainSessionKey.asStateFlow()

  private val cameraHudSeq = AtomicLong(0)
  private val _cameraHud = MutableStateFlow<CameraHudState?>(null)
  val cameraHud: StateFlow<CameraHudState?> = _cameraHud.asStateFlow()

  private val _cameraFlashToken = MutableStateFlow(0L)
  val cameraFlashToken: StateFlow<Long> = _cameraFlashToken.asStateFlow()

  private val _screenRecordActive = MutableStateFlow(false)
  val screenRecordActive: StateFlow<Boolean> = _screenRecordActive.asStateFlow()

  private val _canvasA2uiHydrated = MutableStateFlow(false)
  val canvasA2uiHydrated: StateFlow<Boolean> = _canvasA2uiHydrated.asStateFlow()
  private val _canvasRehydratePending = MutableStateFlow(false)
  val canvasRehydratePending: StateFlow<Boolean> = _canvasRehydratePending.asStateFlow()
  private val _canvasRehydrateErrorText = MutableStateFlow<String?>(null)
  val canvasRehydrateErrorText: StateFlow<String?> = _canvasRehydrateErrorText.asStateFlow()

  private val _serverName = MutableStateFlow<String?>(null)
  val serverName: StateFlow<String?> = _serverName.asStateFlow()

  private val _remoteAddress = MutableStateFlow<String?>(null)
  val remoteAddress: StateFlow<String?> = _remoteAddress.asStateFlow()

  private val _seamColorArgb = MutableStateFlow(DEFAULT_SEAM_COLOR_ARGB)
  val seamColorArgb: StateFlow<Long> = _seamColorArgb.asStateFlow()

  private val _isForeground = MutableStateFlow(true)
  val isForeground: StateFlow<Boolean> = _isForeground.asStateFlow()

  private var lastAutoA2uiUrl: String? = null
  private var didAutoRequestCanvasRehydrate = false
  private val canvasRehydrateSeq = AtomicLong(0)
  private var operatorConnected = false
  private var operatorStatusText: String = "Offline"
  private var nodeStatusText: String = "Offline"

  private val operatorSession =
    GatewaySession(
      scope = scope,
      identityStore = identityStore,
      deviceAuthStore = deviceAuthStore,
      onConnected = { name, remote, mainSessionKey ->
        operatorConnected = true
        operatorStatusText = "Connected"
        _serverName.value = name
        _remoteAddress.value = remote
        _seamColorArgb.value = DEFAULT_SEAM_COLOR_ARGB
        applyMainSessionKey(mainSessionKey)
        updateStatus()
        micCapture.onGatewayConnectionChanged(true)
        scope.launch {
          refreshBrandingFromGateway()
          if (voiceReplySpeakerLazy.isInitialized()) {
            voiceReplySpeaker.refreshConfig()
          }
        }
      },
      onDisconnected = { message ->
        operatorConnected = false
        operatorStatusText = message
        _serverName.value = null
        _remoteAddress.value = null
        _seamColorArgb.value = DEFAULT_SEAM_COLOR_ARGB
        if (!isCanonicalMainSessionKey(_mainSessionKey.value)) {
          _mainSessionKey.value = "main"
        }
        chat.applyMainSessionKey(resolveMainSessionKey())
        chat.onDisconnected(message)
        updateStatus()
        micCapture.onGatewayConnectionChanged(false)
      },
      onEvent = { event, payloadJson ->
        handleGatewayEvent(event, payloadJson)
      },
    )

  private val nodeSession =
    GatewaySession(
      scope = scope,
      identityStore = identityStore,
      deviceAuthStore = deviceAuthStore,
      onConnected = { _, _, _ ->
        _nodeConnected.value = true
        nodeStatusText = "Connected"
        didAutoRequestCanvasRehydrate = false
        _canvasA2uiHydrated.value = false
        _canvasRehydratePending.value = false
        _canvasRehydrateErrorText.value = null
        updateStatus()
        maybeNavigateToA2uiOnConnect()
      },
      onDisconnected = { message ->
        _nodeConnected.value = false
        nodeStatusText = message
        didAutoRequestCanvasRehydrate = false
        _canvasA2uiHydrated.value = false
        _canvasRehydratePending.value = false
        _canvasRehydrateErrorText.value = null
        updateStatus()
        showLocalCanvasOnDisconnect()
      },
      onEvent = { _, _ -> },
      onInvoke = { req ->
        invokeDispatcher.handleInvoke(req.command, req.paramsJson)
      },
      onTlsFingerprint = { stableId, fingerprint ->
        prefs.saveGatewayTlsFingerprint(stableId, fingerprint)
      },
    )

  init {
    DeviceNotificationListenerService.setNodeEventSink { event, payloadJson ->
      scope.launch {
        nodeSession.sendNodeEvent(event = event, payloadJson = payloadJson)
      }
    }
  }

  private val chat: ChatController =
    ChatController(
      scope = scope,
      session = operatorSession,
      json = json,
      supportsChatSubscribe = false,
    )
  private val voiceReplySpeakerLazy: Lazy<TalkModeManager> = lazy {
    // Reuse the existing TalkMode speech engine (ElevenLabs + deterministic system-TTS fallback)
    // without enabling the legacy talk capture loop.
    TalkModeManager(
      context = appContext,
      scope = scope,
      session = operatorSession,
      supportsChatSubscribe = false,
      isConnected = { operatorConnected },
    ).also { speaker ->
      speaker.setPlaybackEnabled(prefs.speakerEnabled.value)
    }
  }
  private val voiceReplySpeaker: TalkModeManager
    get() = voiceReplySpeakerLazy.value

  private val micCapture: MicCaptureManager by lazy {
    MicCaptureManager(
      context = appContext,
      scope = scope,
      sendToGateway = { message ->
        val idempotencyKey = UUID.randomUUID().toString()
        val params =
          buildJsonObject {
            put("sessionKey", JsonPrimitive(resolveMainSessionKey()))
            put("message", JsonPrimitive(message))
            put("thinking", JsonPrimitive(chatThinkingLevel.value))
            put("timeoutMs", JsonPrimitive(30_000))
            put("idempotencyKey", JsonPrimitive(idempotencyKey))
          }
        val response = operatorSession.request("chat.send", params.toString())
        parseChatSendRunId(response) ?: idempotencyKey
      },
      speakAssistantReply = { text ->
        voiceReplySpeaker.speakAssistantReply(text)
      },
    )
  }

  val micStatusText: StateFlow<String>
    get() = micCapture.statusText

  val micLiveTranscript: StateFlow<String?>
    get() = micCapture.liveTranscript

  val micIsListening: StateFlow<Boolean>
    get() = micCapture.isListening

  val micEnabled: StateFlow<Boolean>
    get() = micCapture.micEnabled

  val micQueuedMessages: StateFlow<List<String>>
    get() = micCapture.queuedMessages

  val micConversation: StateFlow<List<VoiceConversationEntry>>
    get() = micCapture.conversation

  val micInputLevel: StateFlow<Float>
    get() = micCapture.inputLevel

  val micIsSending: StateFlow<Boolean>
    get() = micCapture.isSending

  private fun applyMainSessionKey(candidate: String?) {
    val trimmed = normalizeMainKey(candidate) ?: return
    if (isCanonicalMainSessionKey(_mainSessionKey.value)) return
    if (_mainSessionKey.value == trimmed) return
    _mainSessionKey.value = trimmed
    chat.applyMainSessionKey(trimmed)
  }

  private fun updateStatus() {
    _isConnected.value = operatorConnected
    val operator = operatorStatusText.trim()
    val node = nodeStatusText.trim()
    _statusText.value =
      when {
        operatorConnected && _nodeConnected.value -> "Connected"
        operatorConnected && !_nodeConnected.value -> "Connected (node offline)"
        !operatorConnected && _nodeConnected.value ->
          if (operator.isNotEmpty() && operator != "Offline") {
            "Connected (operator: $operator)"
          } else {
            "Connected (operator offline)"
          }
        operator.isNotBlank() && operator != "Offline" -> operator
        else -> node
      }
  }

  private fun resolveMainSessionKey(): String {
    val trimmed = _mainSessionKey.value.trim()
    return if (trimmed.isEmpty()) "main" else trimmed
  }

  private fun maybeNavigateToA2uiOnConnect() {
    val a2uiUrl = a2uiHandler.resolveA2uiHostUrl() ?: return
    val current = canvas.currentUrl()?.trim().orEmpty()
    if (current.isEmpty() || current == lastAutoA2uiUrl) {
      lastAutoA2uiUrl = a2uiUrl
      canvas.navigate(a2uiUrl)
    }
  }

  private fun showLocalCanvasOnDisconnect() {
    lastAutoA2uiUrl = null
    _canvasA2uiHydrated.value = false
    _canvasRehydratePending.value = false
    _canvasRehydrateErrorText.value = null
    canvas.navigate("")
  }

  fun requestCanvasRehydrate(source: String = "manual", force: Boolean = true) {
    scope.launch {
      if (!_nodeConnected.value) {
        _canvasRehydratePending.value = false
        _canvasRehydrateErrorText.value = "Node offline. Reconnect and retry."
        return@launch
      }
      if (!force && didAutoRequestCanvasRehydrate) return@launch
      didAutoRequestCanvasRehydrate = true
      val requestId = canvasRehydrateSeq.incrementAndGet()
      _canvasRehydratePending.value = true
      _canvasRehydrateErrorText.value = null

      val sessionKey = resolveMainSessionKey()
      val prompt =
        "Restore canvas now for session=$sessionKey source=$source. " +
          "If existing A2UI state exists, replay it immediately. " +
          "If not, create and render a compact mobile-friendly dashboard in Canvas."
      val sent =
        nodeSession.sendNodeEvent(
          event = "agent.request",
          payloadJson =
            buildJsonObject {
              put("message", JsonPrimitive(prompt))
              put("sessionKey", JsonPrimitive(sessionKey))
              put("thinking", JsonPrimitive("low"))
              put("deliver", JsonPrimitive(false))
            }.toString(),
        )
      if (!sent) {
        if (!force) {
          didAutoRequestCanvasRehydrate = false
        }
        if (canvasRehydrateSeq.get() == requestId) {
          _canvasRehydratePending.value = false
          _canvasRehydrateErrorText.value = "Failed to request restore. Tap to retry."
        }
        Log.w("OpenClawCanvas", "canvas rehydrate request failed ($source): transport unavailable")
        return@launch
      }
      scope.launch {
        delay(20_000)
        if (canvasRehydrateSeq.get() != requestId) return@launch
        if (!_canvasRehydratePending.value) return@launch
        if (_canvasA2uiHydrated.value) return@launch
        _canvasRehydratePending.value = false
        _canvasRehydrateErrorText.value = "No canvas update yet. Tap to retry."
      }
    }
  }

  val instanceId: StateFlow<String> = prefs.instanceId
  val displayName: StateFlow<String> = prefs.displayName
  val cameraEnabled: StateFlow<Boolean> = prefs.cameraEnabled
  val locationMode: StateFlow<LocationMode> = prefs.locationMode
  val locationPreciseEnabled: StateFlow<Boolean> = prefs.locationPreciseEnabled
  val preventSleep: StateFlow<Boolean> = prefs.preventSleep
  val manualEnabled: StateFlow<Boolean> = prefs.manualEnabled
  val manualHost: StateFlow<String> = prefs.manualHost
  val manualPort: StateFlow<Int> = prefs.manualPort
  val manualTls: StateFlow<Boolean> = prefs.manualTls
  val gatewayToken: StateFlow<String> = prefs.gatewayToken
  val onboardingCompleted: StateFlow<Boolean> = prefs.onboardingCompleted
  fun setGatewayToken(value: String) = prefs.setGatewayToken(value)
  fun setGatewayPassword(value: String) = prefs.setGatewayPassword(value)
  fun setOnboardingCompleted(value: Boolean) = prefs.setOnboardingCompleted(value)
  val lastDiscoveredStableId: StateFlow<String> = prefs.lastDiscoveredStableId
  val canvasDebugStatusEnabled: StateFlow<Boolean> = prefs.canvasDebugStatusEnabled

  private var didAutoConnect = false

  val chatSessionKey: StateFlow<String> = chat.sessionKey
  val chatSessionId: StateFlow<String?> = chat.sessionId
  val chatMessages: StateFlow<List<ChatMessage>> = chat.messages
  val chatError: StateFlow<String?> = chat.errorText
  val chatHealthOk: StateFlow<Boolean> = chat.healthOk
  val chatThinkingLevel: StateFlow<String> = chat.thinkingLevel
  val chatStreamingAssistantText: StateFlow<String?> = chat.streamingAssistantText
  val chatPendingToolCalls: StateFlow<List<ChatPendingToolCall>> = chat.pendingToolCalls
  val chatSessions: StateFlow<List<ChatSessionEntry>> = chat.sessions
  val pendingRunCount: StateFlow<Int> = chat.pendingRunCount

  init {
    if (prefs.voiceWakeMode.value != VoiceWakeMode.Off) {
      prefs.setVoiceWakeMode(VoiceWakeMode.Off)
    }

    scope.launch {
      prefs.loadGatewayToken()
    }

    scope.launch {
      prefs.talkEnabled.collect { enabled ->
        micCapture.setMicEnabled(enabled)
        externalAudioCaptureActive.value = enabled
      }
    }

    scope.launch(Dispatchers.Default) {
      gateways.collect { list ->
        if (list.isNotEmpty()) {
          // Security: don't let an unauthenticated discovery feed continuously steer autoconnect.
          // UX parity with iOS: only set once when unset.
          if (lastDiscoveredStableId.value.trim().isEmpty()) {
            prefs.setLastDiscoveredStableId(list.first().stableId)
          }
        }

        if (didAutoConnect) return@collect
        if (_isConnected.value) return@collect

        if (manualEnabled.value) {
          val host = manualHost.value.trim()
          val port = manualPort.value
          if (host.isNotEmpty() && port in 1..65535) {
            // Security: autoconnect only to previously trusted gateways (stored TLS pin).
            if (!manualTls.value) return@collect
            val stableId = GatewayEndpoint.manual(host = host, port = port).stableId
            val storedFingerprint = prefs.loadGatewayTlsFingerprint(stableId)?.trim().orEmpty()
            if (storedFingerprint.isEmpty()) return@collect

            didAutoConnect = true
            connect(GatewayEndpoint.manual(host = host, port = port))
          }
          return@collect
        }

        val targetStableId = lastDiscoveredStableId.value.trim()
        if (targetStableId.isEmpty()) return@collect
        val target = list.firstOrNull { it.stableId == targetStableId } ?: return@collect

        // Security: autoconnect only to previously trusted gateways (stored TLS pin).
        val storedFingerprint = prefs.loadGatewayTlsFingerprint(target.stableId)?.trim().orEmpty()
        if (storedFingerprint.isEmpty()) return@collect

        didAutoConnect = true
        connect(target)
      }
    }

    scope.launch {
      combine(
        canvasDebugStatusEnabled,
        statusText,
        serverName,
        remoteAddress,
      ) { debugEnabled, status, server, remote ->
        Quad(debugEnabled, status, server, remote)
      }.distinctUntilChanged()
        .collect { (debugEnabled, status, server, remote) ->
          canvas.setDebugStatusEnabled(debugEnabled)
          if (!debugEnabled) return@collect
          canvas.setDebugStatus(status, server ?: remote)
        }
    }
  }

  fun setForeground(value: Boolean) {
    _isForeground.value = value
  }

  fun setDisplayName(value: String) {
    prefs.setDisplayName(value)
  }

  fun setCameraEnabled(value: Boolean) {
    prefs.setCameraEnabled(value)
  }

  fun setLocationMode(mode: LocationMode) {
    prefs.setLocationMode(mode)
  }

  fun setLocationPreciseEnabled(value: Boolean) {
    prefs.setLocationPreciseEnabled(value)
  }

  fun setPreventSleep(value: Boolean) {
    prefs.setPreventSleep(value)
  }

  fun setManualEnabled(value: Boolean) {
    prefs.setManualEnabled(value)
  }

  fun setManualHost(value: String) {
    prefs.setManualHost(value)
  }

  fun setManualPort(value: Int) {
    prefs.setManualPort(value)
  }

  fun setManualTls(value: Boolean) {
    prefs.setManualTls(value)
  }

  fun setCanvasDebugStatusEnabled(value: Boolean) {
    prefs.setCanvasDebugStatusEnabled(value)
  }

  fun setMicEnabled(value: Boolean) {
    prefs.setTalkEnabled(value)
    micCapture.setMicEnabled(value)
    externalAudioCaptureActive.value = value
  }

  val speakerEnabled: StateFlow<Boolean>
    get() = prefs.speakerEnabled

  fun setSpeakerEnabled(value: Boolean) {
    prefs.setSpeakerEnabled(value)
    if (voiceReplySpeakerLazy.isInitialized()) {
      voiceReplySpeaker.setPlaybackEnabled(value)
    }
  }

  fun refreshGatewayConnection() {
    val endpoint =
      connectedEndpoint ?: run {
        _statusText.value = "Failed: no cached gateway endpoint"
        return
      }
    operatorStatusText = "Connecting…"
    updateStatus()
    val token = prefs.loadGatewayToken()
    val password = prefs.loadGatewayPassword()
    val tls = connectionManager.resolveTlsParams(endpoint)
    operatorSession.connect(endpoint, token, password, connectionManager.buildOperatorConnectOptions(), tls)
    nodeSession.connect(endpoint, token, password, connectionManager.buildNodeConnectOptions(), tls)
    operatorSession.reconnect()
    nodeSession.reconnect()
  }

  fun connect(endpoint: GatewayEndpoint) {
    val tls = connectionManager.resolveTlsParams(endpoint)
    if (tls?.required == true && tls.expectedFingerprint.isNullOrBlank()) {
      // First-time TLS: capture fingerprint, ask user to verify out-of-band, then store and connect.
      _statusText.value = "Verify gateway TLS fingerprint…"
      scope.launch {
        val fp = probeGatewayTlsFingerprint(endpoint.host, endpoint.port) ?: run {
          _statusText.value = "Failed: can't read TLS fingerprint"
          return@launch
        }
        _pendingGatewayTrust.value = GatewayTrustPrompt(endpoint = endpoint, fingerprintSha256 = fp)
      }
      return
    }

    connectedEndpoint = endpoint
    operatorStatusText = "Connecting…"
    nodeStatusText = "Connecting…"
    updateStatus()
    val token = prefs.loadGatewayToken()
    val password = prefs.loadGatewayPassword()
    operatorSession.connect(endpoint, token, password, connectionManager.buildOperatorConnectOptions(), tls)
    nodeSession.connect(endpoint, token, password, connectionManager.buildNodeConnectOptions(), tls)
  }

  fun acceptGatewayTrustPrompt() {
    val prompt = _pendingGatewayTrust.value ?: return
    _pendingGatewayTrust.value = null
    prefs.saveGatewayTlsFingerprint(prompt.endpoint.stableId, prompt.fingerprintSha256)
    connect(prompt.endpoint)
  }

  fun declineGatewayTrustPrompt() {
    _pendingGatewayTrust.value = null
    _statusText.value = "Offline"
  }

  private fun hasRecordAudioPermission(): Boolean {
    return (
      ContextCompat.checkSelfPermission(appContext, Manifest.permission.RECORD_AUDIO) ==
        PackageManager.PERMISSION_GRANTED
      )
  }

  fun connectManual() {
    val host = manualHost.value.trim()
    val port = manualPort.value
    if (host.isEmpty() || port <= 0 || port > 65535) {
      _statusText.value = "Failed: invalid manual host/port"
      return
    }
    connect(GatewayEndpoint.manual(host = host, port = port))
  }

  fun disconnect() {
    connectedEndpoint = null
    _pendingGatewayTrust.value = null
    operatorSession.disconnect()
    nodeSession.disconnect()
  }

  fun handleCanvasA2UIActionFromWebView(payloadJson: String) {
    scope.launch {
      val trimmed = payloadJson.trim()
      if (trimmed.isEmpty()) return@launch

      val root =
        try {
          json.parseToJsonElement(trimmed).asObjectOrNull() ?: return@launch
        } catch (_: Throwable) {
          return@launch
        }

      val userActionObj = (root["userAction"] as? JsonObject) ?: root
      val actionId = (userActionObj["id"] as? JsonPrimitive)?.content?.trim().orEmpty().ifEmpty {
        java.util.UUID.randomUUID().toString()
      }
      val name = OpenClawCanvasA2UIAction.extractActionName(userActionObj) ?: return@launch

      val surfaceId =
        (userActionObj["surfaceId"] as? JsonPrimitive)?.content?.trim().orEmpty().ifEmpty { "main" }
      val sourceComponentId =
        (userActionObj["sourceComponentId"] as? JsonPrimitive)?.content?.trim().orEmpty().ifEmpty { "-" }
      val contextJson = (userActionObj["context"] as? JsonObject)?.toString()

      val sessionKey = resolveMainSessionKey()
      val message =
        OpenClawCanvasA2UIAction.formatAgentMessage(
          actionName = name,
          sessionKey = sessionKey,
          surfaceId = surfaceId,
          sourceComponentId = sourceComponentId,
          host = displayName.value,
          instanceId = instanceId.value.lowercase(),
          contextJson = contextJson,
        )

      val connected = _nodeConnected.value
      var error: String? = null
      if (connected) {
        val sent =
          nodeSession.sendNodeEvent(
            event = "agent.request",
            payloadJson =
              buildJsonObject {
                put("message", JsonPrimitive(message))
                put("sessionKey", JsonPrimitive(sessionKey))
                put("thinking", JsonPrimitive("low"))
                put("deliver", JsonPrimitive(false))
                put("key", JsonPrimitive(actionId))
              }.toString(),
          )
        if (!sent) {
          error = "send failed"
        }
      } else {
        error = "gateway not connected"
      }

      try {
        canvas.eval(
          OpenClawCanvasA2UIAction.jsDispatchA2UIActionStatus(
            actionId = actionId,
            ok = connected && error == null,
            error = error,
          ),
        )
      } catch (_: Throwable) {
        // ignore
      }
    }
  }

  fun loadChat(sessionKey: String) {
    val key = sessionKey.trim().ifEmpty { resolveMainSessionKey() }
    chat.load(key)
  }

  fun refreshChat() {
    chat.refresh()
  }

  fun refreshChatSessions(limit: Int? = null) {
    chat.refreshSessions(limit = limit)
  }

  fun setChatThinkingLevel(level: String) {
    chat.setThinkingLevel(level)
  }

  fun switchChatSession(sessionKey: String) {
    chat.switchSession(sessionKey)
  }

  fun abortChat() {
    chat.abort()
  }

  fun sendChat(message: String, thinking: String, attachments: List<OutgoingAttachment>) {
    chat.sendMessage(message = message, thinkingLevel = thinking, attachments = attachments)
  }

  private fun handleGatewayEvent(event: String, payloadJson: String?) {
    micCapture.handleGatewayEvent(event, payloadJson)
    chat.handleGatewayEvent(event, payloadJson)
  }

  private fun parseChatSendRunId(response: String): String? {
    return try {
      val root = json.parseToJsonElement(response).asObjectOrNull() ?: return null
      root["runId"].asStringOrNull()
    } catch (_: Throwable) {
      null
    }
  }

  private suspend fun refreshBrandingFromGateway() {
    if (!_isConnected.value) return
    try {
      val res = operatorSession.request("config.get", "{}")
      val root = json.parseToJsonElement(res).asObjectOrNull()
      val config = root?.get("config").asObjectOrNull()
      val ui = config?.get("ui").asObjectOrNull()
      val raw = ui?.get("seamColor").asStringOrNull()?.trim()
      val sessionCfg = config?.get("session").asObjectOrNull()
      val mainKey = normalizeMainKey(sessionCfg?.get("mainKey").asStringOrNull())
      applyMainSessionKey(mainKey)

      val parsed = parseHexColorArgb(raw)
      _seamColorArgb.value = parsed ?: DEFAULT_SEAM_COLOR_ARGB
    } catch (_: Throwable) {
      // ignore
    }
  }

  private fun triggerCameraFlash() {
    // Token is used as a pulse trigger; value doesn't matter as long as it changes.
    _cameraFlashToken.value = SystemClock.elapsedRealtimeNanos()
  }

  private fun showCameraHud(message: String, kind: CameraHudKind, autoHideMs: Long? = null) {
    val token = cameraHudSeq.incrementAndGet()
    _cameraHud.value = CameraHudState(token = token, kind = kind, message = message)

    if (autoHideMs != null && autoHideMs > 0) {
      scope.launch {
        delay(autoHideMs)
        if (_cameraHud.value?.token == token) _cameraHud.value = null
      }
    }
  }

}
