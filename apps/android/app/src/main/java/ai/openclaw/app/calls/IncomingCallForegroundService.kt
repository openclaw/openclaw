package ai.openclaw.app.calls

import ai.openclaw.app.NodeApp
import android.app.Notification
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder

/** Owns the ongoing CallStyle notification and Android's post-Answer call/microphone lifetime. */
class IncomingCallForegroundService : Service() {
  private val calls get() = (application as NodeApp).ensureBackgroundRuntime().incomingCalls

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(
    intent: Intent?,
    flags: Int,
    startId: Int,
  ): Int {
    val id = intent?.getStringExtra(IncomingCallController.CALL_ID)
    if ((id == null || !calls.foregroundServiceReady(id, this)) && !calls.ownsForegroundService(this)) stopSelf(startId)
    return START_NOT_STICKY
  }

  internal fun publish(notification: Notification) {
    startForeground(
      IncomingCallController.NOTIFICATION_ID,
      notification,
      ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE,
    )
  }

  internal fun stopCall() {
    stopForeground(STOP_FOREGROUND_REMOVE)
    stopSelf()
  }

  override fun onDestroy() {
    calls.foregroundServiceDestroyed(this)
    super.onDestroy()
  }
}
