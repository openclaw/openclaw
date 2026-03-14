package ai.openclaw.wear

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.RemoteInput
import androidx.core.content.ContextCompat

private const val REPLY_NOTIFICATION_CHANNEL_ID = "wear_replies"
private const val REPLY_NOTIFICATION_ID = 2001
const val REPLY_NOTIFICATION_REMOTE_INPUT_KEY = "wear_notification_reply_text"

class WearReplyNotifier(
  private val context: Context,
) {
  fun showAssistantReply(text: String) {
    if (!canPostNotifications()) return
    ensureChannel()

    val openIntent =
      Intent(context, WearMainActivity::class.java).apply {
        flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
      }

    val contentIntent =
      PendingIntent.getActivity(
        context,
        0,
        openIntent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )

    val remoteInput =
      RemoteInput.Builder(REPLY_NOTIFICATION_REMOTE_INPUT_KEY)
        .setLabel(context.getString(R.string.wear_chat_input_label_reply))
        .build()

    val replyIntent =
      Intent(context, WearNotificationReplyReceiver::class.java)

    val replyPendingIntent =
      PendingIntent.getBroadcast(
        context,
        1,
        replyIntent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
      )

    val replyAction =
      NotificationCompat.Action.Builder(
        R.drawable.ic_mic_complication,
        context.getString(R.string.wear_chat_reply),
        replyPendingIntent,
      )
        .addRemoteInput(remoteInput)
        .setAllowGeneratedReplies(true)
        .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_REPLY)
        .build()

    val notification =
      NotificationCompat.Builder(context, REPLY_NOTIFICATION_CHANNEL_ID)
        .setSmallIcon(R.drawable.ic_mic_complication)
        .setContentTitle(context.getString(R.string.wear_notification_reply_title))
        .setContentText(text)
        .setStyle(NotificationCompat.BigTextStyle().bigText(text))
        .setContentIntent(contentIntent)
        .setAutoCancel(true)
        .setPriority(NotificationCompat.PRIORITY_HIGH)
        .setCategory(NotificationCompat.CATEGORY_MESSAGE)
        .setDefaults(NotificationCompat.DEFAULT_ALL)
        .addAction(replyAction)
        .extend(
          NotificationCompat.WearableExtender()
            .addAction(replyAction),
        )
        .build()

    NotificationManagerCompat.from(context).notify(REPLY_NOTIFICATION_ID, notification)
  }

  fun dismissReplyNotification() {
    NotificationManagerCompat.from(context).cancel(REPLY_NOTIFICATION_ID)
  }

  private fun ensureChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = context.getSystemService(NotificationManager::class.java)
    val existing = manager.getNotificationChannel(REPLY_NOTIFICATION_CHANNEL_ID)
    if (existing != null) return

    val channel =
      NotificationChannel(
        REPLY_NOTIFICATION_CHANNEL_ID,
        context.getString(R.string.wear_notification_reply_channel_name),
        NotificationManager.IMPORTANCE_HIGH,
      ).apply {
        description = context.getString(R.string.wear_notification_reply_channel_description)
        enableVibration(true)
      }

    manager.createNotificationChannel(channel)
  }

  private fun canPostNotifications(): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true
    return ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
      PackageManager.PERMISSION_GRANTED
  }
}
