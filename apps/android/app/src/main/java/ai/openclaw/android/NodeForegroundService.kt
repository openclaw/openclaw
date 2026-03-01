package ai.openclaw.android

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.app.PendingIntent
import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.SystemClock
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

class NodeForegroundService : Service() {
  private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
  private var notificationJob: Job? = null
  private var reconnectHeartbeatJob: Job? = null
  private var lastRequiresMic = false
  private var didStartForeground = false
  private var heartbeatOfflineSinceElapsedMs: Long = 0L
  private var heartbeatLastAttemptElapsedMs: Long = 0L
  private var heartbeatBackoffMs: Long = RECONNECT_HEARTBEAT_INTERVAL_MS

  override fun onCreate() {
    super.onCreate()
    ensureChannel()
    val initial = buildNotification(title = "OpenClaw Node", text = "Starting…")
    startForegroundWithTypes(notification = initial, requiresMic = false)

    val runtime = (application as NodeApp).runtime
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

          val requiresMic =
            micListening && hasRecordAudioPermission()
          startForegroundWithTypes(
            notification = buildNotification(title = title, text = text),
            requiresMic = requiresMic,
          )
        }
      }

    reconnectHeartbeatJob =
      scope.launch(Dispatchers.IO) {
        while (isActive) {
          delay(RECONNECT_HEARTBEAT_INTERVAL_MS)
          runCatching {
            runReconnectHeartbeat(runtime)
          }.onFailure {
            Log.w("OpenClawNode", "service reconnect heartbeat failed", it)
          }
        }
      }
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_STOP -> {
        (application as NodeApp).runtime.disconnect()
        stopSelf()
        return START_NOT_STICKY
      }
    }
    // Keep running; connection is managed by NodeRuntime (auto-reconnect + manual).
    return START_STICKY
  }

  override fun onDestroy() {
    notificationJob?.cancel()
    reconnectHeartbeatJob?.cancel()
    scope.cancel()
    super.onDestroy()
  }

  override fun onBind(intent: Intent?) = null

  private suspend fun runReconnectHeartbeat(runtime: NodeRuntime) {
    if (!runtime.hasCachedEndpointForRecovery()) {
      heartbeatOfflineSinceElapsedMs = 0L
      heartbeatLastAttemptElapsedMs = 0L
      heartbeatBackoffMs = RECONNECT_HEARTBEAT_INTERVAL_MS
      return
    }

    if (!runtime.hasUsableNetworkForRecovery()) {
      return
    }

    val operatorConnected = runtime.isConnected.value
    val nodeConnected = runtime.nodeConnected.value
    val probeHealthy = runtime.serviceHeartbeatProbeHealthy(reason = "fgs_heartbeat")
    if (probeHealthy) {
      heartbeatOfflineSinceElapsedMs = 0L
      heartbeatLastAttemptElapsedMs = 0L
      heartbeatBackoffMs = RECONNECT_HEARTBEAT_INTERVAL_MS
      return
    }

    val now = SystemClock.elapsedRealtime()
    if (heartbeatOfflineSinceElapsedMs == 0L) {
      heartbeatOfflineSinceElapsedMs = now
      Log.i(
        "OpenClawNode",
        "service heartbeat: unhealthy detected opConnected=$operatorConnected nodeConnected=$nodeConnected",
      )
      return
    }

    val offlineForMs = now - heartbeatOfflineSinceElapsedMs
    val sinceLastAttemptMs = now - heartbeatLastAttemptElapsedMs
    if (offlineForMs < RECONNECT_HEARTBEAT_GRACE_MS) return
    if (heartbeatLastAttemptElapsedMs != 0L && sinceLastAttemptMs < heartbeatBackoffMs) return

    heartbeatLastAttemptElapsedMs = now
    val backoffUsedMs = heartbeatBackoffMs
    heartbeatBackoffMs = (heartbeatBackoffMs * 2).coerceAtMost(RECONNECT_HEARTBEAT_MAX_BACKOFF_MS)
    Log.i(
      "OpenClawNode",
      "service heartbeat reconnect: offlineFor=${offlineForMs}ms backoff=${backoffUsedMs}ms opConnected=$operatorConnected nodeConnected=$nodeConnected",
    )
    runtime.requestServiceHeartbeatReconnect(reason = "fgs_heartbeat")
  }

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

  private fun startForegroundWithTypes(notification: Notification, requiresMic: Boolean) {
    if (didStartForeground && requiresMic == lastRequiresMic) {
      updateNotification(notification)
      return
    }

    lastRequiresMic = requiresMic
    val types =
      if (requiresMic) {
        ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
      } else {
        ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
      }
    startForeground(NOTIFICATION_ID, notification, types)
    didStartForeground = true
  }

  private fun hasRecordAudioPermission(): Boolean {
    return (
      ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) ==
        PackageManager.PERMISSION_GRANTED
      )
  }

  companion object {
    private const val CHANNEL_ID = "connection"
    private const val NOTIFICATION_ID = 1
    private const val RECONNECT_HEARTBEAT_INTERVAL_MS = 15_000L
    private const val RECONNECT_HEARTBEAT_GRACE_MS = 20_000L
    private const val RECONNECT_HEARTBEAT_MAX_BACKOFF_MS = 120_000L

    private const val ACTION_STOP = "ai.openclaw.android.action.STOP"

    fun start(context: Context) {
      val intent = Intent(context, NodeForegroundService::class.java)
      context.startForegroundService(intent)
    }

    fun stop(context: Context) {
      val intent = Intent(context, NodeForegroundService::class.java).setAction(ACTION_STOP)
      context.startService(intent)
    }
  }
}

private data class Quint<A, B, C, D, E>(val first: A, val second: B, val third: C, val fourth: D, val fifth: E)
