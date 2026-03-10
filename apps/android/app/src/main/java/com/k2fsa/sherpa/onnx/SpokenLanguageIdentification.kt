package com.k2fsa.sherpa.onnx

import android.content.res.AssetManager

data class SpokenLanguageIdentificationWhisperConfig(
    var encoder: String = "",
    var decoder: String = "",
    var tailPaddings: Int = -1,
)

data class SpokenLanguageIdentificationConfig(
    var whisper: SpokenLanguageIdentificationWhisperConfig = SpokenLanguageIdentificationWhisperConfig(),
    var numThreads: Int = 1,
    var debug: Boolean = false,
    var provider: String = "cpu",
)

class SpokenLanguageIdentification(
    assetManager: AssetManager? = null,
    config: SpokenLanguageIdentificationConfig,
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

    fun createStream(): OfflineStream {
        val p = createStream(ptr)
        return OfflineStream(p)
    }

    fun compute(stream: OfflineStream) = compute(ptr, stream.ptr)

    private external fun newFromAsset(
        assetManager: AssetManager,
        config: SpokenLanguageIdentificationConfig,
    ): Long

    private external fun newFromFile(
        config: SpokenLanguageIdentificationConfig,
    ): Long

    private external fun delete(ptr: Long)

    private external fun createStream(ptr: Long): Long

    private external fun compute(ptr: Long, streamPtr: Long): String

    companion object {
        init {
            System.loadLibrary("sherpa-onnx-jni")
        }
    }
}

// please refer to
// https://k2-fsa.github.io/sherpa/onnx/spolken-language-identification/pretrained_models.html#whisper
// to download more models
fun getSpokenLanguageIdentificationConfig(
    type: Int,
    numThreads: Int = 1
): SpokenLanguageIdentificationConfig? {
    when (type) {
        0 -> {
            val modelDir = "sherpa-onnx-whisper-tiny"
            return SpokenLanguageIdentificationConfig(
                whisper = SpokenLanguageIdentificationWhisperConfig(
                    encoder = "$modelDir/tiny-encoder.int8.onnx",
                    decoder = "$modelDir/tiny-decoder.int8.onnx",
                ),
                numThreads = numThreads,
                debug = true,
            )
        }

        1 -> {
            val modelDir = "sherpa-onnx-whisper-base"
            return SpokenLanguageIdentificationConfig(
                whisper = SpokenLanguageIdentificationWhisperConfig(
                    encoder = "$modelDir/tiny-encoder.int8.onnx",
                    decoder = "$modelDir/tiny-decoder.int8.onnx",
                ),
                numThreads = 1,
                debug = true,
            )
        }
    }
    return null
}
