package ai.openclaw.wear

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.RemoteInput

class WearNotificationReplyReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val results = RemoteInput.getResultsFromIntent(intent)
    val text =
      results
        ?.getCharSequence(REPLY_NOTIFICATION_REMOTE_INPUT_KEY)
        ?.toString()
        ?.trim()
        .orEmpty()
    if (text.isEmpty()) return

    val app = context.applicationContext as? WearApp ?: return
    app.chatController.sendMessage(text)
    WearReplyNotifier(context).dismissReplyNotification()
  }
}
