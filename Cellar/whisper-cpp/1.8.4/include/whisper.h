#ifndef WHISPER_H
#define WHISPER_H

#include "ggml.h"
#include "ggml-cpu.h"

#include <stddef.h>
#include <stdint.h>
#include <stdbool.h>

#ifdef __GNUC__
#    define WHISPER_DEPRECATED(func, hint) func __attribute__((deprecated(hint)))
#elif defined(_MSC_VER)
#    define WHISPER_DEPRECATED(func, hint) __declspec(deprecated(hint)) func
#else
#    define WHISPER_DEPRECATED(func, hint) func
#endif

#ifdef WHISPER_SHARED
#    ifdef _WIN32
#        ifdef WHISPER_BUILD
#            define WHISPER_API __declspec(dllexport)
#        else
#            define WHISPER_API __declspec(dllimport)
#        endif
#    else
#        define WHISPER_API __attribute__ ((visibility ("default")))
#    endif
#else
#    define WHISPER_API
#endif

#define WHISPER_SAMPLE_RATE 16000
#define WHISPER_N_FFT       400
#define WHISPER_HOP_LENGTH  160
#define WHISPER_CHUNK_SIZE  30

#ifdef __cplusplus
extern "C" {
#endif

    //
    // C interface
    //
    // The following interface is thread-safe as long as the sample whisper_context is not used by multiple threads
    // concurrently.
    //
    // Basic usage:
    //
    //     #include "whisper.h"
    //
    //     ...
    //
    //     whisper_context_params cparams = whisper_context_default_params();
    //
    //     struct whisper_context * ctx = whisper_init_from_file_with_params("/path/to/ggml-base.en.bin", cparams);
    //
    //     if (whisper_full(ctx, wparams, pcmf32.data(), pcmf32.size()) != 0) {
    //         fprintf(stderr, "failed to process audio\n");
    //         return 7;
    //     }
    //
    //     const int n_segments = whisper_full_n_segments(ctx);
    //     for (int i = 0; i < n_segments; ++i) {
    //         const char * text = whisper_full_get_segment_text(ctx, i);
    //         printf("%s", text);
    //     }
    //
    //     whisper_free(ctx);
    //
    //     ...
    //
    // This is a demonstration of the most straightforward usage of the library.
    // "pcmf32" contains the RAW audio data in 32-bit floating point format.
    //
    // The interface also allows for more fine-grained control over the computation, but it requires a deeper
    // understanding of how the model works.
    //

    struct whisper_context;
    struct whisper_state;
    struct whisper_full_params;

    typedef int32_t whisper_pos;
    typedef int32_t whisper_token;
    typedef int32_t whisper_seq_id;

    enum whisper_alignment_heads_preset {
        WHISPER_AHEADS_NONE,
        WHISPER_AHEADS_N_TOP_MOST,  // All heads from the N-top-most text-layers
        WHISPER_AHEADS_CUSTOM,
        WHISPER_AHEADS_TINY_EN,
        WHISPER_AHEADS_TINY,
        WHISPER_AHEADS_BASE_EN,
        WHISPER_AHEADS_BASE,
        WHISPER_AHEADS_SMALL_EN,
        WHISPER_AHEADS_SMALL,
        WHISPER_AHEADS_MEDIUM_EN,
        WHISPER_AHEADS_MEDIUM,
        WHISPER_AHEADS_LARGE_V1,
        WHISPER_AHEADS_LARGE_V2,
        WHISPER_AHEADS_LARGE_V3,
        WHISPER_AHEADS_LARGE_V3_TURBO,
    };

    typedef struct whisper_ahead {
        int n_text_layer;
        int n_head;
    } whisper_ahead;

    typedef struct whisper_aheads {
        size_t n_heads;
        const whisper_ahead * heads;
    } whisper_aheads;

    struct whisper_context_params {
        bool  use_gpu;
        bool  flash_attn;
        int   gpu_device;  // CUDA device

        // [EXPERIMENTAL] Token-level timestamps with DTW
        bool dtw_token_timestamps;
        enum whisper_alignment_heads_preset dtw_aheads_preset;

        int dtw_n_top;
        struct whisper_aheads dtw_aheads;

        size_t dtw_mem_size; // TODO: remove
    };

    typedef struct whisper_token_data {
        whisper_token id;  // token id
        whisper_token tid; // forced timestamp token id

        float p;           // probability of the token
        float plog;        // log probability of the token
        float pt;          // probability of the timestamp token
        float ptsum;       // sum of probabilities of all timestamp tokens

        // token-level timestamp data
        // do not use if you haven't computed token-level timestamps
        int64_t t0;        // start time of the token
        int64_t t1;        //   end time of the token

        // [EXPERIMENTAL] Token-level timestamps with DTW
        // do not use if you haven't computed token-level timestamps with dtw
        // Roughly corresponds to the moment in audio in which the token was output
        int64_t t_dtw;

        float vlen;        // voice length of the token
    } whisper_token_data;

    typedef struct whisper_model_loader {
        void * context;

        size_t (*read)(void * ctx, void * output, size_t read_size);
        bool    (*eof)(void * ctx);
        void  (*close)(void * ctx);
    } whisper_model_loader;

    // grammar element type
    enum whisper_gretype {
        // end of rule definition
        WHISPER_GRETYPE_END            = 0,

        // start of alternate definition for rule
        WHISPER_GRETYPE_ALT            = 1,

        // non-terminal element: reference to rule
        WHISPER_GRETYPE_RULE_REF       = 2,

        // terminal element: character (code point)
        WHISPER_GRETYPE_CHAR           = 3,

        // inverse char(s) ([^a], [^a-b] [^abc])
        WHISPER_GRETYPE_CHAR_NOT       = 4,

        // modifies a preceding WHISPER_GRETYPE_CHAR or LLAMA_GRETYPE_CHAR_ALT to
        // be an inclusive range ([a-z])
        WHISPER_GRETYPE_CHAR_RNG_UPPER = 5,

        // modifies a preceding WHISPER_GRETYPE_CHAR or
        // WHISPER_GRETYPE_CHAR_RNG_UPPER to add an alternate char to match ([ab], [a-zA])
        WHISPER_GRETYPE_CHAR_ALT       = 6,
    };

    typedef struct whisper_grammar_element {
        enum whisper_gretype type;
        uint32_t             value; // Unicode code point or rule ID
    } whisper_grammar_element;

    typedef struct whisper_vad_params {
        float threshold;               // Probability threshold to consider as speech.
        int   min_speech_duration_ms;  // Min duration for a valid speech segment.
        int   min_silence_duration_ms; // Min silence duration to consider speech as ended.
        float max_speech_duration_s;   // Max duration of a speech segment before forcing a new segment.
        int   speech_pad_ms;           // Padding added before and after speech segments.
        float samples_overlap;         // Overlap in seconds when copying audio samples from speech segment.
    } whisper_vad_params;

    WHISPER_API const char * whisper_version(void);

    // Various functions for loading a ggml whisper model.
    // Allocate (almost) all memory needed for the model.
    // Return NULL on failure
    WHISPER_API struct whisper_context * whisper_init_from_file_with_params  (const char * path_model,              struct whisper_context_params params);
    WHISPER_API struct whisper_context * whisper_init_from_buffer_with_params(void * buffer, size_t buffer_size,    struct whisper_context_params params);
    WHISPER_API struct whisper_context * whisper_init_with_params            (struct whisper_model_loader * loader, struct whisper_context_params params);

    // These are the same as the above, but the internal state of the context is not allocated automatically
    // It is the responsibility of the caller to allocate the state using whisper_init_state() (#523)
    WHISPER_API struct whisper_context * whisper_init_from_file_with_params_no_state  (const char * path_model,              struct whisper_context_params params);
    WHISPER_API struct whisper_context * whisper_init_from_buffer_with_params_no_state(void * buffer, size_t buffer_size,    struct whisper_context_params params);
    WHISPER_API struct whisper_context * whisper_init_with_params_no_state            (struct whisper_model_loader * loader, struct whisper_context_params params);

    WHISPER_DEPRECATED(
        WHISPER_API struct whisper_context * whisper_init_from_file(const char * path_model),
        "use whisper_init_from_file_with_params instead"
    );
    WHISPER_DEPRECATED(
        WHISPER_API struct whisper_context * whisper_init_from_buffer(void * buffer, size_t buffer_size),
        "use whisper_init_from_buffer_with_params instead"
    );
    WHISPER_DEPRECATED(
        WHISPER_API struct whisper_context * whisper_init(struct whisper_model_loader * loader),
        "use whisper_init_with_params instead"
    );
    WHISPER_DEPRECATED(
        WHISPER_API struct whisper_context * whisper_init_from_file_no_state(const char * path_model),
        "use whisper_init_from_file_with_params_no_state instead"
    );
    WHISPER_DEPRECATED(
        WHISPER_API struct whisper_context * whisper_init_from_buffer_no_state(void * buffer, size_t buffer_size),
        "use whisper_init_from_buffer_with_params_no_state instead"
    );
    WHISPER_DEPRECATED(
        WHISPER_API struct whisper_context * whisper_init_no_state(struct whisper_model_loader * loader),
        "use whisper_init_with_params_no_state instead"
    );

    WHISPER_API struct whisper_state * whisper_init_state(struct whisper_context * ctx);

    // Given a context, enable use of OpenVINO for encode inference.
    // model_path: Optional path to OpenVINO encoder IR model. If set to nullptr,
    //                      the path will be generated from the ggml model path that was passed
    //                      in to whisper_init_from_file. For example, if 'path_model' was
    //                      "/path/to/ggml-base.en.bin", then OpenVINO IR model path will be
    //                      assumed to be "/path/to/ggml-base.en-encoder-openvino.xml".
    // device: OpenVINO device to run inference on ("CPU", "GPU", etc.)
    // cache_dir: Optional cache directory that can speed up init time, especially for
    //                     GPU, by caching compiled 'blobs' there.
    //                     Set to nullptr if not used.
    // Returns 0 on success. If OpenVINO is not enabled in build, this simply returns 1.
    WHISPER_API int whisper_ctx_init_openvino_encoder_with_state(
        struct whisper_context * ctx,
          struct whisper_state * state,
                    const char * model_path,
                    const char * device,
                    const char * cache_dir);

    WHISPER_API int whisper_ctx_init_openvino_encoder(
        struct whisper_context * ctx,
                    const char * model_path,
                    const char * device,
                    const char * cache_dir);

    // Frees all allocated memory
    WHISPER_API void whisper_free      (struct whisper_context * ctx);
    WHISPER_API void whisper_free_state(struct whisper_state * state);
    WHISPER_API void whisper_free_params(struct whisper_full_params * params);
    WHISPER_API void whisper_free_context_params(struct whisper_context_params * params);

    // Convert RAW PCM audio to log mel spectrogram.
    // The resulting spectrogram is stored inside the default state of the provided whisper context.
    // Returns 0 on success
    WHISPER_API int whisper_pcm_to_mel(
            struct whisper_context * ctx,
                       const float * samples,
                               int   n_samples,
                               int   n_threads);

    WHISPER_API int whisper_pcm_to_mel_with_state(
            struct whisper_context * ctx,
              struct whisper_state * state,
                       const float * samples,
                               int   n_samples,
                               int   n_threads);

    // This can be used to set a custom log mel spectrogram inside the default state of the provided whisper context.
    // Use this instead of whisper_pcm_to_mel() if you want to provide your own log mel spectrogram.
    // n_mel must be 80
    // Returns 0 on success
    WHISPER_API int whisper_set_mel(
            struct whisper_context * ctx,
                       const float * data,
                               int   n_len,
                               int   n_mel);

    WHISPER_API int whisper_set_mel_with_state(
            struct whisper_context * ctx,
              struct whisper_state * state,
                       const float * data,
                               int   n_len,
                               int   n_mel);

    // Run the Whisper encoder on the log mel spectrogram stored inside the default state in the provided whisper context.
    // Make sure to call whisper_pcm_to_mel() or whisper_set_mel() first.
    // offset can be used to specify the offset of the first frame in the spectrogram.
    // Returns 0 on success
    WHISPER_API int whisper_encode(
            struct whisper_context * ctx,
                               int   offset,
                               int   n_threads);

    WHISPER_API int whisper_encode_with_state(
            struct whisper_context * ctx,
              struct whisper_state * state,
                               int   offset,
                               int   n_threads);

    // Run the Whisper decoder to obtain the logits and probabilities for the next token.
    // Make sure to call whisper_encode() first.
    // tokens + n_tokens is the provided context for the decoder.
    // n_past is the number of tokens to use from previous decoder calls.
    // Returns 0 on success
    // TODO: add support for multiple decoders
    WHISPER_API int whisper_decode(
            struct whisper_context * ctx,
               const whisper_token * tokens,
                               int   n_tokens,
                               int   n_past,
                               int   n_threads);

    WHISPER_API int whisper_decode_with_state(
            struct whisper_context * ctx,
              struct whisper_state * state,
               const whisper_token * tokens,
                               int   n_tokens,
                               int   n_past,
                               int   n_threads);

    // Convert the provided text into tokens.
    // The tokens pointer must be large enough to hold the resulting tokens.
    // Returns the number of tokens on success, no more than n_max_tokens
    // Returns a negative number on failure - the number of tokens that would have been returned
    // TODO: not sure if correct
    WHISPER_API int whisper_tokenize(
            struct whisper_context * ctx,
                        const char * text,
                     whisper_token * tokens,
                               int   n_max_tokens);

    // Return the number of tokens in the provided text
    // Equivalent to: -whisper_tokenize(ctx, text, NULL, 0)
    int whisper_token_count(struct whisper_context * ctx, const char * text);

    // Largest language id (i.e. number of available languages - 1)
    WHISPER_API int whisper_lang_max_id(void);

    // Return the id of the specified language, returns -1 if not found
    // Examples:
    //   "de" -> 2
    //   "german" -> 2
    WHISPER_API int whisper_lang_id(const char * lang);

    // Return the short string of the specified language id (e.g. 2 -> "de"), returns nullptr if not found
    WHISPER_API const char * whisper_lang_str(int id);

    // Return the short string of the specified language name (e.g. 2 -> "german"), returns nullptr if not found
    WHISPER_API const char * whisper_lang_str_full(int id);

    // Use mel data at offset_ms to try and auto-detect the spoken language
    // Make sure to call whisper_pcm_to_mel() or whisper_set_mel() first
    // Returns the top language id or negative on failure
    // If not null, fills the lang_probs array with the probabilities of all languages
    // The array must be whisper_lang_max_id() + 1 in size
    // ref: https://github.com/openai/whisper/blob/main/whisper/decoding.py#L18-L69
    WHISPER_API int whisper_lang_auto_detect(
            struct whisper_context * ctx,
                               int   offset_ms,
                               int   n_threads,
                             float * lang_probs);

    WHISPER_API int whisper_lang_auto_detect_with_state(
            struct whisper_context * ctx,
              struct whisper_state * state,
                               int   offset_ms,
                               int   n_threads,
                             float * lang_probs);

    WHISPER_API int whisper_n_len           (struct whisper_context * ctx); // mel length
    WHISPER_API int whisper_n_len_from_state(struct whisper_state * state); // mel length
    WHISPER_API int whisper_n_vocab         (struct whisper_context * ctx);
    WHISPER_API int whisper_n_text_ctx      (struct whisper_context * ctx);
    WHISPER_API int whisper_n_audio_ctx     (struct whisper_context * ctx);
    WHISPER_API int whisper_is_multilingual (struct whisper_context * ctx);

    WHISPER_API int whisper_model_n_vocab      (struct whisper_context * ctx);
    WHISPER_API int whisper_model_n_audio_ctx  (struct whisper_context * ctx);
    WHISPER_API int whisper_model_n_audio_state(struct whisper_context * ctx);
    WHISPER_API int whisper_model_n_audio_head (struct whisper_context * ctx);
    WHISPER_API int whisper_model_n_audio_layer(struct whisper_context * ctx);
    WHISPER_API int whisper_model_n_text_ctx   (struct whisper_context * ctx);
    WHISPER_API int whisper_model_n_text_state (struct whisper_context * ctx);
    WHISPER_API int whisper_model_n_text_head  (struct whisper_context * ctx);
    WHISPER_API int whisper_model_n_text_layer (struct whisper_context * ctx);
    WHISPER_API int whisper_model_n_mels       (struct whisper_context * ctx);
    WHISPER_API int whisper_model_ftype        (struct whisper_context * ctx);
    WHISPER_API int whisper_model_type         (struct whisper_context * ctx);

    // Token logits obtained from the last call to whisper_decode()
    // The logits for the last token are stored in the last row
    // Rows: n_tokens
    // Cols: n_vocab
    WHISPER_API float * whisper_get_logits           (struct whisper_context * ctx);
    WHISPER_API float * whisper_get_logits_from_state(struct whisper_state * state);

    // Token Id -> String. Uses the vocabulary in the provided context
    WHISPER_API const char * whisper_token_to_str(struct whisper_context * ctx, whisper_token token);
    WHISPER_API const char * whisper_model_type_readable(struct whisper_context * ctx);


    // Special tokens
    WHISPER_API whisper_token whisper_token_eot (struct whisper_context * ctx);
    WHISPER_API whisper_token whisper_token_sot (struct whisper_context * ctx);
    WHISPER_API whisper_token whisper_token_solm(struct whisper_context * ctx);
    WHISPER_API whisper_token whisper_token_prev(struct whisper_context * ctx);
    WHISPER_API whisper_token whisper_token_nosp(struct whisper_context * ctx);
    WHISPER_API whisper_token whisper_token_not (struct whisper_context * ctx);
    WHISPER_API whisper_token whisper_token_beg (struct whisper_context * ctx);
    WHISPER_API whisper_token whisper_token_lang(struct whisper_context * ctx, int lang_id);

    // Task tokens
    WHISPER_API whisper_token whisper_token_translate (struct whisper_context * ctx);
    WHISPER_API whisper_token whisper_token_transcribe(struct whisper_context * ctx);

    // Performance information from the default state.
    struct whisper_timings {
        float sample_ms;
        float encode_ms;
        float decode_ms;
        float batchd_ms;
        float prompt_ms;
    };
    WHISPER_API struct whisper_timings * whisper_get_timings(struct whisper_context * ctx);
    WHISPER_API void whisper_print_timings(struct whisper_context * ctx);
    WHISPER_API void whisper_reset_timings(struct whisper_context * ctx);

    // Print system information
    WHISPER_API const char * whisper_print_system_info(void);

    ////////////////////////////////////////////////////////////////////////////

    // Available sampling strategies
    enum whisper_sampling_strategy {
        WHISPER_SAMPLING_GREEDY,      // similar to OpenAI's GreedyDecoder
        WHISPER_SAMPLING_BEAM_SEARCH, // similar to OpenAI's BeamSearchDecoder
    };

    // Text segment callback
    // Called on every newly generated text segment
    // Use the whisper_full_...() functions to obtain the text segments
    typedef void (*whisper_new_segment_callback)(struct whisper_context * ctx, struct whisper_state * state, int n_new, void * user_data);

    // Progress callback
    typedef void (*whisper_progress_callback)(struct whisper_context * ctx, struct whisper_state * state, int progress, void * user_data);

    // Encoder begin callback
    // If not NULL, called before the encoder starts
    // If it returns false, the computation is aborted
    typedef bool (*whisper_encoder_begin_callback)(struct whisper_context * ctx, struct whisper_state * state, void * user_data);

    // Logits filter callback
    // Can be used to modify the logits before sampling
    // If not NULL, called after applying temperature to logits
    typedef void (*whisper_logits_filter_callback)(
            struct whisper_context * ctx,
              struct whisper_state * state,
          const whisper_token_data * tokens,
                               int   n_tokens,
                             float * logits,
                              void * user_data);

    // Parameters for the whisper_full() function
    // If you change the order or add new parameters, make sure to update the default values in whisper.cpp:
    // whisper_full_default_params()
    struct whisper_full_params {
        enum whisper_sampling_strategy strategy;

        int n_threads;
        int n_max_text_ctx;     // max tokens to use from past text as prompt for the decoder
        int offset_ms;          // start offset in ms
        int duration_ms;        // audio duration to process in ms

        bool translate;
        bool no_context;        // do not use past transcription (if any) as initial prompt for the decoder
        bool no_timestamps;     // do not generate timestamps
        bool single_segment;    // force single segment output (useful for streaming)
        bool print_special;     // print special tokens (e.g. <SOT>, <EOT>, <BEG>, etc.)
        bool print_progress;    // print progress information
        bool print_realtime;    // print results from within whisper.cpp (avoid it, use callback instead)
        bool print_timestamps;  // print timestamps for each text segment when printing realtime

        // [EXPERIMENTAL] token-level timestamps
        bool  token_timestamps; // enable token-level timestamps
        float thold_pt;         // timestamp token probability threshold (~0.01)
        float thold_ptsum;      // timestamp token sum probability threshold (~0.01)
        int   max_len;          // max segment length in characters
        bool  split_on_word;    // split on word rather than on token (when used with max_len)
        int   max_tokens;       // max tokens per segment (0 = no limit)

        // [EXPERIMENTAL] speed-up techniques
        // note: these can significantly reduce the quality of the output
        bool debug_mode;        // enable debug_mode provides extra info (eg. Dump log_mel)
        int  audio_ctx;         // overwrite the audio context size (0 = use default)

        // [EXPERIMENTAL] [TDRZ] tinydiarize
        bool tdrz_enable;       // enable tinydiarize speaker turn detection

        // A regular expression that matches tokens to suppress
        const char * suppress_regex;

        // tokens to provide to the whisper decoder as initial prompt
        // these are prepended to any existing text context from a previous call
        // use whisper_tokenize() to convert text to tokens
        // maximum of whisper_n_text_ctx()/2 tokens are used (typically 224)
        const char * initial_prompt;
        bool carry_initial_prompt; // if true, always prepend initial_prompt to every decode window (may reduce conditioning on previous text)
        const whisper_token * prompt_tokens;
        int prompt_n_tokens;

        // for auto-detection, set to nullptr, "" or "auto"
        const char * language;
        bool detect_language;

        // common decoding parameters:
        bool suppress_blank; // ref: https://github.com/openai/whisper/blob/f82bc59f5ea234d4b97fb2860842ed38519f7e65/whisper/decoding.py#L89
        bool suppress_nst;   // non-speech tokens, ref: https://github.com/openai/whisper/blob/7858aa9c08d98f75575035ecd6481f462d66ca27/whisper/tokenizer.py#L224-L253

        float temperature;      // initial decoding temperature, ref: https://ai.stackexchange.com/a/32478
        float max_initial_ts;   // ref: https://github.com/openai/whisper/blob/f82bc59f5ea234d4b97fb2860842ed38519f7e65/whisper/decoding.py#L97
        float length_penalty;   // ref: https://github.com/openai/whisper/blob/f82bc59f5ea234d4b97fb2860842ed38519f7e65/whisper/transcribe.py#L267

        // fallback parameters
        // ref: https://github.com/openai/whisper/blob/f82bc59f5ea234d4b97fb2860842ed38519f7e65/whisper/transcribe.py#L274-L278
        float temperature_inc;
        float entropy_thold;    // similar to OpenAI's "compression_ratio_threshold"
        float logprob_thold;
        float no_speech_thold;

        struct {
            int best_of;    // ref: https://github.com/openai/whisper/blob/f82bc59f5ea234d4b97fb2860842ed38519f7e65/whisper/transcribe.py#L264
        } greedy;

        struct {
            int beam_size;  // ref: https://github.com/openai/whisper/blob/f82bc59f5ea234d4b97fb2860842ed38519f7e65/whisper/transcribe.py#L265

            float patience; // TODO: not implemented, ref: https://arxiv.org/pdf/2204.05424.pdf
        } beam_search;

        // called for every newly generated text segment
        whisper_new_segment_callback new_segment_callback;
        void * new_segment_callback_user_data;

        // called on each progress update
        whisper_progress_callback progress_callback;
        void * progress_callback_user_data;

        // called each time before the encoder starts
        whisper_encoder_begin_callback encoder_begin_callback;
        void * encoder_begin_callback_user_data;

        // called each time before ggml computation starts
        ggml_abort_callback abort_callback;
        void * abort_callback_user_data;

        // called by each decoder to filter obtained logits
        whisper_logits_filter_callback logits_filter_callback;
        void * logits_filter_callback_user_data;

        const whisper_grammar_element ** grammar_rules;
        size_t                           n_grammar_rules;
        size_t                           i_start_rule;
        float                            grammar_penalty;

        // Voice Activity Detection (VAD) params
        bool         vad;                         // Enable VAD
        const char * vad_model_path;              // Path to VAD model

        whisper_vad_params vad_params;
    };

    // NOTE: this function allocates memory, and it is the responsibility of the caller to free the pointer - see whisper_free_context_params & whisper_free_params()
    WHISPER_API struct whisper_context_params * whisper_context_default_params_by_ref(void);
    WHISPER_API struct whisper_context_params   whisper_context_default_params       (void);

    WHISPER_API struct whisper_full_params * whisper_full_default_params_by_ref(enum whisper_sampling_strategy strategy);
    WHISPER_API struct whisper_full_params   whisper_full_default_params       (enum whisper_sampling_strategy strategy);

    // Run the entire model: PCM -> log mel spectrogram -> encoder -> decoder -> text
    // Not thread safe for same context
    // Uses the specified decoding strategy to obtain the text.
    WHISPER_API int whisper_full(
                struct whisper_context * ctx,
            struct whisper_full_params   params,
                           const float * samples,
                                   int   n_samples);

    WHISPER_API int whisper_full_with_state(
                struct whisper_context * ctx,
                  struct whisper_state * state,
            struct whisper_full_params   params,
                           const float * samples,
                                   int   n_samples);

    // Split the input audio in chunks and process each chunk separately using whisper_full_with_state()
    // Result is stored in the default state of the context
    // Not thread safe if executed in parallel on the same context.
    // It seems this approach can offer some speedup in some cases.
    // However, the transcription accuracy can be worse at the beginning and end of each chunk.
    WHISPER_API int whisper_full_parallel(
                struct whisper_context * ctx,
            struct whisper_full_params   params,
                           const float * samples,
                                   int   n_samples,
                                   int   n_processors);

    // Number of generated text segments
    // A segment can be a few words, a sentence, or even a paragraph.
    WHISPER_API int whisper_full_n_segments           (struct whisper_context * ctx);
    WHISPER_API int whisper_full_n_segments_from_state(struct whisper_state * state);

    // Language id associated with the context's default state
    WHISPER_API int whisper_full_lang_id(struct whisper_context * ctx);

    // Language id associated with the provided state
    WHISPER_API int whisper_full_lang_id_from_state(struct whisper_state * state);

    // Get the start and end time of the specified segment
    WHISPER_API int64_t whisper_full_get_segment_t0           (struct whisper_context * ctx, int i_segment);
    WHISPER_API int64_t whisper_full_get_segment_t0_from_state(struct whisper_state * state, int i_segment);

    WHISPER_API int64_t whisper_full_get_segment_t1           (struct whisper_context * ctx, int i_segment);
    WHISPER_API int64_t whisper_full_get_segment_t1_from_state(struct whisper_state * state, int i_segment);

    // Get whether the next segment is predicted as a speaker turn
    WHISPER_API bool whisper_full_get_segment_speaker_turn_next(struct whisper_context * ctx, int i_segment);
    WHISPER_API bool whisper_full_get_segment_speaker_turn_next_from_state(struct whisper_state * state, int i_segment);

    // Get the text of the specified segment
    WHISPER_API const char * whisper_full_get_segment_text           (struct whisper_context * ctx, int i_segment);
    WHISPER_API const char * whisper_full_get_segment_text_from_state(struct whisper_state * state, int i_segment);

    // Get number of tokens in the specified segment
    WHISPER_API int whisper_full_n_tokens           (struct whisper_context * ctx, int i_segment);
    WHISPER_API int whisper_full_n_tokens_from_state(struct whisper_state * state, int i_segment);

    // Get the token text of the specified token in the specified segment
    WHISPER_API const char * whisper_full_get_token_text           (struct whisper_context * ctx, int i_segment, int i_token);
    WHISPER_API const char * whisper_full_get_token_text_from_state(struct whisper_context * ctx, struct whisper_state * state, int i_segment, int i_token);

    WHISPER_API whisper_token whisper_full_get_token_id           (struct whisper_context * ctx, int i_segment, int i_token);
    WHISPER_API whisper_token whisper_full_get_token_id_from_state(struct whisper_state * state, int i_segment, int i_token);

    // Get token data for the specified token in the specified segment
    // This contains probabilities, timestamps, etc.
    WHISPER_API whisper_token_data whisper_full_get_token_data           (struct whisper_context * ctx, int i_segment, int i_token);
    WHISPER_API whisper_token_data whisper_full_get_token_data_from_state(struct whisper_state * state, int i_segment, int i_token);

    // Get the probability of the specified token in the specified segment
    WHISPER_API float whisper_full_get_token_p           (struct whisper_context * ctx, int i_segment, int i_token);
    WHISPER_API float whisper_full_get_token_p_from_state(struct whisper_state * state, int i_segment, int i_token);

    //
    // Voice Activity Detection (VAD)
    //

    struct whisper_vad_context;

    WHISPER_API struct whisper_vad_params whisper_vad_default_params(void);

    struct whisper_vad_context_params {
        int   n_threads;  // The number of threads to use for processing.
        bool  use_gpu;
        int   gpu_device; // CUDA device
    };

    WHISPER_API struct whisper_vad_context_params whisper_vad_default_context_params(void);

    WHISPER_API struct whisper_vad_context * whisper_vad_init_from_file_with_params(const char * path_model,              struct whisper_vad_context_params params);
    WHISPER_API struct whisper_vad_context * whisper_vad_init_with_params          (struct whisper_model_loader * loader, struct whisper_vad_context_params params);

    WHISPER_API bool whisper_vad_detect_speech(
            struct whisper_vad_context * vctx,
                           const float * samples,
                                   int   n_samples);

    WHISPER_API int     whisper_vad_n_probs(struct whisper_vad_context * vctx);
    WHISPER_API float * whisper_vad_probs  (struct whisper_vad_context * vctx);

    struct whisper_vad_segments;

    WHISPER_API struct whisper_vad_segments * whisper_vad_segments_from_probs(
            struct whisper_vad_context * vctx,
            struct whisper_vad_params    params);

    WHISPER_API struct whisper_vad_segments * whisper_vad_segments_from_samples(
            struct whisper_vad_context * vctx,
            struct whisper_vad_params    params,
                           const float * samples,
                                   int   n_samples);

    WHISPER_API int whisper_vad_segments_n_segments(struct whisper_vad_segments * segments);

    WHISPER_API float whisper_vad_segments_get_segment_t0(struct whisper_vad_segments * segments, int i_segment);
    WHISPER_API float whisper_vad_segments_get_segment_t1(struct whisper_vad_segments * segments, int i_segment);

    WHISPER_API void whisper_vad_free_segments(struct whisper_vad_segments * segments);
    WHISPER_API void whisper_vad_free         (struct whisper_vad_context  * ctx);

    ////////////////////////////////////////////////////////////////////////////

    // Temporary helpers needed for exposing ggml interface

    WHISPER_API int          whisper_bench_memcpy          (int n_threads);
    WHISPER_API const char * whisper_bench_memcpy_str      (int n_threads);
    WHISPER_API int          whisper_bench_ggml_mul_mat    (int n_threads);
    WHISPER_API const char * whisper_bench_ggml_mul_mat_str(int n_threads);

    // Control logging output; default behavior is to print to stderr

    WHISPER_API void whisper_log_set(ggml_log_callback log_callback, void * user_data);

    // Get the no_speech probability for the specified segment
    WHISPER_API float whisper_full_get_segment_no_speech_prob           (struct whisper_context * ctx, int i_segment);
    WHISPER_API float whisper_full_get_segment_no_speech_prob_from_state(struct whisper_state * state, int i_segment);
#ifdef __cplusplus
}
#endif

#endif
