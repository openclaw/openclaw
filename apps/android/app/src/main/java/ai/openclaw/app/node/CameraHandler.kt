package ai.openclaw.app.node

import ai.openclaw.app.BuildConfig
import ai.openclaw.app.gateway.GatewaySession
import ai.openclaw.app.takeUtf16Safe
import android.content.Context
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import java.util.concurrent.atomic.AtomicReference

internal const val CAMERA_CLIP_MAX_RAW_BYTES: Long = 18L * 1024L * 1024L
private const val CAMERA_DEBUG_STACK_TRACE_MAX_CHARS = 2_000

/**
 * Raw MP4 size guard before base64 encoding the clip into a node.invoke response.
 */
internal fun isCameraClipWithinPayloadLimit(rawBytes: Long): Boolean = rawBytes in 0L..CAMERA_CLIP_MAX_RAW_BYTES

/** Gateway camera commands with payload-size enforcement and audio ownership. */
class CameraHandler(
  private val appContext: Context,
  private val camera: CameraCaptureManager,
  private val setCameraAudioCaptureActive: (Boolean) -> Boolean,
) {
  /** Handles camera.list by exposing CameraX devices through gateway metadata. */
  suspend fun handleList(_paramsJson: String?): GatewaySession.InvokeResult =
    try {
      val devices = camera.listDevices()
      GatewaySession.InvokeResult.ok(Json.encodeToString(mapOf("devices" to devices)))
    } catch (err: CancellationException) {
      throw err
    } catch (err: Throwable) {
      val (code, message) = invokeErrorFromThrowable(err)
      GatewaySession.InvokeResult.error(code = code, message = message)
    }

  suspend fun handleSnap(paramsJson: String?): GatewaySession.InvokeResult {
    val logFile = if (BuildConfig.DEBUG) java.io.File(appContext.cacheDir, "camera_debug.log") else null
    val camLog = cameraLogger(logFile, "camera.snap")
    try {
      logFile?.writeText("") // clear
      camLog("starting, params=$paramsJson")
      val res =
        try {
          camLog("calling camera.snap()")
          val r = camera.snap(paramsJson)
          camLog("success, payload size=${r.length}")
          r
        } catch (err: CancellationException) {
          throw err
        } catch (err: Throwable) {
          camLog("inner error: ${err::class.java.simpleName}: ${err.message}")
          camLog("stack: ${err.stackTraceToString().takeUtf16Safe(CAMERA_DEBUG_STACK_TRACE_MAX_CHARS)}")
          val (code, message) = invokeErrorFromThrowable(err)
          return GatewaySession.InvokeResult.error(code = code, message = message)
        }
      camLog("returning result")
      return GatewaySession.InvokeResult.ok(res)
    } catch (err: CancellationException) {
      throw err
    } catch (err: Throwable) {
      camLog("outer error: ${err::class.java.simpleName}: ${err.message}")
      camLog("stack: ${err.stackTraceToString().takeUtf16Safe(CAMERA_DEBUG_STACK_TRACE_MAX_CHARS)}")
      return GatewaySession.InvokeResult.error(code = "UNAVAILABLE", message = err.message ?: "camera snap failed")
    }
  }

  /** Handles camera.clip and keeps external audio capture paused while camera audio is active. */
  suspend fun handleClip(paramsJson: String?): GatewaySession.InvokeResult {
    val clipLogFile = if (BuildConfig.DEBUG) java.io.File(appContext.cacheDir, "camera_debug.log") else null
    val clipLog = cameraLogger(clipLogFile, "camera.clip", "CLIP ")
    val includeAudio = parseJsonBooleanFlag(parseJsonParamsObject(paramsJson), "includeAudio") ?: true
    val ownsAudioCapture = includeAudio && setCameraAudioCaptureActive(true)
    if (includeAudio && !ownsAudioCapture) {
      return nodeInvokeError("MIC_BUSY", "another audio capture is active")
    }
    val ownedClipFile = AtomicReference<java.io.File?>()
    try {
      clipLogFile?.writeText("") // clear
      clipLog("starting, params=$paramsJson includeAudio=$includeAudio")
      val filePayload =
        try {
          clipLog("calling camera.clip()")
          val r =
            camera.clip(paramsJson) { file ->
              check(ownedClipFile.compareAndSet(null, file)) { "camera clip already owns a file" }
            }
          clipLog("success, file size=${r.file.length()}")
          r
        } catch (err: CancellationException) {
          throw err
        } catch (err: Throwable) {
          clipLog("inner error: ${err::class.java.simpleName}: ${err.message}")
          clipLog("stack: ${err.stackTraceToString().takeUtf16Safe(CAMERA_DEBUG_STACK_TRACE_MAX_CHARS)}")
          val (code, message) = invokeErrorFromThrowable(err)
          return GatewaySession.InvokeResult.error(code = code, message = message)
        }
      val rawBytes = filePayload.file.length()
      if (!isCameraClipWithinPayloadLimit(rawBytes)) {
        clipLog("payload too large: bytes=$rawBytes max=$CAMERA_CLIP_MAX_RAW_BYTES")
        return nodeInvokeError(
          "PAYLOAD_TOO_LARGE",
          "camera clip is $rawBytes bytes; max is $CAMERA_CLIP_MAX_RAW_BYTES bytes. Reduce durationMs and retry.",
        )
      }

      val bytes = withContext(Dispatchers.IO) { filePayload.file.readBytes() }
      val base64 = android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)
      clipLog("returning base64 payload")
      return GatewaySession.InvokeResult.ok(
        """{"format":"mp4","base64":"$base64","durationMs":${filePayload.durationMs},"hasAudio":${filePayload.hasAudio}}""",
      )
    } catch (err: CancellationException) {
      throw err
    } catch (err: Throwable) {
      clipLog("outer error: ${err::class.java.simpleName}: ${err.message}")
      clipLog("stack: ${err.stackTraceToString().takeUtf16Safe(CAMERA_DEBUG_STACK_TRACE_MAX_CHARS)}")
      return GatewaySession.InvokeResult.error(code = "UNAVAILABLE", message = err.message ?: "camera clip failed")
    } finally {
      try {
        ownedClipFile.getAndSet(null)?.let { file ->
          // Nest dispatcher changes so cancellation cannot replace the original failure.
          withContext(NonCancellable) {
            withContext(Dispatchers.IO) { file.delete() }
          }
        }
      } finally {
        // Prevent talk/transcription capture from competing with camera audio after every exit path.
        if (ownsAudioCapture) setCameraAudioCaptureActive(false)
      }
    }
  }

  private fun cameraLogger(
    file: java.io.File?,
    command: String,
    prefix: String = "",
  ): (String) -> Unit =
    { message ->
      if (BuildConfig.DEBUG) {
        val time = java.text.SimpleDateFormat("HH:mm:ss.SSS", java.util.Locale.US).format(java.util.Date())
        file?.appendText("[$prefix$time] $message\n")
        android.util.Log.w("openclaw", "$command: $message")
      }
    }
}
