package ai.openclaw.android.node

import android.content.Context
import ai.openclaw.android.CameraHudKind
import ai.openclaw.android.BuildConfig
import ai.openclaw.android.SecurePrefs
import ai.openclaw.android.gateway.GatewayEndpoint
import ai.openclaw.android.gateway.GatewaySession
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.asRequestBody

class CameraHandler(
  private val appContext: Context,
  private val camera: CameraCaptureManager,
  private val prefs: SecurePrefs,
  private val connectedEndpoint: () -> GatewayEndpoint?,
  private val externalAudioCaptureActive: MutableStateFlow<Boolean>,
  private val showCameraHud: (message: String, kind: CameraHudKind, autoHideMs: Long?) -> Unit,
  private val triggerCameraFlash: () -> Unit,
  private val invokeErrorFromThrowable: (err: Throwable) -> Pair<String, String>,
) {

  suspend fun handleSnap(paramsJson: String?): GatewaySession.InvokeResult {
    val logFile = if (BuildConfig.DEBUG) java.io.File(appContext.cacheDir, "camera_debug.log") else null
    fun camLog(msg: String) {
      if (!BuildConfig.DEBUG) return
      val ts = java.text.SimpleDateFormat("HH:mm:ss.SSS", java.util.Locale.US).format(java.util.Date())
      logFile?.appendText("[$ts] $msg\n")
      android.util.Log.w("openclaw", "camera.snap: $msg")
    }
    try {
      logFile?.writeText("") // clear
      camLog("starting, params=$paramsJson")
      camLog("calling showCameraHud")
      showCameraHud("Taking photo…", CameraHudKind.Photo, null)
      camLog("calling triggerCameraFlash")
      triggerCameraFlash()
      val res =
        try {
          camLog("calling camera.snap()")
          val r = camera.snap(paramsJson)
          camLog("success, payload size=${r.payloadJson.length}")
          r
        } catch (err: Throwable) {
          camLog("inner error: ${err::class.java.simpleName}: ${err.message}")
          camLog("stack: ${err.stackTraceToString().take(2000)}")
          val (code, message) = invokeErrorFromThrowable(err)
          showCameraHud(message, CameraHudKind.Error, 2200)
          return GatewaySession.InvokeResult.error(code = code, message = message)
        }
      camLog("returning result")
      showCameraHud("Photo captured", CameraHudKind.Success, 1600)
      return GatewaySession.InvokeResult.ok(res.payloadJson)
    } catch (err: Throwable) {
      camLog("outer error: ${err::class.java.simpleName}: ${err.message}")
      camLog("stack: ${err.stackTraceToString().take(2000)}")
      return GatewaySession.InvokeResult.error(code = "UNAVAILABLE", message = err.message ?: "camera snap failed")
    }
  }

  suspend fun handleClip(paramsJson: String?): GatewaySession.InvokeResult {
    val clipLogFile = if (BuildConfig.DEBUG) java.io.File(appContext.cacheDir, "camera_debug.log") else null
    fun clipLog(msg: String) {
      if (!BuildConfig.DEBUG) return
      val ts = java.text.SimpleDateFormat("HH:mm:ss.SSS", java.util.Locale.US).format(java.util.Date())
      clipLogFile?.appendText("[CLIP $ts] $msg\n")
      android.util.Log.w("openclaw", "camera.clip: $msg")
    }
    val includeAudio = paramsJson?.contains("\"includeAudio\":true") != false
    if (includeAudio) externalAudioCaptureActive.value = true
    try {
      clipLogFile?.writeText("") // clear
      clipLog("starting, params=$paramsJson includeAudio=$includeAudio")
      clipLog("calling showCameraHud")
      showCameraHud("Recording…", CameraHudKind.Recording, null)
      val filePayload =
        try {
          clipLog("calling camera.clip()")
          val r = camera.clip(paramsJson)
          clipLog("success, file size=${r.file.length()}")
          r
        } catch (err: Throwable) {
          clipLog("inner error: ${err::class.java.simpleName}: ${err.message}")
          clipLog("stack: ${err.stackTraceToString().take(2000)}")
          val (code, message) = invokeErrorFromThrowable(err)
          showCameraHud(message, CameraHudKind.Error, 2400)
          return GatewaySession.InvokeResult.error(code = code, message = message)
        }
      // Upload file via HTTP instead of base64 through WebSocket
      clipLog("uploading via HTTP...")
      val uploadUrl = try {
        withContext(Dispatchers.IO) {
          val ep = connectedEndpoint()
          val gatewayHost = if (ep != null) {
            val isHttps = ep.tlsEnabled || ep.port == 443
            if (!isHttps) {
              clipLog("refusing to upload over plain HTTP — bearer token would be exposed; falling back to base64")
              throw Exception("HTTPS required for upload (bearer token protection)")
            }
            if (ep.port == 443) "https://${ep.host}" else "https://${ep.host}:${ep.port}"
          } else {
            clipLog("error: no gateway endpoint connected, cannot upload")
            throw Exception("no gateway endpoint connected")
          }
          val token = prefs.loadGatewayToken() ?: ""
          val client = okhttp3.OkHttpClient.Builder()
            .connectTimeout(10, java.util.concurrent.TimeUnit.SECONDS)
            .writeTimeout(120, java.util.concurrent.TimeUnit.SECONDS)
            .readTimeout(30, java.util.concurrent.TimeUnit.SECONDS)
            .build()
          val body = filePayload.file.asRequestBody("video/mp4".toMediaType())
          val req = okhttp3.Request.Builder()
            .url("$gatewayHost/upload/clip.mp4")
            .put(body)
            .header("Authorization", "Bearer $token")
            .build()
          clipLog("uploading ${filePayload.file.length()} bytes to $gatewayHost/upload/clip.mp4")
          val resp = client.newCall(req).execute()
          val respBody = resp.body?.string() ?: ""
          clipLog("upload response: ${resp.code} $respBody")
          filePayload.file.delete()
          if (!resp.isSuccessful) throw Exception("upload failed: HTTP ${resp.code}")
          // Parse URL from response
          val urlMatch = Regex("\"url\":\"([^\"]+)\"").find(respBody)
          urlMatch?.groupValues?.get(1) ?: throw Exception("no url in response: $respBody")
        }
      } catch (err: Throwable) {
        clipLog("upload failed: ${err.message}, falling back to base64")
        // Fallback to base64 if upload fails
        val bytes = withContext(Dispatchers.IO) {
          val b = filePayload.file.readBytes()
          filePayload.file.delete()
          b
        }
        val base64 = android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)
        showCameraHud("Clip captured", CameraHudKind.Success, 1800)
        return GatewaySession.InvokeResult.ok(
          """{"format":"mp4","base64":"$base64","durationMs":${filePayload.durationMs},"hasAudio":${filePayload.hasAudio}}"""
        )
      }
      clipLog("returning URL result: $uploadUrl")
      showCameraHud("Clip captured", CameraHudKind.Success, 1800)
      return GatewaySession.InvokeResult.ok(
        """{"format":"mp4","url":"$uploadUrl","durationMs":${filePayload.durationMs},"hasAudio":${filePayload.hasAudio}}"""
      )
    } catch (err: Throwable) {
      clipLog("outer error: ${err::class.java.simpleName}: ${err.message}")
      clipLog("stack: ${err.stackTraceToString().take(2000)}")
      return GatewaySession.InvokeResult.error(code = "UNAVAILABLE", message = err.message ?: "camera clip failed")
    } finally {
      if (includeAudio) externalAudioCaptureActive.value = false
    }
  }
}
