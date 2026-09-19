package ai.openclaw.app.auto

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import androidx.core.app.NotificationCompat

class CarNotificationHandler(private val context: Context) {
  private val notificationManager =
    context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

  companion object {
    const val CHANNEL_ID = "openclaw_auto_alerts"
    const val CHANNEL_NAME = "OpenClaw Auto Alertas"
  }

  init {
    createChannel()
  }

  private fun createChannel() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val channel = NotificationChannel(
        CHANNEL_ID,
        CHANNEL_NAME,
        NotificationManager.IMPORTANCE_HIGH
      ).apply {
        description = "Alertas e notificações prioritárias para Android Auto"
      }
      notificationManager.createNotificationChannel(channel)
    }
  }

  fun postCarAlert(id: Int, title: String, message: String) {
    val builder = NotificationCompat.Builder(context, CHANNEL_ID)
      .setSmallIcon(android.R.drawable.ic_dialog_info)
      .setContentTitle(title)
      .setContentText(message)
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setCategory(NotificationCompat.CATEGORY_MESSAGE)
      .setAutoCancel(true)

    notificationManager.notify(id, builder.build())
  }
}
