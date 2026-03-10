package com.k2fsa.sherpa.onnx

import android.content.res.AssetManager

data class OfflineZipformerAudioTaggingModelConfig(
    var model: String = "",
)

data class AudioTaggingModelConfig(
    var zipformer: OfflineZipformerAudioTaggingModelConfig = OfflineZipformerAudioTaggingModelConfig(),
    var ced: String = "",
    var numThreads: Int = 1,
    var debug: Boolean = false,
    var provider: String = "cpu",
)

data class AudioTaggingConfig(
    var model: AudioTaggingModelConfig = AudioTaggingModelConfig(),
    var labels: String = "",
    var topK: Int = 5,
)

data class AudioEvent(
    val name: String,
    val index: Int,
    val prob: Float,
)

class AudioTagging(
    assetManager: AssetManager? = null,
    config: AudioTaggingConfig,
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

    @Suppress("UNCHECKED_CAST")
    fun compute(stream: OfflineStream, topK: Int = -1): Array<AudioEvent> {
        return compute(ptr, stream.ptr, topK)
    }

    private external fun newFromAsset(
        assetManager: AssetManager,
        config: AudioTaggingConfig,
    ): Long

    private external fun newFromFile(
        config: AudioTaggingConfig,
    ): Long

    private external fun delete(ptr: Long)

    private external fun createStream(ptr: Long): Long

    private external fun compute(ptr: Long, streamPtr: Long, topK: Int): Array<AudioEvent>

    companion object {
        init {
            System.loadLibrary("sherpa-onnx-jni")
        }
    }
}

// please refer to
// https://github.com/k2-fsa/sherpa-onnx/releases/tag/audio-tagging-models
// to download more models
//
// See also
// https://k2-fsa.github.io/sherpa/onnx/audio-tagging/
fun getAudioTaggingConfig(type: Int, numThreads: Int = 1): AudioTaggingConfig? {
    when (type) {
        0 -> {
            val modelDir = "sherpa-onnx-zipformer-small-audio-tagging-2024-04-15"
            return AudioTaggingConfig(
                model = AudioTaggingModelConfig(
                    zipformer = OfflineZipformerAudioTaggingModelConfig(model = "$modelDir/model.int8.onnx"),
                    numThreads = numThreads,
                    debug = true,
                ),
                labels = "$modelDir/class_labels_indices.csv",
                topK = 3,
            )
        }

        1 -> {
            val modelDir = "sherpa-onnx-zipformer-audio-tagging-2024-04-09"
            return AudioTaggingConfig(
                model = AudioTaggingModelConfig(
                    zipformer = OfflineZipformerAudioTaggingModelConfig(model = "$modelDir/model.int8.onnx"),
                    numThreads = numThreads,
                    debug = true,
                ),
                labels = "$modelDir/class_labels_indices.csv",
                topK = 3,
            )
        }

        2 -> {
            val modelDir = "sherpa-onnx-ced-tiny-audio-tagging-2024-04-19"
            return AudioTaggingConfig(
                model = AudioTaggingModelConfig(
                    ced = "$modelDir/model.int8.onnx",
                    numThreads = numThreads,
                    debug = true,
                ),
                labels = "$modelDir/class_labels_indices.csv",
                topK = 3,
            )
        }

        3 -> {
            val modelDir = "sherpa-onnx-ced-mini-audio-tagging-2024-04-19"
            return AudioTaggingConfig(
                model = AudioTaggingModelConfig(
                    ced = "$modelDir/model.int8.onnx",
                    numThreads = numThreads,
                    debug = true,
                ),
                labels = "$modelDir/class_labels_indices.csv",
                topK = 3,
            )
        }

        4 -> {
            val modelDir = "sherpa-onnx-ced-small-audio-tagging-2024-04-19"
            return AudioTaggingConfig(
                model = AudioTaggingModelConfig(
                    ced = "$modelDir/model.int8.onnx",
                    numThreads = numThreads,
                    debug = true,
                ),
                labels = "$modelDir/class_labels_indices.csv",
                topK = 3,
            )
        }

        5 -> {
            val modelDir = "sherpa-onnx-ced-base-audio-tagging-2024-04-19"
            return AudioTaggingConfig(
                model = AudioTaggingModelConfig(
                    ced = "$modelDir/model.int8.onnx",
                    numThreads = numThreads,
                    debug = true,
                ),
                labels = "$modelDir/class_labels_indices.csv",
                topK = 3,
            )
        }
    }

    return null
}
