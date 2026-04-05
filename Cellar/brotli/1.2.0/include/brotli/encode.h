/* Copyright 2013 Google Inc. All Rights Reserved.

   Distributed under MIT license.
   See file LICENSE for detail or copy at https://opensource.org/licenses/MIT
*/

/**
 * @file
 * API for Brotli compression.
 */

#ifndef BROTLI_ENC_ENCODE_H_
#define BROTLI_ENC_ENCODE_H_

#include <brotli/port.h>
#include <brotli/shared_dictionary.h>
#include <brotli/types.h>  /* IWYU pragma: export */

#if defined(__cplusplus) || defined(c_plusplus)
extern "C" {
#endif

/** Minimal value for ::BROTLI_PARAM_LGWIN parameter. */
#define BROTLI_MIN_WINDOW_BITS 10
/**
 * Maximal value for ::BROTLI_PARAM_LGWIN parameter.
 *
 * @note equal to @c BROTLI_MAX_DISTANCE_BITS constant.
 */
#define BROTLI_MAX_WINDOW_BITS 24
/**
 * Maximal value for ::BROTLI_PARAM_LGWIN parameter
 * in "Large Window Brotli" (32-bit).
 */
#define BROTLI_LARGE_MAX_WINDOW_BITS 30
/** Minimal value for ::BROTLI_PARAM_LGBLOCK parameter. */
#define BROTLI_MIN_INPUT_BLOCK_BITS 16
/** Maximal value for ::BROTLI_PARAM_LGBLOCK parameter. */
#define BROTLI_MAX_INPUT_BLOCK_BITS 24
/** Minimal value for ::BROTLI_PARAM_QUALITY parameter. */
#define BROTLI_MIN_QUALITY 0
/** Maximal value for ::BROTLI_PARAM_QUALITY parameter. */
#define BROTLI_MAX_QUALITY 11

/** Options for ::BROTLI_PARAM_MODE parameter. */
typedef enum BrotliEncoderMode {
  /**
   * Default compression mode.
   *
   * In this mode compressor does not know anything in advance about the
   * properties of the input.
   */
  BROTLI_MODE_GENERIC = 0,
  /** Compression mode for UTF-8 formatted text input. */
  BROTLI_MODE_TEXT = 1,
  /** Compression mode used in WOFF 2.0. */
  BROTLI_MODE_FONT = 2
} BrotliEncoderMode;

/** Default value for ::BROTLI_PARAM_QUALITY parameter. */
#define BROTLI_DEFAULT_QUALITY 11
/** Default value for ::BROTLI_PARAM_LGWIN parameter. */
#define BROTLI_DEFAULT_WINDOW 22
/** Default value for ::BROTLI_PARAM_MODE parameter. */
#define BROTLI_DEFAULT_MODE BROTLI_MODE_GENERIC

/** Operations that can be performed by streaming encoder. */
typedef enum BrotliEncoderOperation {
  /**
   * Process input.
   *
   * Encoder may postpone producing output, until it has processed enough input.
   */
  BROTLI_OPERATION_PROCESS = 0,
  /**
   * Produce output for all processed input.
   *
   * Actual flush is performed when input stream is depleted and there is enough
   * space in output stream. This means that client should repeat
   * ::BROTLI_OPERATION_FLUSH operation until @p available_in becomes @c 0, and
   * ::BrotliEncoderHasMoreOutput returns ::BROTLI_FALSE. If output is acquired
   * via ::BrotliEncoderTakeOutput, then operation should be repeated after
   * output buffer is drained.
   *
   * @warning Until flush is complete, client @b SHOULD @b NOT swap,
   *          reduce or extend input stream.
   *
   * When flush is complete, output data will be sufficient for decoder to
   * reproduce all the given input.
   */
  BROTLI_OPERATION_FLUSH = 1,
  /**
   * Finalize the stream.
   *
   * Actual finalization is performed when input stream is depleted and there is
   * enough space in output stream. This means that client should repeat
   * ::BROTLI_OPERATION_FINISH operation until @p available_in becomes @c 0, and
   * ::BrotliEncoderHasMoreOutput returns ::BROTLI_FALSE. If output is acquired
   * via ::BrotliEncoderTakeOutput, then operation should be repeated after
   * output buffer is drained.
   *
   * @warning Until finalization is complete, client @b SHOULD @b NOT swap,
   *          reduce or extend input stream.
   *
   * Helper function ::BrotliEncoderIsFinished checks if stream is finalized and
   * output fully dumped.
   *
   * Adding more input data to finalized stream is impossible.
   */
  BROTLI_OPERATION_FINISH = 2,
  /**
   * Emit metadata block to stream.
   *
   * Metadata is opaque to Brotli: neither encoder, nor decoder processes this
   * data or relies on it. It may be used to pass some extra information from
   * encoder client to decoder client without interfering with main data stream.
   *
   * @note Encoder may emit empty metadata blocks internally, to pad encoded
   *       stream to byte boundary.
   *
   * @warning Until emitting metadata is complete client @b SHOULD @b NOT swap,
   *          reduce or extend input stream.
   *
   * @warning The whole content of input buffer is considered to be the content
   *          of metadata block. Do @b NOT @e append metadata to input stream,
   *          before it is depleted with other operations.
   *
   * Stream is soft-flushed before metadata block is emitted. Metadata block
   * @b MUST be no longer than than 16MiB.
   */
  BROTLI_OPERATION_EMIT_METADATA = 3
} BrotliEncoderOperation;

/** Options to be used with ::BrotliEncoderSetParameter. */
typedef enum BrotliEncoderParameter {
  /**
   * Tune encoder for specific input.
   *
   * ::BrotliEncoderMode enumerates all available values.
   */
  BROTLI_PARAM_MODE = 0,
  /**
   * The main compression speed-density lever.
   *
   * The higher the quality, the slower the compression. Range is
   * from ::BROTLI_MIN_QUALITY to ::BROTLI_MAX_QUALITY.
   */
  BROTLI_PARAM_QUALITY = 1,
  /**
   * Recommended sliding LZ77 window size.
   *
   * Encoder may reduce this value, e.g. if input is much smaller than
   * window size.
   *
   * Window size is `(1 << value) - 16`.
   *
   * Range is from ::BROTLI_MIN_WINDOW_BITS to ::BROTLI_MAX_WINDOW_BITS.
   */
  BROTLI_PARAM_LGWIN = 2,
  /**
   * Recommended input block size.
   *
   * Encoder may reduce this value, e.g. if input is much smaller than input
   * block size.
   *
   * Range is from ::BROTLI_MIN_INPUT_BLOCK_BITS to
   * ::BROTLI_MAX_INPUT_BLOCK_BITS.
   *
   * @note Bigger input block size allows better compression, but consumes more
   *       memory. \n The rough formula of memory used for temporary input
   *       storage is `3 << lgBlock`.
   */
  BROTLI_PARAM_LGBLOCK = 3,
  /**
   * Flag that affects usage of "literal context modeling" format feature.
   *
   * This flag is a "decoding-speed vs compression ratio" trade-off.
   */
  BROTLI_PARAM_DISABLE_LITERAL_CONTEXT_MODELING = 4,
  /**
   * Estimated total input size for all ::BrotliEncoderCompressStream calls.
   *
   * The default value is 0, which means that the total input size is unknown.
   */
  BROTLI_PARAM_SIZE_HINT = 5,
  /**
   * Flag that determines if "Large Window Brotli" is used.
   */
  BROTLI_PARAM_LARGE_WINDOW = 6,
  /**
   * Recommended number of postfix bits (NPOSTFIX).
   *
   * Encoder may change this value.
   *
   * Range is from 0 to ::BROTLI_MAX_NPOSTFIX.
   */
  BROTLI_PARAM_NPOSTFIX = 7,
  /**
   * Recommended number of direct distance codes (NDIRECT).
   *
   * Encoder may change this value.
   *
   * Range is from 0 to (15 << NPOSTFIX) in steps of (1 << NPOSTFIX).
   */
  BROTLI_PARAM_NDIRECT = 8,
  /**
   * Number of bytes of input stream already processed by a different instance.
   *
   * @note It is important to configure all the encoder instances with same
   *       parameters (except this one) in order to allow all the encoded parts
   *       obey the same restrictions implied by header.
   *
   * If offset is not 0, then stream header is omitted.
   * In any case output start is byte aligned, so for proper streams stitching
   * "predecessor" stream must be flushed.
   *
   * Range is not artificially limited, but all the values greater or equal to
   * maximal window size have the same effect. Values greater than 2**30 are not
   * allowed.
   */
  BROTLI_PARAM_STREAM_OFFSET = 9
} BrotliEncoderParameter;

/**
 * Opaque structure that holds encoder state.
 *
 * Allocated and initialized with ::BrotliEncoderCreateInstance.
 * Cleaned up and deallocated with ::BrotliEncoderDestroyInstance.
 */
typedef struct BrotliEncoderStateStruct BrotliEncoderState;

/**
 * Sets the specified parameter to the given encoder instance.
 *
 * @param state encoder instance
 * @param param parameter to set
 * @param value new parameter value
 * @returns ::BROTLI_FALSE if parameter is unrecognized, or value is invalid
 * @returns ::BROTLI_FALSE if value of parameter can not be changed at current
 *          encoder state (e.g. when encoding is started, window size might be
 *          already encoded and therefore it is impossible to change it)
 * @returns ::BROTLI_TRUE if value is accepted
 * @warning invalid values might be accepted in case they would not break
 *          encoding process.
 */
BROTLI_ENC_API BROTLI_BOOL BrotliEncoderSetParameter(
    BrotliEncoderState* state, BrotliEncoderParameter param, uint32_t value);

/**
 * Creates an instance of ::BrotliEncoderState and initializes it.
 *
 * @p alloc_func and @p free_func @b MUST be both zero or both non-zero. In the
 * case they are both zero, default memory allocators are used. @p opaque is
 * passed to @p alloc_func and @p free_func when they are called. @p free_func
 * has to return without doing anything when asked to free a NULL pointer.
 *
 * @param alloc_func custom memory allocation function
 * @param free_func custom memory free function
 * @param opaque custom memory manager handle
 * @returns @c 0 if instance can not be allocated or initialized
 * @returns pointer to initialized ::BrotliEncoderState otherwise
 */
BROTLI_ENC_API BrotliEncoderState* BrotliEncoderCreateInstance(
    brotli_alloc_func alloc_func, brotli_free_func free_func, void* opaque);

/**
 * Deinitializes and frees ::BrotliEncoderState instance.
 *
 * @param state decoder instance to be cleaned up and deallocated
 */
BROTLI_ENC_API void BrotliEncoderDestroyInstance(BrotliEncoderState* state);

/* Opaque type for pointer to different possible internal structures containing
   dictionary prepared for the encoder */
typedef struct BrotliEncoderPreparedDictionaryStruct
    BrotliEncoderPreparedDictionary;

/**
 * Prepares a shared dictionary from the given file format for the encoder.
 *
 * @p alloc_func and @p free_func @b MUST be both zero or both non-zero. In the
 * case they are both zero, default memory allocators are used. @p opaque is
 * passed to @p alloc_func and @p free_func when they are called. @p free_func
 * has to return without doing anything when asked to free a NULL pointer.
 *
 * @warning Created instance is "lean"; it does not contain copy of @p data,
 *          rather it contains only pointer to it; therefore,
 *          @p data @b MUST outlive the created instance.
 *
 * @param type type of dictionary stored in data
 * @param data_size size of @p data buffer
 * @param data pointer to the dictionary data
 * @param quality the maximum Brotli quality to prepare the dictionary for,
 *        use BROTLI_MAX_QUALITY by default
 * @param alloc_func custom memory allocation function
 * @param free_func custom memory free function
 * @param opaque custom memory manager handle
 */
BROTLI_ENC_API BrotliEncoderPreparedDictionary*
BrotliEncoderPrepareDictionary(BrotliSharedDictionaryType type,
    size_t data_size, const uint8_t data[BROTLI_ARRAY_PARAM(data_size)],
    int quality,
    brotli_alloc_func alloc_func, brotli_free_func free_func, void* opaque);

BROTLI_ENC_API void BrotliEncoderDestroyPreparedDictionary(
    BrotliEncoderPreparedDictionary* dictionary);

/**
 * Attaches a prepared dictionary of any type to the encoder. Can be used
 * multiple times to attach multiple dictionaries. The dictionary type was
 * determined by BrotliEncoderPrepareDictionary. Multiple raw prefix
 * dictionaries and/or max 1 serialized dictionary with custom words can be
 * attached.
 *
 * @returns ::BROTLI_FALSE in case of error
 * @returns ::BROTLI_TRUE otherwise
 */
BROTLI_ENC_API BROTLI_BOOL BrotliEncoderAttachPreparedDictionary(
    BrotliEncoderState* state,
    const BrotliEncoderPreparedDictionary* dictionary);

/**
 * Calculates the output size bound for the given @p input_size.
 *
 * @warning Result is only valid if quality is at least @c 2 and, in
 *          case ::BrotliEncoderCompressStream was used, no flushes
 *          (::BROTLI_OPERATION_FLUSH) were performed.
 *
 * @param input_size size of projected input
 * @returns @c 0 if result does not fit @c size_t
 */
BROTLI_ENC_API size_t BrotliEncoderMaxCompressedSize(size_t input_size);

/**
 * Performs one-shot memory-to-memory compression.
 *
 * Compresses the data in @p input_buffer into @p encoded_buffer, and sets
 * @p *encoded_size to the compressed length.
 *
 * @note If ::BrotliEncoderMaxCompressedSize(@p input_size) returns non-zero
 *       value, then output is guaranteed to be no longer than that.
 *
 * @note If @p lgwin is greater than ::BROTLI_MAX_WINDOW_BITS then resulting
 *       stream might be incompatible with RFC 7932; to decode such streams,
 *       decoder should be configured with
 *       ::BROTLI_DECODER_PARAM_LARGE_WINDOW = @c 1
 *
 * @param quality quality parameter value, e.g. ::BROTLI_DEFAULT_QUALITY
 * @param lgwin lgwin parameter value, e.g. ::BROTLI_DEFAULT_WINDOW
 * @param mode mode parameter value, e.g. ::BROTLI_DEFAULT_MODE
 * @param input_size size of @p input_buffer
 * @param input_buffer input data buffer with at least @p input_size
 *        addressable bytes
 * @param[in, out] encoded_size @b in: size of @p encoded_buffer; \n
 *                 @b out: length of compressed data written to
 *                 @p encoded_buffer, or @c 0 if compression fails
 * @param encoded_buffer compressed data destination buffer
 * @returns ::BROTLI_FALSE in case of compression error
 * @returns ::BROTLI_FALSE if output buffer is too small
 * @returns ::BROTLI_TRUE otherwise
 */
BROTLI_ENC_API BROTLI_BOOL BrotliEncoderCompress(
    int quality, int lgwin, BrotliEncoderMode mode, size_t input_size,
    const uint8_t input_buffer[BROTLI_ARRAY_PARAM(input_size)],
    size_t* encoded_size,
    uint8_t encoded_buffer[BROTLI_ARRAY_PARAM(*encoded_size)]);

/**
 * Compresses input stream to output stream.
 *
 * The values @p *available_in and @p *available_out must specify the number of
 * bytes addressable at @p *next_in and @p *next_out respectively.
 * When @p *available_out is @c 0, @p next_out is allowed to be @c NULL.
 *
 * After each call, @p *available_in will be decremented by the amount of input
 * bytes consumed, and the @p *next_in pointer will be incremented by that
 * amount. Similarly, @p *available_out will be decremented by the amount of
 * output bytes written, and the @p *next_out pointer will be incremented by
 * that amount.
 *
 * @p total_out, if it is not a null-pointer, will be set to the number
 * of bytes compressed since the last @p state initialization.
 *
 *
 *
 * Internally workflow consists of 3 tasks:
 *  -# (optionally) copy input data to internal buffer
 *  -# actually compress data and (optionally) store it to internal buffer
 *  -# (optionally) copy compressed bytes from internal buffer to output stream
 *
 * Whenever all 3 tasks can't move forward anymore, or error occurs, this
 * method returns the control flow to caller.
 *
 * @p op is used to perform flush, finish the stream, or inject metadata block.
 * See ::BrotliEncoderOperation for more information.
 *
 * Flushing the stream means forcing encoding of all input passed to encoder and
 * completing the current output block, so it could be fully decoded by stream
 * decoder. To perform flush set @p op to ::BROTLI_OPERATION_FLUSH.
 * Under some circumstances (e.g. lack of output stream capacity) this operation
 * would require several calls to ::BrotliEncoderCompressStream. The method must
 * be called again until both input stream is depleted and encoder has no more
 * output (see ::BrotliEncoderHasMoreOutput) after the method is called.
 *
 * Finishing the stream means encoding of all input passed to encoder and
 * adding specific "final" marks, so stream decoder could determine that stream
 * is complete. To perform finish set @p op to ::BROTLI_OPERATION_FINISH.
 * Under some circumstances (e.g. lack of output stream capacity) this operation
 * would require several calls to ::BrotliEncoderCompressStream. The method must
 * be called again until both input stream is depleted and encoder has no more
 * output (see ::BrotliEncoderHasMoreOutput) after the method is called.
 *
 * @warning When flushing and finishing, @p op should not change until operation
 *          is complete; input stream should not be swapped, reduced or
 *          extended as well.
 *
 * @param state encoder instance
 * @param op requested operation
 * @param[in, out] available_in @b in: amount of available input; \n
 *                 @b out: amount of unused input
 * @param[in, out] next_in pointer to the next input byte
 * @param[in, out] available_out @b in: length of output buffer; \n
 *                 @b out: remaining size of output buffer
 * @param[in, out] next_out compressed output buffer cursor;
 *                 can be @c NULL if @p available_out is @c 0
 * @param[out] total_out number of bytes produced so far; can be @c NULL
 * @returns ::BROTLI_FALSE if there was an error
 * @returns ::BROTLI_TRUE otherwise
 */
BROTLI_ENC_API BROTLI_BOOL BrotliEncoderCompressStream(
    BrotliEncoderState* state, BrotliEncoderOperation op, size_t* available_in,
    const uint8_t** next_in, size_t* available_out, uint8_t** next_out,
    size_t* total_out);

/**
 * Checks if encoder instance reached the final state.
 *
 * @param state encoder instance
 * @returns ::BROTLI_TRUE if encoder is in a state where it reached the end of
 *          the input and produced all of the output
 * @returns ::BROTLI_FALSE otherwise
 */
BROTLI_ENC_API BROTLI_BOOL BrotliEncoderIsFinished(BrotliEncoderState* state);

/**
 * Checks if encoder has more output.
 *
 * @param state encoder instance
 * @returns ::BROTLI_TRUE, if encoder has some unconsumed output
 * @returns ::BROTLI_FALSE otherwise
 */
BROTLI_ENC_API BROTLI_BOOL BrotliEncoderHasMoreOutput(
    BrotliEncoderState* state);

/**
 * Acquires pointer to internal output buffer.
 *
 * This method is used to make language bindings easier and more efficient:
 *  -# push data to ::BrotliEncoderCompressStream,
 *     until ::BrotliEncoderHasMoreOutput returns BROTLI_TRUE
 *  -# use ::BrotliEncoderTakeOutput to peek bytes and copy to language-specific
 *     entity
 *
 * Also this could be useful if there is an output stream that is able to
 * consume all the provided data (e.g. when data is saved to file system).
 *
 * @attention After every call to ::BrotliEncoderTakeOutput @p *size bytes of
 *            output are considered consumed for all consecutive calls to the
 *            instance methods; returned pointer becomes invalidated as well.
 *
 * @note Encoder output is not guaranteed to be contiguous. This means that
 *       after the size-unrestricted call to ::BrotliEncoderTakeOutput,
 *       immediate next call to ::BrotliEncoderTakeOutput may return more data.
 *
 * @param state encoder instance
 * @param[in, out] size @b in: number of bytes caller is ready to take, @c 0 if
 *                 any amount could be handled; \n
 *                 @b out: amount of data pointed by returned pointer and
 *                 considered consumed; \n
 *                 out value is never greater than in value, unless it is @c 0
 * @returns pointer to output data
 */
BROTLI_ENC_API const uint8_t* BrotliEncoderTakeOutput(
    BrotliEncoderState* state, size_t* size);

/* Returns the estimated peak memory usage (in bytes) of the BrotliCompress()
   function, not counting the memory needed for the input and output. */
BROTLI_ENC_EXTRA_API size_t BrotliEncoderEstimatePeakMemoryUsage(
    int quality, int lgwin, size_t input_size);
/* Returns 0 if dictionary is not valid; otherwise returns allocation size. */
BROTLI_ENC_EXTRA_API size_t BrotliEncoderGetPreparedDictionarySize(
    const BrotliEncoderPreparedDictionary* dictionary);

/**
 * Gets an encoder library version.
 *
 * Look at BROTLI_MAKE_HEX_VERSION for more information.
 */
BROTLI_ENC_API uint32_t BrotliEncoderVersion(void);

#if defined(__cplusplus) || defined(c_plusplus)
}  /* extern "C" */
#endif

#endif  /* BROTLI_ENC_ENCODE_H_ */
