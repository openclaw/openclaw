package ai.openclaw.wear

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import ai.openclaw.wear.chat.WearChatMessage
import ai.openclaw.wear.chat.WearChatController
import ai.openclaw.android.gateway.ChatSessionEntry
import ai.openclaw.wear.gateway.WearGatewayConfig
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow

class WearViewModel(app: Application) : AndroidViewModel(app) {
  private val wearApp = app as WearApp
  private val chat: WearChatController = wearApp.chatController
  val config: StateFlow<WearGatewayConfig> = wearApp.config

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
  val sessions: StateFlow<List<ChatSessionEntry>> = chat.sessions
  val assistantReplies: SharedFlow<String> = chat.assistantReplies

  fun sendMessage(text: String) = chat.sendMessage(text)
  fun switchSession(key: String) = chat.switchSession(key)
  fun refreshSessions() = chat.fetchSessions()
  fun refreshChat() = chat.loadHistory()
  fun clearError() = chat.clearErrorText()

  fun saveChatConfig(config: WearGatewayConfig) {
    wearApp.saveChatConfig(config)
  }

  fun saveConnectionConfig(config: WearGatewayConfig) {
    wearApp.saveConnectionConfig(config)
  }

  fun disconnect() {
    wearApp.disconnect()
  }

  fun reconnect() {
    wearApp.reconnect()
  }
}
