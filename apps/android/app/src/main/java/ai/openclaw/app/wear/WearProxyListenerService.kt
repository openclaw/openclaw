package ai.openclaw.app.wear

import ai.openclaw.app.NodeApp
import ai.openclaw.wear.shared.WearProtocol
import com.google.android.gms.wearable.MessageEvent
import com.google.android.gms.wearable.WearableListenerService
import kotlinx.coroutines.runBlocking

class WearProxyListenerService : WearableListenerService() {
  override fun onMessageReceived(messageEvent: MessageEvent) {
    if (messageEvent.path != WearProtocol.REQUEST_PATH) return
    val app = application as? NodeApp ?: return
    // WearableListenerService callbacks run off-main-thread, and the service may be
    // unbound when this callback returns. Keep the response inside that lifecycle.
    runBlocking { app.wearProxyBridge.handleMessage(messageEvent.sourceNodeId, messageEvent.data) }
  }
}
