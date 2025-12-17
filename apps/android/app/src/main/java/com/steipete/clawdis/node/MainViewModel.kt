package com.steipete.clawdis.node

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import com.steipete.clawdis.node.bridge.BridgeEndpoint
import com.steipete.clawdis.node.node.CameraCaptureManager
import com.steipete.clawdis.node.node.CanvasController
import kotlinx.coroutines.flow.StateFlow

class MainViewModel(app: Application) : AndroidViewModel(app) {
  private val runtime: NodeRuntime = (app as NodeApp).runtime

  val canvas: CanvasController = runtime.canvas
  val camera: CameraCaptureManager = runtime.camera

  val bridges: StateFlow<List<BridgeEndpoint>> = runtime.bridges

  val isConnected: StateFlow<Boolean> = runtime.isConnected
  val statusText: StateFlow<String> = runtime.statusText
  val serverName: StateFlow<String?> = runtime.serverName
  val remoteAddress: StateFlow<String?> = runtime.remoteAddress

  val instanceId: StateFlow<String> = runtime.instanceId
  val displayName: StateFlow<String> = runtime.displayName
  val cameraEnabled: StateFlow<Boolean> = runtime.cameraEnabled
  val wakeWords: StateFlow<List<String>> = runtime.wakeWords
  val manualEnabled: StateFlow<Boolean> = runtime.manualEnabled
  val manualHost: StateFlow<String> = runtime.manualHost
  val manualPort: StateFlow<Int> = runtime.manualPort

  val chatMessages: StateFlow<List<NodeRuntime.ChatMessage>> = runtime.chatMessages
  val chatError: StateFlow<String?> = runtime.chatError
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

  fun connect(endpoint: BridgeEndpoint) {
    runtime.connect(endpoint)
  }

  fun connectManual() {
    runtime.connectManual()
  }

  fun disconnect() {
    runtime.disconnect()
  }

  fun loadChat(sessionKey: String = "main") {
    runtime.loadChat(sessionKey)
  }

  fun sendChat(sessionKey: String = "main", message: String) {
    runtime.sendChat(sessionKey, message)
  }
}
