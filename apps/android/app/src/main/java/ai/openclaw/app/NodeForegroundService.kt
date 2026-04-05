package ai.openclaw.app

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import androidx.core.content.ContextCompat
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch

open class NodeForegroundService : Service() {
  private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
  private var notificationJob: Job? = null
  private var didStartForeground = false
  private var currentForegroundServiceType: Int? = null
  private var latestNotification: Notification? = null

  override fun onCreate() {
    super.onCreate()
    ensureChannel()
    val initial = buildNotification(title = "OpenClaw Node", text = "Starting…")
    startForegroundWithTypes(notification = initial)

    val runtime = (application as NodeApp).peekRuntime()
    if (runtime == null) {
      stopSelf()
      return
    }
    notificationJob =
      scope.launch {
        combine(
          runtime.statusText,
          runtime.serverName,
          runtime.isConnected,
          runtime.micEnabled,
          runtime.micIsListening,
        ) { status, server, connected, micEnabled, micListening ->
          Quint(status, server, connected, micEnabled, micListening)
        }.collect { (status, server, connected, micEnabled, micListening) ->
          val title = if (connected) "OpenClaw Node · Connected" else "OpenClaw Node"
          val micSuffix =
            if (micEnabled) {
              if (micListening) " · Mic: Listening" else " · Mic: Pending"
            } else {
              ""
            }
          val text = (server?.let { "$status · $it" } ?: status) + micSuffix

          startForegroundWithTypes(
            notification = buildNotification(title = title, text = text),
          )
        }
      }
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_STOP -> {
        (application as NodeApp).peekRuntime()?.disconnect()
        stopSelf()
        return START_NOT_STICKY
      }
      ACTION_REFRESH_FOREGROUND -> refreshForegroundServiceType()
    }
    // Keep running; connection is managed by NodeRuntime (auto-reconnect + manual).
    return START_STICKY
  }

  override fun onDestroy() {
    notificationJob?.cancel()
    scope.cancel()
    super.onDestroy()
  }

  override fun onBind(intent: Intent?) = null

  private fun ensureChannel() {
    val mgr = getSystemService(NotificationManager::class.java)
    val channel =
      NotificationChannel(
        CHANNEL_ID,
        "Connection",
        NotificationManager.IMPORTANCE_LOW,
      ).apply {
        description = "OpenClaw node connection status"
        setShowBadge(false)
      }
    mgr.createNotificationChannel(channel)
  }

  private fun buildNotification(title: String, text: String): Notification {
    val launchIntent = Intent(this, MainActivity::class.java).apply {
      flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
    }
    val launchPending =
      PendingIntent.getActivity(
        this,
        1,
        launchIntent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )

    val stopIntent = Intent(this, NodeForegroundService::class.java).setAction(ACTION_STOP)
    val stopPending =
      PendingIntent.getService(
        this,
        2,
        stopIntent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )

    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(R.mipmap.ic_launcher)
      .setContentTitle(title)
      .setContentText(text)
      .setContentIntent(launchPending)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
      .addAction(0, "Disconnect", stopPending)
      .build()
  }

  private fun updateNotification(notification: Notification) {
    val mgr = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    mgr.notify(NOTIFICATION_ID, notification)
  }

  private fun startForegroundWithTypes(notification: Notification) {
    latestNotification = notification
    val serviceType = foregroundServiceType(includeLocationType = canUseLocationForegroundServiceType())
    if (!shouldRestartForeground(serviceType)) {
      updateNotification(notification)
      return
    }
    startForeground(
      NOTIFICATION_ID,
      notification,
      serviceType,
    )
    didStartForeground = true
    currentForegroundServiceType = serviceType
  }

  private fun refreshForegroundServiceType() {
    startForegroundWithTypes(
      notification = latestNotification ?: buildNotification(title = "OpenClaw Node", text = "Starting…"),
    )
  }

  internal open fun hasAnyLocationPermission(): Boolean {
    return ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) ==
      PackageManager.PERMISSION_GRANTED ||
      ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) ==
      PackageManager.PERMISSION_GRANTED
  }

  internal open fun isAppForeground(): Boolean {
    return (application as? NodeApp)?.peekRuntime()?.isForeground?.value == true
  }

  internal open fun canUseBackgroundLocation(): Boolean {
    val prefs = (application as? NodeApp)?.prefs ?: return false
    return prefs.effectiveLocationMode() == LocationMode.Always &&
      ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_BACKGROUND_LOCATION) ==
      PackageManager.PERMISSION_GRANTED
  }

  internal open fun canUseLocationForegroundServiceType(): Boolean {
    return hasAnyLocationPermission() && (isAppForeground() || canUseBackgroundLocation())
  }

  private fun foregroundServiceType(includeLocationType: Boolean): Int {
    return ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC or
      if (includeLocationType) ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION else 0
  }

  private fun shouldRestartForeground(serviceType: Int): Boolean {
    return !didStartForeground || currentForegroundServiceType != serviceType
  }

  companion object {
    private const val CHANNEL_ID = "connection"
    private const val NOTIFICATION_ID = 1

    private const val ACTION_STOP = "ai.openclaw.app.action.STOP"
    private const val ACTION_REFRESH_FOREGROUND = "ai.openclaw.app.action.REFRESH_FOREGROUND"

    fun start(context: Context) {
      val intent = Intent(context, NodeForegroundService::class.java)
      context.startForegroundService(intent)
    }

    fun stop(context: Context) {
      val intent = Intent(context, NodeForegroundService::class.java).setAction(ACTION_STOP)
      context.startService(intent)
    }

    fun refresh(context: Context) {
      val intent = Intent(context, NodeForegroundService::class.java).setAction(ACTION_REFRESH_FOREGROUND)
      context.startForegroundService(intent)
    }
  }
}

private data class Quint<A, B, C, D, E>(val first: A, val second: B, val third: C, val fourth: D, val fifth: E)
