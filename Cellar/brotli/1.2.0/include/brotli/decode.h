/* Copyright 2013 Google Inc. All Rights Reserved.

   Distributed under MIT license.
   See file LICENSE for detail or copy at https://opensource.org/licenses/MIT
*/

/**
 * @file
 * API for Brotli decompression.
 */

#ifndef BROTLI_DEC_DECODE_H_
#define BROTLI_DEC_DECODE_H_

#include <brotli/port.h>
#include <brotli/shared_dictionary.h>
#include <brotli/types.h>  /* IWYU pragma: export */

#if defined(__cplusplus) || defined(c_plusplus)
extern "C" {
#endif

/**
 * Opaque structure that holds decoder state.
 *
 * Allocated and initialized with ::BrotliDecoderCreateInstance.
 * Cleaned up and deallocated with ::BrotliDecoderDestroyInstance.
 */
typedef struct BrotliDecoderStateStruct BrotliDecoderState;

/**
 * Result type for ::BrotliDecoderDecompress and
 * ::BrotliDecoderDecompressStream functions.
 */
typedef enum {
  /** Decoding error, e.g. corrupted input or memory allocation problem. */
  BROTLI_DECODER_RESULT_ERROR = 0,
  /** Decoding successfully completed. */
  BROTLI_DECODER_RESULT_SUCCESS = 1,
  /** Partially done; should be called again with more input. */
  BROTLI_DECODER_RESULT_NEEDS_MORE_INPUT = 2,
  /** Partially done; should be called again with more output. */
  BROTLI_DECODER_RESULT_NEEDS_MORE_OUTPUT = 3
} BrotliDecoderResult;

/**
 * Template that evaluates items of ::BrotliDecoderErrorCode.
 *
 * Example: @code {.cpp}
 * // Log Brotli error code.
 * switch (brotliDecoderErrorCode) {
 * #define CASE_(PREFIX, NAME, CODE) \
 *   case BROTLI_DECODER ## PREFIX ## NAME: \
 *     LOG(INFO) << "error code:" << #NAME; \
 *     break;
 * #define NEWLINE_
 * BROTLI_DECODER_ERROR_CODES_LIST(CASE_, NEWLINE_)
 * #undef CASE_
 * #undef NEWLINE_
 *   default: LOG(FATAL) << "unknown brotli error code";
 * }
 * @endcode
 */
#define BROTLI_DECODER_ERROR_CODES_LIST(BROTLI_ERROR_CODE, SEPARATOR)      \
  BROTLI_ERROR_CODE(_, NO_ERROR, 0) SEPARATOR                              \
  /* Same as BrotliDecoderResult values */                                 \
  BROTLI_ERROR_CODE(_, SUCCESS, 1) SEPARATOR                               \
  BROTLI_ERROR_CODE(_, NEEDS_MORE_INPUT, 2) SEPARATOR                      \
  BROTLI_ERROR_CODE(_, NEEDS_MORE_OUTPUT, 3) SEPARATOR                     \
                                                                           \
  /* Errors caused by invalid input */                                     \
  BROTLI_ERROR_CODE(_ERROR_FORMAT_, EXUBERANT_NIBBLE, -1) SEPARATOR        \
  BROTLI_ERROR_CODE(_ERROR_FORMAT_, RESERVED, -2) SEPARATOR                \
  BROTLI_ERROR_CODE(_ERROR_FORMAT_, EXUBERANT_META_NIBBLE, -3) SEPARATOR   \
  BROTLI_ERROR_CODE(_ERROR_FORMAT_, SIMPLE_HUFFMAN_ALPHABET, -4) SEPARATOR \
  BROTLI_ERROR_CODE(_ERROR_FORMAT_, SIMPLE_HUFFMAN_SAME, -5) SEPARATOR     \
  BROTLI_ERROR_CODE(_ERROR_FORMAT_, CL_SPACE, -6) SEPARATOR                \
  BROTLI_ERROR_CODE(_ERROR_FORMAT_, HUFFMAN_SPACE, -7) SEPARATOR           \
  BROTLI_ERROR_CODE(_ERROR_FORMAT_, CONTEXT_MAP_REPEAT, -8) SEPARATOR      \
  BROTLI_ERROR_CODE(_ERROR_FORMAT_, BLOCK_LENGTH_1, -9) SEPARATOR          \
  BROTLI_ERROR_CODE(_ERROR_FORMAT_, BLOCK_LENGTH_2, -10) SEPARATOR         \
  BROTLI_ERROR_CODE(_ERROR_FORMAT_, TRANSFORM, -11) SEPARATOR              \
  BROTLI_ERROR_CODE(_ERROR_FORMAT_, DICTIONARY, -12) SEPARATOR             \
  BROTLI_ERROR_CODE(_ERROR_FORMAT_, WINDOW_BITS, -13) SEPARATOR            \
  BROTLI_ERROR_CODE(_ERROR_FORMAT_, PADDING_1, -14) SEPARATOR              \
  BROTLI_ERROR_CODE(_ERROR_FORMAT_, PADDING_2, -15) SEPARATOR              \
  BROTLI_ERROR_CODE(_ERROR_FORMAT_, DISTANCE, -16) SEPARATOR               \
                                                                           \
  /* -17 code is reserved */                                               \
                                                                           \
  BROTLI_ERROR_CODE(_ERROR_, COMPOUND_DICTIONARY, -18) SEPARATOR           \
  BROTLI_ERROR_CODE(_ERROR_, DICTIONARY_NOT_SET, -19) SEPARATOR            \
  BROTLI_ERROR_CODE(_ERROR_, INVALID_ARGUMENTS, -20) SEPARATOR             \
                                                                           \
  /* Memory allocation problems */                                         \
  BROTLI_ERROR_CODE(_ERROR_ALLOC_, CONTEXT_MODES, -21) SEPARATOR           \
  /* Literal, insert and distance trees together */                        \
  BROTLI_ERROR_CODE(_ERROR_ALLOC_, TREE_GROUPS, -22) SEPARATOR             \
  /* -23..-24 codes are reserved for distinct tree groups */               \
  BROTLI_ERROR_CODE(_ERROR_ALLOC_, CONTEXT_MAP, -25) SEPARATOR             \
  BROTLI_ERROR_CODE(_ERROR_ALLOC_, RING_BUFFER_1, -26) SEPARATOR           \
  BROTLI_ERROR_CODE(_ERROR_ALLOC_, RING_BUFFER_2, -27) SEPARATOR           \
  /* -28..-29 codes are reserved for dynamic ring-buffer allocation */     \
  BROTLI_ERROR_CODE(_ERROR_ALLOC_, BLOCK_TYPE_TREES, -30) SEPARATOR        \
                                                                           \
  /* "Impossible" states */                                                \
  BROTLI_ERROR_CODE(_ERROR_, UNREACHABLE, -31)

/**
 * Error code for detailed logging / production debugging.
 *
 * See ::BrotliDecoderGetErrorCode and ::BROTLI_LAST_ERROR_CODE.
 */
typedef enum {
#define BROTLI_COMMA_ ,
#define BROTLI_ERROR_CODE_ENUM_ITEM_(PREFIX, NAME, CODE) \
    BROTLI_DECODER ## PREFIX ## NAME = CODE
  BROTLI_DECODER_ERROR_CODES_LIST(BROTLI_ERROR_CODE_ENUM_ITEM_, BROTLI_COMMA_)
} BrotliDecoderErrorCode;
#undef BROTLI_ERROR_CODE_ENUM_ITEM_
#undef BROTLI_COMMA_

/**
 * The value of the last error code, negative integer.
 *
 * All other error code values are in the range from ::BROTLI_LAST_ERROR_CODE
 * to @c -1. There are also 4 other possible non-error codes @c 0 .. @c 3 in
 * ::BrotliDecoderErrorCode enumeration.
 */
#define BROTLI_LAST_ERROR_CODE BROTLI_DECODER_ERROR_UNREACHABLE

/** Options to be used with ::BrotliDecoderSetParameter. */
typedef enum BrotliDecoderParameter {
  /**
   * Disable "canny" ring buffer allocation strategy.
   *
   * Ring buffer is allocated according to window size, despite the real size of
   * the content.
   */
  BROTLI_DECODER_PARAM_DISABLE_RING_BUFFER_REALLOCATION = 0,
  /**
   * Flag that determines if "Large Window Brotli" is used.
   */
  BROTLI_DECODER_PARAM_LARGE_WINDOW = 1
} BrotliDecoderParameter;

/**
 * Sets the specified parameter to the given decoder instance.
 *
 * @param state decoder instance
 * @param param parameter to set
 * @param value new parameter value
 * @returns ::BROTLI_FALSE if parameter is unrecognized, or value is invalid
 * @returns ::BROTLI_TRUE if value is accepted
 */
BROTLI_DEC_API BROTLI_BOOL BrotliDecoderSetParameter(
    BrotliDecoderState* state, BrotliDecoderParameter param, uint32_t value);

/**
 * Adds LZ77 prefix dictionary, adds or replaces built-in static dictionary and
 * transforms.
 *
 * Attached dictionary ownership is not transferred.
 * Data provided to this method should be kept accessible until
 * decoding is finished and decoder instance is destroyed.
 *
 * @note Dictionaries can NOT be attached after actual decoding is started.
 *
 * @param state decoder instance
 * @param type dictionary data format
 * @param data_size length of memory region pointed by @p data
 * @param data dictionary data in format corresponding to @p type
 * @returns ::BROTLI_FALSE if dictionary is corrupted,
 *          or dictionary count limit is reached
 * @returns ::BROTLI_TRUE if dictionary is accepted / attached
 */
BROTLI_DEC_API BROTLI_BOOL BrotliDecoderAttachDictionary(
    BrotliDecoderState* state, BrotliSharedDictionaryType type,
    size_t data_size, const uint8_t data[BROTLI_ARRAY_PARAM(data_size)]);

/**
 * Creates an instance of ::BrotliDecoderState and initializes it.
 *
 * The instance can be used once for decoding and should then be destroyed with
 * ::BrotliDecoderDestroyInstance, it cannot be reused for a new decoding
 * session.
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
 * @returns pointer to initialized ::BrotliDecoderState otherwise
 */
BROTLI_DEC_API BrotliDecoderState* BrotliDecoderCreateInstance(
    brotli_alloc_func alloc_func, brotli_free_func free_func, void* opaque);

/**
 * Deinitializes and frees ::BrotliDecoderState instance.
 *
 * @param state decoder instance to be cleaned up and deallocated
 */
BROTLI_DEC_API void BrotliDecoderDestroyInstance(BrotliDecoderState* state);

/**
 * Performs one-shot memory-to-memory decompression.
 *
 * Decompresses the data in @p encoded_buffer into @p decoded_buffer, and sets
 * @p *decoded_size to the decompressed length.
 *
 * @param encoded_size size of @p encoded_buffer
 * @param encoded_buffer compressed data buffer with at least @p encoded_size
 *        addressable bytes
 * @param[in, out] decoded_size @b in: size of @p decoded_buffer; \n
 *                 @b out: length of decompressed data written to
 *                 @p decoded_buffer
 * @param decoded_buffer decompressed data destination buffer
 * @returns ::BROTLI_DECODER_RESULT_ERROR if input is corrupted, memory
 *          allocation failed, or @p decoded_buffer is not large enough;
 * @returns ::BROTLI_DECODER_RESULT_SUCCESS otherwise
 */
BROTLI_DEC_API BrotliDecoderResult BrotliDecoderDecompress(
    size_t encoded_size,
    const uint8_t encoded_buffer[BROTLI_ARRAY_PARAM(encoded_size)],
    size_t* decoded_size,
    uint8_t decoded_buffer[BROTLI_ARRAY_PARAM(*decoded_size)]);

/**
 * Decompresses the input stream to the output stream.
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
 * of bytes decompressed since the last @p state initialization.
 *
 * @note Input is never overconsumed, so @p next_in and @p available_in could be
 * passed to the next consumer after decoding is complete.
 *
 * @param state decoder instance
 * @param[in, out] available_in @b in: amount of available input; \n
 *                 @b out: amount of unused input
 * @param[in, out] next_in pointer to the next compressed byte
 * @param[in, out] available_out @b in: length of output buffer; \n
 *                 @b out: remaining size of output buffer
 * @param[in, out] next_out output buffer cursor;
 *                 can be @c NULL if @p available_out is @c 0
 * @param[out] total_out number of bytes decompressed so far; can be @c NULL
 * @returns ::BROTLI_DECODER_RESULT_ERROR if input is corrupted, memory
 *          allocation failed, arguments were invalid, etc.;
 *          use ::BrotliDecoderGetErrorCode to get detailed error code
 * @returns ::BROTLI_DECODER_RESULT_NEEDS_MORE_INPUT decoding is blocked until
 *          more input data is provided
 * @returns ::BROTLI_DECODER_RESULT_NEEDS_MORE_OUTPUT decoding is blocked until
 *          more output space is provided
 * @returns ::BROTLI_DECODER_RESULT_SUCCESS decoding is finished, no more
 *          input might be consumed and no more output will be produced
 */
BROTLI_DEC_API BrotliDecoderResult BrotliDecoderDecompressStream(
  BrotliDecoderState* state, size_t* available_in, const uint8_t** next_in,
  size_t* available_out, uint8_t** next_out, size_t* total_out);

/**
 * Checks if decoder has more output.
 *
 * @param state decoder instance
 * @returns ::BROTLI_TRUE, if decoder has some unconsumed output
 * @returns ::BROTLI_FALSE otherwise
 */
BROTLI_DEC_API BROTLI_BOOL BrotliDecoderHasMoreOutput(
    const BrotliDecoderState* state);

/**
 * Acquires pointer to internal output buffer.
 *
 * This method is used to make language bindings easier and more efficient:
 *  -# push data to ::BrotliDecoderDecompressStream,
 *     until ::BROTLI_DECODER_RESULT_NEEDS_MORE_OUTPUT is reported
 *  -# use ::BrotliDecoderTakeOutput to peek bytes and copy to language-specific
 *     entity
 *
 * Also this could be useful if there is an output stream that is able to
 * consume all the provided data (e.g. when data is saved to file system).
 *
 * @attention After every call to ::BrotliDecoderTakeOutput @p *size bytes of
 *            output are considered consumed for all consecutive calls to the
 *            instance methods; returned pointer becomes invalidated as well.
 *
 * @note Decoder output is not guaranteed to be contiguous. This means that
 *       after the size-unrestricted call to ::BrotliDecoderTakeOutput,
 *       immediate next call to ::BrotliDecoderTakeOutput may return more data.
 *
 * @param state decoder instance
 * @param[in, out] size @b in: number of bytes caller is ready to take, @c 0 if
 *                 any amount could be handled; \n
 *                 @b out: amount of data pointed by returned pointer and
 *                 considered consumed; \n
 *                 out value is never greater than in value, unless it is @c 0
 * @returns pointer to output data
 */
BROTLI_DEC_API const uint8_t* BrotliDecoderTakeOutput(
    BrotliDecoderState* state, size_t* size);

/**
 * Checks if instance has already consumed input.
 *
 * Instance that returns ::BROTLI_FALSE is considered "fresh" and could be
 * reused.
 *
 * @param state decoder instance
 * @returns ::BROTLI_TRUE if decoder has already used some input bytes
 * @returns ::BROTLI_FALSE otherwise
 */
BROTLI_DEC_API BROTLI_BOOL BrotliDecoderIsUsed(const BrotliDecoderState* state);

/**
 * Checks if decoder instance reached the final state.
 *
 * @param state decoder instance
 * @returns ::BROTLI_TRUE if decoder is in a state where it reached the end of
 *          the input and produced all of the output
 * @returns ::BROTLI_FALSE otherwise
 */
BROTLI_DEC_API BROTLI_BOOL BrotliDecoderIsFinished(
    const BrotliDecoderState* state);

/**
 * Acquires a detailed error code.
 *
 * Should be used only after ::BrotliDecoderDecompressStream returns
 * ::BROTLI_DECODER_RESULT_ERROR.
 *
 * See also ::BrotliDecoderErrorString
 *
 * @param state decoder instance
 * @returns last saved error code
 */
BROTLI_DEC_API BrotliDecoderErrorCode BrotliDecoderGetErrorCode(
    const BrotliDecoderState* state);

/**
 * Converts error code to a c-string.
 */
BROTLI_DEC_API const char* BrotliDecoderErrorString(BrotliDecoderErrorCode c);

/**
 * Gets a decoder library version.
 *
 * Look at BROTLI_MAKE_HEX_VERSION for more information.
 */
BROTLI_DEC_API uint32_t BrotliDecoderVersion(void);

/**
 * Callback to fire on metadata block start.
 *
 * After this callback is fired, if @p size is not @c 0, it is followed by
 * ::brotli_decoder_metadata_chunk_func as more metadata block contents become
 * accessible.
 *
 * @param opaque callback handle
 * @param size size of metadata block
 */
typedef void (*brotli_decoder_metadata_start_func)(void* opaque, size_t size);

/**
 * Callback to fire on metadata block chunk becomes available.
 *
 * This function can be invoked multiple times per metadata block; block should
 * be considered finished when sum of @p size matches the announced metadata
 * block size. Chunks contents pointed by @p data are transient and shouln not
 * be accessed after leaving the callback.
 *
 * @param opaque callback handle
 * @param data pointer to metadata contents
 * @param size size of metadata block chunk, at least @c 1
 */
typedef void (*brotli_decoder_metadata_chunk_func)(void* opaque,
                                                   const uint8_t* data,
                                                   size_t size);

/**
 * Sets callback for receiving metadata blocks.
 *
 * @param state decoder instance
 * @param start_func callback on metadata block start
 * @param chunk_func callback on metadata block chunk
 * @param opaque callback handle
 */
BROTLI_DEC_API void BrotliDecoderSetMetadataCallbacks(
    BrotliDecoderState* state,
    brotli_decoder_metadata_start_func start_func,
    brotli_decoder_metadata_chunk_func chunk_func, void* opaque);

#if defined(__cplusplus) || defined(c_plusplus)
} /* extern "C" */
#endif

#endif  /* BROTLI_DEC_DECODE_H_ */
