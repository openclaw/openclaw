package ai.hanzo.bot.android

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import ai.hanzo.bot.android.chat.ChatMessage
import ai.hanzo.bot.android.chat.ChatPendingToolCall
import ai.hanzo.bot.android.chat.ChatSessionEntry
import ai.hanzo.bot.android.chat.OutgoingAttachment
import ai.hanzo.bot.android.gateway.GatewayEndpoint
import ai.hanzo.bot.android.node.CameraCaptureManager
import ai.hanzo.bot.android.node.CanvasController
import ai.hanzo.bot.android.node.ScreenRecordManager
import ai.hanzo.bot.android.node.SmsManager
import ai.hanzo.bot.android.voice.VoiceConversationEntry
import kotlinx.coroutines.flow.StateFlow

class MainViewModel(app: Application) : AndroidViewModel(app) {
  private val runtime: NodeRuntime = (app as NodeApp).runtime

  val canvas: CanvasController = runtime.canvas
  val camera: CameraCaptureManager = runtime.camera
  val screenRecorder: ScreenRecordManager = runtime.screenRecorder
  val sms: SmsManager = runtime.sms

  val gateways: StateFlow<List<GatewayEndpoint>> = runtime.gateways
  val discoveryStatusText: StateFlow<String> = runtime.discoveryStatusText

  val isConnected: StateFlow<Boolean> = runtime.isConnected
  val isNodeConnected: StateFlow<Boolean> = runtime.isNodeConnected
  val statusText: StateFlow<String> = runtime.statusText
  val serverName: StateFlow<String?> = runtime.serverName
  val remoteAddress: StateFlow<String?> = runtime.remoteAddress
  val pendingGatewayTrust: StateFlow<NodeRuntime.GatewayTrustPrompt?> = runtime.pendingGatewayTrust
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
  val wakeWords: StateFlow<List<String>> = runtime.wakeWords
  val voiceWakeMode: StateFlow<VoiceWakeMode> = runtime.voiceWakeMode
  val voiceWakeStatusText: StateFlow<String> = runtime.voiceWakeStatusText
  val voiceWakeIsListening: StateFlow<Boolean> = runtime.voiceWakeIsListening
  val talkEnabled: StateFlow<Boolean> = runtime.talkEnabled
  val talkStatusText: StateFlow<String> = runtime.talkStatusText
  val talkIsListening: StateFlow<Boolean> = runtime.talkIsListening
  val talkIsSpeaking: StateFlow<Boolean> = runtime.talkIsSpeaking
  val onboardingCompleted: StateFlow<Boolean> = runtime.onboardingCompleted
  val micEnabled: StateFlow<Boolean> = runtime.micEnabled
  val micStatusText: StateFlow<String> = runtime.micStatusText
  val micLiveTranscript: StateFlow<String?> = runtime.micLiveTranscript
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
  val canvasDebugStatusEnabled: StateFlow<Boolean> = runtime.canvasDebugStatusEnabled
  val canvasCurrentUrl: StateFlow<String?> = runtime.canvasCurrentUrl
  val canvasA2uiHydrated: StateFlow<Boolean> = runtime.canvasA2uiHydrated
  val canvasRehydratePending: StateFlow<Boolean> = runtime.canvasRehydratePending
  val canvasRehydrateErrorText: StateFlow<String?> = runtime.canvasRehydrateErrorText

  val chatSessionKey: StateFlow<String> = runtime.chatSessionKey
  val chatSessionId: StateFlow<String?> = runtime.chatSessionId
  val chatMessages: StateFlow<List<ChatMessage>> = runtime.chatMessages
  val chatError: StateFlow<String?> = runtime.chatError
  val chatHealthOk: StateFlow<Boolean> = runtime.chatHealthOk
  val chatThinkingLevel: StateFlow<String> = runtime.chatThinkingLevel
  val chatStreamingAssistantText: StateFlow<String?> = runtime.chatStreamingAssistantText
  val chatPendingToolCalls: StateFlow<List<ChatPendingToolCall>> = runtime.chatPendingToolCalls
  val chatSessions: StateFlow<List<ChatSessionEntry>> = runtime.chatSessions
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

  fun setCanvasDebugStatusEnabled(value: Boolean) {
    runtime.setCanvasDebugStatusEnabled(value)
  }

<<<<<<< HEAD:apps/android/app/src/main/java/ai/hanzo/bot/android/MainViewModel.kt
  fun setWakeWords(words: List<String>) {
    runtime.setWakeWords(words)
  }

  fun resetWakeWordsDefaults() {
    runtime.resetWakeWordsDefaults()
  }

  fun setVoiceWakeMode(mode: VoiceWakeMode) {
    runtime.setVoiceWakeMode(mode)
  }

  fun setTalkEnabled(enabled: Boolean) {
    runtime.setTalkEnabled(enabled)
=======
  fun setVoiceScreenActive(active: Boolean) {
    runtime.setVoiceScreenActive(active)
>>>>>>> 68db055f1 (feat(android): wire TalkModeManager into NodeRuntime for voice screen TTS):apps/android/app/src/main/java/ai/openclaw/android/MainViewModel.kt
  }

  fun setMicEnabled(enabled: Boolean) {
    runtime.setMicEnabled(enabled)
  }

  fun setGatewayPassword(password: String) {
    runtime.setGatewayPassword(password)
  }

  fun setOnboardingCompleted(value: Boolean) {
    runtime.setOnboardingCompleted(value)
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

  fun requestCanvasRehydrate(source: String) {
    runtime.requestCanvasRehydrate(source)
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

  fun sendChat(message: String, thinking: String, attachments: List<OutgoingAttachment>) {
    runtime.sendChat(message = message, thinking = thinking, attachments = attachments)
  }
}
