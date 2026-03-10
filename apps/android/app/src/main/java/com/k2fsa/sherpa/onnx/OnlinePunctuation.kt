package com.k2fsa.sherpa.onnx

import android.content.res.AssetManager

data class OnlinePunctuationModelConfig(
    var cnnBilstm: String = "",
    var bpeVocab: String = "",
    var numThreads: Int = 1,
    var debug: Boolean = false,
    var provider: String = "cpu",
)


data class OnlinePunctuationConfig(
    var model: OnlinePunctuationModelConfig,
)

class OnlinePunctuation(
    assetManager: AssetManager? = null,
    config: OnlinePunctuationConfig,
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
        config: OnlinePunctuationConfig,
    ): Long

    private external fun newFromFile(
        config: OnlinePunctuationConfig,
    ): Long

    companion object {
        init {
            System.loadLibrary("sherpa-onnx-jni")
        }
    }
}
