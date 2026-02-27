package ai.openclaw.android.node

import android.content.Context
import android.hardware.display.DisplayManager
import android.media.MediaRecorder
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.util.Base64
import ai.openclaw.android.ScreenCaptureRequester
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import java.io.File
import kotlin.math.roundToInt

class ScreenRecordManager(private val context: Context) {
  data class Payload(val payloadJson: String)

  @Volatile private var screenCaptureRequester: ScreenCaptureRequester? = null
  @Volatile private var permissionRequester: ai.openclaw.android.PermissionRequester? = null

  fun attachScreenCaptureRequester(requester: ScreenCaptureRequester) {
    screenCaptureRequester = requester
  }

  fun attachPermissionRequester(requester: ai.openclaw.android.PermissionRequester) {
    permissionRequester = requester
  }

  suspend fun record(paramsJson: String?): Payload =
    withContext(Dispatchers.Default) {
      val requester =
        screenCaptureRequester
          ?: throw IllegalStateException(
            "SCREEN_PERMISSION_REQUIRED: grant Screen Recording permission",
          )

      val params = parseParamsObject(paramsJson)
      val durationMs = (parseDurationMs(params) ?: 10_000).coerceIn(250, 60_000)
      val fps = (parseFps(params) ?: 10.0).coerceIn(1.0, 60.0)
      val fpsInt = fps.roundToInt().coerceIn(1, 60)
      val screenIndex = parseScreenIndex(params)
      val includeAudio = parseIncludeAudio(params) ?: true
      val format = parseString(params, key = "format")
      if (format != null && format.lowercase() != "mp4") {
        throw IllegalArgumentException("INVALID_REQUEST: screen format must be mp4")
      }
      if (screenIndex != null && screenIndex != 0) {
        throw IllegalArgumentException("INVALID_REQUEST: screenIndex must be 0 on Android")
      }

      val capture = requester.requestCapture()
        ?: throw IllegalStateException(
          "SCREEN_PERMISSION_REQUIRED: grant Screen Recording permission",
        )

      val mgr =
        context.getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
      val projection = mgr.getMediaProjection(capture.resultCode, capture.data)
        ?: throw IllegalStateException("UNAVAILABLE: screen capture unavailable")

      val metrics = context.resources.displayMetrics
      val width = metrics.widthPixels
      val height = metrics.heightPixels
      val densityDpi = metrics.densityDpi

      val file = File.createTempFile("openclaw-screen-", ".mp4")
      if (includeAudio) ensureMicPermission()

      val recorder = createMediaRecorder()
      var virtualDisplay: android.hardware.display.VirtualDisplay? = null
      try {
        if (includeAudio) {
          recorder.setAudioSource(MediaRecorder.AudioSource.MIC)
        }
        recorder.setVideoSource(MediaRecorder.VideoSource.SURFACE)
        recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
        recorder.setVideoEncoder(MediaRecorder.VideoEncoder.H264)
        if (includeAudio) {
          recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
          recorder.setAudioChannels(1)
          recorder.setAudioSamplingRate(44_100)
          recorder.setAudioEncodingBitRate(96_000)
        }
        recorder.setVideoSize(width, height)
        recorder.setVideoFrameRate(fpsInt)
        recorder.setVideoEncodingBitRate(estimateBitrate(width, height, fpsInt))
        recorder.setOutputFile(file.absolutePath)
        recorder.prepare()

        val surface = recorder.surface
        virtualDisplay =
          projection.createVirtualDisplay(
            "openclaw-screen",
            width,
            height,
            densityDpi,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            surface,
            null,
            null,
          )

        recorder.start()
        delay(durationMs.toLong())
      } finally {
        try {
          recorder.stop()
        } catch (_: Throwable) {
          // ignore
        }
        recorder.reset()
        recorder.release()
        virtualDisplay?.release()
        projection.stop()
      }

      val bytes = withContext(Dispatchers.IO) { file.readBytes() }
      file.delete()
      val base64 = Base64.encodeToString(bytes, Base64.NO_WRAP)
      Payload(
        """{"format":"mp4","base64":"$base64","durationMs":$durationMs,"fps":$fpsInt,"screenIndex":0,"hasAudio":$includeAudio}""",
      )
    }

  private fun createMediaRecorder(): MediaRecorder = MediaRecorder(context)

  private suspend fun ensureMicPermission() {
    val granted =
      androidx.core.content.ContextCompat.checkSelfPermission(
        context,
        android.Manifest.permission.RECORD_AUDIO,
      ) == android.content.pm.PackageManager.PERMISSION_GRANTED
    if (granted) return

    val requester =
      permissionRequester
        ?: throw IllegalStateException("MIC_PERMISSION_REQUIRED: grant Microphone permission")
    val results = requester.requestIfMissing(listOf(android.Manifest.permission.RECORD_AUDIO))
    if (results[android.Manifest.permission.RECORD_AUDIO] != true) {
      throw IllegalStateException("MIC_PERMISSION_REQUIRED: grant Microphone permission")
    }
  }

  private fun parseParamsObject(paramsJson: String?): JsonObject? {
    if (paramsJson.isNullOrBlank()) return null
    return try {
      Json.parseToJsonElement(paramsJson).asObjectOrNull()
    } catch (_: Throwable) {
      null
    }
  }

  private fun readPrimitive(params: JsonObject?, key: String): JsonPrimitive? =
    params?.get(key) as? JsonPrimitive

  private fun parseDurationMs(params: JsonObject?): Int? =
    readPrimitive(params, "durationMs")?.contentOrNull?.toIntOrNull()

  private fun parseFps(params: JsonObject?): Double? =
    readPrimitive(params, "fps")?.contentOrNull?.toDoubleOrNull()

  private fun parseScreenIndex(params: JsonObject?): Int? =
    readPrimitive(params, "screenIndex")?.contentOrNull?.toIntOrNull()

  private fun parseIncludeAudio(params: JsonObject?): Boolean? {
    val value = readPrimitive(params, "includeAudio")?.contentOrNull?.trim()?.lowercase()
    return when (value) {
      "true" -> true
      "false" -> false
      else -> null
    }
  }

  private fun parseString(params: JsonObject?, key: String): String? =
    readPrimitive(params, key)?.contentOrNull

  private fun estimateBitrate(width: Int, height: Int, fps: Int): Int {
    val pixels = width.toLong() * height.toLong()
    val raw = (pixels * fps.toLong() * 2L).toInt()
    return raw.coerceIn(1_000_000, 12_000_000)
  }
}
