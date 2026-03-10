// Copyright (c)  2024  Xiaomi Corporation
package com.k2fsa.sherpa.onnx

import android.content.res.AssetManager

data class KeywordSpotterConfig(
    var featConfig: FeatureConfig = FeatureConfig(),
    var modelConfig: OnlineModelConfig = OnlineModelConfig(),
    var maxActivePaths: Int = 4,
    var keywordsFile: String = "keywords.txt",
    var keywordsScore: Float = 1.5f,
    var keywordsThreshold: Float = 0.25f,
    var numTrailingBlanks: Int = 2,
)

data class KeywordSpotterResult(
    val keyword: String,
    val tokens: Array<String>,
    val timestamps: FloatArray,
    // TODO(fangjun): Add more fields
) {
    override fun toString(): String {
        val tokensStr = tokens.joinToString(", ")
        val timestampsStr = timestamps.joinToString(", ") { "%.2f".format(it) }
        return "Keyword: $keyword\nTokens: [$tokensStr]\nTimestamps: [$timestampsStr]"
    }
}

class KeywordSpotter(
    assetManager: AssetManager? = null,
    val config: KeywordSpotterConfig,
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

    fun createStream(keywords: String = ""): OnlineStream {
        val p = createStream(ptr, keywords)
        return OnlineStream(p)
    }

    fun decode(stream: OnlineStream) = decode(ptr, stream.ptr)
    fun reset(stream: OnlineStream) = reset(ptr, stream.ptr)
    fun isReady(stream: OnlineStream) = isReady(ptr, stream.ptr)
    fun getResult(stream: OnlineStream): KeywordSpotterResult {
        return getResult(ptr, stream.ptr)
    }

    private external fun delete(ptr: Long)

    private external fun newFromAsset(
        assetManager: AssetManager,
        config: KeywordSpotterConfig,
    ): Long

    private external fun newFromFile(
        config: KeywordSpotterConfig,
    ): Long

    private external fun createStream(ptr: Long, keywords: String): Long
    private external fun isReady(ptr: Long, streamPtr: Long): Boolean
    private external fun decode(ptr: Long, streamPtr: Long)
    private external fun reset(ptr: Long, streamPtr: Long)
    private external fun getResult(ptr: Long, streamPtr: Long): KeywordSpotterResult

    companion object {
        init {
            System.loadLibrary("sherpa-onnx-jni")
        }
    }
}

/*
Please see
https://k2-fsa.github.io/sherpa/onnx/kws/pretrained_models/index.html
for a list of pre-trained models.

We only add a few here. Please change the following code
to add your own. (It should be straightforward to add a new model
by following the code)

@param type
0 - sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01 (Chinese)
    https://www.modelscope.cn/models/pkufool/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01/summary

1 - sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01 (English)
    https://www.modelscope.cn/models/pkufool/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01/summary

 */
fun getKwsModelConfig(type: Int): OnlineModelConfig? {
    when (type) {
        0 -> {
            val modelDir = "sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01"
            return OnlineModelConfig(
                transducer = OnlineTransducerModelConfig(
                    encoder = "$modelDir/encoder-epoch-12-avg-2-chunk-16-left-64.onnx",
                    decoder = "$modelDir/decoder-epoch-12-avg-2-chunk-16-left-64.onnx",
                    joiner = "$modelDir/joiner-epoch-12-avg-2-chunk-16-left-64.onnx",
                ),
                tokens = "$modelDir/tokens.txt",
                modelType = "zipformer2",
            )
        }

        1 -> {
            val modelDir = "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01"
            return OnlineModelConfig(
                transducer = OnlineTransducerModelConfig(
                    encoder = "$modelDir/encoder-epoch-12-avg-2-chunk-16-left-64.onnx",
                    decoder = "$modelDir/decoder-epoch-12-avg-2-chunk-16-left-64.onnx",
                    joiner = "$modelDir/joiner-epoch-12-avg-2-chunk-16-left-64.onnx",
                ),
                tokens = "$modelDir/tokens.txt",
                modelType = "zipformer2",
            )
        }

    }
    return null
}

/*
 * Get the default keywords for each model.
 * Caution: The types and modelDir should be the same as those in getModelConfig
 * function above.
 */
fun getKeywordsFile(type: Int): String {
    when (type) {
        0 -> {
            val modelDir = "sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01"
            return "$modelDir/keywords.txt"
        }

        1 -> {
            val modelDir = "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01"
            return "$modelDir/keywords.txt"
        }

    }
    return ""
}
