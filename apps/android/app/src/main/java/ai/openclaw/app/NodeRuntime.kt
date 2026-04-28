package ai.openclaw.app

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.SystemClock
import android.util.Log
import androidx.core.content.ContextCompat
import ai.openclaw.app.chat.ChatController
import ai.openclaw.app.chat.ChatMessage
import ai.openclaw.app.chat.ChatPendingToolCall
import ai.openclaw.app.wear.WearProxyBridge
import ai.openclaw.app.wear.WearProxyEventSession
import ai.openclaw.android.gateway.GatewayEvent
import ai.openclaw.android.gateway.ChatSessionEntry
import ai.openclaw.app.chat.OutgoingAttachment
import ai.openclaw.app.gateway.DeviceIdentityStore
import ai.openclaw.app.gateway.GatewayConnectAuth
import ai.openclaw.app.gateway.GatewayEndpoint
import ai.openclaw.app.gateway.GatewayTrustPrompt
import ai.openclaw.app.gateway.GatewayTlsProbeResult
import ai.openclaw.app.gateway.probeGatewayTlsFingerprint
import ai.openclaw.app.gateway.NodeGatewayCoordinator
import ai.openclaw.app.node.*
import ai.openclaw.app.protocol.OpenClawCanvasA2UIAction
import ai.openclaw.app.voice.MicCaptureManager
import ai.openclaw.app.voice.TalkModeManager
import ai.openclaw.app.voice.VoiceConversationEntry
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import java.util.UUID
import java.util.concurrent.atomic.AtomicLong

class NodeRuntime(
  context: Context,
  val prefs: SecurePrefs = SecurePrefs(context.applicationContext),
  private val tlsFingerprintProbe: suspend (String, Int) -> GatewayTlsProbeResult = ::probeGatewayTlsFingerprint,
) {
  private val appContext = context.applicationContext
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  val canvas = CanvasController()
  val camera = CameraCaptureManager(appContext)
  val location = LocationCaptureManager(appContext)
  val sms = SmsManager(appContext)
  private val json = Json { ignoreUnknownKeys = true }

  private val externalAudioCaptureActive = MutableStateFlow(false)
  private val _voiceCaptureMode = MutableStateFlow(VoiceCaptureMode.Off)
  val voiceCaptureMode: StateFlow<VoiceCaptureMode> = _voiceCaptureMode.asStateFlow()

  private val identityStore = DeviceIdentityStore(appContext)
  private val homeCanvasPayloadBuilder = HomeCanvasPayloadBuilder()

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

  private val locationHandler: LocationHandler = LocationHandler(
    appContext = appContext,
    location = location,
    json = json,
    isForeground = { _isForeground.value },
    locationPreciseEnabled = { locationPreciseEnabled.value },
  )

  private val deviceHandler: DeviceHandler = DeviceHandler(
    appContext = appContext,
    smsEnabled = BuildConfig.OPENCLAW_ENABLE_SMS,
    callLogEnabled = BuildConfig.OPENCLAW_ENABLE_CALL_LOG,
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

  private val callLogHandler: CallLogHandler = CallLogHandler(
    appContext = appContext,
  )

  private val motionHandler: MotionHandler = MotionHandler(
    appContext = appContext,
  )

  private val smsHandlerImpl: SmsHandler = SmsHandler(
    sms = sms,
  )

  private val connectionManager: ConnectionManager = ConnectionManager(
    prefs = prefs,
    cameraEnabled = { cameraEnabled.value },
    locationMode = { locationMode.value },
    voiceWakeMode = { VoiceWakeMode.Off },
    motionActivityAvailable = { motionHandler.isActivityAvailable() },
    motionPedometerAvailable = { motionHandler.isPedometerAvailable() },
    sendSmsAvailable = { BuildConfig.OPENCLAW_ENABLE_SMS && sms.canSendSms() },
    readSmsAvailable = { BuildConfig.OPENCLAW_ENABLE_SMS && sms.canReadSms() },
    smsSearchPossible = { BuildConfig.OPENCLAW_ENABLE_SMS && sms.hasTelephonyFeature() },
    callLogAvailable = { BuildConfig.OPENCLAW_ENABLE_CALL_LOG },
    hasRecordAudioPermission = { hasRecordAudioPermission() },
    manualTls = { manualTls.value },
  )

  // Centralize discovery + session wiring so NodeRuntime can focus on device/UI logic.
  private val gatewayCoordinator =
    NodeGatewayCoordinator(
      context = appContext,
      scope = scope,
      prefs = prefs,
      connectionManager = connectionManager,
      identityStore = identityStore,
      callbacks =
        NodeGatewayCoordinator.Callbacks(
          onOperatorConnected = { _, _, mainSessionKey ->
            applyMainSessionKey(mainSessionKey)
            micCapture.onGatewayConnectionChanged(true)
            scope.launch {
              refreshHomeCanvasOverviewIfConnected()
              if (voiceReplySpeakerLazy.isInitialized()) {
                voiceReplySpeaker.refreshConfig()
              }
            }
          },
          onOperatorDisconnected = { message ->
            if (!isCanonicalMainSessionKey(_mainSessionKey.value)) {
              _mainSessionKey.value = "main"
            }
            chat.applyMainSessionKey(resolveMainSessionKey())
            chat.onDisconnected(message)
            micCapture.onGatewayConnectionChanged(false)
          },
          onOperatorEvent = { event, payloadJson ->
            handleGatewayEvent(event, payloadJson)
          },
          onNodeConnected = {
            didAutoRequestCanvasRehydrate = false
            _canvasA2uiHydrated.value = false
            _canvasRehydratePending.value = false
            _canvasRehydrateErrorText.value = null
            showLocalCanvasOnConnect()
          },
          onNodeDisconnected = { _ ->
            didAutoRequestCanvasRehydrate = false
            _canvasA2uiHydrated.value = false
            _canvasRehydratePending.value = false
            _canvasRehydrateErrorText.value = null
            showLocalCanvasOnDisconnect()
          },
          onNodeInvoke = { req ->
            invokeDispatcher.handleInvoke(req.command, req.paramsJson)
          },
          onStatusChanged = {
            updateHomeCanvasState()
          },
        ),
      tlsFingerprintProbe = tlsFingerprintProbe,
    )

  private val operatorSession = gatewayCoordinator.operatorSession
  private val nodeSession = gatewayCoordinator.nodeSession

  private val a2uiHandler: A2UIHandler = A2UIHandler(
    canvas = canvas,
    json = json,
    getNodeCanvasHostUrl = { nodeSession.currentCanvasHostUrl() },
    getOperatorCanvasHostUrl = { operatorSession.currentCanvasHostUrl() },
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
    smsHandler = smsHandlerImpl,
    a2uiHandler = a2uiHandler,
    debugHandler = debugHandler,
    callLogHandler = callLogHandler,
    isForeground = { _isForeground.value },
    cameraEnabled = { cameraEnabled.value },
    locationEnabled = { locationMode.value != LocationMode.Off },
    sendSmsAvailable = { BuildConfig.OPENCLAW_ENABLE_SMS && sms.canSendSms() },
    readSmsAvailable = { BuildConfig.OPENCLAW_ENABLE_SMS && sms.canReadSms() },
    smsFeatureEnabled = { BuildConfig.OPENCLAW_ENABLE_SMS },
    smsTelephonyAvailable = { sms.hasTelephonyFeature() },
    callLogAvailable = { BuildConfig.OPENCLAW_ENABLE_CALL_LOG },
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
  val gateways: StateFlow<List<GatewayEndpoint>> = gatewayCoordinator.gateways
  val discoveryStatusText: StateFlow<String> = gatewayCoordinator.discoveryStatusText

  val isConnected: StateFlow<Boolean> = gatewayCoordinator.isConnected
  val nodeConnected: StateFlow<Boolean> = gatewayCoordinator.nodeConnected

  val statusText: StateFlow<String> = gatewayCoordinator.statusText

  val pendingGatewayTrust: StateFlow<GatewayTrustPrompt?> = gatewayCoordinator.pendingGatewayTrust

  private fun resolveNodeMainSessionKey(agentId: String? = gatewayDefaultAgentId): String {
    val deviceId = identityStore.loadOrCreate().deviceId
    return buildNodeMainSessionKey(deviceId, agentId)
  }

  private val _mainSessionKey = MutableStateFlow(resolveNodeMainSessionKey())
  val mainSessionKey: StateFlow<String> = _mainSessionKey.asStateFlow()

  private val cameraHudSeq = AtomicLong(0)
  private val _cameraHud = MutableStateFlow<CameraHudState?>(null)
  val cameraHud: StateFlow<CameraHudState?> = _cameraHud.asStateFlow()

  private val _cameraFlashToken = MutableStateFlow(0L)
  val cameraFlashToken: StateFlow<Long> = _cameraFlashToken.asStateFlow()

  private val _canvasA2uiHydrated = MutableStateFlow(false)
  val canvasA2uiHydrated: StateFlow<Boolean> = _canvasA2uiHydrated.asStateFlow()
  private val _canvasRehydratePending = MutableStateFlow(false)
  val canvasRehydratePending: StateFlow<Boolean> = _canvasRehydratePending.asStateFlow()
  private val _canvasRehydrateErrorText = MutableStateFlow<String?>(null)
  val canvasRehydrateErrorText: StateFlow<String?> = _canvasRehydrateErrorText.asStateFlow()

  val serverName: StateFlow<String?> = gatewayCoordinator.serverName
  val remoteAddress: StateFlow<String?> = gatewayCoordinator.remoteAddress
  val seamColorArgb: StateFlow<Long> = gatewayCoordinator.seamColorArgb

  private val _isForeground = MutableStateFlow(true)
  val isForeground: StateFlow<Boolean> = _isForeground.asStateFlow()

  private var gatewayDefaultAgentId: String? = null
  private var gatewayAgents: List<GatewayAgentSummary> = emptyList()
  private var didAutoRequestCanvasRehydrate = false
  private val canvasRehydrateSeq = AtomicLong(0)

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
    ).also {
      it.applyMainSessionKey(_mainSessionKey.value)
    }
  private val voiceReplySpeakerLazy: Lazy<TalkModeManager> = lazy {
    // Reuse the existing TalkMode speech engine for native Android TTS playback
    // without enabling the legacy talk capture loop.
    TalkModeManager(
      context = appContext,
      scope = scope,
      session = operatorSession,
      supportsChatSubscribe = false,
      isConnected = { isConnected.value },
      onBeforeSpeak = { micCapture.pauseForTts() },
      onAfterSpeak = { micCapture.resumeAfterTts() },
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
      sendToGateway = { message, onRunIdKnown ->
        val idempotencyKey = UUID.randomUUID().toString()
        // Notify MicCaptureManager of the idempotency key *before* the network
        // call so pendingRunId is set before any chat events can arrive.
        onRunIdKnown(idempotencyKey)
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
        // Voice-tab replies should speak through the dedicated reply speaker.
        // Relying on talkMode.ttsOnAllResponses here can drop playback if the
        // chat-event path misses the terminal event for this turn.
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

  val micCooldown: StateFlow<Boolean>
    get() = micCapture.micCooldown

  val micQueuedMessages: StateFlow<List<String>>
    get() = micCapture.queuedMessages

  val micConversation: StateFlow<List<VoiceConversationEntry>>
    get() = micCapture.conversation

  val micInputLevel: StateFlow<Float>
    get() = micCapture.inputLevel

  val micIsSending: StateFlow<Boolean>
    get() = micCapture.isSending

  private val talkMode: TalkModeManager by lazy {
    TalkModeManager(
      context = appContext,
      scope = scope,
      session = operatorSession,
      supportsChatSubscribe = true,
      isConnected = { isConnected.value },
      onBeforeSpeak = { micCapture.pauseForTts() },
      onAfterSpeak = { micCapture.resumeAfterTts() },
    )
  }

  val talkModeEnabled: StateFlow<Boolean>
    get() = talkMode.isEnabled

  val talkModeListening: StateFlow<Boolean>
    get() = talkMode.isListening

  val talkModeSpeaking: StateFlow<Boolean>
    get() = talkMode.isSpeaking

  val talkModeStatusText: StateFlow<String>
    get() = talkMode.statusText

  private fun syncMainSessionKey(agentId: String?) {
    val resolvedKey = resolveNodeMainSessionKey(agentId)
    // Always push the resolved session key into TalkMode, even when the
    // state flow value is unchanged, so lazy TalkMode instances do not
    // stay on the default "main" session key.
    talkMode.setMainSessionKey(resolvedKey)
    if (_mainSessionKey.value == resolvedKey) return
    _mainSessionKey.value = resolvedKey
    emitWearProxyEvent("mainSessionKey", resolvedKey)
    chat.applyMainSessionKey(resolvedKey)
    updateHomeCanvasState()
  }

  private fun applyMainSessionKey(candidate: String?) {
    val trimmed = normalizeMainKey(candidate)
    if (_mainSessionKey.value == trimmed) return
    _mainSessionKey.value = trimmed
    emitWearProxyEvent("mainSessionKey", trimmed)
    talkMode.setMainSessionKey(trimmed)
    chat.applyMainSessionKey(trimmed)
    updateHomeCanvasState()
  }

  private fun resolveMainSessionKey(): String {
    val trimmed = _mainSessionKey.value.trim()
    return if (trimmed.isEmpty()) "main" else trimmed
  }

  private fun showLocalCanvasOnConnect() {
    _canvasA2uiHydrated.value = false
    _canvasRehydratePending.value = false
    _canvasRehydrateErrorText.value = null
    canvas.navigate("")
  }

  private fun showLocalCanvasOnDisconnect() {
    _canvasA2uiHydrated.value = false
    _canvasRehydratePending.value = false
    _canvasRehydrateErrorText.value = null
    canvas.navigate("")
  }

  fun refreshHomeCanvasOverviewIfConnected() {
    if (!isConnected.value) {
      updateHomeCanvasState()
      return
    }
    scope.launch {
      refreshBrandingFromGateway()
      refreshAgentsFromGateway()
    }
  }

  fun requestCanvasRehydrate(source: String = "manual", force: Boolean = true) {
    scope.launch {
      if (!nodeConnected.value) {
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
  fun setGatewayBootstrapToken(value: String) = prefs.setGatewayBootstrapToken(value)
  fun setGatewayPassword(value: String) = prefs.setGatewayPassword(value)
  fun resetGatewaySetupAuth() {
    prefs.clearGatewaySetupAuth()
    val deviceId = identityStore.loadOrCreate().deviceId
    gatewayCoordinator.clearStoredDeviceTokens(deviceId)
  }
  fun setOnboardingCompleted(value: Boolean) = prefs.setOnboardingCompleted(value)
  val lastDiscoveredStableId: StateFlow<String> = prefs.lastDiscoveredStableId
  val canvasDebugStatusEnabled: StateFlow<Boolean> = prefs.canvasDebugStatusEnabled
  val notificationForwardingEnabled: StateFlow<Boolean> = prefs.notificationForwardingEnabled
  val notificationForwardingMode: StateFlow<NotificationPackageFilterMode> =
    prefs.notificationForwardingMode
  val notificationForwardingPackages: StateFlow<Set<String>> = prefs.notificationForwardingPackages
  val notificationForwardingQuietHoursEnabled: StateFlow<Boolean> =
    prefs.notificationForwardingQuietHoursEnabled
  val notificationForwardingQuietStart: StateFlow<String> = prefs.notificationForwardingQuietStart
  val notificationForwardingQuietEnd: StateFlow<String> = prefs.notificationForwardingQuietEnd
  val notificationForwardingMaxEventsPerMinute: StateFlow<Int> =
    prefs.notificationForwardingMaxEventsPerMinute
  val notificationForwardingSessionKey: StateFlow<String?> = prefs.notificationForwardingSessionKey

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

    if (prefs.voiceMicEnabled.value) {
      setVoiceCaptureMode(VoiceCaptureMode.ManualMic, persistManualMic = false)
    }
    gatewayCoordinator.startAutoConnect()

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

    updateHomeCanvasState()
  }

  fun setForeground(value: Boolean) {
    _isForeground.value = value
    if (value) {
      gatewayCoordinator.reconnectPreferredGatewayOnForeground()
    } else {
      stopManualVoiceSession()
    }
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

  fun setNotificationForwardingEnabled(value: Boolean) {
    prefs.setNotificationForwardingEnabled(value)
  }

  fun setNotificationForwardingMode(mode: NotificationPackageFilterMode) {
    prefs.setNotificationForwardingMode(mode)
  }

  fun setNotificationForwardingPackages(packages: List<String>) {
    prefs.setNotificationForwardingPackages(packages)
  }

  fun setNotificationForwardingQuietHours(
    enabled: Boolean,
    start: String,
    end: String,
  ): Boolean {
    return prefs.setNotificationForwardingQuietHours(enabled = enabled, start = start, end = end)
  }

  fun setNotificationForwardingMaxEventsPerMinute(value: Int) {
    prefs.setNotificationForwardingMaxEventsPerMinute(value)
  }

  fun setNotificationForwardingSessionKey(value: String?) {
    prefs.setNotificationForwardingSessionKey(value)
  }

  fun setVoiceScreenActive(active: Boolean) {
    if (!active) {
      stopManualVoiceSession()
    }
    // Don't re-enable on active=true; mic toggle drives that
  }

  fun setMicEnabled(value: Boolean) {
    setVoiceCaptureMode(if (value) VoiceCaptureMode.ManualMic else VoiceCaptureMode.Off)
  }

  fun setTalkModeEnabled(value: Boolean) {
    setVoiceCaptureMode(if (value) VoiceCaptureMode.TalkMode else VoiceCaptureMode.Off)
  }

  val speakerEnabled: StateFlow<Boolean>
    get() = prefs.speakerEnabled

  fun setSpeakerEnabled(value: Boolean) {
    prefs.setSpeakerEnabled(value)
    if (voiceReplySpeakerLazy.isInitialized()) {
      voiceReplySpeaker.setPlaybackEnabled(value)
    }
    // Keep TalkMode in sync so any active Talk playback also respects speaker mute.
    talkMode.setPlaybackEnabled(value)
  }

  private fun setVoiceCaptureMode(
    mode: VoiceCaptureMode,
    persistManualMic: Boolean = true,
  ) {
    if (mode == VoiceCaptureMode.TalkMode && !hasRecordAudioPermission()) {
      _voiceCaptureMode.value = VoiceCaptureMode.Off
      externalAudioCaptureActive.value = false
      return
    }
    if (_voiceCaptureMode.value == mode) return
    _voiceCaptureMode.value = mode
    when (mode) {
      VoiceCaptureMode.Off -> {
        talkMode.ttsOnAllResponses = false
        talkMode.setEnabled(false)
        stopVoicePlayback()
        micCapture.setMicEnabled(false)
        if (persistManualMic) {
          prefs.setVoiceMicEnabled(false)
        }
        NodeForegroundService.setVoiceCaptureMode(appContext, VoiceCaptureMode.Off)
        externalAudioCaptureActive.value = false
      }

      VoiceCaptureMode.ManualMic -> {
        talkMode.ttsOnAllResponses = false
        talkMode.setEnabled(false)
        NodeForegroundService.setVoiceCaptureMode(appContext, VoiceCaptureMode.ManualMic)
        if (persistManualMic) {
          prefs.setVoiceMicEnabled(true)
        }
        // Tapping mic on interrupts any active TTS (barge-in).
        stopVoicePlayback()
        scope.launch { talkMode.ensureChatSubscribed() }
        micCapture.setMicEnabled(true)
        externalAudioCaptureActive.value = true
      }

      VoiceCaptureMode.TalkMode -> {
        if (persistManualMic) {
          prefs.setVoiceMicEnabled(false)
        }
        micCapture.setMicEnabled(false)
        NodeForegroundService.setVoiceCaptureMode(appContext, VoiceCaptureMode.TalkMode)
        talkMode.ttsOnAllResponses = true
        talkMode.setPlaybackEnabled(speakerEnabled.value)
        scope.launch { talkMode.ensureChatSubscribed() }
        talkMode.setEnabled(true)
        externalAudioCaptureActive.value = true
      }
    }
  }

  private fun stopManualVoiceSession() {
    if (_voiceCaptureMode.value != VoiceCaptureMode.ManualMic) return
    setVoiceCaptureMode(VoiceCaptureMode.Off)
  }

  private fun stopActiveVoiceSession() {
    talkMode.ttsOnAllResponses = false
    talkMode.setEnabled(false)
    stopVoicePlayback()
    micCapture.setMicEnabled(false)
    prefs.setVoiceMicEnabled(false)
    NodeForegroundService.setVoiceCaptureMode(appContext, VoiceCaptureMode.Off)
    _voiceCaptureMode.value = VoiceCaptureMode.Off
    externalAudioCaptureActive.value = false
  }

  private fun stopVoicePlayback() {
    talkMode.stopTts()
    if (voiceReplySpeakerLazy.isInitialized()) {
      voiceReplySpeaker.stopTts()
    }
  }

  fun refreshGatewayConnection() {
    gatewayCoordinator.refreshConnection()
  }

  fun connect(endpoint: GatewayEndpoint) {
    gatewayCoordinator.connect(endpoint)
  }

  fun connect(
    endpoint: GatewayEndpoint,
    auth: GatewayConnectAuth,
  ) {
    gatewayCoordinator.connect(endpoint, auth)
  }

  internal fun resolveGatewayConnectAuth(explicitAuth: GatewayConnectAuth? = null): GatewayConnectAuth {
    return explicitAuth
      ?: GatewayConnectAuth(
        token = prefs.loadGatewayToken(),
        bootstrapToken = prefs.loadGatewayBootstrapToken(),
        password = prefs.loadGatewayPassword(),
      )
  }

  fun acceptGatewayTrustPrompt() {
    gatewayCoordinator.acceptGatewayTrustPrompt()
  }

  fun declineGatewayTrustPrompt() {
    gatewayCoordinator.declineGatewayTrustPrompt()
  }

  private fun hasRecordAudioPermission(): Boolean {
    return (
      ContextCompat.checkSelfPermission(appContext, Manifest.permission.RECORD_AUDIO) ==
        PackageManager.PERMISSION_GRANTED
      )
  }

  fun connectManual() {
    gatewayCoordinator.connectManual()
  }

  fun disconnect() {
    stopActiveVoiceSession()
    gatewayCoordinator.disconnect()
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

      val connected = nodeConnected.value
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

  fun isTrustedCanvasActionUrl(rawUrl: String?): Boolean {
    return a2uiHandler.isTrustedCanvasActionUrl(rawUrl)
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

  suspend fun sendChatAwaitAcceptance(
    message: String,
    thinking: String,
    attachments: List<OutgoingAttachment>,
  ): Boolean {
    return chat.sendMessageAwaitAcceptance(message = message, thinkingLevel = thinking, attachments = attachments)
  }

  private fun handleGatewayEvent(event: String, payloadJson: String?) {
    micCapture.handleGatewayEvent(event, payloadJson)
    talkMode.handleGatewayEvent(event, payloadJson)
    chat.handleGatewayEvent(event, payloadJson)
    emitWearProxyEvent(event, payloadJson)
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
    if (!isConnected.value) return
    try {
      val res = operatorSession.request("config.get", "{}")
      val root = json.parseToJsonElement(res).asObjectOrNull()
      val config = root?.get("config").asObjectOrNull()
      val ui = config?.get("ui").asObjectOrNull()
      val raw = ui?.get("seamColor").asStringOrNull()?.trim()
      syncMainSessionKey(gatewayDefaultAgentId)

      val parsed = parseHexColorArgb(raw)
      gatewayCoordinator.updateSeamColorArgb(parsed ?: DEFAULT_SEAM_COLOR_ARGB)
      updateHomeCanvasState()
    } catch (_: Throwable) {
      // ignore
    }
  }

  private suspend fun refreshAgentsFromGateway() {
    if (!isConnected.value) return
    try {
      val res = operatorSession.request("agents.list", "{}")
      val root = json.parseToJsonElement(res).asObjectOrNull() ?: return
      val defaultAgentId = root["defaultId"].asStringOrNull()?.trim().orEmpty()
      val mainKey = normalizeMainKey(root["mainKey"].asStringOrNull())
      val agents =
        (root["agents"] as? JsonArray)?.mapNotNull { item ->
          val obj = item.asObjectOrNull() ?: return@mapNotNull null
          val id = obj["id"].asStringOrNull()?.trim().orEmpty()
          if (id.isEmpty()) return@mapNotNull null
          val name = obj["name"].asStringOrNull()?.trim()
          val emoji = obj["identity"].asObjectOrNull()?.get("emoji").asStringOrNull()?.trim()
          GatewayAgentSummary(
            id = id,
            name = name?.takeIf { it.isNotEmpty() },
            emoji = emoji?.takeIf { it.isNotEmpty() },
          )
        } ?: emptyList()

      gatewayDefaultAgentId = defaultAgentId.ifEmpty { null }
      gatewayAgents = agents
      syncMainSessionKey(resolveAgentIdFromMainSessionKey(mainKey) ?: gatewayDefaultAgentId)
      updateHomeCanvasState()
    } catch (_: Throwable) {
      // ignore
    }
  }

  private fun updateHomeCanvasState() {
    val payload =
      try {
        json.encodeToString(
          homeCanvasPayloadBuilder.build(
            HomeCanvasSnapshot(
              isConnected = isConnected.value,
              statusText = statusText.value,
              serverName = serverName.value,
              remoteAddress = remoteAddress.value,
              mainSessionKey = _mainSessionKey.value,
              defaultAgentId = gatewayDefaultAgentId,
              agents = gatewayAgents,
            ),
          ),
        )
      } catch (_: Throwable) {
        null
      }
    canvas.updateHomeCanvasState(payload)
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

  // -- Wear OS proxy support --

  private val wearProxyBridge =
    WearProxyBridge(
      scope = scope,
      json = json,
      isConnected = { isConnected.value },
      operatorStatusText = { gatewayCoordinator.operatorStatusText.value },
      statusText = { statusText.value },
      gatewayConfig = { gatewayCoordinator.buildWearProxyGatewayConfig() },
    )

  internal fun emitWearProxyEvent(event: String, payloadJson: String?) {
    wearProxyBridge.emit(event, payloadJson)
  }

  internal fun openWearProxyEventSession(logTag: String = "WearProxy"): WearProxyEventSession {
    return wearProxyBridge.openEventSession(logTag = logTag)
  }

  fun wearProxyHandshakePayload(): String {
    return wearProxyBridge.handshakePayload()
  }

  suspend fun requestForWearProxy(method: String, paramsJson: String?, timeoutMs: Long = 15_000): String {
    return operatorSession.request(method, paramsJson, timeoutMs)
  }

}
