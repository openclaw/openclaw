/* Copyright (c) 2017 Google Inc.
   Written by Andrew Allen */
/*
   Redistribution and use in source and binary forms, with or without
   modification, are permitted provided that the following conditions
   are met:

   - Redistributions of source code must retain the above copyright
   notice, this list of conditions and the following disclaimer.

   - Redistributions in binary form must reproduce the above copyright
   notice, this list of conditions and the following disclaimer in the
   documentation and/or other materials provided with the distribution.

   THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
   ``AS IS'' AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
   LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
   A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER
   OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL,
   EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,
   PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
   PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF
   LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
   NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
   SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/

/**
 * @file opus_projection.h
 * @brief Opus projection reference API
 */

#ifndef OPUS_PROJECTION_H
#define OPUS_PROJECTION_H

#include "opus_multistream.h"

#ifdef __cplusplus
extern "C" {
#endif

/** @cond OPUS_INTERNAL_DOC */

/** These are the actual encoder and decoder CTL ID numbers.
  * They should not be used directly by applications.c
  * In general, SETs should be even and GETs should be odd.*/
/**@{*/
#define OPUS_PROJECTION_GET_DEMIXING_MATRIX_GAIN_REQUEST    6001
#define OPUS_PROJECTION_GET_DEMIXING_MATRIX_SIZE_REQUEST    6003
#define OPUS_PROJECTION_GET_DEMIXING_MATRIX_REQUEST         6005
/**@}*/


/** @endcond */

/** @defgroup opus_projection_ctls Projection specific encoder and decoder CTLs
  *
  * These are convenience macros that are specific to the
  * opus_projection_encoder_ctl() and opus_projection_decoder_ctl()
  * interface.
  * The CTLs from @ref opus_genericctls, @ref opus_encoderctls,
  * @ref opus_decoderctls, and @ref opus_multistream_ctls may be applied to a
  * projection encoder or decoder as well.
  */
/**@{*/

/** Gets the gain (in dB. S7.8-format) of the demixing matrix from the encoder.
  * @param[out] x <tt>opus_int32 *</tt>: Returns the gain (in dB. S7.8-format)
  *                                      of the demixing matrix.
  * @hideinitializer
  */
#define OPUS_PROJECTION_GET_DEMIXING_MATRIX_GAIN(x) OPUS_PROJECTION_GET_DEMIXING_MATRIX_GAIN_REQUEST, opus_check_int_ptr(x)


/** Gets the size in bytes of the demixing matrix from the encoder.
  * @param[out] x <tt>opus_int32 *</tt>: Returns the size in bytes of the
  *                                      demixing matrix.
  * @hideinitializer
  */
#define OPUS_PROJECTION_GET_DEMIXING_MATRIX_SIZE(x) OPUS_PROJECTION_GET_DEMIXING_MATRIX_SIZE_REQUEST, opus_check_int_ptr(x)


/** Copies the demixing matrix to the supplied pointer location.
  * @param[out] x <tt>unsigned char *</tt>: Returns the demixing matrix to the
  *                                         supplied pointer location.
  * @param y <tt>opus_int32</tt>: The size in bytes of the reserved memory at the
  *                              pointer location.
  * @hideinitializer
  */
#define OPUS_PROJECTION_GET_DEMIXING_MATRIX(x,y) OPUS_PROJECTION_GET_DEMIXING_MATRIX_REQUEST, x, opus_check_int(y)


/**@}*/

/** Opus projection encoder state.
 * This contains the complete state of a projection Opus encoder.
 * It is position independent and can be freely copied.
 * @see opus_projection_ambisonics_encoder_create
 */
typedef struct OpusProjectionEncoder OpusProjectionEncoder;


/** Opus projection decoder state.
  * This contains the complete state of a projection Opus decoder.
  * It is position independent and can be freely copied.
  * @see opus_projection_decoder_create
  * @see opus_projection_decoder_init
  */
typedef struct OpusProjectionDecoder OpusProjectionDecoder;


/**\name Projection encoder functions */
/**@{*/

/** Gets the size of an OpusProjectionEncoder structure.
  * @param channels <tt>int</tt>: The total number of input channels to encode.
  *                               This must be no more than 255.
  * @param mapping_family <tt>int</tt>: The mapping family to use for selecting
  *                                     the appropriate projection.
  * @returns The size in bytes on success, or a negative error code
  *          (see @ref opus_errorcodes) on error.
  */
OPUS_EXPORT OPUS_WARN_UNUSED_RESULT opus_int32 opus_projection_ambisonics_encoder_get_size(
    int channels,
    int mapping_family
);


/** Allocates and initializes a projection encoder state.
  * Call opus_projection_encoder_destroy() to release
  * this object when finished.
  * @param Fs <tt>opus_int32</tt>: Sampling rate of the input signal (in Hz).
  *                                This must be one of 8000, 12000, 16000,
  *                                24000, or 48000.
  * @param channels <tt>int</tt>: Number of channels in the input signal.
  *                               This must be at most 255.
  *                               It may be greater than the number of
  *                               coded channels (<code>streams +
  *                               coupled_streams</code>).
  * @param mapping_family <tt>int</tt>: The mapping family to use for selecting
  *                                     the appropriate projection.
  * @param[out] streams <tt>int *</tt>: The total number of streams that will
  *                                     be encoded from the input.
  * @param[out] coupled_streams <tt>int *</tt>: Number of coupled (2 channel)
  *                                 streams that will be encoded from the input.
  * @param application <tt>int</tt>: The target encoder application.
  *                                  This must be one of the following:
  * <dl>
  * <dt>#OPUS_APPLICATION_VOIP</dt>
  * <dd>Process signal for improved speech intelligibility.</dd>
  * <dt>#OPUS_APPLICATION_AUDIO</dt>
  * <dd>Favor faithfulness to the original input.</dd>
  * <dt>#OPUS_APPLICATION_RESTRICTED_LOWDELAY</dt>
  * <dd>Configure the minimum possible coding delay by disabling certain modes
  * of operation.</dd>
  * </dl>
  * @param[out] error <tt>int *</tt>: Returns #OPUS_OK on success, or an error
  *                                   code (see @ref opus_errorcodes) on
  *                                   failure.
  */
OPUS_EXPORT OPUS_WARN_UNUSED_RESULT OpusProjectionEncoder *opus_projection_ambisonics_encoder_create(
    opus_int32 Fs,
    int channels,
    int mapping_family,
    int *streams,
    int *coupled_streams,
    int application,
    int *error
) OPUS_ARG_NONNULL(4) OPUS_ARG_NONNULL(5);


/** Initialize a previously allocated projection encoder state.
  * The memory pointed to by \a st must be at least the size returned by
  * opus_projection_ambisonics_encoder_get_size().
  * This is intended for applications which use their own allocator instead of
  * malloc.
  * To reset a previously initialized state, use the #OPUS_RESET_STATE CTL.
  * @see opus_projection_ambisonics_encoder_create
  * @see opus_projection_ambisonics_encoder_get_size
  * @param st <tt>OpusProjectionEncoder*</tt>: Projection encoder state to initialize.
  * @param Fs <tt>opus_int32</tt>: Sampling rate of the input signal (in Hz).
  *                                This must be one of 8000, 12000, 16000,
  *                                24000, or 48000.
  * @param channels <tt>int</tt>: Number of channels in the input signal.
  *                               This must be at most 255.
  *                               It may be greater than the number of
  *                               coded channels (<code>streams +
  *                               coupled_streams</code>).
  * @param streams <tt>int</tt>: The total number of streams to encode from the
  *                              input.
  *                              This must be no more than the number of channels.
  * @param coupled_streams <tt>int</tt>: Number of coupled (2 channel) streams
  *                                      to encode.
  *                                      This must be no larger than the total
  *                                      number of streams.
  *                                      Additionally, The total number of
  *                                      encoded channels (<code>streams +
  *                                      coupled_streams</code>) must be no
  *                                      more than the number of input channels.
  * @param application <tt>int</tt>: The target encoder application.
  *                                  This must be one of the following:
  * <dl>
  * <dt>#OPUS_APPLICATION_VOIP</dt>
  * <dd>Process signal for improved speech intelligibility.</dd>
  * <dt>#OPUS_APPLICATION_AUDIO</dt>
  * <dd>Favor faithfulness to the original input.</dd>
  * <dt>#OPUS_APPLICATION_RESTRICTED_LOWDELAY</dt>
  * <dd>Configure the minimum possible coding delay by disabling certain modes
  * of operation.</dd>
  * </dl>
  * @returns #OPUS_OK on success, or an error code (see @ref opus_errorcodes)
  *          on failure.
  */
OPUS_EXPORT int opus_projection_ambisonics_encoder_init(
    OpusProjectionEncoder *st,
    opus_int32 Fs,
    int channels,
    int mapping_family,
    int *streams,
    int *coupled_streams,
    int application
) OPUS_ARG_NONNULL(1) OPUS_ARG_NONNULL(5) OPUS_ARG_NONNULL(6);


/** Encodes a projection Opus frame.
  * @param st <tt>OpusProjectionEncoder*</tt>: Projection encoder state.
  * @param[in] pcm <tt>const opus_int16*</tt>: The input signal as interleaved
  *                                            samples.
  *                                            This must contain
  *                                            <code>frame_size*channels</code>
  *                                            samples.
  * @param frame_size <tt>int</tt>: Number of samples per channel in the input
  *                                 signal.
  *                                 This must be an Opus frame size for the
  *                                 encoder's sampling rate.
  *                                 For example, at 48 kHz the permitted values
  *                                 are 120, 240, 480, 960, 1920, and 2880.
  *                                 Passing in a duration of less than 10 ms
  *                                 (480 samples at 48 kHz) will prevent the
  *                                 encoder from using the LPC or hybrid modes.
  * @param[out] data <tt>unsigned char*</tt>: Output payload.
  *                                           This must contain storage for at
  *                                           least \a max_data_bytes.
  * @param [in] max_data_bytes <tt>opus_int32</tt>: Size of the allocated
  *                                                 memory for the output
  *                                                 payload. This may be
  *                                                 used to impose an upper limit on
  *                                                 the instant bitrate, but should
  *                                                 not be used as the only bitrate
  *                                                 control. Use #OPUS_SET_BITRATE to
  *                                                 control the bitrate.
  * @returns The length of the encoded packet (in bytes) on success or a
  *          negative error code (see @ref opus_errorcodes) on failure.
  */
OPUS_EXPORT OPUS_WARN_UNUSED_RESULT int opus_projection_encode(
    OpusProjectionEncoder *st,
    const opus_int16 *pcm,
    int frame_size,
    unsigned char *data,
    opus_int32 max_data_bytes
) OPUS_ARG_NONNULL(1) OPUS_ARG_NONNULL(2) OPUS_ARG_NONNULL(4);

/** Encodes a projection Opus frame.
  * @param st <tt>OpusProjectionEncoder*</tt>: Projection encoder state.
  * @param[in] pcm <tt>const opus_int32*</tt>: The input signal as interleaved
  *                                            samples representing (or slightly exceeding) 24-bit values.
  *                                            This must contain
  *                                            <code>frame_size*channels</code>
  *                                            samples.
  * @param frame_size <tt>int</tt>: Number of samples per channel in the input
  *                                 signal.
  *                                 This must be an Opus frame size for the
  *                                 encoder's sampling rate.
  *                                 For example, at 48 kHz the permitted values
  *                                 are 120, 240, 480, 960, 1920, and 2880.
  *                                 Passing in a duration of less than 10 ms
  *                                 (480 samples at 48 kHz) will prevent the
  *                                 encoder from using the LPC or hybrid modes.
  * @param[out] data <tt>unsigned char*</tt>: Output payload.
  *                                           This must contain storage for at
  *                                           least \a max_data_bytes.
  * @param [in] max_data_bytes <tt>opus_int32</tt>: Size of the allocated
  *                                                 memory for the output
  *                                                 payload. This may be
  *                                                 used to impose an upper limit on
  *                                                 the instant bitrate, but should
  *                                                 not be used as the only bitrate
  *                                                 control. Use #OPUS_SET_BITRATE to
  *                                                 control the bitrate.
  * @returns The length of the encoded packet (in bytes) on success or a
  *          negative error code (see @ref opus_errorcodes) on failure.
  */
OPUS_EXPORT OPUS_WARN_UNUSED_RESULT int opus_projection_encode24(
    OpusProjectionEncoder *st,
    const opus_int32 *pcm,
    int frame_size,
    unsigned char *data,
    opus_int32 max_data_bytes
) OPUS_ARG_NONNULL(1) OPUS_ARG_NONNULL(2) OPUS_ARG_NONNULL(4);


/** Encodes a projection Opus frame from floating point input.
  * @param st <tt>OpusProjectionEncoder*</tt>: Projection encoder state.
  * @param[in] pcm <tt>const float*</tt>: The input signal as interleaved
  *                                       samples with a normal range of
  *                                       +/-1.0.
  *                                       Samples with a range beyond +/-1.0
  *                                       are supported but will be clipped by
  *                                       decoders using the integer API and
  *                                       should only be used if it is known
  *                                       that the far end supports extended
  *                                       dynamic range.
  *                                       This must contain
  *                                       <code>frame_size*channels</code>
  *                                       samples.
  * @param frame_size <tt>int</tt>: Number of samples per channel in the input
  *                                 signal.
  *                                 This must be an Opus frame size for the
  *                                 encoder's sampling rate.
  *                                 For example, at 48 kHz the permitted values
  *                                 are 120, 240, 480, 960, 1920, and 2880.
  *                                 Passing in a duration of less than 10 ms
  *                                 (480 samples at 48 kHz) will prevent the
  *                                 encoder from using the LPC or hybrid modes.
  * @param[out] data <tt>unsigned char*</tt>: Output payload.
  *                                           This must contain storage for at
  *                                           least \a max_data_bytes.
  * @param [in] max_data_bytes <tt>opus_int32</tt>: Size of the allocated
  *                                                 memory for the output
  *                                                 payload. This may be
  *                                                 used to impose an upper limit on
  *                                                 the instant bitrate, but should
  *                                                 not be used as the only bitrate
  *                                                 control. Use #OPUS_SET_BITRATE to
  *                                                 control the bitrate.
  * @returns The length of the encoded packet (in bytes) on success or a
  *          negative error code (see @ref opus_errorcodes) on failure.
  */
OPUS_EXPORT OPUS_WARN_UNUSED_RESULT int opus_projection_encode_float(
    OpusProjectionEncoder *st,
    const float *pcm,
    int frame_size,
    unsigned char *data,
    opus_int32 max_data_bytes
) OPUS_ARG_NONNULL(1) OPUS_ARG_NONNULL(2) OPUS_ARG_NONNULL(4);


/** Frees an <code>OpusProjectionEncoder</code> allocated by
  * opus_projection_ambisonics_encoder_create().
  * @param st <tt>OpusProjectionEncoder*</tt>: Projection encoder state to be freed.
  */
OPUS_EXPORT void opus_projection_encoder_destroy(OpusProjectionEncoder *st);


/** Perform a CTL function on a projection Opus encoder.
  *
  * Generally the request and subsequent arguments are generated by a
  * convenience macro.
  * @param st <tt>OpusProjectionEncoder*</tt>: Projection encoder state.
  * @param request This and all remaining parameters should be replaced by one
  *                of the convenience macros in @ref opus_genericctls,
  *                @ref opus_encoderctls, @ref opus_multistream_ctls, or
  *                @ref opus_projection_ctls
  * @see opus_genericctls
  * @see opus_encoderctls
  * @see opus_multistream_ctls
  * @see opus_projection_ctls
  */
OPUS_EXPORT int opus_projection_encoder_ctl(OpusProjectionEncoder *st, int request, ...) OPUS_ARG_NONNULL(1);


/**@}*/

/**\name Projection decoder functions */
/**@{*/

/** Gets the size of an <code>OpusProjectionDecoder</code> structure.
  * @param channels <tt>int</tt>: The total number of output channels.
  *                               This must be no more than 255.
  * @param streams <tt>int</tt>: The total number of streams coded in the
  *                              input.
  *                              This must be no more than 255.
  * @param coupled_streams <tt>int</tt>: Number streams to decode as coupled
  *                                      (2 channel) streams.
  *                                      This must be no larger than the total
  *                                      number of streams.
  *                                      Additionally, The total number of
  *                                      coded channels (<code>streams +
  *                                      coupled_streams</code>) must be no
  *                                      more than 255.
  * @returns The size in bytes on success, or a negative error code
  *          (see @ref opus_errorcodes) on error.
  */
OPUS_EXPORT OPUS_WARN_UNUSED_RESULT opus_int32 opus_projection_decoder_get_size(
    int channels,
    int streams,
    int coupled_streams
);


/** Allocates and initializes a projection decoder state.
  * Call opus_projection_decoder_destroy() to release
  * this object when finished.
  * @param Fs <tt>opus_int32</tt>: Sampling rate to decode at (in Hz).
  *                                This must be one of 8000, 12000, 16000,
  *                                24000, or 48000.
  * @param channels <tt>int</tt>: Number of channels to output.
  *                               This must be at most 255.
  *                               It may be different from the number of coded
  *                               channels (<code>streams +
  *                               coupled_streams</code>).
  * @param streams <tt>int</tt>: The total number of streams coded in the
  *                              input.
  *                              This must be no more than 255.
  * @param coupled_streams <tt>int</tt>: Number of streams to decode as coupled
  *                                      (2 channel) streams.
  *                                      This must be no larger than the total
  *                                      number of streams.
  *                                      Additionally, The total number of
  *                                      coded channels (<code>streams +
  *                                      coupled_streams</code>) must be no
  *                                      more than 255.
  * @param[in] demixing_matrix <tt>const unsigned char[demixing_matrix_size]</tt>: Demixing matrix
  *                         that mapping from coded channels to output channels,
  *                         as described in @ref opus_projection and
  *                         @ref opus_projection_ctls.
  * @param demixing_matrix_size <tt>opus_int32</tt>: The size in bytes of the
  *                                                  demixing matrix, as
  *                                                  described in @ref
  *                                                  opus_projection_ctls.
  * @param[out] error <tt>int *</tt>: Returns #OPUS_OK on success, or an error
  *                                   code (see @ref opus_errorcodes) on
  *                                   failure.
  */
OPUS_EXPORT OPUS_WARN_UNUSED_RESULT OpusProjectionDecoder *opus_projection_decoder_create(
    opus_int32 Fs,
    int channels,
    int streams,
    int coupled_streams,
    unsigned char *demixing_matrix,
    opus_int32 demixing_matrix_size,
    int *error
) OPUS_ARG_NONNULL(5);


/** Initialize a previously allocated projection decoder state object.
  * The memory pointed to by \a st must be at least the size returned by
  * opus_projection_decoder_get_size().
  * This is intended for applications which use their own allocator instead of
  * malloc.
  * To reset a previously initialized state, use the #OPUS_RESET_STATE CTL.
  * @see opus_projection_decoder_create
  * @see opus_projection_deocder_get_size
  * @param st <tt>OpusProjectionDecoder*</tt>: Projection encoder state to initialize.
  * @param Fs <tt>opus_int32</tt>: Sampling rate to decode at (in Hz).
  *                                This must be one of 8000, 12000, 16000,
  *                                24000, or 48000.
  * @param channels <tt>int</tt>: Number of channels to output.
  *                               This must be at most 255.
  *                               It may be different from the number of coded
  *                               channels (<code>streams +
  *                               coupled_streams</code>).
  * @param streams <tt>int</tt>: The total number of streams coded in the
  *                              input.
  *                              This must be no more than 255.
  * @param coupled_streams <tt>int</tt>: Number of streams to decode as coupled
  *                                      (2 channel) streams.
  *                                      This must be no larger than the total
  *                                      number of streams.
  *                                      Additionally, The total number of
  *                                      coded channels (<code>streams +
  *                                      coupled_streams</code>) must be no
  *                                      more than 255.
  * @param[in] demixing_matrix <tt>const unsigned char[demixing_matrix_size]</tt>: Demixing matrix
  *                         that mapping from coded channels to output channels,
  *                         as described in @ref opus_projection and
  *                         @ref opus_projection_ctls.
  * @param demixing_matrix_size <tt>opus_int32</tt>: The size in bytes of the
  *                                                  demixing matrix, as
  *                                                  described in @ref
  *                                                  opus_projection_ctls.
  * @returns #OPUS_OK on success, or an error code (see @ref opus_errorcodes)
  *          on failure.
  */
OPUS_EXPORT int opus_projection_decoder_init(
    OpusProjectionDecoder *st,
    opus_int32 Fs,
    int channels,
    int streams,
    int coupled_streams,
    unsigned char *demixing_matrix,
    opus_int32 demixing_matrix_size
) OPUS_ARG_NONNULL(1) OPUS_ARG_NONNULL(6);


/** Decode a projection Opus packet.
  * @param st <tt>OpusProjectionDecoder*</tt>: Projection decoder state.
  * @param[in] data <tt>const unsigned char*</tt>: Input payload.
  *                                                Use a <code>NULL</code>
  *                                                pointer to indicate packet
  *                                                loss.
  * @param len <tt>opus_int32</tt>: Number of bytes in payload.
  * @param[out] pcm <tt>opus_int16*</tt>: Output signal, with interleaved
  *                                       samples.
  *                                       This must contain room for
  *                                       <code>frame_size*channels</code>
  *                                       samples.
  * @param frame_size <tt>int</tt>: The number of samples per channel of
  *                                 available space in \a pcm.
  *                                 If this is less than the maximum packet duration
  *                                 (120 ms; 5760 for 48kHz), this function will not be capable
  *                                 of decoding some packets. In the case of PLC (data==NULL)
  *                                 or FEC (decode_fec=1), then frame_size needs to be exactly
  *                                 the duration of audio that is missing, otherwise the
  *                                 decoder will not be in the optimal state to decode the
  *                                 next incoming packet. For the PLC and FEC cases, frame_size
  *                                 <b>must</b> be a multiple of 2.5 ms.
  * @param decode_fec <tt>int</tt>: Flag (0 or 1) to request that any in-band
  *                                 forward error correction data be decoded.
  *                                 If no such data is available, the frame is
  *                                 decoded as if it were lost.
  * @returns Number of samples decoded on success or a negative error code
  *          (see @ref opus_errorcodes) on failure.
  */
OPUS_EXPORT OPUS_WARN_UNUSED_RESULT int opus_projection_decode(
    OpusProjectionDecoder *st,
    const unsigned char *data,
    opus_int32 len,
    opus_int16 *pcm,
    int frame_size,
    int decode_fec
) OPUS_ARG_NONNULL(1) OPUS_ARG_NONNULL(4);

/** Decode a projection Opus packet.
  * @param st <tt>OpusProjectionDecoder*</tt>: Projection decoder state.
  * @param[in] data <tt>const unsigned char*</tt>: Input payload.
  *                                                Use a <code>NULL</code>
  *                                                pointer to indicate packet
  *                                                loss.
  * @param len <tt>opus_int32</tt>: Number of bytes in payload.
  * @param[out] pcm <tt>opus_int32*</tt>: Output signal, with interleaved
  *                                       samples representing (or slightly exceeding) 24-bit values.
  *                                       This must contain room for
  *                                       <code>frame_size*channels</code>
  *                                       samples.
  * @param frame_size <tt>int</tt>: The number of samples per channel of
  *                                 available space in \a pcm.
  *                                 If this is less than the maximum packet duration
  *                                 (120 ms; 5760 for 48kHz), this function will not be capable
  *                                 of decoding some packets. In the case of PLC (data==NULL)
  *                                 or FEC (decode_fec=1), then frame_size needs to be exactly
  *                                 the duration of audio that is missing, otherwise the
  *                                 decoder will not be in the optimal state to decode the
  *                                 next incoming packet. For the PLC and FEC cases, frame_size
  *                                 <b>must</b> be a multiple of 2.5 ms.
  * @param decode_fec <tt>int</tt>: Flag (0 or 1) to request that any in-band
  *                                 forward error correction data be decoded.
  *                                 If no such data is available, the frame is
  *                                 decoded as if it were lost.
  * @returns Number of samples decoded on success or a negative error code
  *          (see @ref opus_errorcodes) on failure.
  */
OPUS_EXPORT OPUS_WARN_UNUSED_RESULT int opus_projection_decode24(
    OpusProjectionDecoder *st,
    const unsigned char *data,
    opus_int32 len,
    opus_int32 *pcm,
    int frame_size,
    int decode_fec
) OPUS_ARG_NONNULL(1) OPUS_ARG_NONNULL(4);

/** Decode a projection Opus packet with floating point output.
  * @param st <tt>OpusProjectionDecoder*</tt>: Projection decoder state.
  * @param[in] data <tt>const unsigned char*</tt>: Input payload.
  *                                                Use a <code>NULL</code>
  *                                                pointer to indicate packet
  *                                                loss.
  * @param len <tt>opus_int32</tt>: Number of bytes in payload.
  * @param[out] pcm <tt>opus_int16*</tt>: Output signal, with interleaved
  *                                       samples.
  *                                       This must contain room for
  *                                       <code>frame_size*channels</code>
  *                                       samples.
  * @param frame_size <tt>int</tt>: The number of samples per channel of
  *                                 available space in \a pcm.
  *                                 If this is less than the maximum packet duration
  *                                 (120 ms; 5760 for 48kHz), this function will not be capable
  *                                 of decoding some packets. In the case of PLC (data==NULL)
  *                                 or FEC (decode_fec=1), then frame_size needs to be exactly
  *                                 the duration of audio that is missing, otherwise the
  *                                 decoder will not be in the optimal state to decode the
  *                                 next incoming packet. For the PLC and FEC cases, frame_size
  *                                 <b>must</b> be a multiple of 2.5 ms.
  * @param decode_fec <tt>int</tt>: Flag (0 or 1) to request that any in-band
  *                                 forward error correction data be decoded.
  *                                 If no such data is available, the frame is
  *                                 decoded as if it were lost.
  * @returns Number of samples decoded on success or a negative error code
  *          (see @ref opus_errorcodes) on failure.
  */
OPUS_EXPORT OPUS_WARN_UNUSED_RESULT int opus_projection_decode_float(
    OpusProjectionDecoder *st,
    const unsigned char *data,
    opus_int32 len,
    float *pcm,
    int frame_size,
    int decode_fec
) OPUS_ARG_NONNULL(1) OPUS_ARG_NONNULL(4);


/** Perform a CTL function on a projection Opus decoder.
  *
  * Generally the request and subsequent arguments are generated by a
  * convenience macro.
  * @param st <tt>OpusProjectionDecoder*</tt>: Projection decoder state.
  * @param request This and all remaining parameters should be replaced by one
  *                of the convenience macros in @ref opus_genericctls,
  *                @ref opus_decoderctls, @ref opus_multistream_ctls, or
  *                @ref opus_projection_ctls.
  * @see opus_genericctls
  * @see opus_decoderctls
  * @see opus_multistream_ctls
  * @see opus_projection_ctls
  */
OPUS_EXPORT int opus_projection_decoder_ctl(OpusProjectionDecoder *st, int request, ...) OPUS_ARG_NONNULL(1);


/** Frees an <code>OpusProjectionDecoder</code> allocated by
  * opus_projection_decoder_create().
  * @param st <tt>OpusProjectionDecoder</tt>: Projection decoder state to be freed.
  */
OPUS_EXPORT void opus_projection_decoder_destroy(OpusProjectionDecoder *st);


/**@}*/

/**@}*/

#ifdef __cplusplus
}
#endif

#endif /* OPUS_PROJECTION_H */
