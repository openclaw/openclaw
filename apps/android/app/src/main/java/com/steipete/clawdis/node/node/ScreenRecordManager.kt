package com.steipete.clawdis.node.node

import android.content.Context
import android.hardware.display.DisplayManager
import android.media.MediaRecorder
import android.media.projection.MediaProjectionManager
import android.util.Base64
import com.steipete.clawdis.node.ScreenCaptureRequester
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import java.io.File
import kotlin.math.roundToInt

class ScreenRecordManager(private val context: Context) {
  data class Payload(val payloadJson: String)

  @Volatile private var screenCaptureRequester: ScreenCaptureRequester? = null

  fun attachScreenCaptureRequester(requester: ScreenCaptureRequester) {
    screenCaptureRequester = requester
  }

  suspend fun record(paramsJson: String?): Payload =
    withContext(Dispatchers.Default) {
      val requester =
        screenCaptureRequester
          ?: throw IllegalStateException(
            "SCREEN_PERMISSION_REQUIRED: grant Screen Recording permission",
          )

      val durationMs = (parseDurationMs(paramsJson) ?: 10_000).coerceIn(250, 60_000)
      val fps = (parseFps(paramsJson) ?: 10.0).coerceIn(1.0, 60.0)
      val fpsInt = fps.roundToInt().coerceIn(1, 60)
      val screenIndex = parseScreenIndex(paramsJson)
      val format = parseString(paramsJson, key = "format")
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

      val file = File.createTempFile("clawdis-screen-", ".mp4")
      val recorder = MediaRecorder()
      var virtualDisplay: android.hardware.display.VirtualDisplay? = null
      try {
        recorder.setVideoSource(MediaRecorder.VideoSource.SURFACE)
        recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
        recorder.setVideoEncoder(MediaRecorder.VideoEncoder.H264)
        recorder.setVideoSize(width, height)
        recorder.setVideoFrameRate(fpsInt)
        recorder.setVideoEncodingBitRate(estimateBitrate(width, height, fpsInt))
        recorder.setOutputFile(file.absolutePath)
        recorder.prepare()

        val surface = recorder.surface
        virtualDisplay =
          projection.createVirtualDisplay(
            "clawdis-screen",
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
        """{"format":"mp4","base64":"$base64","durationMs":$durationMs,"fps":$fpsInt,"screenIndex":0}""",
      )
    }

  private fun parseDurationMs(paramsJson: String?): Int? =
    parseNumber(paramsJson, key = "durationMs")?.toIntOrNull()

  private fun parseFps(paramsJson: String?): Double? =
    parseNumber(paramsJson, key = "fps")?.toDoubleOrNull()

  private fun parseScreenIndex(paramsJson: String?): Int? =
    parseNumber(paramsJson, key = "screenIndex")?.toIntOrNull()

  private fun parseNumber(paramsJson: String?, key: String): String? {
    val raw = paramsJson ?: return null
    val needle = "\"$key\""
    val idx = raw.indexOf(needle)
    if (idx < 0) return null
    val colon = raw.indexOf(':', idx + needle.length)
    if (colon < 0) return null
    val tail = raw.substring(colon + 1).trimStart()
    return tail.takeWhile { it.isDigit() || it == '.' || it == '-' }
  }

  private fun parseString(paramsJson: String?, key: String): String? {
    val raw = paramsJson ?: return null
    val needle = "\"$key\""
    val idx = raw.indexOf(needle)
    if (idx < 0) return null
    val colon = raw.indexOf(':', idx + needle.length)
    if (colon < 0) return null
    val tail = raw.substring(colon + 1).trimStart()
    if (!tail.startsWith('\"')) return null
    val rest = tail.drop(1)
    val end = rest.indexOf('\"')
    if (end < 0) return null
    return rest.substring(0, end)
  }

  private fun estimateBitrate(width: Int, height: Int, fps: Int): Int {
    val pixels = width.toLong() * height.toLong()
    val raw = (pixels * fps.toLong() * 2L).toInt()
    return raw.coerceIn(1_000_000, 12_000_000)
  }
}
