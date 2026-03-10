package ai.openclaw.android.voice

import android.content.Context
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

/**
 * Manages sherpa-onnx ASR and TTS instances for offline speech recognition and synthesis.
 * Handles model initialization and provides unified access to speech services.
 */
class SherpaOnnxManager(
  private val context: Context,
  private val scope: CoroutineScope,
) {
  companion object {
    private const val TAG = "SherpaOnnxManager"

    // Model paths relative to assets
    private const val ASR_MODEL_DIR = "sherpa-onnx/asr"
    private const val TTS_MODEL_DIR = "sherpa-onnx/tts"

    // Default Chinese ASR model: streaming-paraformer-bilingual-zh-en
    private const val DEFAULT_ASR_MODEL = "sherpa-onnx-streaming-paraformer-bilingual-zh-en"

    // Default Chinese TTS model: null means use system TTS fallback
    private val DEFAULT_TTS_MODEL: String? = null
  }

  private val _isInitialized = MutableStateFlow(false)
  val isInitialized: StateFlow<Boolean> = _isInitialized

  private val _initializationStatus = MutableStateFlow("Not initialized")
  val initializationStatus: StateFlow<String> = _initializationStatus

  private val _asrEnabled = MutableStateFlow(false)
  val asrEnabled: StateFlow<Boolean> = _asrEnabled

  private val _ttsEnabled = MutableStateFlow(false)
  val ttsEnabled: StateFlow<Boolean> = _ttsEnabled

  var recognizer: SherpaOnnxRecognizer? = null
    private set

  var tts: SherpaOnnxTts? = null
    private set

  private var modelDir: File? = null

  /**
   * Initialize sherpa-onnx models.
   * Copies model files from assets to app storage and initializes ASR/TTS.
   */
  suspend fun initialize(
    asrModelName: String? = null,
    ttsModelName: String? = null,
  ): Boolean = withContext(Dispatchers.IO) {
    if (_isInitialized.value) {
      Log.d(TAG, "Already initialized")
      return@withContext true
    }

    try {
      _initializationStatus.value = "Extracting models..."
      Log.d(TAG, "Initializing sherpa-onnx")

      // Setup model directory - use external storage for models
      // Try external files directory first (where we pushed via adb)
      modelDir = context.getExternalFilesDir("sherpa-onnx-models")
      if (modelDir == null || !modelDir!!.exists()) {
        // Fallback to internal storage
        modelDir = File(context.filesDir, "sherpa-onnx-models")
      }
      if (!modelDir!!.exists()) {
        modelDir!!.mkdirs()
      }

      // Extract models from assets
      extractAssetsIfNeeded()

      // Initialize ASR
      val asrOk = initializeAsr(asrModelName)
      _asrEnabled.value = asrOk

      // Initialize TTS
      val ttsOk = initializeTts(ttsModelName)
      _ttsEnabled.value = ttsOk

      _isInitialized.value = true
      _initializationStatus.value = if (asrOk || ttsOk) "Ready" else "Partial (check models)"
      Log.d(TAG, "Initialization complete: ASR=$asrOk, TTS=$ttsOk")
      true
    } catch (e: Throwable) {
      Log.e(TAG, "Initialization failed", e)
      _initializationStatus.value = "Failed: ${e.message}"
      _isInitialized.value = false
      false
    }
  }

  private suspend fun initializeAsr(modelName: String?): Boolean {
    return try {
      val model = modelName ?: DEFAULT_ASR_MODEL
      _initializationStatus.value = "Loading ASR model..."
      Log.d(TAG, "Loading ASR model: $model")

      val recognizer = SherpaOnnxRecognizer(
        modelDir = modelDir!!,
        modelName = model,
      )
      val initialized = recognizer.initialize()
      if (initialized) {
        this.recognizer = recognizer
        Log.d(TAG, "ASR initialized successfully")
      }
      initialized
    } catch (e: Throwable) {
      Log.e(TAG, "ASR initialization failed", e)
      false
    }
  }

  private suspend fun initializeTts(modelName: String?): Boolean {
    return try {
      val model = modelName ?: DEFAULT_TTS_MODEL
      if (model == null) {
        Log.d(TAG, "TTS model not specified, using system TTS fallback")
        return false
      }

      _initializationStatus.value = "Loading TTS model..."
      Log.d(TAG, "Loading TTS model: $model")

      val tts = SherpaOnnxTts(
        modelDir = modelDir!!,
        modelName = model,
      )
      val initialized = tts.initialize()
      if (initialized) {
        this.tts = tts
        Log.d(TAG, "TTS initialized successfully")
      }
      initialized
    } catch (e: Throwable) {
      Log.e(TAG, "TTS initialization failed", e)
      false
    }
  }

  private fun extractAssetsIfNeeded() {
    val asrDir = File(modelDir!!, ASR_MODEL_DIR)
    val ttsDir = File(modelDir!!, TTS_MODEL_DIR)

    if (asrDir.exists() && ttsDir.exists()) {
      // Check if essential model files exist
      val asrModel = File(asrDir, DEFAULT_ASR_MODEL)
      // Only check TTS model if DEFAULT_TTS_MODEL is not null
      if (asrModel.exists()) {
        Log.d(TAG, "Models already extracted")
        return
      }
    }

    // Extract models from assets
    Log.d(TAG, "Extracting models from assets...")
    extractAssetDirectory(ASR_MODEL_DIR, asrDir)
    extractAssetDirectory(TTS_MODEL_DIR, ttsDir)
  }

  private fun extractAssetDirectory(assetPath: String, targetDir: File) {
    try {
      val assets = context.assets.list(assetPath) ?: emptyArray()
      if (assets.isEmpty()) {
        Log.w(TAG, "No assets found at $assetPath")
        return
      }

      targetDir.mkdirs()

      for (asset in assets) {
        val assetFilePath = "$assetPath/$asset"
        val targetFile = File(targetDir, asset)

        if (isDirectory(assetFilePath)) {
          extractAssetDirectory(assetFilePath, targetFile)
        } else {
          context.assets.open(assetFilePath).use { input ->
            targetFile.outputStream().use { output ->
              input.copyTo(output)
            }
          }
        }
      }
      Log.d(TAG, "Extracted $assetPath to ${targetDir.absolutePath}")
    } catch (e: Throwable) {
      Log.e(TAG, "Failed to extract $assetPath", e)
    }
  }

  private fun isDirectory(assetPath: String): Boolean {
    return try {
      val assets = context.assets.list(assetPath)
      assets != null && assets.isNotEmpty()
    } catch (e: Throwable) {
      false
    }
  }

  /**
   * Release all resources
   */
  fun release() {
    Log.d(TAG, "Releasing resources")
    scope.launch {
      withContext(Dispatchers.Main) {
        recognizer?.release()
        recognizer = null
        tts?.release()
        tts = null
        _isInitialized.value = false
        _asrEnabled.value = false
        _ttsEnabled.value = false
        _initializationStatus.value = "Released"
      }
    }
  }

  /**
   * Check if ASR is available and ready
   */
  fun isAsrReady(): Boolean {
    return _isInitialized.value && _asrEnabled.value && recognizer != null
  }

  /**
   * Check if TTS is available and ready
   */
  fun isTtsReady(): Boolean {
    return _isInitialized.value && _ttsEnabled.value && tts != null
  }
}
