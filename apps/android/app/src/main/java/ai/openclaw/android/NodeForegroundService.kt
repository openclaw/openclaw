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
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout

class NodeForegroundService : Service() {
  private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
  private var notificationJob: Job? = null
  @Volatile private var lastRequiresMic = false
  @Volatile private var lastRequiresMediaProjection = false
  @Volatile private var didStartForeground = false
  private var lastNotificationTitle = "OpenClaw Node"
  private var lastNotificationText = "Starting…"

  override fun onCreate() {
    super.onCreate()
    currentInstance = this
    ensureChannel()
    val initial = buildNotification(title = lastNotificationTitle, text = lastNotificationText)
    startForegroundWithTypes(notification = initial, requiresMic = false, requiresMediaProjection = false)

    val runtime = (application as NodeApp).runtime
    val connectionStateFlow =
      combine(
        runtime.statusText,
        runtime.serverName,
        runtime.isConnected,
      ) { status: String, server: String?, connected: Boolean ->
        ConnectionState(status = status, server = server, connected = connected)
      }
    val captureStateFlow =
      combine(
        runtime.micEnabled,
        runtime.micIsListening,
        runtime.screenRecordActive,
      ) { micEnabled: Boolean, micListening: Boolean, screenRecordActive: Boolean ->
        CaptureState(
          micEnabled = micEnabled,
          micListening = micListening,
          screenRecordActive = screenRecordActive,
        )
      }
    notificationJob =
      scope.launch {
        combine(connectionStateFlow, captureStateFlow) { connection, capture ->
          ServiceNotificationState(connection = connection, capture = capture)
        }.collect { state ->
          val title = if (state.connection.connected) "OpenClaw Node · Connected" else "OpenClaw Node"
          val micSuffix =
            if (state.capture.micEnabled) {
              if (state.capture.micListening) " · Mic: Listening" else " · Mic: Pending"
            } else {
              ""
            }
          val screenSuffix = if (state.capture.screenRecordActive) " · Screen: Recording" else ""
          val text = (state.connection.server?.let { "${state.connection.status} · $it" } ?: state.connection.status) + micSuffix + screenSuffix

          val requiresMic = state.capture.micEnabled && hasRecordAudioPermission()
          startForegroundWithTypes(
            notification = buildNotification(title = title, text = text),
            requiresMic = requiresMic,
            requiresMediaProjection = state.capture.screenRecordActive,
          )
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
      ACTION_UPDATE_CAPTURE_TYPES -> {
        applyCaptureTypes(
          requiresMic = intent.getBooleanExtra(EXTRA_REQUIRES_MIC, false),
          requiresMediaProjection = intent.getBooleanExtra(EXTRA_REQUIRES_MEDIA_PROJECTION, false),
        )
      }
    }
    // Keep running; connection is managed by NodeRuntime (auto-reconnect + manual).
    return START_STICKY
  }

  override fun onDestroy() {
    notificationJob?.cancel()
    scope.cancel()
    if (currentInstance === this) {
      currentInstance = null
    }
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
    lastNotificationTitle = title
    lastNotificationText = text

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

  private fun startForegroundWithTypes(
    notification: Notification,
    requiresMic: Boolean,
    requiresMediaProjection: Boolean,
  ) {
    if (
      didStartForeground &&
        requiresMic == lastRequiresMic &&
        requiresMediaProjection == lastRequiresMediaProjection
    ) {
      updateNotification(notification)
      return
    }

    lastRequiresMic = requiresMic
    lastRequiresMediaProjection = requiresMediaProjection
    var types = ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
    if (requiresMic) {
      types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
    }
    if (requiresMediaProjection) {
      types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
    }
    startForeground(NOTIFICATION_ID, notification, types)
    didStartForeground = true
  }

  private fun applyCaptureTypes(
    requiresMic: Boolean,
    requiresMediaProjection: Boolean,
  ) {
    startForegroundWithTypes(
      notification = buildNotification(title = lastNotificationTitle, text = lastNotificationText),
      requiresMic = requiresMic,
      requiresMediaProjection = requiresMediaProjection,
    )
  }

  private fun hasForegroundTypes(
    requiresMic: Boolean,
    requiresMediaProjection: Boolean,
  ): Boolean =
    didStartForeground &&
      lastRequiresMic == requiresMic &&
      lastRequiresMediaProjection == requiresMediaProjection

  private fun hasRecordAudioPermission(): Boolean {
    return (
      ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) ==
        PackageManager.PERMISSION_GRANTED
      )
  }

  companion object {
    private const val CHANNEL_ID = "connection"
    private const val NOTIFICATION_ID = 1

    private const val ACTION_STOP = "ai.openclaw.android.action.STOP"
    private const val ACTION_UPDATE_CAPTURE_TYPES = "ai.openclaw.android.action.UPDATE_CAPTURE_TYPES"
    private const val EXTRA_REQUIRES_MIC = "requiresMic"
    private const val EXTRA_REQUIRES_MEDIA_PROJECTION = "requiresMediaProjection"

    @Volatile private var currentInstance: NodeForegroundService? = null

    fun start(context: Context) {
      val intent = Intent(context, NodeForegroundService::class.java)
      context.startForegroundService(intent)
    }

    fun stop(context: Context) {
      val intent = Intent(context, NodeForegroundService::class.java).setAction(ACTION_STOP)
      context.startService(intent)
    }

    private fun requestCaptureTypes(
      context: Context,
      requiresMic: Boolean,
      requiresMediaProjection: Boolean,
    ) {
      val intent =
        Intent(context, NodeForegroundService::class.java)
          .setAction(ACTION_UPDATE_CAPTURE_TYPES)
          .putExtra(EXTRA_REQUIRES_MIC, requiresMic)
          .putExtra(EXTRA_REQUIRES_MEDIA_PROJECTION, requiresMediaProjection)

      if (currentInstance == null) {
        context.startForegroundService(intent)
      } else {
        context.startService(intent)
      }
    }

    suspend fun ensureCaptureTypes(
      context: Context,
      requiresMic: Boolean,
      requiresMediaProjection: Boolean,
      timeoutMs: Long = 2_000,
    ) {
      requestCaptureTypes(
        context = context,
        requiresMic = requiresMic,
        requiresMediaProjection = requiresMediaProjection,
      )

      withTimeout(timeoutMs) {
        while (true) {
          val service = currentInstance
          if (service != null && service.hasForegroundTypes(requiresMic, requiresMediaProjection)) {
            return@withTimeout
          }
          delay(25)
        }
      }
    }
  }
}

private data class ConnectionState(
  val status: String,
  val server: String?,
  val connected: Boolean,
)

private data class CaptureState(
  val micEnabled: Boolean,
  val micListening: Boolean,
  val screenRecordActive: Boolean,
)

private data class ServiceNotificationState(
  val connection: ConnectionState,
  val capture: CaptureState,
)
