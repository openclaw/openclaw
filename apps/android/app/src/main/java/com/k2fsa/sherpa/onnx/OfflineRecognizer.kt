package com.k2fsa.sherpa.onnx

import android.content.res.AssetManager

data class OfflineRecognizerResult(
    val text: String,
    val tokens: Array<String>,
    val timestamps: FloatArray,
    val lang: String,
    val emotion: String,
    val event: String,

    // valid only for TDT models
    val durations: FloatArray,
)

data class OfflineTransducerModelConfig(
    var encoder: String = "",
    var decoder: String = "",
    var joiner: String = "",
)

data class OfflineParaformerModelConfig(
    var model: String = "",
    var qnnConfig: QnnConfig = QnnConfig(),
)

data class OfflineNemoEncDecCtcModelConfig(
    var model: String = "",
)

data class OfflineDolphinModelConfig(
    var model: String = "",
)

data class OfflineZipformerCtcModelConfig(
    var model: String = "",
    var qnnConfig: QnnConfig = QnnConfig(),
)

data class OfflineWenetCtcModelConfig(
    var model: String = "",
)

data class OfflineOmnilingualAsrCtcModelConfig(
    var model: String = "",
)

data class OfflineMedAsrCtcModelConfig(
    var model: String = "",
)

data class OfflineFunAsrNanoModelConfig(
    var encoderAdaptor: String = "",
    var llm: String = "",
    var embedding: String = "",
    var tokenizer: String = "",
    var systemPrompt: String = "You are a helpful assistant.",
    var userPrompt: String = "语音转写：",
    var maxNewTokens: Int = 512,
    var temperature: Float = 1e-6f,
    var topP: Float = 0.8f,
    var seed: Int = 42,
    var language: String = "",
    var itn: Boolean = true,
    var hotwords: String = "",
)

data class OfflineWhisperModelConfig(
    var encoder: String = "",
    var decoder: String = "",
    var language: String = "en", // Used with multilingual model
    var task: String = "transcribe", // transcribe or translate
    var tailPaddings: Int = 1000, // Padding added at the end of the samples
    var enableTokenTimestamps: Boolean = false,
    var enableSegmentTimestamps: Boolean = false,
)

data class OfflineCanaryModelConfig(
    var encoder: String = "",
    var decoder: String = "",
    var srcLang: String = "en",
    var tgtLang: String = "en",
    var usePnc: Boolean = true,
)

data class OfflineFireRedAsrModelConfig(
    var encoder: String = "",
    var decoder: String = "",
)

data class OfflineMoonshineModelConfig(
    var preprocessor: String = "",
    var encoder: String = "",
    var uncachedDecoder: String = "",
    var cachedDecoder: String = "",
)

data class OfflineSenseVoiceModelConfig(
    var model: String = "",
    var language: String = "",
    var useInverseTextNormalization: Boolean = true,
    var qnnConfig: QnnConfig = QnnConfig(),
)

data class OfflineModelConfig(
    var transducer: OfflineTransducerModelConfig = OfflineTransducerModelConfig(),
    var paraformer: OfflineParaformerModelConfig = OfflineParaformerModelConfig(),
    var whisper: OfflineWhisperModelConfig = OfflineWhisperModelConfig(),
    var fireRedAsr: OfflineFireRedAsrModelConfig = OfflineFireRedAsrModelConfig(),
    var moonshine: OfflineMoonshineModelConfig = OfflineMoonshineModelConfig(),
    var nemo: OfflineNemoEncDecCtcModelConfig = OfflineNemoEncDecCtcModelConfig(),
    var senseVoice: OfflineSenseVoiceModelConfig = OfflineSenseVoiceModelConfig(),
    var dolphin: OfflineDolphinModelConfig = OfflineDolphinModelConfig(),
    var zipformerCtc: OfflineZipformerCtcModelConfig = OfflineZipformerCtcModelConfig(),
    var wenetCtc: OfflineWenetCtcModelConfig = OfflineWenetCtcModelConfig(),
    var omnilingual: OfflineOmnilingualAsrCtcModelConfig = OfflineOmnilingualAsrCtcModelConfig(),
    var medasr: OfflineMedAsrCtcModelConfig = OfflineMedAsrCtcModelConfig(),
    var funasrNano: OfflineFunAsrNanoModelConfig = OfflineFunAsrNanoModelConfig(),
    var canary: OfflineCanaryModelConfig = OfflineCanaryModelConfig(),
    var teleSpeech: String = "",
    var numThreads: Int = 1,
    var debug: Boolean = false,
    var provider: String = "cpu",
    var modelType: String = "",
    var tokens: String = "",
    var modelingUnit: String = "",
    var bpeVocab: String = "",
)

data class OfflineRecognizerConfig(
    var featConfig: FeatureConfig = FeatureConfig(),
    var modelConfig: OfflineModelConfig = OfflineModelConfig(),
    // var lmConfig: OfflineLMConfig(), // TODO(fangjun): enable it
    var hr: HomophoneReplacerConfig = HomophoneReplacerConfig(),
    var decodingMethod: String = "greedy_search",
    var maxActivePaths: Int = 4,
    var hotwordsFile: String = "",
    var hotwordsScore: Float = 1.5f,
    var ruleFsts: String = "",
    var ruleFars: String = "",
    var blankPenalty: Float = 0.0f,
)

class OfflineRecognizer(
    assetManager: AssetManager? = null,
    val config: OfflineRecognizerConfig,
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

    fun getResult(stream: OfflineStream): OfflineRecognizerResult {
        return getResult(stream.ptr)
    }

    fun decode(stream: OfflineStream) = decode(ptr, stream.ptr)

    fun setConfig(config: OfflineRecognizerConfig) = setConfig(ptr, config)

    private external fun delete(ptr: Long)

    private external fun createStream(ptr: Long): Long

    private external fun setConfig(ptr: Long, config: OfflineRecognizerConfig)

    private external fun newFromAsset(
        assetManager: AssetManager,
        config: OfflineRecognizerConfig,
    ): Long

    private external fun newFromFile(
        config: OfflineRecognizerConfig,
    ): Long

    private external fun decode(ptr: Long, streamPtr: Long)

    private external fun getResult(streamPtr: Long): OfflineRecognizerResult

    companion object {
        init {
            System.loadLibrary("sherpa-onnx-jni")
        }

        @JvmStatic
        external fun prependAdspLibraryPath(newPath: String) // for qnn
    }
}

/*
Please see
https://k2-fsa.github.io/sherpa/onnx/pretrained_models/index.html
for a list of pre-trained models.

We only add a few here. Please change the following code
to add your own. (It should be straightforward to add a new model
by following the code)

@param type

0 - csukuangfj/sherpa-onnx-paraformer-zh-2023-09-14 (Chinese)
    https://k2-fsa.github.io/sherpa/onnx/pretrained_models/offline-paraformer/paraformer-models.html#csukuangfj-sherpa-onnx-paraformer-zh-2023-09-14-chinese
    int8

1 - icefall-asr-multidataset-pruned_transducer_stateless7-2023-05-04 (English)
    https://k2-fsa.github.io/sherpa/onnx/pretrained_models/offline-transducer/zipformer-transducer-models.html#icefall-asr-multidataset-pruned-transducer-stateless7-2023-05-04-english
    encoder int8, decoder/joiner float32

2 - sherpa-onnx-whisper-tiny.en
    https://k2-fsa.github.io/sherpa/onnx/pretrained_models/whisper/tiny.en.html#tiny-en
    encoder int8, decoder int8

3 - sherpa-onnx-whisper-base.en
    https://k2-fsa.github.io/sherpa/onnx/pretrained_models/whisper/tiny.en.html#tiny-en
    encoder int8, decoder int8

4 - pkufool/icefall-asr-zipformer-wenetspeech-20230615 (Chinese)
    https://k2-fsa.github.io/sherpa/onnx/pretrained_models/offline-transducer/zipformer-transducer-models.html#pkufool-icefall-asr-zipformer-wenetspeech-20230615-chinese
    encoder/joiner int8, decoder fp32

 */
fun getOfflineModelConfig(type: Int): OfflineModelConfig? {
    when (type) {
        0 -> {
            val modelDir = "sherpa-onnx-paraformer-zh-2023-09-14"
            return OfflineModelConfig(
                paraformer = OfflineParaformerModelConfig(
                    model = "$modelDir/model.int8.onnx",
                ),
                tokens = "$modelDir/tokens.txt",
                modelType = "paraformer",
            )
        }

        1 -> {
            val modelDir = "icefall-asr-multidataset-pruned_transducer_stateless7-2023-05-04"
            return OfflineModelConfig(
                transducer = OfflineTransducerModelConfig(
                    encoder = "$modelDir/encoder-epoch-30-avg-4.int8.onnx",
                    decoder = "$modelDir/decoder-epoch-30-avg-4.onnx",
                    joiner = "$modelDir/joiner-epoch-30-avg-4.onnx",
                ),
                tokens = "$modelDir/tokens.txt",
                modelType = "transducer",
            )
        }

        2 -> {
            val modelDir = "sherpa-onnx-whisper-tiny.en"
            return OfflineModelConfig(
                whisper = OfflineWhisperModelConfig(
                    encoder = "$modelDir/tiny.en-encoder.int8.onnx",
                    decoder = "$modelDir/tiny.en-decoder.int8.onnx",
                ),
                tokens = "$modelDir/tiny.en-tokens.txt",
                modelType = "whisper",
            )
        }

        3 -> {
            val modelDir = "sherpa-onnx-whisper-base.en"
            return OfflineModelConfig(
                whisper = OfflineWhisperModelConfig(
                    encoder = "$modelDir/base.en-encoder.int8.onnx",
                    decoder = "$modelDir/base.en-decoder.int8.onnx",
                ),
                tokens = "$modelDir/base.en-tokens.txt",
                modelType = "whisper",
            )
        }


        4 -> {
            val modelDir = "icefall-asr-zipformer-wenetspeech-20230615"
            return OfflineModelConfig(
                transducer = OfflineTransducerModelConfig(
                    encoder = "$modelDir/encoder-epoch-12-avg-4.int8.onnx",
                    decoder = "$modelDir/decoder-epoch-12-avg-4.onnx",
                    joiner = "$modelDir/joiner-epoch-12-avg-4.int8.onnx",
                ),
                tokens = "$modelDir/tokens.txt",
                modelType = "transducer",
            )
        }

        5 -> {
            val modelDir = "sherpa-onnx-zipformer-multi-zh-hans-2023-9-2"
            return OfflineModelConfig(
                transducer = OfflineTransducerModelConfig(
                    encoder = "$modelDir/encoder-epoch-20-avg-1.int8.onnx",
                    decoder = "$modelDir/decoder-epoch-20-avg-1.onnx",
                    joiner = "$modelDir/joiner-epoch-20-avg-1.int8.onnx",
                ),
                tokens = "$modelDir/tokens.txt",
                modelType = "transducer",
            )
        }

        6 -> {
            val modelDir = "sherpa-onnx-nemo-ctc-en-citrinet-512"
            return OfflineModelConfig(
                nemo = OfflineNemoEncDecCtcModelConfig(
                    model = "$modelDir/model.int8.onnx",
                ),
                tokens = "$modelDir/tokens.txt",
            )
        }

        7 -> {
            val modelDir = "sherpa-onnx-nemo-fast-conformer-ctc-be-de-en-es-fr-hr-it-pl-ru-uk-20k"
            return OfflineModelConfig(
                nemo = OfflineNemoEncDecCtcModelConfig(
                    model = "$modelDir/model.onnx",
                ),
                tokens = "$modelDir/tokens.txt",
            )
        }

        8 -> {
            val modelDir = "sherpa-onnx-nemo-fast-conformer-ctc-en-24500"
            return OfflineModelConfig(
                nemo = OfflineNemoEncDecCtcModelConfig(
                    model = "$modelDir/model.onnx",
                ),
                tokens = "$modelDir/tokens.txt",
            )
        }

        9 -> {
            val modelDir = "sherpa-onnx-nemo-fast-conformer-ctc-en-de-es-fr-14288"
            return OfflineModelConfig(
                nemo = OfflineNemoEncDecCtcModelConfig(
                    model = "$modelDir/model.onnx",
                ),
                tokens = "$modelDir/tokens.txt",
            )
        }

        10 -> {
            val modelDir = "sherpa-onnx-nemo-fast-conformer-ctc-es-1424"
            return OfflineModelConfig(
                nemo = OfflineNemoEncDecCtcModelConfig(
                    model = "$modelDir/model.onnx",
                ),
                tokens = "$modelDir/tokens.txt",
            )
        }

        11 -> {
            val modelDir = "sherpa-onnx-telespeech-ctc-int8-zh-2024-06-04"
            return OfflineModelConfig(
                teleSpeech = "$modelDir/model.int8.onnx",
                tokens = "$modelDir/tokens.txt",
                modelType = "telespeech_ctc",
            )
        }

        12 -> {
            val modelDir = "sherpa-onnx-zipformer-thai-2024-06-20"
            return OfflineModelConfig(
                transducer = OfflineTransducerModelConfig(
                    encoder = "$modelDir/encoder-epoch-12-avg-5.int8.onnx",
                    decoder = "$modelDir/decoder-epoch-12-avg-5.onnx",
                    joiner = "$modelDir/joiner-epoch-12-avg-5.int8.onnx",
                ),
                tokens = "$modelDir/tokens.txt",
                modelType = "transducer",
            )
        }

        13 -> {
            val modelDir = "sherpa-onnx-zipformer-korean-2024-06-24"
            return OfflineModelConfig(
                transducer = OfflineTransducerModelConfig(
                    encoder = "$modelDir/encoder-epoch-99-avg-1.int8.onnx",
                    decoder = "$modelDir/decoder-epoch-99-avg-1.onnx",
                    joiner = "$modelDir/joiner-epoch-99-avg-1.int8.onnx",
                ),
                tokens = "$modelDir/tokens.txt",
                modelType = "transducer",
            )
        }

        14 -> {
            val modelDir = "sherpa-onnx-paraformer-zh-small-2024-03-09"
            return OfflineModelConfig(
                paraformer = OfflineParaformerModelConfig(
                    model = "$modelDir/model.int8.onnx",
                ),
                tokens = "$modelDir/tokens.txt",
                modelType = "paraformer",
            )
        }

        15 -> {
            val modelDir = "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17"
            return OfflineModelConfig(
                senseVoice = OfflineSenseVoiceModelConfig(
                    model = "$modelDir/model.int8.onnx",
                ),
                tokens = "$modelDir/tokens.txt",
            )
        }

        16 -> {
            val modelDir = "sherpa-onnx-zipformer-ja-reazonspeech-2024-08-01"
            return OfflineModelConfig(
                transducer = OfflineTransducerModelConfig(
                    encoder = "$modelDir/encoder-epoch-99-avg-1.int8.onnx",
                    decoder = "$modelDir/decoder-epoch-99-avg-1.onnx",
                    joiner = "$modelDir/joiner-epoch-99-avg-1.int8.onnx",
                ),
                tokens = "$modelDir/tokens.txt",
                modelType = "transducer",
            )
        }

        17 -> {
            val modelDir = "sherpa-onnx-zipformer-ru-2024-09-18"
            return OfflineModelConfig(
                transducer = OfflineTransducerModelConfig(
                    encoder = "$modelDir/encoder.int8.onnx",
                    decoder = "$modelDir/decoder.onnx",
                    joiner = "$modelDir/joiner.int8.onnx",
                ),
                tokens = "$modelDir/tokens.txt",
                modelType = "transducer",
            )
        }

        18 -> {
            val modelDir = "sherpa-onnx-small-zipformer-ru-2024-09-18"
            return OfflineModelConfig(
                transducer = OfflineTransducerModelConfig(
                    encoder = "$modelDir/encoder.int8.onnx",
                    decoder = "$modelDir/decoder.onnx",
                    joiner = "$modelDir/joiner.int8.onnx",
                ),
                tokens = "$modelDir/tokens.txt",
                modelType = "transducer",
            )
        }

        19 -> {
            val modelDir = "sherpa-onnx-nemo-ctc-giga-am-russian-2024-10-24"
            return OfflineModelConfig(
                nemo = OfflineNemoEncDecCtcModelConfig(
                    model = "$modelDir/model.int8.onnx",
                ),
                tokens = "$modelDir/tokens.txt",
            )
        }

        20 -> {
            val modelDir = "sherpa-onnx-nemo-transducer-giga-am-russian-2024-10-24"
            return OfflineModelConfig(
                transducer = OfflineTransducerModelConfig(
                    encoder = "$modelDir/encoder.int8.onnx",
                    decoder = "$modelDir/decoder.onnx",
                    joiner = "$modelDir/joiner.onnx",
                ),
                tokens = "$modelDir/tokens.txt",
                modelType = "nemo_transducer",
            )
        }

        21 -> {
            val modelDir = "sherpa-onnx-moonshine-tiny-en-int8"
            return OfflineModelConfig(
                moonshine = OfflineMoonshineModelConfig(
                    preprocessor = "$modelDir/preprocess.onnx",
                    encoder = "$modelDir/encode.int8.onnx",
                    uncachedDecoder = "$modelDir/uncached_decode.int8.onnx",
                    cachedDecoder = "$modelDir/cached_decode.int8.onnx",
                ),
                tokens = "$modelDir/tokens.txt",
            )
        }

        22 -> {
            val modelDir = "sherpa-onnx-moonshine-base-en-int8"
            return OfflineModelConfig(
                moonshine = OfflineMoonshineModelConfig(
                    preprocessor = "$modelDir/preprocess.onnx",
                    encoder = "$modelDir/encode.int8.onnx",
                    uncachedDecoder = "$modelDir/uncached_decode.int8.onnx",
                    cachedDecoder = "$modelDir/cached_decode.int8.onnx",
                ),
                tokens = "$modelDir/tokens.txt",
            )
        }

        23 -> {
            val modelDir = "sherpa-onnx-zipformer-zh-en-2023-11-22"
            return OfflineModelConfig(
                transducer = OfflineTransducerModelConfig(
                    encoder = "$modelDir/encoder-epoch-34-avg-19.int8.onnx",
                    decoder = "$modelDir/decoder-epoch-34-avg-19.onnx",
                    joiner = "$modelDir/joiner-epoch-34-avg-19.int8.onnx",
                ),
                tokens = "$modelDir/tokens.txt",
                modelType = "transducer",
            )
        }

        24 -> {
            val modelDir = "sherpa-onnx-fire-red-asr-large-zh_en-2025-02-16"
            return OfflineModelConfig(
                fireRedAsr = OfflineFireRedAsrModelConfig(
                    encoder = "$modelDir/encoder.int8.onnx",
                    decoder = "$modelDir/decoder.int8.onnx",
                ),
                tokens = "$modelDir/tokens.txt",
            )
        }

        25 -> {
            val modelDir = "sherpa-onnx-dolphin-base-ctc-multi-lang-int8-2025-04-02"
            return OfflineModelConfig(
                dolphin = OfflineDolphinModelConfig(
                    model = "$modelDir/model.int8.onnx",
                ),
                tokens = "$modelDir/tokens.txt",
            )
        }

        26 -> {
            val modelDir = "sherpa-onnx-zipformer-vi-int8-2025-04-20"
            return OfflineModelConfig(
                transducer = OfflineTransducerModelConfig(
                    encoder = "$modelDir/encoder-epoch-12-avg-8.int8.onnx",
                    decoder = "$modelDir/decoder-epoch-12-avg-8.onnx",
                    joiner = "$modelDir/joiner-epoch-12-avg-8.int8.onnx",
                ),
                tokens = "$modelDir/tokens.txt",
                modelType = "transducer",
            )
        }

        27 -> {
            val modelDir = "sherpa-onnx-nemo-ctc-giga-am-v2-russian-2025-04-19"
            return OfflineModelConfig(
                nemo = OfflineNemoEncDecCtcModelConfig(
                    model = "$modelDir/model.int8.onnx",
                ),
                tokens = "$modelDir/tokens.txt",
            )
        }

        28 -> {
            val modelDir = "sherpa-onnx-nemo-transducer-giga-am-v2-russian-2025-04-19"
            return OfflineModelConfig(
                transducer = OfflineTransducerModelConfig(
                    encoder = "$modelDir/encoder.int8.onnx",
                    decoder = "$modelDir/decoder.onnx",
                    joiner = "$modelDir/joiner.onnx",
                ),
                tokens = "$modelDir/tokens.txt",
                modelType = "nemo_transducer",
            )
        }

        29 -> {
            val modelDir = "sherpa-onnx-zipformer-ru-int8-2025-04-20"
            return OfflineModelConfig(
                transducer = OfflineTransducerModelConfig(
                    encoder = "$modelDir/encoder.int8.onnx",
                    decoder = "$modelDir/decoder.onnx",
                    joiner = "$modelDir/joiner.int8.onnx",
                ),
                tokens = "$modelDir/tokens.txt",
                modelType = "transducer",
            )
        }

        30 -> {
            val modelDir = "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8"
            return OfflineModelConfig(
                transducer = OfflineTransducerModelConfig(
                    encoder = "$modelDir/encoder.int8.onnx",
                    decoder = "$modelDir/decoder.int8.onnx",
                    joiner = "$modelDir/joiner.int8.onnx",
                ),
                tokens = "$modelDir/tokens.txt",
                modelType = "nemo_transducer",
            )
        }

        31 -> {
            val modelDir = "sherpa-onnx-zipformer-ctc-zh-int8-2025-07-03"
            return OfflineModelConfig(
                zipformerCtc = OfflineZipformerCtcModelConfig(
                    model = "$modelDir/model.int8.onnx",
                ),
                tokens = "$modelDir/tokens.txt",
            )
        }

        32 -> {
            val modelDir = "sherpa-onnx-nemo-canary-180m-flash-en-es-de-fr-int8"
            return OfflineModelConfig(
                canary = OfflineCanaryModelConfig(
                    encoder = "$modelDir/encoder.int8.onnx",
                    decoder = "$modelDir/decoder.int8.onnx",
                    srcLang = "en",
                    tgtLang = "en",
                    usePnc = true,
                ),
                tokens = "$modelDir/tokens.txt",
            )
        }

        33 -> {
            val modelDir = "sherpa-onnx-nemo-parakeet_tdt_ctc_110m-en-36000-int8"
            return OfflineModelConfig(
                nemo = OfflineNemoEncDecCtcModelConfig(
                    model = "$modelDir/model.int8.onnx",
                ),
                tokens = "$modelDir/tokens.txt",
            )
        }

        34 -> {
            val modelDir = "sherpa-onnx-nemo-parakeet-tdt_ctc-0.6b-ja-35000-int8"
            return OfflineModelConfig(
                nemo = OfflineNemoEncDecCtcModelConfig(
                    model = "$modelDir/model.int8.onnx",
                ),
                tokens = "$modelDir/tokens.txt",
            )
        }

        35 -> {
            val modelDir = "sherpa-onnx-nemo-transducer-stt_pt_fastconformer_hybrid_large_pc-int8"
            return OfflineModelConfig(
                transducer = OfflineTransducerModelConfig(
                    encoder = "$modelDir/encoder.int8.onnx",
                    decoder = "$modelDir/decoder.int8.onnx",
                    joiner = "$modelDir/joiner.int8.onnx",
                ),
                tokens = "$modelDir/tokens.txt",
                modelType = "nemo_transducer",
            )
        }

        36 -> {
            val modelDir = "sherpa-onnx-nemo-stt_pt_fastconformer_hybrid_large_pc-int8"
            return OfflineModelConfig(
                nemo = OfflineNemoEncDecCtcModelConfig(
                    model = "$modelDir/model.int8.onnx",
                ),
                tokens = "$modelDir/tokens.txt",
            )
        }

        37 -> {
            val modelDir = "sherpa-onnx-nemo-transducer-stt_de_fastconformer_hybrid_large_pc-int8"
            return OfflineModelConfig(
                transducer = OfflineTransducerModelConfig(
                    encoder = "$modelDir/encoder.int8.onnx",
                    decoder = "$modelDir/decoder.int8.onnx",
                    joiner = "$modelDir/joiner.int8.onnx",
                ),
                tokens = "$modelDir/tokens.txt",
                modelType = "nemo_transducer",
            )
        }

        38 -> {
            val modelDir = "sherpa-onnx-nemo-stt_de_fastconformer_hybrid_large_pc-int8"
            return OfflineModelConfig(
                nemo = OfflineNemoEncDecCtcModelConfig(
                    model = "$modelDir/model.int8.onnx",
                ),
                tokens = "$modelDir/tokens.txt",
            )
        }

        39 -> {
            val modelDir = "sherpa-onnx-zipformer-ctc-small-zh-int8-2025-07-16"
            return OfflineModelConfig(
                zipformerCtc = OfflineZipformerCtcModelConfig(
                    model = "$modelDir/model.int8.onnx",
                ),
                tokens = "$modelDir/tokens.txt",
            )
        }

        40 -> {
            val modelDir = "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8"
            return OfflineModelConfig(
                transducer = OfflineTransducerModelConfig(
                    encoder = "$modelDir/encoder.int8.onnx",
                    decoder = "$modelDir/decoder.int8.onnx",
                    joiner = "$modelDir/joiner.int8.onnx",
                ),
                tokens = "$modelDir/tokens.txt",
                modelType = "nemo_transducer",
            )
        }

        41 -> {
            val modelDir = "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09"
            return OfflineModelConfig(
                senseVoice = OfflineSenseVoiceModelConfig(
                    model = "$modelDir/model.int8.onnx",
                ),
                tokens = "$modelDir/tokens.txt",
            )
        }

        42 -> {
            val modelDir =
                "sherpa-onnx-wenetspeech-yue-u2pp-conformer-ctc-zh-en-cantonese-int8-2025-09-10"
            return OfflineModelConfig(
                wenetCtc = OfflineWenetCtcModelConfig(
                    model = "$modelDir/model.int8.onnx",
                ),
                tokens = "$modelDir/tokens.txt",
            )
        }

        43 -> {
            val modelDir = "sherpa-onnx-paraformer-zh-int8-2025-10-07"
            return OfflineModelConfig(
                paraformer = OfflineParaformerModelConfig(
                    model = "$modelDir/model.int8.onnx",
                ),
                tokens = "$modelDir/tokens.txt",
                modelType = "paraformer",
            )
        }

        44 -> {
            val modelDir = "sherpa-onnx-omnilingual-asr-1600-languages-300M-ctc-int8-2025-11-12"
            return OfflineModelConfig(
                omnilingual = OfflineOmnilingualAsrCtcModelConfig(
                    model = "$modelDir/model.int8.onnx",
                ),
                tokens = "$modelDir/tokens.txt",
            )
        }

        45 -> {
            val modelDir = "sherpa-onnx-medasr-ctc-en-int8-2025-12-25"
            return OfflineModelConfig(
                medasr = OfflineMedAsrCtcModelConfig(
                    model = "$modelDir/model.int8.onnx",
                ),
                tokens = "$modelDir/tokens.txt",
            )
        }

        46 -> {
            val modelDir = "sherpa-onnx-funasr-nano-int8-2025-12-30"
            return OfflineModelConfig(
                funasrNano = OfflineFunAsrNanoModelConfig(
                    encoderAdaptor = "$modelDir/encoder_adaptor.int8.onnx",
                    llm = "$modelDir/llm.int8.onnx",
                    embedding = "$modelDir/embedding.int8.onnx",
                    tokenizer = "$modelDir/Qwen3-0.6B",
                ),
                tokens = "",
            )
        }

        47 -> {
            val modelDir = "sherpa-onnx-wenetspeech-wu-u2pp-conformer-ctc-zh-int8-2026-02-03"
            return OfflineModelConfig(
                wenetCtc = OfflineWenetCtcModelConfig(
                    model = "$modelDir/model.int8.onnx",
                ),
                tokens = "$modelDir/tokens.txt",
            )
        }

        48 -> {
            val modelDir = "sherpa-onnx-wenetspeech-wu-u2pp-conformer-ctc-zh-2026-02-03"
            return OfflineModelConfig(
                wenetCtc = OfflineWenetCtcModelConfig(
                    model = "$modelDir/model.onnx",
                ),
                tokens = "$modelDir/tokens.txt",
            )
        }

        49 -> {
            val modelDir = "sherpa-onnx-zipformer-vi-30M-int8-2026-02-09"
            return OfflineModelConfig(
                transducer = OfflineTransducerModelConfig(
                    encoder = "$modelDir/encoder.int8.onnx",
                    decoder = "$modelDir/decoder.onnx",
                    joiner = "$modelDir/joiner.int8.onnx",
                ),
                tokens = "$modelDir/tokens.txt",
                modelType = "transducer",
            )
        }

        9000 -> {
            val modelDir =
                "sherpa-onnx-qnn-5-seconds-sense-voice-zh-en-ja-ko-yue-2024-07-17-int8-android-aarch64"
            return OfflineModelConfig(
                provider = "qnn",
                senseVoice = OfflineSenseVoiceModelConfig(
                    model = "$modelDir/libmodel.so",
                    qnnConfig = QnnConfig(
                        // Please copy libQnnHtp.so and libQnnSystem.so to jniLibs/arm64-v8a by yourself
                        //
                        // model.bin is created in the first run and is used from the second run
                        // to speed up the initialization
                        backendLib = "libQnnHtp.so",
                        systemLib = "libQnnSystem.so",
                        contextBinary = "$modelDir/model.bin",
                    ),
                ),
                tokens = "$modelDir/tokens.txt",
                debug = true,
            )
        }

        9001 -> {
            val modelDir =
                "sherpa-onnx-qnn-8-seconds-sense-voice-zh-en-ja-ko-yue-2024-07-17-int8-android-aarch64"
            return OfflineModelConfig(
                provider = "qnn",
                senseVoice = OfflineSenseVoiceModelConfig(
                    model = "$modelDir/libmodel.so",
                    qnnConfig = QnnConfig(
                        backendLib = "libQnnHtp.so",
                        systemLib = "libQnnSystem.so",
                        contextBinary = "$modelDir/model.bin",
                    ),
                ),
                tokens = "$modelDir/tokens.txt",
                debug = true,
            )
        }

        9002 -> {
            val modelDir =
                "sherpa-onnx-qnn-10-seconds-sense-voice-zh-en-ja-ko-yue-2024-07-17-int8-android-aarch64"
            return OfflineModelConfig(
                provider = "qnn",
                senseVoice = OfflineSenseVoiceModelConfig(
                    model = "$modelDir/libmodel.so",
                    qnnConfig = QnnConfig(
                        backendLib = "libQnnHtp.so",
                        systemLib = "libQnnSystem.so",
                        contextBinary = "$modelDir/model.bin",
                    ),
                ),
                tokens = "$modelDir/tokens.txt",
                debug = true,
            )
        }

        9003 -> {
            val modelDir =
                "sherpa-onnx-qnn-13-seconds-sense-voice-zh-en-ja-ko-yue-2024-07-17-int8-android-aarch64"
            return OfflineModelConfig(
                provider = "qnn",
                senseVoice = OfflineSenseVoiceModelConfig(
                    model = "$modelDir/libmodel.so",
                    qnnConfig = QnnConfig(
                        backendLib = "libQnnHtp.so",
                        systemLib = "libQnnSystem.so",
                        contextBinary = "$modelDir/model.bin",
                    ),
                ),
                tokens = "$modelDir/tokens.txt",
            )
        }

        9004 -> {
            val modelDir =
                "sherpa-onnx-qnn-15-seconds-sense-voice-zh-en-ja-ko-yue-2024-07-17-int8-android-aarch64"
            return OfflineModelConfig(
                provider = "qnn",
                senseVoice = OfflineSenseVoiceModelConfig(
                    model = "$modelDir/libmodel.so",
                    qnnConfig = QnnConfig(
                        backendLib = "libQnnHtp.so",
                        systemLib = "libQnnSystem.so",
                        contextBinary = "$modelDir/model.bin",
                    ),
                ),
                tokens = "$modelDir/tokens.txt",
            )
        }

        9005 -> {
            val modelDir =
                "sherpa-onnx-qnn-18-seconds-sense-voice-zh-en-ja-ko-yue-2024-07-17-int8-android-aarch64"
            return OfflineModelConfig(
                provider = "qnn",
                senseVoice = OfflineSenseVoiceModelConfig(
                    model = "$modelDir/libmodel.so",
                    qnnConfig = QnnConfig(
                        backendLib = "libQnnHtp.so",
                        systemLib = "libQnnSystem.so",
                        contextBinary = "$modelDir/model.bin",
                    ),
                ),
                tokens = "$modelDir/tokens.txt",
            )
        }

        9006 -> {
            val modelDir =
                "sherpa-onnx-qnn-20-seconds-sense-voice-zh-en-ja-ko-yue-2024-07-17-int8-android-aarch64"
            return OfflineModelConfig(
                provider = "qnn",
                senseVoice = OfflineSenseVoiceModelConfig(
                    model = "$modelDir/libmodel.so",
                    qnnConfig = QnnConfig(
                        backendLib = "libQnnHtp.so",
                        systemLib = "libQnnSystem.so",
                        contextBinary = "$modelDir/model.bin",
                    ),
                ),
                tokens = "$modelDir/tokens.txt",
            )
        }

        9007 -> {
            val modelDir =
                "sherpa-onnx-qnn-23-seconds-sense-voice-zh-en-ja-ko-yue-2024-07-17-int8-android-aarch64"
            return OfflineModelConfig(
                provider = "qnn",
                senseVoice = OfflineSenseVoiceModelConfig(
                    model = "$modelDir/libmodel.so",
                    qnnConfig = QnnConfig(
                        backendLib = "libQnnHtp.so",
                        systemLib = "libQnnSystem.so",
                        contextBinary = "$modelDir/model.bin",
                    ),
                ),
                tokens = "$modelDir/tokens.txt",
            )
        }

        9008 -> {
            val modelDir =
                "sherpa-onnx-qnn-25-seconds-sense-voice-zh-en-ja-ko-yue-2024-07-17-int8-android-aarch64"
            return OfflineModelConfig(
                provider = "qnn",
                senseVoice = OfflineSenseVoiceModelConfig(
                    model = "$modelDir/libmodel.so",
                    qnnConfig = QnnConfig(
                        backendLib = "libQnnHtp.so",
                        systemLib = "libQnnSystem.so",
                        contextBinary = "$modelDir/model.bin",
                    ),
                ),
                tokens = "$modelDir/tokens.txt",
            )
        }

        9009 -> {
            val modelDir =
                "sherpa-onnx-qnn-28-seconds-sense-voice-zh-en-ja-ko-yue-2024-07-17-int8-android-aarch64"
            return OfflineModelConfig(
                provider = "qnn",
                senseVoice = OfflineSenseVoiceModelConfig(
                    model = "$modelDir/libmodel.so",
                    qnnConfig = QnnConfig(
                        backendLib = "libQnnHtp.so",
                        systemLib = "libQnnSystem.so",
                        contextBinary = "$modelDir/model.bin",
                    ),
                ),
                tokens = "$modelDir/tokens.txt",
            )
        }

        9010 -> {
            val modelDir =
                "sherpa-onnx-qnn-30-seconds-sense-voice-zh-en-ja-ko-yue-2024-07-17-int8-android-aarch64"
            return OfflineModelConfig(
                provider = "qnn",
                senseVoice = OfflineSenseVoiceModelConfig(
                    model = "$modelDir/libmodel.so",
                    qnnConfig = QnnConfig(
                        backendLib = "libQnnHtp.so",
                        systemLib = "libQnnSystem.so",
                        contextBinary = "$modelDir/model.bin",
                    ),
                ),
                tokens = "$modelDir/tokens.txt",
            )
        }

        9011 -> {
            val modelDir =
                "sherpa-onnx-qnn-5-seconds-zipformer-ctc-zh-2025-07-03-int8-android-aarch64"
            return OfflineModelConfig(
                provider = "qnn",
                zipformerCtc = OfflineZipformerCtcModelConfig(
                    model = "$modelDir/libmodel.so",
                    qnnConfig = QnnConfig(
                        backendLib = "libQnnHtp.so",
                        systemLib = "libQnnSystem.so",
                        contextBinary = "$modelDir/model.bin",
                    ),
                ),
                tokens = "$modelDir/tokens.txt",
                debug = true,
            )
        }

        9012 -> {
            val modelDir =
                "sherpa-onnx-qnn-8-seconds-zipformer-ctc-zh-2025-07-03-int8-android-aarch64"
            return OfflineModelConfig(
                provider = "qnn",
                zipformerCtc = OfflineZipformerCtcModelConfig(
                    model = "$modelDir/libmodel.so",
                    qnnConfig = QnnConfig(
                        backendLib = "libQnnHtp.so",
                        systemLib = "libQnnSystem.so",
                        contextBinary = "$modelDir/model.bin",
                    ),
                ),
                tokens = "$modelDir/tokens.txt",
                debug = true,
            )
        }

        9013 -> {
            val modelDir =
                "sherpa-onnx-qnn-10-seconds-zipformer-ctc-zh-2025-07-03-int8-android-aarch64"
            return OfflineModelConfig(
                provider = "qnn",
                zipformerCtc = OfflineZipformerCtcModelConfig(
                    model = "$modelDir/libmodel.so",
                    qnnConfig = QnnConfig(
                        backendLib = "libQnnHtp.so",
                        systemLib = "libQnnSystem.so",
                        contextBinary = "$modelDir/model.bin",
                    ),
                ),
                tokens = "$modelDir/tokens.txt",
                debug = true,
            )
        }

        9014 -> {
            val modelDir =
                "sherpa-onnx-qnn-13-seconds-zipformer-ctc-zh-2025-07-03-int8-android-aarch64"
            return OfflineModelConfig(
                provider = "qnn",
                zipformerCtc = OfflineZipformerCtcModelConfig(
                    model = "$modelDir/libmodel.so",
                    qnnConfig = QnnConfig(
                        backendLib = "libQnnHtp.so",
                        systemLib = "libQnnSystem.so",
                        contextBinary = "$modelDir/model.bin",
                    ),
                ),
                tokens = "$modelDir/tokens.txt",
            )
        }

        9015 -> {
            val modelDir =
                "sherpa-onnx-qnn-15-seconds-zipformer-ctc-zh-2025-07-03-int8-android-aarch64"
            return OfflineModelConfig(
                provider = "qnn",
                zipformerCtc = OfflineZipformerCtcModelConfig(
                    model = "$modelDir/libmodel.so",
                    qnnConfig = QnnConfig(
                        backendLib = "libQnnHtp.so",
                        systemLib = "libQnnSystem.so",
                        contextBinary = "$modelDir/model.bin",
                    ),
                ),
                tokens = "$modelDir/tokens.txt",
            )
        }

        9016 -> {
            val modelDir =
                "sherpa-onnx-qnn-18-seconds-zipformer-ctc-zh-2025-07-03-int8-android-aarch64"
            return OfflineModelConfig(
                provider = "qnn",
                zipformerCtc = OfflineZipformerCtcModelConfig(
                    model = "$modelDir/libmodel.so",
                    qnnConfig = QnnConfig(
                        backendLib = "libQnnHtp.so",
                        systemLib = "libQnnSystem.so",
                        contextBinary = "$modelDir/model.bin",
                    ),
                ),
                tokens = "$modelDir/tokens.txt",
            )
        }

        9017 -> {
            val modelDir =
                "sherpa-onnx-qnn-20-seconds-zipformer-ctc-zh-2025-07-03-int8-android-aarch64"
            return OfflineModelConfig(
                provider = "qnn",
                zipformerCtc = OfflineZipformerCtcModelConfig(
                    model = "$modelDir/libmodel.so",
                    qnnConfig = QnnConfig(
                        backendLib = "libQnnHtp.so",
                        systemLib = "libQnnSystem.so",
                        contextBinary = "$modelDir/model.bin",
                    ),
                ),
                tokens = "$modelDir/tokens.txt",
            )
        }

        9018 -> {
            val modelDir =
                "sherpa-onnx-qnn-23-seconds-zipformer-ctc-zh-2025-07-03-int8-android-aarch64"
            return OfflineModelConfig(
                provider = "qnn",
                zipformerCtc = OfflineZipformerCtcModelConfig(
                    model = "$modelDir/libmodel.so",
                    qnnConfig = QnnConfig(
                        backendLib = "libQnnHtp.so",
                        systemLib = "libQnnSystem.so",
                        contextBinary = "$modelDir/model.bin",
                    ),
                ),
                tokens = "$modelDir/tokens.txt",
            )
        }

        9019 -> {
            val modelDir =
                "sherpa-onnx-qnn-25-seconds-zipformer-ctc-zh-2025-07-03-int8-android-aarch64"
            return OfflineModelConfig(
                provider = "qnn",
                zipformerCtc = OfflineZipformerCtcModelConfig(
                    model = "$modelDir/libmodel.so",
                    qnnConfig = QnnConfig(
                        backendLib = "libQnnHtp.so",
                        systemLib = "libQnnSystem.so",
                        contextBinary = "$modelDir/model.bin",
                    ),
                ),
                tokens = "$modelDir/tokens.txt",
            )
        }

        9020 -> {
            val modelDir =
                "sherpa-onnx-qnn-28-seconds-zipformer-ctc-zh-2025-07-03-int8-android-aarch64"
            return OfflineModelConfig(
                provider = "qnn",
                zipformerCtc = OfflineZipformerCtcModelConfig(
                    model = "$modelDir/libmodel.so",
                    qnnConfig = QnnConfig(
                        backendLib = "libQnnHtp.so",
                        systemLib = "libQnnSystem.so",
                        contextBinary = "$modelDir/model.bin",
                    ),
                ),
                tokens = "$modelDir/tokens.txt",
            )
        }

        9021 -> {
            val modelDir =
                "sherpa-onnx-qnn-30-seconds-zipformer-ctc-zh-2025-07-03-int8-android-aarch64"
            return OfflineModelConfig(
                provider = "qnn",
                zipformerCtc = OfflineZipformerCtcModelConfig(
                    model = "$modelDir/libmodel.so",
                    qnnConfig = QnnConfig(
                        backendLib = "libQnnHtp.so",
                        systemLib = "libQnnSystem.so",
                        contextBinary = "$modelDir/model.bin",
                    ),
                ),
                tokens = "$modelDir/tokens.txt",
            )
        }

        9022 -> {
            // for Xiaomi 17 Pro
            val modelDir =
                "sherpa-onnx-qnn-SM8850-binary-10-seconds-sense-voice-zh-en-ja-ko-yue-2024-07-17-int8"
            return OfflineModelConfig(
                provider = "qnn",
                senseVoice = OfflineSenseVoiceModelConfig(
                    qnnConfig = QnnConfig(
                        // Please copy libQnnHtp.so and libQnnSystem.so to jniLibs/arm64-v8a by yourself
                        backendLib = "libQnnHtp.so",
                        systemLib = "libQnnSystem.so",
                        contextBinary = "$modelDir/model.bin",
                    ),
                ),
                tokens = "$modelDir/tokens.txt",
                debug = true,
            )
        }

        9023 -> {
            val modelDir = "sherpa-onnx-qnn-5-seconds-paraformer-zh-2023-03-28-int8-android-aarch64"
            return OfflineModelConfig(
                provider = "qnn",
                paraformer = OfflineParaformerModelConfig(
                    model = "$modelDir/libencoder.so,$modelDir/libpredictor.so,$modelDir/libdecoder.so",
                    qnnConfig = QnnConfig(
                        backendLib = "libQnnHtp.so",
                        systemLib = "libQnnSystem.so",
                        // The following three *.bin files are generated during the first run
                        // and are used to replace the corresponding *.so files in later runs
                        contextBinary = "$modelDir/encoder.bin,$modelDir/predictor.bin,$modelDir/decoder.bin",
                    ),
                ),
                tokens = "$modelDir/tokens.txt",
                debug = true,
            )
        }

        9024 -> {
            val modelDir = "sherpa-onnx-qnn-5-seconds-paraformer-zh-2025-10-07-int8-android-aarch64"
            return OfflineModelConfig(
                provider = "qnn",
                paraformer = OfflineParaformerModelConfig(
                    model = "$modelDir/libencoder.so,$modelDir/libpredictor.so,$modelDir/libdecoder.so",
                    qnnConfig = QnnConfig(
                        backendLib = "libQnnHtp.so",
                        systemLib = "libQnnSystem.so",
                        // The following three *.bin files are generated during the first run
                        // and are used to replace the corresponding *.so files in later runs
                        contextBinary = "$modelDir/encoder.bin,$modelDir/predictor.bin,$modelDir/decoder.bin",
                    ),
                ),
                tokens = "$modelDir/tokens.txt",
                debug = true,
            )
        }

        9025 -> {
            // for Xiaomi 17 Pro
            val modelDir = "sherpa-onnx-qnn-SM8850-binary-5-seconds-paraformer-zh-2023-03-28-int8"
            return OfflineModelConfig(
                provider = "qnn",
                paraformer = OfflineParaformerModelConfig(
                    qnnConfig = QnnConfig(
                        backendLib = "libQnnHtp.so",
                        systemLib = "libQnnSystem.so",
                        contextBinary = "$modelDir/encoder.bin,$modelDir/predictor.bin,$modelDir/decoder.bin",
                    ),
                ),
                tokens = "$modelDir/tokens.txt",
                debug = true,
            )
        }
    }
    return null
}
