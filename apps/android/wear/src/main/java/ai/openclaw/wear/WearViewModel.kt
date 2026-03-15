package ai.openclaw.wear

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import ai.openclaw.wear.chat.WearChatMessage
import ai.openclaw.wear.chat.WearChatController
import ai.openclaw.android.gateway.GatewaySessionEntry
import ai.openclaw.wear.gateway.WearGatewayConfig
import ai.openclaw.wear.gateway.WearGatewayConfigStore
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

class WearViewModel(app: Application) : AndroidViewModel(app) {
  private val wearApp = app as WearApp
  private val chat: WearChatController = wearApp.chatController
  private val configStore: WearGatewayConfigStore = wearApp.configStore
  private val _config = MutableStateFlow(configStore.load())
  val config: StateFlow<WearGatewayConfig> = _config.asStateFlow()

  // Connection — delegate to WearApp's derived flows that auto-track client switches
  val connected: StateFlow<Boolean> = wearApp.connected
  val statusText: StateFlow<String> = wearApp.statusText

  // Chat
  val sessionKey: StateFlow<String> = chat.sessionKey
  val messages: StateFlow<List<WearChatMessage>> = chat.messages
  val streamingText: StateFlow<String?> = chat.streamingText
  val errorText: StateFlow<String?> = chat.errorText
  val isLoading: StateFlow<Boolean> = chat.isLoading
  val isSending: StateFlow<Boolean> = chat.isSending
  val sessions: StateFlow<List<GatewaySessionEntry>> = chat.sessions
  val assistantReplies: SharedFlow<String> = chat.assistantReplies

  fun sendMessage(text: String) = chat.sendMessage(text)
  fun switchSession(key: String) = chat.switchSession(key)
  fun refreshSessions() = chat.fetchSessions()
  fun refreshChat() = chat.loadHistory()
  fun clearError() = chat.clearErrorText()

  private fun saveConfig(config: WearGatewayConfig) {
    configStore.save(config)
    _config.value = config
  }

  fun saveChatConfig(config: WearGatewayConfig) {
    saveConfig(config)
  }

  fun saveConnectionConfig(config: WearGatewayConfig) {
    val previousConfig = _config.value
    saveConfig(config)
    if (
      previousConfig.host != config.host ||
      previousConfig.port != config.port ||
      previousConfig.token != config.token ||
      previousConfig.password != config.password ||
      previousConfig.useTls != config.useTls ||
      previousConfig.usePhoneProxy != config.usePhoneProxy
    ) {
      wearApp.switchConnectionMode(config.usePhoneProxy)
    }
  }

  fun disconnect() {
    wearApp.directClient?.disconnect()
    wearApp.proxyClient?.disconnect()
  }

  fun reconnect() {
    wearApp.switchConnectionMode(_config.value.usePhoneProxy)
  }
}
