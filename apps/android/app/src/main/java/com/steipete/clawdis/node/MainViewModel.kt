package com.steipete.clawdis.node

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import com.steipete.clawdis.node.bridge.BridgeEndpoint
import com.steipete.clawdis.node.chat.OutgoingAttachment
import com.steipete.clawdis.node.node.CameraCaptureManager
import com.steipete.clawdis.node.node.CanvasController
import com.steipete.clawdis.node.node.ScreenRecordManager
import kotlinx.coroutines.flow.StateFlow

class MainViewModel(app: Application) : AndroidViewModel(app) {
  private val runtime: NodeRuntime = (app as NodeApp).runtime

  val canvas: CanvasController = runtime.canvas
  val camera: CameraCaptureManager = runtime.camera
  val screenRecorder: ScreenRecordManager = runtime.screenRecorder

  val bridges: StateFlow<List<BridgeEndpoint>> = runtime.bridges
  val discoveryStatusText: StateFlow<String> = runtime.discoveryStatusText

  val isConnected: StateFlow<Boolean> = runtime.isConnected
  val statusText: StateFlow<String> = runtime.statusText
  val serverName: StateFlow<String?> = runtime.serverName
  val remoteAddress: StateFlow<String?> = runtime.remoteAddress

  val cameraHud: StateFlow<CameraHudState?> = runtime.cameraHud
  val cameraFlashToken: StateFlow<Long> = runtime.cameraFlashToken

  val instanceId: StateFlow<String> = runtime.instanceId
  val displayName: StateFlow<String> = runtime.displayName
  val cameraEnabled: StateFlow<Boolean> = runtime.cameraEnabled
  val preventSleep: StateFlow<Boolean> = runtime.preventSleep
  val wakeWords: StateFlow<List<String>> = runtime.wakeWords
  val voiceWakeMode: StateFlow<VoiceWakeMode> = runtime.voiceWakeMode
  val voiceWakeStatusText: StateFlow<String> = runtime.voiceWakeStatusText
  val voiceWakeIsListening: StateFlow<Boolean> = runtime.voiceWakeIsListening
  val manualEnabled: StateFlow<Boolean> = runtime.manualEnabled
  val manualHost: StateFlow<String> = runtime.manualHost
  val manualPort: StateFlow<Int> = runtime.manualPort

  val chatSessionKey: StateFlow<String> = runtime.chatSessionKey
  val chatSessionId: StateFlow<String?> = runtime.chatSessionId
  val chatMessages = runtime.chatMessages
  val chatError: StateFlow<String?> = runtime.chatError
  val chatHealthOk: StateFlow<Boolean> = runtime.chatHealthOk
  val chatThinkingLevel: StateFlow<String> = runtime.chatThinkingLevel
  val chatStreamingAssistantText: StateFlow<String?> = runtime.chatStreamingAssistantText
  val chatPendingToolCalls = runtime.chatPendingToolCalls
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

  fun setWakeWords(words: List<String>) {
    runtime.setWakeWords(words)
  }

  fun resetWakeWordsDefaults() {
    runtime.resetWakeWordsDefaults()
  }

  fun setVoiceWakeMode(mode: VoiceWakeMode) {
    runtime.setVoiceWakeMode(mode)
  }

  fun connect(endpoint: BridgeEndpoint) {
    runtime.connect(endpoint)
  }

  fun connectManual() {
    runtime.connectManual()
  }

  fun disconnect() {
    runtime.disconnect()
  }

  fun handleCanvasA2UIActionFromWebView(payloadJson: String) {
    runtime.handleCanvasA2UIActionFromWebView(payloadJson)
  }

  fun loadChat(sessionKey: String = "main") {
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
