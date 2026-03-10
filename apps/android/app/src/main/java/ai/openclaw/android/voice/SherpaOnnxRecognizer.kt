package ai.openclaw.android.voice

import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.util.Log
import com.k2fsa.sherpa.onnx.FeatureConfig
import com.k2fsa.sherpa.onnx.OnlineModelConfig
import com.k2fsa.sherpa.onnx.OnlineParaformerModelConfig
import com.k2fsa.sherpa.onnx.OnlineRecognizer
import com.k2fsa.sherpa.onnx.OnlineRecognizerConfig
import com.k2fsa.sherpa.onnx.OnlineStream
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

/**
 * Wrapper for sherpa-onnx OnlineRecognizer for streaming speech recognition.
 * Provides offline ASR capabilities with real-time transcription.
 *
 * This class uses the official sherpa-onnx Kotlin API.
 * The native library provides OnlineRecognizer for streaming ASR.
 */
class SherpaOnnxRecognizer(
  private val modelDir: File,
  private val modelName: String,
) {
  companion object {
    private const val TAG = "SherpaOnnxRecognizer"

    // Audio recording parameters
    private const val SAMPLE_RATE = 16000
    private const val CHANNEL_CONFIG = AudioFormat.CHANNEL_IN_MONO
    private const val AUDIO_FORMAT = AudioFormat.ENCODING_PCM_16BIT
    private const val BUFFER_SIZE_FACTOR = 4

    // Recognition parameters
    private const val SILENCE_WINDOW_MS = 700L
    private const val MIN_SPEECH_DURATION_MS = 300L
    private const val DECODE_INTERVAL_MS = 100L
  }

  // Sherpa-onnx recognizer instance
  private var recognizer: OnlineRecognizer? = null
  private var stream: OnlineStream? = null

  // Audio recording
  private var audioRecord: AudioRecord? = null
  private var recordingJob: Job? = null
  private var isRecording = false

  // Recognition state
  private val _isRecognizing = MutableStateFlow(false)
  val isRecognizing: StateFlow<Boolean> = _isRecognizing

  private val _transcript = MutableStateFlow("")
  val transcript: StateFlow<String> = _transcript

  private val _isFinal = MutableStateFlow(false)
  val isFinal: StateFlow<Boolean> = _isFinal

  // Callbacks
  var onPartialResult: ((String) -> Unit)? = null
  var onFinalResult: ((String) -> Unit)? = null
  var onError: ((Throwable) -> Unit)? = null

  // Timing for silence detection
  private var lastSpeechTimeMs: Long = 0
  private var currentTranscript = ""

  suspend fun initialize(): Boolean = withContext(Dispatchers.IO) {
    try {
      Log.d(TAG, "Initializing recognizer with model: $modelName")

      val modelPath = File(modelDir, "asr/$modelName").absolutePath
      val config = createRecognizerConfig(modelPath)

      recognizer = OnlineRecognizer(assetManager = null, config = config)

      Log.d(TAG, "Recognizer initialized successfully")
      true
    } catch (e: Throwable) {
      Log.e(TAG, "Failed to initialize recognizer", e)
      onError?.invoke(e)
      false
    }
  }

  private fun createRecognizerConfig(modelPath: String): OnlineRecognizerConfig {
    // For streaming-paraformer-bilingual-zh-en:
    // Use int8 quantized models for mobile
    val modelConfig = OnlineModelConfig(
      paraformer = OnlineParaformerModelConfig(
        encoder = "$modelPath/encoder.int8.onnx",
        decoder = "$modelPath/decoder.int8.onnx",
      ),
      tokens = "$modelPath/tokens.txt",
      numThreads = 4,
      modelType = "paraformer",
    )

    val featConfig = FeatureConfig(
      sampleRate = SAMPLE_RATE,
      featureDim = 80,
    )

    return OnlineRecognizerConfig(
      featConfig = featConfig,
      modelConfig = modelConfig,
      enableEndpoint = true,
      decodingMethod = "greedy_search",
      maxActivePaths = 4,
    )
  }

  suspend fun startRecognition(scope: CoroutineScope): Boolean = withContext(Dispatchers.IO) {
    try {
      if (_isRecognizing.value) {
        Log.w(TAG, "Already recognizing")
        return@withContext true
      }

      Log.d(TAG, "Starting recognition")

      // Create a new stream for recognition
      recognizer?.let { rec ->
        stream = rec.createStream()
      }

      // Start audio recording
      isRecording = true
      lastSpeechTimeMs = System.currentTimeMillis()
      currentTranscript = ""

      recordingJob = scope.launch(Dispatchers.IO) {
        recordAndRecognize()
      }

      _isRecognizing.value = true
      _isFinal.value = false
      _transcript.value = ""

      Log.d(TAG, "Recognition started")
      true
    } catch (e: Throwable) {
      Log.e(TAG, "Failed to start recognition", e)
      onError?.invoke(e)
      false
    }
  }

  private suspend fun recordAndRecognize() {
    val bufferSize = AudioRecord.getMinBufferSize(SAMPLE_RATE, CHANNEL_CONFIG, AUDIO_FORMAT)
    if (bufferSize == AudioRecord.ERROR || bufferSize == AudioRecord.ERROR_BAD_VALUE) {
      onError?.invoke(IllegalStateException("Invalid buffer size"))
      return
    }

    val audioBufferSize = bufferSize * BUFFER_SIZE_FACTOR
    val audioBuffer = ByteArray(audioBufferSize)

    audioRecord = AudioRecord(
      MediaRecorder.AudioSource.VOICE_RECOGNITION,
      SAMPLE_RATE,
      CHANNEL_CONFIG,
      AUDIO_FORMAT,
      audioBufferSize,
    )

    if (audioRecord?.state != AudioRecord.STATE_INITIALIZED) {
      onError?.invoke(IllegalStateException("AudioRecord initialization failed"))
      return
    }

    try {
      audioRecord?.startRecording()
      Log.d(TAG, "Audio recording started")

      var lastDecodeTime = System.currentTimeMillis()

      while (isRecording && _isRecognizing.value) {
        val read = audioRecord?.read(audioBuffer, 0, audioBufferSize) ?: 0
        if (read <= 0) continue

        // Process audio in chunks
        processAudioChunk(audioBuffer, read)

        // Decode periodically
        val now = System.currentTimeMillis()
        if (now - lastDecodeTime >= DECODE_INTERVAL_MS) {
          decode()
          checkSilence()
          lastDecodeTime = now
        }
      }

      // Final decode before stopping
      decode()
      if (currentTranscript.isNotBlank()) {
        _isFinal.value = true
        _transcript.value = currentTranscript
        onFinalResult?.invoke(currentTranscript)
      }
    } catch (e: Throwable) {
      Log.e(TAG, "Error during recognition", e)
      onError?.invoke(e)
    } finally {
      audioRecord?.stop()
      audioRecord?.release()
      audioRecord = null
      resetStream()
    }
  }

  private fun processAudioChunk(buffer: ByteArray, size: Int) {
    // Check if there's speech energy (simple VAD)
    val energy = calculateEnergy(buffer, size)
    if (energy > 100) { // Threshold for speech detection
      lastSpeechTimeMs = System.currentTimeMillis()
    }

    // Convert PCM16 to float for sherpa-onnx
    val floatSamples = convertPcm16ToFloat(buffer, size)

    // Feed audio to recognizer
    stream?.acceptWaveform(floatSamples, SAMPLE_RATE)
  }

  private fun convertPcm16ToFloat(buffer: ByteArray, size: Int): FloatArray {
    val floatSamples = FloatArray(size / 2)
    for (i in floatSamples.indices) {
      val byte1 = buffer[i * 2].toInt() and 0xFF
      val byte2 = buffer[i * 2 + 1].toInt()
      val sample = (byte1 or (byte2 shl 8)).toShort()
      floatSamples[i] = sample.toFloat() / 32768.0f
    }
    return floatSamples
  }

  private fun calculateEnergy(buffer: ByteArray, size: Int): Double {
    var sum = 0.0
    for (i in 0 until size step 2) {
      if (i + 1 < size) {
        val sample = ((buffer[i + 1].toInt() shl 8) or (buffer[i].toInt() and 0xFF)).toShort()
        sum += sample * sample
      }
    }
    return sum / (size / 2)
  }

  private fun checkSilence() {
    val now = System.currentTimeMillis()
    val silenceDuration = now - lastSpeechTimeMs

    // Only finalize if we have some speech and sufficient silence
    if (silenceDuration > SILENCE_WINDOW_MS && currentTranscript.isNotBlank()) {
      Log.d(TAG, "Silence detected, finalizing: ${currentTranscript.take(50)}...")
      isRecording = false
      _isFinal.value = true
      _transcript.value = currentTranscript
      onFinalResult?.invoke(currentTranscript)
    }
  }

  private fun decode() {
    val rec = recognizer ?: return
    val str = stream ?: return

    rec.decode(str)

    // Check for endpoint
    if (rec.isEndpoint(str)) {
      val result = rec.getResult(str)
      if (result.text.isNotBlank() && result.text != currentTranscript) {
        currentTranscript = result.text
        _transcript.value = result.text
        _isFinal.value = true
        onFinalResult?.invoke(result.text)
        Log.d(TAG, "Final result: ${result.text}")
      }
      rec.reset(str)
      currentTranscript = ""
    } else {
      val result = rec.getResult(str)
      if (result.text.isNotBlank() && result.text != currentTranscript) {
        currentTranscript = result.text
        _transcript.value = result.text
        _isFinal.value = false
        onPartialResult?.invoke(result.text)
        Log.d(TAG, "Partial result: ${result.text}")
      }
    }
  }

  fun stopRecognition() {
    Log.d(TAG, "Stopping recognition")
    isRecording = false
    _isRecognizing.value = false
    recordingJob?.cancel()
    recordingJob = null

    audioRecord?.apply {
      if (recordingState == AudioRecord.RECORDSTATE_RECORDING) {
        stop()
      }
      release()
    }
    audioRecord = null

    resetStream()
  }

  fun reset() {
    currentTranscript = ""
    _transcript.value = ""
    _isFinal.value = false
    lastSpeechTimeMs = System.currentTimeMillis()
    resetStream()
  }

  private fun resetStream() {
    recognizer?.let { rec ->
      stream?.let { str ->
        rec.reset(str)
      }
    }
  }

  fun release() {
    Log.d(TAG, "Releasing recognizer")
    stopRecognition()

    stream?.release()
    stream = null

    recognizer?.release()
    recognizer = null

    onPartialResult = null
    onFinalResult = null
    onError = null
  }
}
