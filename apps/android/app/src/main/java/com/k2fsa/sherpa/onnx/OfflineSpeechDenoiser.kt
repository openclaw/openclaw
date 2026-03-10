package com.k2fsa.sherpa.onnx

import android.content.res.AssetManager

data class OfflineSpeechDenoiserGtcrnModelConfig(
    var model: String = "",
)

data class OfflineSpeechDenoiserModelConfig(
    var gtcrn: OfflineSpeechDenoiserGtcrnModelConfig = OfflineSpeechDenoiserGtcrnModelConfig(),
    var numThreads: Int = 1,
    var debug: Boolean = false,
    var provider: String = "cpu",
)

data class OfflineSpeechDenoiserConfig(
    var model: OfflineSpeechDenoiserModelConfig = OfflineSpeechDenoiserModelConfig(),
)

class DenoisedAudio(
    val samples: FloatArray,
    val sampleRate: Int,
) {
    fun save(filename: String) =
        saveImpl(filename = filename, samples = samples, sampleRate = sampleRate)

    private external fun saveImpl(
        filename: String,
        samples: FloatArray,
        sampleRate: Int
    ): Boolean
}

class OfflineSpeechDenoiser(
    assetManager: AssetManager? = null,
    config: OfflineSpeechDenoiserConfig,
) {
    private var ptr: Long

    init {
        ptr = if (assetManager != null) {
            newFromAsset(assetManager, config)
        } else {
            newFromFile(config)
        }
    }

    protected fun finalize() {
        if (ptr != 0L) {
            delete(ptr)
            ptr = 0
        }
    }

    fun release() = finalize()

    fun run(samples: FloatArray, sampleRate: Int) = run(ptr, samples, sampleRate)

    val sampleRate
      get() = getSampleRate(ptr)

    private external fun newFromAsset(
        assetManager: AssetManager,
        config: OfflineSpeechDenoiserConfig,
    ): Long

    private external fun newFromFile(
        config: OfflineSpeechDenoiserConfig,
    ): Long

    private external fun delete(ptr: Long)

    private external fun run(ptr: Long, samples: FloatArray, sampleRate: Int): DenoisedAudio

    private external fun getSampleRate(ptr: Long): Int

    companion object {
        init {
            System.loadLibrary("sherpa-onnx-jni")
        }
    }
}
