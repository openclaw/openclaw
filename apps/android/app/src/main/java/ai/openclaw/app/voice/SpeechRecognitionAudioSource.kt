package ai.openclaw.app.voice

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Build
import android.os.ParcelFileDescriptor
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.io.IOException

internal const val speechRecognitionSampleRateHz = 16_000

internal class SpeechRecognitionAudioSource(
  val readDescriptor: ParcelFileDescriptor,
  private val writeStream: ParcelFileDescriptor.AutoCloseOutputStream,
  private val audioRecord: AudioRecord,
) {
  private var finishRequested = false
  private var inputFinished = false
  private var descriptorClosed = false
  var pumpJob: Job? = null

  @Synchronized
  fun requestFinish() {
    if (finishRequested) return
    finishRequested = true
    runCatching { audioRecord.stop() }
  }

  // close() must wait for a pump already inside release, not just observe its claim.
  @Synchronized
  fun finishFromPump() {
    if (inputFinished) return
    inputFinished = true
    runCatching { audioRecord.stop() }
    runCatching { audioRecord.release() }
    runCatching { writeStream.close() }
  }

  @Synchronized
  fun close() {
    requestFinish()
    pumpJob?.cancel()
    finishFromPump()
    pumpJob = null
    if (!descriptorClosed) {
      descriptorClosed = true
      runCatching { readDescriptor.close() }
    }
  }
}

@SuppressLint("MissingPermission")
internal fun openSpeechRecognitionAudioSource(scope: CoroutineScope): SpeechRecognitionAudioSource {
  check(Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
  val minBufferSize =
    AudioRecord.getMinBufferSize(
      speechRecognitionSampleRateHz,
      AudioFormat.CHANNEL_IN_MONO,
      AudioFormat.ENCODING_PCM_16BIT,
    )
  check(minBufferSize > 0) { "AudioRecord buffer unavailable" }

  val pipe = ParcelFileDescriptor.createPipe()
  var recorder: AudioRecord? = null
  var writeStream: ParcelFileDescriptor.AutoCloseOutputStream? = null
  try {
    recorder =
      AudioRecord(
        MediaRecorder.AudioSource.VOICE_RECOGNITION,
        speechRecognitionSampleRateHz,
        AudioFormat.CHANNEL_IN_MONO,
        AudioFormat.ENCODING_PCM_16BIT,
        minBufferSize * 2,
      )
    check(recorder.state == AudioRecord.STATE_INITIALIZED) { "AudioRecord initialization failed" }
    recorder.startRecording()
    check(recorder.recordingState == AudioRecord.RECORDSTATE_RECORDING) { "AudioRecord did not start" }
    val activeRecorder = recorder
    val activeWriteStream = ParcelFileDescriptor.AutoCloseOutputStream(pipe[1])
    writeStream = activeWriteStream
    val source = SpeechRecognitionAudioSource(pipe[0], activeWriteStream, activeRecorder)
    source.pumpJob =
      scope.launch(Dispatchers.IO) {
        val buffer = ByteArray(minBufferSize.coerceAtLeast(4_096))
        try {
          while (currentCoroutineContext().isActive) {
            val bytesRead = activeRecorder.read(buffer, 0, buffer.size)
            if (bytesRead <= 0) break
            activeWriteStream.write(buffer, 0, bytesRead)
          }
        } catch (err: IOException) {
          Log.d("OpenClawSpeechRecognition", "Audio pipe closed: ${err.message}")
        } finally {
          source.finishFromPump()
        }
      }
    return source
  } catch (err: Throwable) {
    runCatching { recorder?.stop() }
    runCatching { recorder?.release() }
    runCatching { writeStream?.close() }
    if (writeStream == null) runCatching { pipe[1].close() }
    runCatching { pipe[0].close() }
    throw err
  }
}
