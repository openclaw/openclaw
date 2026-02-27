package ai.openclaw.android

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import ai.openclaw.android.gateway.GatewayEndpoint
import ai.openclaw.android.chat.ChatConnectionState
import ai.openclaw.android.chat.ChatQueuedOutbound
import ai.openclaw.android.chat.OutgoingAttachment
import ai.openclaw.android.node.CameraCaptureManager
import ai.openclaw.android.node.CanvasController
import ai.openclaw.android.node.ScreenRecordManager
import ai.openclaw.android.node.SmsManager
import ai.openclaw.android.voice.VoiceConversationEntry
import kotlinx.coroutines.flow.StateFlow

class MainViewModel(app: Application) : AndroidViewModel(app) {
  private val runtime: NodeRuntime = (app as NodeApp).runtime

  val canvas: CanvasController = runtime.canvas
  val canvasCurrentUrl: StateFlow<String?> = runtime.canvas.currentUrl
  val canvasA2uiHydrated: StateFlow<Boolean> = runtime.canvasA2uiHydrated
  val canvasRehydratePending: StateFlow<Boolean> = runtime.canvasRehydratePending
  val canvasRehydrateErrorText: StateFlow<String?> = runtime.canvasRehydrateErrorText
  val camera: CameraCaptureManager = runtime.camera
  val screenRecorder: ScreenRecordManager = runtime.screenRecorder
  val sms: SmsManager = runtime.sms

  val gateways: StateFlow<List<GatewayEndpoint>> = runtime.gateways
  val discoveryStatusText: StateFlow<String> = runtime.discoveryStatusText

  val isConnected: StateFlow<Boolean> = runtime.isConnected
  val isNodeConnected: StateFlow<Boolean> = runtime.nodeConnected
  val statusText: StateFlow<String> = runtime.statusText
  val serverName: StateFlow<String?> = runtime.serverName
  val remoteAddress: StateFlow<String?> = runtime.remoteAddress
  val pendingGatewayTrust: StateFlow<NodeRuntime.GatewayTrustPrompt?> = runtime.pendingGatewayTrust
  val gatewayReconnectAttempts: StateFlow<Int> = runtime.gatewayReconnectAttempts
  val lastGatewayError: StateFlow<String?> = runtime.lastGatewayError
  val lastGatewayConnectedAtMs: StateFlow<Long?> = runtime.lastGatewayConnectedAtMs
  val lastGatewayDisconnectedAtMs: StateFlow<Long?> = runtime.lastGatewayDisconnectedAtMs
  val isForeground: StateFlow<Boolean> = runtime.isForeground
  val seamColorArgb: StateFlow<Long> = runtime.seamColorArgb
  val mainSessionKey: StateFlow<String> = runtime.mainSessionKey

  val cameraHud: StateFlow<CameraHudState?> = runtime.cameraHud
  val cameraFlashToken: StateFlow<Long> = runtime.cameraFlashToken
  val screenRecordActive: StateFlow<Boolean> = runtime.screenRecordActive

  val instanceId: StateFlow<String> = runtime.instanceId
  val displayName: StateFlow<String> = runtime.displayName
  val cameraEnabled: StateFlow<Boolean> = runtime.cameraEnabled
  val locationMode: StateFlow<LocationMode> = runtime.locationMode
  val locationPreciseEnabled: StateFlow<Boolean> = runtime.locationPreciseEnabled
  val preventSleep: StateFlow<Boolean> = runtime.preventSleep
  val micEnabled: StateFlow<Boolean> = runtime.micEnabled
  val micCooldown: StateFlow<Boolean> = runtime.micCooldown
  val micStatusText: StateFlow<String> = runtime.micStatusText
  val micLiveTranscript: StateFlow<String?> = runtime.micLiveTranscript
  val micIsListening: StateFlow<Boolean> = runtime.micIsListening
  val micQueuedMessages: StateFlow<List<String>> = runtime.micQueuedMessages
  val micConversation: StateFlow<List<VoiceConversationEntry>> = runtime.micConversation
  val micInputLevel: StateFlow<Float> = runtime.micInputLevel
  val micIsSending: StateFlow<Boolean> = runtime.micIsSending
  val speakerEnabled: StateFlow<Boolean> = runtime.speakerEnabled
  val manualEnabled: StateFlow<Boolean> = runtime.manualEnabled
  val manualHost: StateFlow<String> = runtime.manualHost
  val manualPort: StateFlow<Int> = runtime.manualPort
  val manualTls: StateFlow<Boolean> = runtime.manualTls
  val gatewayToken: StateFlow<String> = runtime.gatewayToken
  val onboardingCompleted: StateFlow<Boolean> = runtime.onboardingCompleted
  val canvasDebugStatusEnabled: StateFlow<Boolean> = runtime.canvasDebugStatusEnabled
  val backgroundBatteryHistoryEnabled: StateFlow<Boolean> = runtime.backgroundBatteryHistoryEnabled
  val backgroundLocationHistoryEnabled: StateFlow<Boolean> = runtime.backgroundLocationHistoryEnabled
  val telemetrySyncEnabled: StateFlow<Boolean> = runtime.telemetrySyncEnabled
  val telemetrySamplingMode: StateFlow<TelemetrySamplingMode> = runtime.telemetrySamplingMode
  val telemetryRetention: StateFlow<TelemetryRetention> = runtime.telemetryRetention

  val chatSessionKey: StateFlow<String> = runtime.chatSessionKey
  val chatSessionId: StateFlow<String?> = runtime.chatSessionId
  val chatMessages = runtime.chatMessages
  val chatError: StateFlow<String?> = runtime.chatError
  val chatHealthOk: StateFlow<Boolean> = runtime.chatHealthOk
  val chatConnectionState: StateFlow<ChatConnectionState> = runtime.chatConnectionState
  val chatThinkingLevel: StateFlow<String> = runtime.chatThinkingLevel
  val chatStreamingAssistantText: StateFlow<String?> = runtime.chatStreamingAssistantText
  val chatPendingToolCalls = runtime.chatPendingToolCalls
  val chatQueuedItems: StateFlow<List<ChatQueuedOutbound>> = runtime.chatQueuedItems
  val chatSessions = runtime.chatSessions
  val pendingRunCount: StateFlow<Int> = runtime.pendingRunCount

  fun setForeground(value: Boolean) {
    runtime.setForeground(value)
  }

  fun setDisplayName(value: String) {
    runtime.setDisplayName(value)
  }

  fun setCameraEnabled(value: Boolean) {
    runtime.setCameraEnabled(value)
  }

  fun setLocationMode(mode: LocationMode) {
    runtime.setLocationMode(mode)
  }

  fun setLocationPreciseEnabled(value: Boolean) {
    runtime.setLocationPreciseEnabled(value)
  }

  fun setPreventSleep(value: Boolean) {
    runtime.setPreventSleep(value)
  }

  fun setManualEnabled(value: Boolean) {
    runtime.setManualEnabled(value)
  }

  fun setManualHost(value: String) {
    runtime.setManualHost(value)
  }

  fun setManualPort(value: Int) {
    runtime.setManualPort(value)
  }

  fun setManualTls(value: Boolean) {
    runtime.setManualTls(value)
  }

  fun setGatewayToken(value: String) {
    runtime.setGatewayToken(value)
  }

  fun setGatewayPassword(value: String) {
    runtime.setGatewayPassword(value)
  }

  fun setOnboardingCompleted(value: Boolean) {
    runtime.setOnboardingCompleted(value)
  }

  fun setCanvasDebugStatusEnabled(value: Boolean) {
    runtime.setCanvasDebugStatusEnabled(value)
  }

  fun setBackgroundBatteryHistoryEnabled(value: Boolean) {
    runtime.setBackgroundBatteryHistoryEnabled(value)
  }

  fun setBackgroundLocationHistoryEnabled(value: Boolean) {
    runtime.setBackgroundLocationHistoryEnabled(value)
  }

  fun setTelemetrySyncEnabled(value: Boolean) {
    runtime.setTelemetrySyncEnabled(value)
  }

  fun setTelemetrySamplingMode(mode: TelemetrySamplingMode) {
    runtime.setTelemetrySamplingMode(mode)
  }

  fun setTelemetryRetention(retention: TelemetryRetention) {
    runtime.setTelemetryRetention(retention)
  }

  fun setVoiceScreenActive(active: Boolean) {
    runtime.setVoiceScreenActive(active)
  }

  fun setMicEnabled(enabled: Boolean) {
    runtime.setMicEnabled(enabled)
  }

  fun setSpeakerEnabled(enabled: Boolean) {
    runtime.setSpeakerEnabled(enabled)
  }

  fun refreshGatewayConnection() {
    runtime.refreshGatewayConnection()
  }

  fun connect(endpoint: GatewayEndpoint) {
    runtime.connect(endpoint)
  }

  fun connectManual() {
    runtime.connectManual()
  }

  fun gatewayDebugSummary(): String {
    return runtime.gatewayDebugSummary()
  }

  fun resetGatewayDiagnostics() {
    runtime.resetGatewayDiagnostics()
  }

  fun disconnect() {
    runtime.disconnect()
  }

  fun acceptGatewayTrustPrompt() {
    runtime.acceptGatewayTrustPrompt()
  }

  fun declineGatewayTrustPrompt() {
    runtime.declineGatewayTrustPrompt()
  }

  fun handleCanvasA2UIActionFromWebView(payloadJson: String) {
    runtime.handleCanvasA2UIActionFromWebView(payloadJson)
  }

  fun onCanvasPageFinished(url: String?) {
    runtime.onCanvasPageFinished(url)
  }

  fun requestCanvasRehydrate(source: String = "screen_tab") {
    runtime.requestCanvasRehydrate(source = source, force = true)
  }

  fun loadChat(sessionKey: String) {
    runtime.loadChat(sessionKey)
  }

  fun refreshChat() {
    runtime.refreshChat()
  }

  fun refreshChatSessions(limit: Int? = null) {
    runtime.refreshChatSessions(limit = limit)
  }

  fun setChatThinkingLevel(level: String) {
    runtime.setChatThinkingLevel(level)
  }

  fun switchChatSession(sessionKey: String) {
    runtime.switchChatSession(sessionKey)
  }

  fun abortChat() {
    runtime.abortChat()
  }

  fun retryLastChatMessage(): Boolean {
    return runtime.retryLastChatMessage()
  }

  fun sendChat(
    message: String,
    thinking: String,
    attachments: List<OutgoingAttachment>,
    reEvaluateOnReconnect: Boolean = false,
  ) {
    runtime.sendChat(
      message = message,
      thinking = thinking,
      attachments = attachments,
      reEvaluateOnReconnect = reEvaluateOnReconnect,
    )
  }
}
