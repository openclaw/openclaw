/* Copyright (c) 2011 Xiph.Org Foundation
   Written by Jean-Marc Valin */
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
 * @file opus_multistream.h
 * @brief Opus reference implementation multistream API
 */

#ifndef OPUS_MULTISTREAM_H
#define OPUS_MULTISTREAM_H

#include "opus.h"

#ifdef __cplusplus
extern "C" {
#endif

/** @cond OPUS_INTERNAL_DOC */

/** Macros to trigger compilation errors when the wrong types are provided to a
  * CTL. */
/**@{*/
#define opus_check_encstate_ptr(ptr) ((ptr) + ((ptr) - (OpusEncoder**)(ptr)))
#define opus_check_decstate_ptr(ptr) ((ptr) + ((ptr) - (OpusDecoder**)(ptr)))
/**@}*/

/** These are the actual encoder and decoder CTL ID numbers.
  * They should not be used directly by applications.
  * In general, SETs should be even and GETs should be odd.*/
/**@{*/
#define OPUS_MULTISTREAM_GET_ENCODER_STATE_REQUEST 5120
#define OPUS_MULTISTREAM_GET_DECODER_STATE_REQUEST 5122
/**@}*/

/** @endcond */

/** @defgroup opus_multistream_ctls Multistream specific encoder and decoder CTLs
  *
  * These are convenience macros that are specific to the
  * opus_multistream_encoder_ctl() and opus_multistream_decoder_ctl()
  * interface.
  * The CTLs from @ref opus_genericctls, @ref opus_encoderctls, and
  * @ref opus_decoderctls may be applied to a multistream encoder or decoder as
  * well.
  * In addition, you may retrieve the encoder or decoder state for an specific
  * stream via #OPUS_MULTISTREAM_GET_ENCODER_STATE or
  * #OPUS_MULTISTREAM_GET_DECODER_STATE and apply CTLs to it individually.
  */
/**@{*/

/** Gets the encoder state for an individual stream of a multistream encoder.
  * @param[in] x <tt>opus_int32</tt>: The index of the stream whose encoder you
  *                                   wish to retrieve.
  *                                   This must be non-negative and less than
  *                                   the <code>streams</code> parameter used
  *                                   to initialize the encoder.
  * @param[out] y <tt>OpusEncoder**</tt>: Returns a pointer to the given
  *                                       encoder state.
  * @retval OPUS_BAD_ARG The index of the requested stream was out of range.
  * @hideinitializer
  */
#define OPUS_MULTISTREAM_GET_ENCODER_STATE(x,y) OPUS_MULTISTREAM_GET_ENCODER_STATE_REQUEST, opus_check_int(x), opus_check_encstate_ptr(y)

/** Gets the decoder state for an individual stream of a multistream decoder.
  * @param[in] x <tt>opus_int32</tt>: The index of the stream whose decoder you
  *                                   wish to retrieve.
  *                                   This must be non-negative and less than
  *                                   the <code>streams</code> parameter used
  *                                   to initialize the decoder.
  * @param[out] y <tt>OpusDecoder**</tt>: Returns a pointer to the given
  *                                       decoder state.
  * @retval OPUS_BAD_ARG The index of the requested stream was out of range.
  * @hideinitializer
  */
#define OPUS_MULTISTREAM_GET_DECODER_STATE(x,y) OPUS_MULTISTREAM_GET_DECODER_STATE_REQUEST, opus_check_int(x), opus_check_decstate_ptr(y)

/**@}*/

/** @defgroup opus_multistream Opus Multistream API
  * @{
  *
  * The multistream API allows individual Opus streams to be combined into a
  * single packet, enabling support for up to 255 channels. Unlike an
  * elementary Opus stream, the encoder and decoder must negotiate the channel
  * configuration before the decoder can successfully interpret the data in the
  * packets produced by the encoder. Some basic information, such as packet
  * duration, can be computed without any special negotiation.
  *
  * The format for multistream Opus packets is defined in
  * <a href="https://tools.ietf.org/html/rfc7845">RFC 7845</a>
  * and is based on the self-delimited Opus framing described in Appendix B of
  * <a href="https://tools.ietf.org/html/rfc6716">RFC 6716</a>.
  * Normal Opus packets are just a degenerate case of multistream Opus packets,
  * and can be encoded or decoded with the multistream API by setting
  * <code>streams</code> to <code>1</code> when initializing the encoder or
  * decoder.
  *
  * Multistream Opus streams can contain up to 255 elementary Opus streams.
  * These may be either "uncoupled" or "coupled", indicating that the decoder
  * is configured to decode them to either 1 or 2 channels, respectively.
  * The streams are ordered so that all coupled streams appear at the
  * beginning.
  *
  * A <code>mapping</code> table defines which decoded channel <code>i</code>
  * should be used for each input/output (I/O) channel <code>j</code>. This table is
  * typically provided as an unsigned char array.
  * Let <code>i = mapping[j]</code> be the index for I/O channel <code>j</code>.
  * If <code>i < 2*coupled_streams</code>, then I/O channel <code>j</code> is
  * encoded as the left channel of stream <code>(i/2)</code> if <code>i</code>
  * is even, or  as the right channel of stream <code>(i/2)</code> if
  * <code>i</code> is odd. Otherwise, I/O channel <code>j</code> is encoded as
  * mono in stream <code>(i - coupled_streams)</code>, unless it has the special
  * value 255, in which case it is omitted from the encoding entirely (the
  * decoder will reproduce it as silence). Each value <code>i</code> must either
  * be the special value 255 or be less than <code>streams + coupled_streams</code>.
  *
  * The output channels specified by the encoder
  * should use the
  * <a href="https://www.xiph.org/vorbis/doc/Vorbis_I_spec.html#x1-810004.3.9">Vorbis
  * channel ordering</a>. A decoder may wish to apply an additional permutation
  * to the mapping the encoder used to achieve a different output channel
  * order (e.g. for outputting in WAV order).
  *
  * Each multistream packet contains an Opus packet for each stream, and all of
  * the Opus packets in a single multistream packet must have the same
  * duration. Therefore the duration of a multistream packet can be extracted
  * from the TOC sequence of the first stream, which is located at the
  * beginning of the packet, just like an elementary Opus stream:
  *
  * @code
  * int nb_samples;
  * int nb_frames;
  * nb_frames = opus_packet_get_nb_frames(data, len);
  * if (nb_frames < 1)
  *   return nb_frames;
  * nb_samples = opus_packet_get_samples_per_frame(data, 48000) * nb_frames;
  * @endcode
  *
  * The general encoding and decoding process proceeds exactly the same as in
  * the normal @ref opus_encoder and @ref opus_decoder APIs.
  * See their documentation for an overview of how to use the corresponding
  * multistream functions.
  */

/** Opus multistream encoder state.
  * This contains the complete state of a multistream Opus encoder.
  * It is position independent and can be freely copied.
  * @see opus_multistream_encoder_create
  * @see opus_multistream_encoder_init
  */
typedef struct OpusMSEncoder OpusMSEncoder;

/** Opus multistream decoder state.
  * This contains the complete state of a multistream Opus decoder.
  * It is position independent and can be freely copied.
  * @see opus_multistream_decoder_create
  * @see opus_multistream_decoder_init
  */
typedef struct OpusMSDecoder OpusMSDecoder;

/**\name Multistream encoder functions */
/**@{*/

/** Gets the size of an OpusMSEncoder structure.
  * @param streams <tt>int</tt>: The total number of streams to encode from the
  *                              input.
  *                              This must be no more than 255.
  * @param coupled_streams <tt>int</tt>: Number of coupled (2 channel) streams
  *                                      to encode.
  *                                      This must be no larger than the total
  *                                      number of streams.
  *                                      Additionally, The total number of
  *                                      encoded channels (<code>streams +
  *                                      coupled_streams</code>) must be no
  *                                      more than 255.
  * @returns The size in bytes on success, or a negative error code
  *          (see @ref opus_errorcodes) on error.
  */
OPUS_EXPORT OPUS_WARN_UNUSED_RESULT opus_int32 opus_multistream_encoder_get_size(
      int streams,
      int coupled_streams
);

OPUS_EXPORT OPUS_WARN_UNUSED_RESULT opus_int32 opus_multistream_surround_encoder_get_size(
      int channels,
      int mapping_family
);


/** Allocates and initializes a multistream encoder state.
  * Call opus_multistream_encoder_destroy() to release
  * this object when finished.
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
  * @param[in] mapping <code>const unsigned char[channels]</code>: Mapping from
  *                    encoded channels to input channels, as described in
  *                    @ref opus_multistream. As an extra constraint, the
  *                    multistream encoder does not allow encoding coupled
  *                    streams for which one channel is unused since this
  *                    is never a good idea.
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
OPUS_EXPORT OPUS_WARN_UNUSED_RESULT OpusMSEncoder *opus_multistream_encoder_create(
      opus_int32 Fs,
      int channels,
      int streams,
      int coupled_streams,
      const unsigned char *mapping,
      int application,
      int *error
) OPUS_ARG_NONNULL(5);

OPUS_EXPORT OPUS_WARN_UNUSED_RESULT OpusMSEncoder *opus_multistream_surround_encoder_create(
      opus_int32 Fs,
      int channels,
      int mapping_family,
      int *streams,
      int *coupled_streams,
      unsigned char *mapping,
      int application,
      int *error
) OPUS_ARG_NONNULL(4) OPUS_ARG_NONNULL(5) OPUS_ARG_NONNULL(6);

/** Initialize a previously allocated multistream encoder state.
  * The memory pointed to by \a st must be at least the size returned by
  * opus_multistream_encoder_get_size().
  * This is intended for applications which use their own allocator instead of
  * malloc.
  * To reset a previously initialized state, use the #OPUS_RESET_STATE CTL.
  * @see opus_multistream_encoder_create
  * @see opus_multistream_encoder_get_size
  * @param st <tt>OpusMSEncoder*</tt>: Multistream encoder state to initialize.
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
  * @param[in] mapping <code>const unsigned char[channels]</code>: Mapping from
  *                    encoded channels to input channels, as described in
  *                    @ref opus_multistream. As an extra constraint, the
  *                    multistream encoder does not allow encoding coupled
  *                    streams for which one channel is unused since this
  *                    is never a good idea.
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
OPUS_EXPORT int opus_multistream_encoder_init(
      OpusMSEncoder *st,
      opus_int32 Fs,
      int channels,
      int streams,
      int coupled_streams,
      const unsigned char *mapping,
      int application
) OPUS_ARG_NONNULL(1) OPUS_ARG_NONNULL(6);

OPUS_EXPORT int opus_multistream_surround_encoder_init(
      OpusMSEncoder *st,
      opus_int32 Fs,
      int channels,
      int mapping_family,
      int *streams,
      int *coupled_streams,
      unsigned char *mapping,
      int application
) OPUS_ARG_NONNULL(1) OPUS_ARG_NONNULL(5) OPUS_ARG_NONNULL(6) OPUS_ARG_NONNULL(7);

/** Encodes a multistream Opus frame.
  * @param st <tt>OpusMSEncoder*</tt>: Multistream encoder state.
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
OPUS_EXPORT OPUS_WARN_UNUSED_RESULT int opus_multistream_encode(
    OpusMSEncoder *st,
    const opus_int16 *pcm,
    int frame_size,
    unsigned char *data,
    opus_int32 max_data_bytes
) OPUS_ARG_NONNULL(1) OPUS_ARG_NONNULL(2) OPUS_ARG_NONNULL(4);

/** Encodes a multistream Opus frame.
  * @param st <tt>OpusMSEncoder*</tt>: Multistream encoder state.
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
OPUS_EXPORT OPUS_WARN_UNUSED_RESULT int opus_multistream_encode24(
    OpusMSEncoder *st,
    const opus_int32 *pcm,
    int frame_size,
    unsigned char *data,
    opus_int32 max_data_bytes
) OPUS_ARG_NONNULL(1) OPUS_ARG_NONNULL(2) OPUS_ARG_NONNULL(4);

/** Encodes a multistream Opus frame from floating point input.
  * @param st <tt>OpusMSEncoder*</tt>: Multistream encoder state.
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
OPUS_EXPORT OPUS_WARN_UNUSED_RESULT int opus_multistream_encode_float(
      OpusMSEncoder *st,
      const float *pcm,
      int frame_size,
      unsigned char *data,
      opus_int32 max_data_bytes
) OPUS_ARG_NONNULL(1) OPUS_ARG_NONNULL(2) OPUS_ARG_NONNULL(4);

/** Frees an <code>OpusMSEncoder</code> allocated by
  * opus_multistream_encoder_create().
  * @param st <tt>OpusMSEncoder*</tt>: Multistream encoder state to be freed.
  */
OPUS_EXPORT void opus_multistream_encoder_destroy(OpusMSEncoder *st);

/** Perform a CTL function on a multistream Opus encoder.
  *
  * Generally the request and subsequent arguments are generated by a
  * convenience macro.
  * @param st <tt>OpusMSEncoder*</tt>: Multistream encoder state.
  * @param request This and all remaining parameters should be replaced by one
  *                of the convenience macros in @ref opus_genericctls,
  *                @ref opus_encoderctls, or @ref opus_multistream_ctls.
  * @see opus_genericctls
  * @see opus_encoderctls
  * @see opus_multistream_ctls
  */
OPUS_EXPORT int opus_multistream_encoder_ctl(OpusMSEncoder *st, int request, ...) OPUS_ARG_NONNULL(1);

/**@}*/

/**\name Multistream decoder functions */
/**@{*/

/** Gets the size of an <code>OpusMSDecoder</code> structure.
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
OPUS_EXPORT OPUS_WARN_UNUSED_RESULT opus_int32 opus_multistream_decoder_get_size(
      int streams,
      int coupled_streams
);

/** Allocates and initializes a multistream decoder state.
  * Call opus_multistream_decoder_destroy() to release
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
  * @param[in] mapping <code>const unsigned char[channels]</code>: Mapping from
  *                    coded channels to output channels, as described in
  *                    @ref opus_multistream.
  * @param[out] error <tt>int *</tt>: Returns #OPUS_OK on success, or an error
  *                                   code (see @ref opus_errorcodes) on
  *                                   failure.
  */
OPUS_EXPORT OPUS_WARN_UNUSED_RESULT OpusMSDecoder *opus_multistream_decoder_create(
      opus_int32 Fs,
      int channels,
      int streams,
      int coupled_streams,
      const unsigned char *mapping,
      int *error
) OPUS_ARG_NONNULL(5);

/** Initialize a previously allocated decoder state object.
  * The memory pointed to by \a st must be at least the size returned by
  * opus_multistream_encoder_get_size().
  * This is intended for applications which use their own allocator instead of
  * malloc.
  * To reset a previously initialized state, use the #OPUS_RESET_STATE CTL.
  * @see opus_multistream_decoder_create
  * @see opus_multistream_deocder_get_size
  * @param st <tt>OpusMSEncoder*</tt>: Multistream encoder state to initialize.
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
  * @param[in] mapping <code>const unsigned char[channels]</code>: Mapping from
  *                    coded channels to output channels, as described in
  *                    @ref opus_multistream.
  * @returns #OPUS_OK on success, or an error code (see @ref opus_errorcodes)
  *          on failure.
  */
OPUS_EXPORT int opus_multistream_decoder_init(
      OpusMSDecoder *st,
      opus_int32 Fs,
      int channels,
      int streams,
      int coupled_streams,
      const unsigned char *mapping
) OPUS_ARG_NONNULL(1) OPUS_ARG_NONNULL(6);

/** Decode a multistream Opus packet.
  * @param st <tt>OpusMSDecoder*</tt>: Multistream decoder state.
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
OPUS_EXPORT OPUS_WARN_UNUSED_RESULT int opus_multistream_decode(
    OpusMSDecoder *st,
    const unsigned char *data,
    opus_int32 len,
    opus_int16 *pcm,
    int frame_size,
    int decode_fec
) OPUS_ARG_NONNULL(1) OPUS_ARG_NONNULL(4);

/** Decode a multistream Opus packet.
  * @param st <tt>OpusMSDecoder*</tt>: Multistream decoder state.
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
OPUS_EXPORT OPUS_WARN_UNUSED_RESULT int opus_multistream_decode24(
    OpusMSDecoder *st,
    const unsigned char *data,
    opus_int32 len,
    opus_int32 *pcm,
    int frame_size,
    int decode_fec
) OPUS_ARG_NONNULL(1) OPUS_ARG_NONNULL(4);

/** Decode a multistream Opus packet with floating point output.
  * @param st <tt>OpusMSDecoder*</tt>: Multistream decoder state.
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
OPUS_EXPORT OPUS_WARN_UNUSED_RESULT int opus_multistream_decode_float(
    OpusMSDecoder *st,
    const unsigned char *data,
    opus_int32 len,
    float *pcm,
    int frame_size,
    int decode_fec
) OPUS_ARG_NONNULL(1) OPUS_ARG_NONNULL(4);

/** Perform a CTL function on a multistream Opus decoder.
  *
  * Generally the request and subsequent arguments are generated by a
  * convenience macro.
  * @param st <tt>OpusMSDecoder*</tt>: Multistream decoder state.
  * @param request This and all remaining parameters should be replaced by one
  *                of the convenience macros in @ref opus_genericctls,
  *                @ref opus_decoderctls, or @ref opus_multistream_ctls.
  * @see opus_genericctls
  * @see opus_decoderctls
  * @see opus_multistream_ctls
  */
OPUS_EXPORT int opus_multistream_decoder_ctl(OpusMSDecoder *st, int request, ...) OPUS_ARG_NONNULL(1);

/** Frees an <code>OpusMSDecoder</code> allocated by
  * opus_multistream_decoder_create().
  * @param st <tt>OpusMSDecoder</tt>: Multistream decoder state to be freed.
  */
OPUS_EXPORT void opus_multistream_decoder_destroy(OpusMSDecoder *st);

/**@}*/

/**@}*/

#ifdef __cplusplus
}
#endif

#endif /* OPUS_MULTISTREAM_H */
