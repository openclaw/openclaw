package ai.openclaw.android.node

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import ai.openclaw.android.InstallResultReceiver
import ai.openclaw.android.MainActivity
import ai.openclaw.android.gateway.GatewaySession
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

class AppUpdateHandler(
  private val appContext: Context,
) {

  fun handleUpdate(paramsJson: String?): GatewaySession.InvokeResult {
    try {
      val url = paramsJson?.let { raw ->
        val urlKey = "\"url\""
        val idx = raw.indexOf(urlKey)
        if (idx < 0) null else {
          val colon = raw.indexOf(':', idx + urlKey.length)
          if (colon < 0) null else {
            val tail = raw.substring(colon + 1).trimStart()
            if (tail.startsWith("\"")) {
              val end = tail.indexOf('"', 1)
              if (end > 1) tail.substring(1, end) else null
            } else null
          }
        }
      } ?: return GatewaySession.InvokeResult.error(
        code = "INVALID_REQUEST",
        message = "INVALID_REQUEST: missing 'url' parameter"
      )

      android.util.Log.w("openclaw", "app.update: downloading from $url")

      val notifId = 9001
      val channelId = "app_update"
      val notifManager = appContext.getSystemService(android.content.Context.NOTIFICATION_SERVICE) as android.app.NotificationManager

      // Create notification channel (required for Android 8+)
      val channel = android.app.NotificationChannel(channelId, "App Updates", android.app.NotificationManager.IMPORTANCE_LOW)
      notifManager.createNotificationChannel(channel)

      // PendingIntent to open the app when notification is tapped
      val launchIntent = Intent(appContext, MainActivity::class.java).apply {
        flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
      }
      val launchPi = PendingIntent.getActivity(appContext, 0, launchIntent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)

      // Launch download async so the invoke returns immediately
      CoroutineScope(Dispatchers.IO).launch {
        try {
          val cacheDir = java.io.File(appContext.cacheDir, "updates")
          cacheDir.mkdirs()
          val file = java.io.File(cacheDir, "update.apk")
          if (file.exists()) file.delete()

          // Show initial progress notification
          fun buildProgressNotif(progress: Int, max: Int, text: String): android.app.Notification {
            return android.app.Notification.Builder(appContext, channelId)
              .setSmallIcon(android.R.drawable.stat_sys_download)
              .setContentTitle("OpenClaw Update")
              .setContentText(text)
              .setProgress(max, progress, max == 0)
              
              .setContentIntent(launchPi)
              .setOngoing(true)
              .build()
          }
          notifManager.notify(notifId, buildProgressNotif(0, 0, "Connecting..."))

          val client = okhttp3.OkHttpClient.Builder()
            .connectTimeout(30, java.util.concurrent.TimeUnit.SECONDS)
            .readTimeout(300, java.util.concurrent.TimeUnit.SECONDS)
            .build()
          val request = okhttp3.Request.Builder().url(url).build()
          val response = client.newCall(request).execute()
          if (!response.isSuccessful) {
            notifManager.cancel(notifId)
            notifManager.notify(notifId, android.app.Notification.Builder(appContext, channelId)
              .setSmallIcon(android.R.drawable.stat_notify_error)
              .setContentTitle("Update Failed")
              
              .setContentIntent(launchPi)
              .setContentText("HTTP ${response.code}")
              .build())
            return@launch
          }

          val contentLength = response.body?.contentLength() ?: -1L
          val body = response.body ?: run {
            notifManager.cancel(notifId)
            return@launch
          }

          // Download with progress tracking
          var totalBytes = 0L
          var lastNotifUpdate = 0L
          body.byteStream().use { input ->
            file.outputStream().use { output ->
              val buffer = ByteArray(8192)
              while (true) {
                val bytesRead = input.read(buffer)
                if (bytesRead == -1) break
                output.write(buffer, 0, bytesRead)
                totalBytes += bytesRead

                // Update notification at most every 500ms
                val now = System.currentTimeMillis()
                if (now - lastNotifUpdate > 500) {
                  lastNotifUpdate = now
                  if (contentLength > 0) {
                    val pct = ((totalBytes * 100) / contentLength).toInt()
                    val mb = String.format("%.1f", totalBytes / 1048576.0)
                    val totalMb = String.format("%.1f", contentLength / 1048576.0)
                    notifManager.notify(notifId, buildProgressNotif(pct, 100, "$mb / $totalMb MB ($pct%)"))
                  } else {
                    val mb = String.format("%.1f", totalBytes / 1048576.0)
                    notifManager.notify(notifId, buildProgressNotif(0, 0, "${mb} MB downloaded"))
                  }
                }
              }
            }
          }

          android.util.Log.w("openclaw", "app.update: downloaded ${file.length()} bytes")

          // Verify file is a valid APK (basic check: ZIP magic bytes)
          val magic = file.inputStream().use { it.read().toByte() to it.read().toByte() }
          if (magic.first != 0x50.toByte() || magic.second != 0x4B.toByte()) {
            android.util.Log.e("openclaw", "app.update: invalid APK (bad magic: ${magic.first}, ${magic.second})")
            file.delete()
            notifManager.cancel(notifId)
            notifManager.notify(notifId, android.app.Notification.Builder(appContext, channelId)
              .setSmallIcon(android.R.drawable.stat_notify_error)
              .setContentTitle("Update Failed")
              
              .setContentIntent(launchPi)
              .setContentText("Downloaded file is not a valid APK")
              .build())
            return@launch
          }

          // Use PackageInstaller session API — works from background on API 34+
          // The system handles showing the install confirmation dialog
          notifManager.cancel(notifId)
          notifManager.notify(notifId, android.app.Notification.Builder(appContext, channelId)
            .setSmallIcon(android.R.drawable.stat_sys_download_done)
            .setContentTitle("Installing Update...")
            
              .setContentIntent(launchPi)
              .setContentText("${String.format("%.1f", totalBytes / 1048576.0)} MB downloaded")
            .build())

          val installer = appContext.packageManager.packageInstaller
          val params = android.content.pm.PackageInstaller.SessionParams(
            android.content.pm.PackageInstaller.SessionParams.MODE_FULL_INSTALL
          )
          params.setSize(file.length())
          val sessionId = installer.createSession(params)
          val session = installer.openSession(sessionId)
          session.openWrite("openclaw-update.apk", 0, file.length()).use { out ->
            file.inputStream().use { inp -> inp.copyTo(out) }
            session.fsync(out)
          }
          // Commit with FLAG_MUTABLE PendingIntent — system requires mutable for PackageInstaller status
          val callbackIntent = android.content.Intent(appContext, InstallResultReceiver::class.java)
          val pi = android.app.PendingIntent.getBroadcast(
            appContext, sessionId, callbackIntent,
            android.app.PendingIntent.FLAG_UPDATE_CURRENT or android.app.PendingIntent.FLAG_MUTABLE
          )
          session.commit(pi.intentSender)
          android.util.Log.w("openclaw", "app.update: PackageInstaller session committed, waiting for user confirmation")
        } catch (err: Throwable) {
          android.util.Log.e("openclaw", "app.update: async error", err)
          notifManager.cancel(notifId)
          notifManager.notify(notifId, android.app.Notification.Builder(appContext, channelId)
            .setSmallIcon(android.R.drawable.stat_notify_error)
            .setContentTitle("Update Failed")
            
              .setContentIntent(launchPi)
              .setContentText(err.message ?: "Unknown error")
            .build())
        }
      }

      // Return immediately — download happens in background
      return GatewaySession.InvokeResult.ok("""{"status":"downloading","url":"$url"}""")
    } catch (err: Throwable) {
      android.util.Log.e("openclaw", "app.update: error", err)
      return GatewaySession.InvokeResult.error(code = "UNAVAILABLE", message = err.message ?: "update failed")
    }
  }
}
