package com.k2fsa.sherpa.onnx

import android.content.res.AssetManager

data class OfflinePunctuationModelConfig(
    var ctTransformer: String = "",
    var numThreads: Int = 1,
    var debug: Boolean = false,
    var provider: String = "cpu",
)


data class OfflinePunctuationConfig(
    var model: OfflinePunctuationModelConfig,
)

class OfflinePunctuation(
    assetManager: AssetManager? = null,
    config: OfflinePunctuationConfig,
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

    fun addPunctuation(text: String) = addPunctuation(ptr, text)

    private external fun delete(ptr: Long)

    private external fun addPunctuation(ptr: Long, text: String): String

    private external fun newFromAsset(
        assetManager: AssetManager,
        config: OfflinePunctuationConfig,
    ): Long

    private external fun newFromFile(
        config: OfflinePunctuationConfig,
    ): Long

    companion object {
        init {
            System.loadLibrary("sherpa-onnx-jni")
        }
    }
}
