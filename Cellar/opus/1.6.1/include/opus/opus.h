/* Copyright (c) 2010-2011 Xiph.Org Foundation, Skype Limited
   Written by Jean-Marc Valin and Koen Vos */
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
 * @file opus.h
 * @brief Opus reference implementation API
 */

#ifndef OPUS_H
#define OPUS_H

#include "opus_types.h"
#include "opus_defines.h"

#ifdef __cplusplus
extern "C" {
#endif

/**
 * @mainpage Opus
 *
 * The Opus codec is designed for interactive speech and audio transmission over the Internet.
 * It is designed by the IETF Codec Working Group and incorporates technology from
 * Skype's SILK codec and Xiph.Org's CELT codec.
 *
 * The Opus codec is designed to handle a wide range of interactive audio applications,
 * including Voice over IP, videoconferencing, in-game chat, and even remote live music
 * performances. It can scale from low bit-rate narrowband speech to very high quality
 * stereo music. Its main features are:

 * @li Sampling rates from 8 to 48 kHz
 * @li Bit-rates from 6 kb/s to 510 kb/s
 * @li Support for both constant bit-rate (CBR) and variable bit-rate (VBR)
 * @li Audio bandwidth from narrowband to full-band
 * @li Support for speech and music
 * @li Support for mono and stereo
 * @li Support for multichannel (up to 255 channels)
 * @li Frame sizes from 2.5 ms to 60 ms
 * @li Good loss robustness and packet loss concealment (PLC)
 * @li Floating point and fixed-point implementation
 *
 * Documentation sections:
 * @li @ref opus_encoder
 * @li @ref opus_decoder
 * @li @ref opus_repacketizer
 * @li @ref opus_multistream
 * @li @ref opus_libinfo
 * @li @ref opus_custom
 */

/** @defgroup opus_encoder Opus Encoder
  * @{
  *
  * @brief This page describes the process and functions used to encode Opus.
  *
  * Since Opus is a stateful codec, the encoding process starts with creating an encoder
  * state. This can be done with:
  *
  * @code
  * int          error;
  * OpusEncoder *enc;
  * enc = opus_encoder_create(Fs, channels, application, &error);
  * @endcode
  *
  * From this point, @c enc can be used for encoding an audio stream. An encoder state
  * @b must @b not be used for more than one stream at the same time. Similarly, the encoder
  * state @b must @b not be re-initialized for each frame.
  *
  * While opus_encoder_create() allocates memory for the state, it's also possible
  * to initialize pre-allocated memory:
  *
  * @code
  * int          size;
  * int          error;
  * OpusEncoder *enc;
  * size = opus_encoder_get_size(channels);
  * enc = malloc(size);
  * error = opus_encoder_init(enc, Fs, channels, application);
  * @endcode
  *
  * where opus_encoder_get_size() returns the required size for the encoder state. Note that
  * future versions of this code may change the size, so no assumptions should be made about it.
  *
  * The encoder state is always continuous in memory and only a shallow copy is sufficient
  * to copy it (e.g. memcpy())
  *
  * It is possible to change some of the encoder's settings using the opus_encoder_ctl()
  * interface. All these settings already default to the recommended value, so they should
  * only be changed when necessary. The most common settings one may want to change are:
  *
  * @code
  * opus_encoder_ctl(enc, OPUS_SET_BITRATE(bitrate));
  * opus_encoder_ctl(enc, OPUS_SET_COMPLEXITY(complexity));
  * opus_encoder_ctl(enc, OPUS_SET_SIGNAL(signal_type));
  * @endcode
  *
  * where
  *
  * @arg bitrate is in bits per second (b/s)
  * @arg complexity is a value from 1 to 10, where 1 is the lowest complexity and 10 is the highest
  * @arg signal_type is either OPUS_AUTO (default), OPUS_SIGNAL_VOICE, or OPUS_SIGNAL_MUSIC
  *
  * See @ref opus_encoderctls and @ref opus_genericctls for a complete list of parameters that can be set or queried. Most parameters can be set or changed at any time during a stream.
  *
  * To encode a frame, opus_encode() or opus_encode_float() must be called with exactly one frame (2.5, 5, 10, 20, 40 or 60 ms) of audio data:
  * @code
  * len = opus_encode(enc, audio_frame, frame_size, packet, max_packet);
  * @endcode
  *
  * where
  * <ul>
  * <li>audio_frame is the audio data in opus_int16 (or float for opus_encode_float())</li>
  * <li>frame_size is the duration of the frame in samples (per channel)</li>
  * <li>packet is the byte array to which the compressed data is written</li>
  * <li>max_packet is the maximum number of bytes that can be written in the packet (4000 bytes is recommended).
  *     Do not use max_packet to control VBR target bitrate, instead use the #OPUS_SET_BITRATE CTL.</li>
  * </ul>
  *
  * opus_encode() and opus_encode_float() return the number of bytes actually written to the packet.
  * The return value <b>can be negative</b>, which indicates that an error has occurred. If the return value
  * is 2 bytes or less, then the packet does not need to be transmitted (DTX).
  *
  * Once the encoder state if no longer needed, it can be destroyed with
  *
  * @code
  * opus_encoder_destroy(enc);
  * @endcode
  *
  * If the encoder was created with opus_encoder_init() rather than opus_encoder_create(),
  * then no action is required aside from potentially freeing the memory that was manually
  * allocated for it (calling free(enc) for the example above)
  *
  */

/** Opus encoder state.
  * This contains the complete state of an Opus encoder.
  * It is position independent and can be freely copied.
  * @see opus_encoder_create,opus_encoder_init
  */
typedef struct OpusEncoder OpusEncoder;

/** Gets the size of an <code>OpusEncoder</code> structure.
  * @param[in] channels <tt>int</tt>: Number of channels.
  *                                   This must be 1 or 2.
  * @returns The size in bytes.
  * @note Since this function does not take the application as input, it will overestimate
  * the size required for OPUS_APPLICATION_RESTRICTED_SILK and OPUS_APPLICATION_RESTRICTED_CELT.
  * That is generally not a problem, except when trying to know the size to use for a copy.
  */
OPUS_EXPORT OPUS_WARN_UNUSED_RESULT int opus_encoder_get_size(int channels);

/**
 */

/** Allocates and initializes an encoder state.
 * There are three coding modes:
 *
 * @ref OPUS_APPLICATION_VOIP gives best quality at a given bitrate for voice
 *    signals. It enhances the  input signal by high-pass filtering and
 *    emphasizing formants and harmonics. Optionally  it includes in-band
 *    forward error correction to protect against packet loss. Use this
 *    mode for typical VoIP applications. Because of the enhancement,
 *    even at high bitrates the output may sound different from the input.
 *
 * @ref OPUS_APPLICATION_AUDIO gives best quality at a given bitrate for most
 *    non-voice signals like music. Use this mode for music and mixed
 *    (music/voice) content, broadcast, and applications requiring less
 *    than 15 ms of coding delay.
 *
 * @ref OPUS_APPLICATION_RESTRICTED_LOWDELAY configures low-delay mode that
 *    disables the speech-optimized mode in exchange for slightly reduced delay.
 *    This mode can only be set on an newly initialized or freshly reset encoder
 *    because it changes the codec delay.
 *
 * This is useful when the caller knows that the speech-optimized modes will not be needed (use with caution).
 * @param [in] Fs <tt>opus_int32</tt>: Sampling rate of input signal (Hz)
 *                                     This must be one of 8000, 12000, 16000,
 *                                     24000, or 48000.
 * @param [in] channels <tt>int</tt>: Number of channels (1 or 2) in input signal
 * @param [in] application <tt>int</tt>: Coding mode (one of @ref OPUS_APPLICATION_VOIP, @ref OPUS_APPLICATION_AUDIO, or @ref OPUS_APPLICATION_RESTRICTED_LOWDELAY)
 * @param [out] error <tt>int*</tt>: @ref opus_errorcodes
 * @note Regardless of the sampling rate and number channels selected, the Opus encoder
 * can switch to a lower audio bandwidth or number of channels if the bitrate
 * selected is too low. This also means that it is safe to always use 48 kHz stereo input
 * and let the encoder optimize the encoding.
 */
OPUS_EXPORT OPUS_WARN_UNUSED_RESULT OpusEncoder *opus_encoder_create(
    opus_int32 Fs,
    int channels,
    int application,
    int *error
);

/** Initializes a previously allocated encoder state
  * The memory pointed to by st must be at least the size returned by opus_encoder_get_size().
  * This is intended for applications which use their own allocator instead of malloc.
  * @see opus_encoder_create(),opus_encoder_get_size()
  * To reset a previously initialized state, use the #OPUS_RESET_STATE CTL.
  * @param [in] st <tt>OpusEncoder*</tt>: Encoder state
  * @param [in] Fs <tt>opus_int32</tt>: Sampling rate of input signal (Hz)
 *                                      This must be one of 8000, 12000, 16000,
 *                                      24000, or 48000.
  * @param [in] channels <tt>int</tt>: Number of channels (1 or 2) in input signal
  * @param [in] application <tt>int</tt>: Coding mode (one of OPUS_APPLICATION_VOIP, OPUS_APPLICATION_AUDIO, or OPUS_APPLICATION_RESTRICTED_LOWDELAY)
  * @retval #OPUS_OK Success or @ref opus_errorcodes
  */
OPUS_EXPORT int opus_encoder_init(
    OpusEncoder *st,
    opus_int32 Fs,
    int channels,
    int application
) OPUS_ARG_NONNULL(1);

/** Encodes an Opus frame.
  * @param [in] st <tt>OpusEncoder*</tt>: Encoder state
  * @param [in] pcm <tt>opus_int16*</tt>: Input signal (interleaved if 2 channels). length is frame_size*channels*sizeof(opus_int16)
  * @param [in] frame_size <tt>int</tt>: Number of samples per channel in the
  *                                      input signal.
  *                                      This must be an Opus frame size for
  *                                      the encoder's sampling rate.
  *                                      For example, at 48 kHz the permitted
  *                                      values are 120, 240, 480, 960, 1920,
  *                                      and 2880.
  *                                      Passing in a duration of less than
  *                                      10 ms (480 samples at 48 kHz) will
  *                                      prevent the encoder from using the LPC
  *                                      or hybrid modes.
  * @param [out] data <tt>unsigned char*</tt>: Output payload.
  *                                            This must contain storage for at
  *                                            least \a max_data_bytes.
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
OPUS_EXPORT OPUS_WARN_UNUSED_RESULT opus_int32 opus_encode(
    OpusEncoder *st,
    const opus_int16 *pcm,
    int frame_size,
    unsigned char *data,
    opus_int32 max_data_bytes
) OPUS_ARG_NONNULL(1) OPUS_ARG_NONNULL(2) OPUS_ARG_NONNULL(4);

/** Encodes an Opus frame.
  * @param [in] st <tt>OpusEncoder*</tt>: Encoder state
  * @param [in] pcm <tt>opus_int32*</tt>: Input signal (interleaved if 2 channels) representing (or slightly exceeding) 24-bit values. length is frame_size*channels*sizeof(opus_int32)
  * @param [in] frame_size <tt>int</tt>: Number of samples per channel in the
  *                                      input signal.
  *                                      This must be an Opus frame size for
  *                                      the encoder's sampling rate.
  *                                      For example, at 48 kHz the permitted
  *                                      values are 120, 240, 480, 960, 1920,
  *                                      and 2880.
  *                                      Passing in a duration of less than
  *                                      10 ms (480 samples at 48 kHz) will
  *                                      prevent the encoder from using the LPC
  *                                      or hybrid modes.
  * @param [out] data <tt>unsigned char*</tt>: Output payload.
  *                                            This must contain storage for at
  *                                            least \a max_data_bytes.
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
OPUS_EXPORT OPUS_WARN_UNUSED_RESULT opus_int32 opus_encode24(
    OpusEncoder *st,
    const opus_int32 *pcm,
    int frame_size,
    unsigned char *data,
    opus_int32 max_data_bytes
) OPUS_ARG_NONNULL(1) OPUS_ARG_NONNULL(2) OPUS_ARG_NONNULL(4);

/** Encodes an Opus frame from floating point input.
  * @param [in] st <tt>OpusEncoder*</tt>: Encoder state
  * @param [in] pcm <tt>float*</tt>: Input in float format (interleaved if 2 channels), with a normal range of +/-1.0.
  *          Samples with a range beyond +/-1.0 are supported but will
  *          be clipped by decoders using the integer API and should
  *          only be used if it is known that the far end supports
  *          extended dynamic range.
  *          length is frame_size*channels*sizeof(float)
  * @param [in] frame_size <tt>int</tt>: Number of samples per channel in the
  *                                      input signal.
  *                                      This must be an Opus frame size for
  *                                      the encoder's sampling rate.
  *                                      For example, at 48 kHz the permitted
  *                                      values are 120, 240, 480, 960, 1920,
  *                                      and 2880.
  *                                      Passing in a duration of less than
  *                                      10 ms (480 samples at 48 kHz) will
  *                                      prevent the encoder from using the LPC
  *                                      or hybrid modes.
  * @param [out] data <tt>unsigned char*</tt>: Output payload.
  *                                            This must contain storage for at
  *                                            least \a max_data_bytes.
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
OPUS_EXPORT OPUS_WARN_UNUSED_RESULT opus_int32 opus_encode_float(
    OpusEncoder *st,
    const float *pcm,
    int frame_size,
    unsigned char *data,
    opus_int32 max_data_bytes
) OPUS_ARG_NONNULL(1) OPUS_ARG_NONNULL(2) OPUS_ARG_NONNULL(4);

/** Frees an <code>OpusEncoder</code> allocated by opus_encoder_create().
  * @param[in] st <tt>OpusEncoder*</tt>: State to be freed.
  */
OPUS_EXPORT void opus_encoder_destroy(OpusEncoder *st);

/** Perform a CTL function on an Opus encoder.
  *
  * Generally the request and subsequent arguments are generated
  * by a convenience macro.
  * @param st <tt>OpusEncoder*</tt>: Encoder state.
  * @param request This and all remaining parameters should be replaced by one
  *                of the convenience macros in @ref opus_genericctls or
  *                @ref opus_encoderctls.
  * @see opus_genericctls
  * @see opus_encoderctls
  */
OPUS_EXPORT int opus_encoder_ctl(OpusEncoder *st, int request, ...) OPUS_ARG_NONNULL(1);
/**@}*/

/** @defgroup opus_decoder Opus Decoder
  * @{
  *
  * @brief This page describes the process and functions used to decode Opus.
  *
  * The decoding process also starts with creating a decoder
  * state. This can be done with:
  * @code
  * int          error;
  * OpusDecoder *dec;
  * dec = opus_decoder_create(Fs, channels, &error);
  * @endcode
  * where
  * @li Fs is the sampling rate and must be 8000, 12000, 16000, 24000, or 48000
  * @li channels is the number of channels (1 or 2)
  * @li error will hold the error code in case of failure (or #OPUS_OK on success)
  * @li the return value is a newly created decoder state to be used for decoding
  *
  * While opus_decoder_create() allocates memory for the state, it's also possible
  * to initialize pre-allocated memory:
  * @code
  * int          size;
  * int          error;
  * OpusDecoder *dec;
  * size = opus_decoder_get_size(channels);
  * dec = malloc(size);
  * error = opus_decoder_init(dec, Fs, channels);
  * @endcode
  * where opus_decoder_get_size() returns the required size for the decoder state. Note that
  * future versions of this code may change the size, so no assumptions should be made about it.
  *
  * The decoder state is always continuous in memory and only a shallow copy is sufficient
  * to copy it (e.g. memcpy())
  *
  * To decode a frame, opus_decode() or opus_decode_float() must be called with a packet of compressed audio data:
  * @code
  * frame_size = opus_decode(dec, packet, len, decoded, max_size, 0);
  * @endcode
  * where
  *
  * @li packet is the byte array containing the compressed data
  * @li len is the exact number of bytes contained in the packet
  * @li decoded is the decoded audio data in opus_int16 (or float for opus_decode_float())
  * @li max_size is the max duration of the frame in samples (per channel) that can fit into the decoded_frame array
  *
  * opus_decode() and opus_decode_float() return the number of samples (per channel) decoded from the packet.
  * If that value is negative, then an error has occurred. This can occur if the packet is corrupted or if the audio
  * buffer is too small to hold the decoded audio.
  *
  * Opus is a stateful codec with overlapping blocks and as a result Opus
  * packets are not coded independently of each other. Packets must be
  * passed into the decoder serially and in the correct order for a correct
  * decode. Lost packets can be replaced with loss concealment by calling
  * the decoder with a null pointer and zero length for the missing packet.
  *
  * A single codec state may only be accessed from a single thread at
  * a time and any required locking must be performed by the caller. Separate
  * streams must be decoded with separate decoder states and can be decoded
  * in parallel unless the library was compiled with NONTHREADSAFE_PSEUDOSTACK
  * defined.
  *
  */

/** Opus decoder state.
  * This contains the complete state of an Opus decoder.
  * It is position independent and can be freely copied.
  * @see opus_decoder_create,opus_decoder_init
  */
typedef struct OpusDecoder OpusDecoder;

/** Opus DRED decoder.
  * This contains the complete state of an Opus DRED decoder.
  * It is position independent and can be freely copied.
  * @see opus_dred_decoder_create,opus_dred_decoder_init
  */
typedef struct OpusDREDDecoder OpusDREDDecoder;


/** Opus DRED state.
  * This contains the complete state of an Opus DRED packet.
  * It is position independent and can be freely copied.
  * @see opus_dred_create,opus_dred_init
  */
typedef struct OpusDRED OpusDRED;

/** Gets the size of an <code>OpusDecoder</code> structure.
  * @param [in] channels <tt>int</tt>: Number of channels.
  *                                    This must be 1 or 2.
  * @returns The size in bytes.
  */
OPUS_EXPORT OPUS_WARN_UNUSED_RESULT int opus_decoder_get_size(int channels);

/** Allocates and initializes a decoder state.
  * @param [in] Fs <tt>opus_int32</tt>: Sample rate to decode at (Hz).
  *                                     This must be one of 8000, 12000, 16000,
  *                                     24000, or 48000.
  * @param [in] channels <tt>int</tt>: Number of channels (1 or 2) to decode
  * @param [out] error <tt>int*</tt>: #OPUS_OK Success or @ref opus_errorcodes
  *
  * Internally Opus stores data at 48000 Hz, so that should be the default
  * value for Fs. However, the decoder can efficiently decode to buffers
  * at 8, 12, 16, and 24 kHz so if for some reason the caller cannot use
  * data at the full sample rate, or knows the compressed data doesn't
  * use the full frequency range, it can request decoding at a reduced
  * rate. Likewise, the decoder is capable of filling in either mono or
  * interleaved stereo pcm buffers, at the caller's request.
  */
OPUS_EXPORT OPUS_WARN_UNUSED_RESULT OpusDecoder *opus_decoder_create(
    opus_int32 Fs,
    int channels,
    int *error
);

/** Initializes a previously allocated decoder state.
  * The state must be at least the size returned by opus_decoder_get_size().
  * This is intended for applications which use their own allocator instead of malloc. @see opus_decoder_create,opus_decoder_get_size
  * To reset a previously initialized state, use the #OPUS_RESET_STATE CTL.
  * @param [in] st <tt>OpusDecoder*</tt>: Decoder state.
  * @param [in] Fs <tt>opus_int32</tt>: Sampling rate to decode to (Hz).
  *                                     This must be one of 8000, 12000, 16000,
  *                                     24000, or 48000.
  * @param [in] channels <tt>int</tt>: Number of channels (1 or 2) to decode
  * @retval #OPUS_OK Success or @ref opus_errorcodes
  */
OPUS_EXPORT int opus_decoder_init(
    OpusDecoder *st,
    opus_int32 Fs,
    int channels
) OPUS_ARG_NONNULL(1);

/** Decode an Opus packet.
  * @param [in] st <tt>OpusDecoder*</tt>: Decoder state
  * @param [in] data <tt>char*</tt>: Input payload. Use a NULL pointer to indicate packet loss
  * @param [in] len <tt>opus_int32</tt>: Number of bytes in payload*
  * @param [out] pcm <tt>opus_int16*</tt>: Output signal (interleaved if 2 channels). length
  *  is frame_size*channels*sizeof(opus_int16)
  * @param [in] frame_size Number of samples per channel of available space in \a pcm.
  *  If this is less than the maximum packet duration (120ms; 5760 for 48kHz), this function will
  *  not be capable of decoding some packets. In the case of PLC (data==NULL) or FEC (decode_fec=1),
  *  then frame_size needs to be exactly the duration of audio that is missing, otherwise the
  *  decoder will not be in the optimal state to decode the next incoming packet. For the PLC and
  *  FEC cases, frame_size <b>must</b> be a multiple of 2.5 ms.
  * @param [in] decode_fec <tt>int</tt>: Flag (0 or 1) to request that any in-band forward error correction data be
  *  decoded. If no such data is available, the frame is decoded as if it were lost.
  * @returns Number of decoded samples per channel or @ref opus_errorcodes
  */
OPUS_EXPORT OPUS_WARN_UNUSED_RESULT int opus_decode(
    OpusDecoder *st,
    const unsigned char *data,
    opus_int32 len,
    opus_int16 *pcm,
    int frame_size,
    int decode_fec
) OPUS_ARG_NONNULL(1) OPUS_ARG_NONNULL(4);

/** Decode an Opus packet.
  * @param [in] st <tt>OpusDecoder*</tt>: Decoder state
  * @param [in] data <tt>char*</tt>: Input payload. Use a NULL pointer to indicate packet loss
  * @param [in] len <tt>opus_int32</tt>: Number of bytes in payload*
  * @param [out] pcm <tt>opus_int32*</tt>: Output signal (interleaved if 2 channels) representing (or slightly exceeding) 24-bit values. length
  *  is frame_size*channels*sizeof(opus_int32)
  * @param [in] frame_size Number of samples per channel of available space in \a pcm.
  *  If this is less than the maximum packet duration (120ms; 5760 for 48kHz), this function will
  *  not be capable of decoding some packets. In the case of PLC (data==NULL) or FEC (decode_fec=1),
  *  then frame_size needs to be exactly the duration of audio that is missing, otherwise the
  *  decoder will not be in the optimal state to decode the next incoming packet. For the PLC and
  *  FEC cases, frame_size <b>must</b> be a multiple of 2.5 ms.
  * @param [in] decode_fec <tt>int</tt>: Flag (0 or 1) to request that any in-band forward error correction data be
  *  decoded. If no such data is available, the frame is decoded as if it were lost.
  * @returns Number of decoded samples or @ref opus_errorcodes
  */
OPUS_EXPORT OPUS_WARN_UNUSED_RESULT int opus_decode24(
    OpusDecoder *st,
    const unsigned char *data,
    opus_int32 len,
    opus_int32 *pcm,
    int frame_size,
    int decode_fec
) OPUS_ARG_NONNULL(1) OPUS_ARG_NONNULL(4);

/** Decode an Opus packet with floating point output.
  * @param [in] st <tt>OpusDecoder*</tt>: Decoder state
  * @param [in] data <tt>char*</tt>: Input payload. Use a NULL pointer to indicate packet loss
  * @param [in] len <tt>opus_int32</tt>: Number of bytes in payload
  * @param [out] pcm <tt>float*</tt>: Output signal (interleaved if 2 channels). length
  *  is frame_size*channels*sizeof(float)
  * @param [in] frame_size Number of samples per channel of available space in \a pcm.
  *  If this is less than the maximum packet duration (120ms; 5760 for 48kHz), this function will
  *  not be capable of decoding some packets. In the case of PLC (data==NULL) or FEC (decode_fec=1),
  *  then frame_size needs to be exactly the duration of audio that is missing, otherwise the
  *  decoder will not be in the optimal state to decode the next incoming packet. For the PLC and
  *  FEC cases, frame_size <b>must</b> be a multiple of 2.5 ms.
  * @param [in] decode_fec <tt>int</tt>: Flag (0 or 1) to request that any in-band forward error correction data be
  *  decoded. If no such data is available the frame is decoded as if it were lost.
  * @returns Number of decoded samples per channel or @ref opus_errorcodes
  */
OPUS_EXPORT OPUS_WARN_UNUSED_RESULT int opus_decode_float(
    OpusDecoder *st,
    const unsigned char *data,
    opus_int32 len,
    float *pcm,
    int frame_size,
    int decode_fec
) OPUS_ARG_NONNULL(1) OPUS_ARG_NONNULL(4);

/** Perform a CTL function on an Opus decoder.
  *
  * Generally the request and subsequent arguments are generated
  * by a convenience macro.
  * @param st <tt>OpusDecoder*</tt>: Decoder state.
  * @param request This and all remaining parameters should be replaced by one
  *                of the convenience macros in @ref opus_genericctls or
  *                @ref opus_decoderctls.
  * @see opus_genericctls
  * @see opus_decoderctls
  */
OPUS_EXPORT int opus_decoder_ctl(OpusDecoder *st, int request, ...) OPUS_ARG_NONNULL(1);

/** Frees an <code>OpusDecoder</code> allocated by opus_decoder_create().
  * @param[in] st <tt>OpusDecoder*</tt>: State to be freed.
  */
OPUS_EXPORT void opus_decoder_destroy(OpusDecoder *st);

/** Gets the size of an <code>OpusDREDDecoder</code> structure.
  * @returns The size in bytes.
  */
OPUS_EXPORT int opus_dred_decoder_get_size(void);

/** Allocates and initializes an OpusDREDDecoder state.
  * @param [out] error <tt>int*</tt>: #OPUS_OK Success or @ref opus_errorcodes
  */
OPUS_EXPORT OpusDREDDecoder *opus_dred_decoder_create(int *error);

/** Initializes an <code>OpusDREDDecoder</code> state.
  * @param[in] dec <tt>OpusDREDDecoder*</tt>: State to be initialized.
  */
OPUS_EXPORT int opus_dred_decoder_init(OpusDREDDecoder *dec);

/** Frees an <code>OpusDREDDecoder</code> allocated by opus_dred_decoder_create().
  * @param[in] dec <tt>OpusDREDDecoder*</tt>: State to be freed.
  */
OPUS_EXPORT void opus_dred_decoder_destroy(OpusDREDDecoder *dec);

/** Perform a CTL function on an Opus DRED decoder.
  *
  * Generally the request and subsequent arguments are generated
  * by a convenience macro.
  * @param dred_dec <tt>OpusDREDDecoder*</tt>: DRED Decoder state.
  * @param request This and all remaining parameters should be replaced by one
  *                of the convenience macros in @ref opus_genericctls or
  *                @ref opus_decoderctls.
  * @see opus_genericctls
  * @see opus_decoderctls
  */
OPUS_EXPORT int opus_dred_decoder_ctl(OpusDREDDecoder *dred_dec, int request, ...);

/** Gets the size of an <code>OpusDRED</code> structure.
  * @returns The size in bytes.
  */
OPUS_EXPORT int opus_dred_get_size(void);

/** Allocates and initializes a DRED state.
  * @param [out] error <tt>int*</tt>: #OPUS_OK Success or @ref opus_errorcodes
  */
OPUS_EXPORT OpusDRED *opus_dred_alloc(int *error);

/** Frees an <code>OpusDRED</code> allocated by opus_dred_create().
  * @param[in] dec <tt>OpusDRED*</tt>: State to be freed.
  */
OPUS_EXPORT void opus_dred_free(OpusDRED *dec);

/** Decode an Opus DRED packet.
  * @param [in] dred_dec <tt>OpusDRED*</tt>: DRED Decoder state
  * @param [in] dred <tt>OpusDRED*</tt>: DRED state
  * @param [in] data <tt>char*</tt>: Input payload
  * @param [in] len <tt>opus_int32</tt>: Number of bytes in payload
  * @param [in] max_dred_samples <tt>opus_int32</tt>: Maximum number of DRED samples that may be needed (if available in the packet).
  * @param [in] sampling_rate <tt>opus_int32</tt>: Sampling rate used for max_dred_samples argument. Needs not match the actual sampling rate of the decoder.
  * @param [out] dred_end <tt>opus_int32*</tt>: Number of non-encoded (silence) samples between the DRED timestamp and the last DRED sample.
  * @param [in] defer_processing <tt>int</tt>: Flag (0 or 1). If set to one, the CPU-intensive part of the DRED decoding is deferred until opus_dred_process() is called.
  * @returns Offset (positive) of the first decoded DRED samples, zero if no DRED is present, or @ref opus_errorcodes
  */
OPUS_EXPORT int opus_dred_parse(OpusDREDDecoder *dred_dec, OpusDRED *dred, const unsigned char *data, opus_int32 len, opus_int32 max_dred_samples, opus_int32 sampling_rate, int *dred_end, int defer_processing) OPUS_ARG_NONNULL(1);

/** Finish decoding an Opus DRED packet. The function only needs to be called if opus_dred_parse() was called with defer_processing=1.
  * The source and destination will often be the same DRED state.
  * @param [in] dred_dec <tt>OpusDRED*</tt>: DRED Decoder state
  * @param [in] src <tt>OpusDRED*</tt>: Source DRED state to start the processing from.
  * @param [out] dst <tt>OpusDRED*</tt>: Destination DRED state to store the updated state after processing.
  * @returns @ref opus_errorcodes
  */
OPUS_EXPORT int opus_dred_process(OpusDREDDecoder *dred_dec, const OpusDRED *src, OpusDRED *dst);

/** Decode audio from an Opus DRED packet with 16-bit output.
  * @param [in] st <tt>OpusDecoder*</tt>: Decoder state
  * @param [in] dred <tt>OpusDRED*</tt>: DRED state
  * @param [in] dred_offset <tt>opus_int32</tt>: position of the redundancy to decode (in samples before the beginning of the real audio data in the packet).
  * @param [out] pcm <tt>opus_int16*</tt>: Output signal (interleaved if 2 channels). length
  *  is frame_size*channels*sizeof(opus_int16)
  * @param [in] frame_size Number of samples per channel to decode in \a pcm.
  *  frame_size <b>must</b> be a multiple of 2.5 ms.
  * @returns Number of decoded samples or @ref opus_errorcodes
  */
OPUS_EXPORT int opus_decoder_dred_decode(OpusDecoder *st, const OpusDRED *dred, opus_int32 dred_offset, opus_int16 *pcm, opus_int32 frame_size);

/** Decode audio from an Opus DRED packet with 24-bit output.
  * @param [in] st <tt>OpusDecoder*</tt>: Decoder state
  * @param [in] dred <tt>OpusDRED*</tt>: DRED state
  * @param [in] dred_offset <tt>opus_int32</tt>: position of the redundancy to decode (in samples before the beginning of the real audio data in the packet).
  * @param [out] pcm <tt>opus_int32*</tt>: Output signal (interleaved if 2 channels). length
  *  is frame_size*channels*sizeof(opus_int16)
  * @param [in] frame_size Number of samples per channel to decode in \a pcm.
  *  frame_size <b>must</b> be a multiple of 2.5 ms.
  * @returns Number of decoded samples or @ref opus_errorcodes
  */
OPUS_EXPORT int opus_decoder_dred_decode24(OpusDecoder *st, const OpusDRED *dred, opus_int32 dred_offset, opus_int32 *pcm, opus_int32 frame_size);

/** Decode audio from an Opus DRED packet with floating point output.
  * @param [in] st <tt>OpusDecoder*</tt>: Decoder state
  * @param [in] dred <tt>OpusDRED*</tt>: DRED state
  * @param [in] dred_offset <tt>opus_int32</tt>: position of the redundancy to decode (in samples before the beginning of the real audio data in the packet).
  * @param [out] pcm <tt>float*</tt>: Output signal (interleaved if 2 channels). length
  *  is frame_size*channels*sizeof(float)
  * @param [in] frame_size Number of samples per channel to decode in \a pcm.
  *  frame_size <b>must</b> be a multiple of 2.5 ms.
  * @returns Number of decoded samples or @ref opus_errorcodes
  */
OPUS_EXPORT int opus_decoder_dred_decode_float(OpusDecoder *st, const OpusDRED *dred, opus_int32 dred_offset, float *pcm, opus_int32 frame_size);


/** Parse an opus packet into one or more frames.
  * Opus_decode will perform this operation internally so most applications do
  * not need to use this function.
  * This function does not copy the frames, the returned pointers are pointers into
  * the input packet.
  * @param [in] data <tt>char*</tt>: Opus packet to be parsed
  * @param [in] len <tt>opus_int32</tt>: size of data
  * @param [out] out_toc <tt>char*</tt>: TOC pointer
  * @param [out] frames <tt>char*[48]</tt> encapsulated frames
  * @param [out] size <tt>opus_int16[48]</tt> sizes of the encapsulated frames
  * @param [out] payload_offset <tt>int*</tt>: returns the position of the payload within the packet (in bytes)
  * @returns number of frames
  */
OPUS_EXPORT int opus_packet_parse(
   const unsigned char *data,
   opus_int32 len,
   unsigned char *out_toc,
   const unsigned char *frames[48],
   opus_int16 size[48],
   int *payload_offset
) OPUS_ARG_NONNULL(1) OPUS_ARG_NONNULL(5);

/** Gets the bandwidth of an Opus packet.
  * @param [in] data <tt>char*</tt>: Opus packet
  * @retval OPUS_BANDWIDTH_NARROWBAND Narrowband (4kHz bandpass)
  * @retval OPUS_BANDWIDTH_MEDIUMBAND Mediumband (6kHz bandpass)
  * @retval OPUS_BANDWIDTH_WIDEBAND Wideband (8kHz bandpass)
  * @retval OPUS_BANDWIDTH_SUPERWIDEBAND Superwideband (12kHz bandpass)
  * @retval OPUS_BANDWIDTH_FULLBAND Fullband (20kHz bandpass)
  * @retval OPUS_INVALID_PACKET The compressed data passed is corrupted or of an unsupported type
  */
OPUS_EXPORT OPUS_WARN_UNUSED_RESULT int opus_packet_get_bandwidth(const unsigned char *data) OPUS_ARG_NONNULL(1);

/** Gets the number of samples per frame from an Opus packet.
  * @param [in] data <tt>char*</tt>: Opus packet.
  *                                  This must contain at least one byte of
  *                                  data.
  * @param [in] Fs <tt>opus_int32</tt>: Sampling rate in Hz.
  *                                     This must be a multiple of 400, or
  *                                     inaccurate results will be returned.
  * @returns Number of samples per frame.
  */
OPUS_EXPORT OPUS_WARN_UNUSED_RESULT int opus_packet_get_samples_per_frame(const unsigned char *data, opus_int32 Fs) OPUS_ARG_NONNULL(1);

/** Gets the number of channels from an Opus packet.
  * @param [in] data <tt>char*</tt>: Opus packet
  * @returns Number of channels
  * @retval OPUS_INVALID_PACKET The compressed data passed is corrupted or of an unsupported type
  */
OPUS_EXPORT OPUS_WARN_UNUSED_RESULT int opus_packet_get_nb_channels(const unsigned char *data) OPUS_ARG_NONNULL(1);

/** Gets the number of frames in an Opus packet.
  * @param [in] packet <tt>char*</tt>: Opus packet
  * @param [in] len <tt>opus_int32</tt>: Length of packet
  * @returns Number of frames
  * @retval OPUS_BAD_ARG Insufficient data was passed to the function
  * @retval OPUS_INVALID_PACKET The compressed data passed is corrupted or of an unsupported type
  */
OPUS_EXPORT OPUS_WARN_UNUSED_RESULT int opus_packet_get_nb_frames(const unsigned char packet[], opus_int32 len) OPUS_ARG_NONNULL(1);

/** Gets the number of samples of an Opus packet.
  * @param [in] packet <tt>char*</tt>: Opus packet
  * @param [in] len <tt>opus_int32</tt>: Length of packet
  * @param [in] Fs <tt>opus_int32</tt>: Sampling rate in Hz.
  *                                     This must be a multiple of 400, or
  *                                     inaccurate results will be returned.
  * @returns Number of samples
  * @retval OPUS_BAD_ARG Insufficient data was passed to the function
  * @retval OPUS_INVALID_PACKET The compressed data passed is corrupted or of an unsupported type
  */
OPUS_EXPORT OPUS_WARN_UNUSED_RESULT int opus_packet_get_nb_samples(const unsigned char packet[], opus_int32 len, opus_int32 Fs) OPUS_ARG_NONNULL(1);

/** Checks whether an Opus packet has LBRR.
  * @param [in] packet <tt>char*</tt>: Opus packet
  * @param [in] len <tt>opus_int32</tt>: Length of packet
  * @returns 1 is LBRR is present, 0 otherwise
  * @retval OPUS_INVALID_PACKET The compressed data passed is corrupted or of an unsupported type
  */
OPUS_EXPORT OPUS_WARN_UNUSED_RESULT int opus_packet_has_lbrr(const unsigned char packet[], opus_int32 len);

/** Gets the number of samples of an Opus packet.
  * @param [in] dec <tt>OpusDecoder*</tt>: Decoder state
  * @param [in] packet <tt>char*</tt>: Opus packet
  * @param [in] len <tt>opus_int32</tt>: Length of packet
  * @returns Number of samples
  * @retval OPUS_BAD_ARG Insufficient data was passed to the function
  * @retval OPUS_INVALID_PACKET The compressed data passed is corrupted or of an unsupported type
  */
OPUS_EXPORT OPUS_WARN_UNUSED_RESULT int opus_decoder_get_nb_samples(const OpusDecoder *dec, const unsigned char packet[], opus_int32 len) OPUS_ARG_NONNULL(1) OPUS_ARG_NONNULL(2);

/** Applies soft-clipping to bring a float signal within the [-1,1] range. If
  * the signal is already in that range, nothing is done. If there are values
  * outside of [-1,1], then the signal is clipped as smoothly as possible to
  * both fit in the range and avoid creating excessive distortion in the
  * process.
  * @param [in,out] pcm <tt>float*</tt>: Input PCM and modified PCM
  * @param [in] frame_size <tt>int</tt> Number of samples per channel to process
  * @param [in] channels <tt>int</tt>: Number of channels
  * @param [in,out] softclip_mem <tt>float*</tt>: State memory for the soft clipping process (one float per channel, initialized to zero)
  */
OPUS_EXPORT void opus_pcm_soft_clip(float *pcm, int frame_size, int channels, float *softclip_mem);


/**@}*/

/** @defgroup opus_repacketizer Repacketizer
  * @{
  *
  * The repacketizer can be used to merge multiple Opus packets into a single
  * packet or alternatively to split Opus packets that have previously been
  * merged. Splitting valid Opus packets is always guaranteed to succeed,
  * whereas merging valid packets only succeeds if all frames have the same
  * mode, bandwidth, and frame size, and when the total duration of the merged
  * packet is no more than 120 ms. The 120 ms limit comes from the
  * specification and limits decoder memory requirements at a point where
  * framing overhead becomes negligible.
  *
  * The repacketizer currently only operates on elementary Opus
  * streams. It will not manipulate multistream packets successfully, except in
  * the degenerate case where they consist of data from a single stream.
  *
  * The repacketizing process starts with creating a repacketizer state, either
  * by calling opus_repacketizer_create() or by allocating the memory yourself,
  * e.g.,
  * @code
  * OpusRepacketizer *rp;
  * rp = (OpusRepacketizer*)malloc(opus_repacketizer_get_size());
  * if (rp != NULL)
  *     opus_repacketizer_init(rp);
  * @endcode
  *
  * Then the application should submit packets with opus_repacketizer_cat(),
  * extract new packets with opus_repacketizer_out() or
  * opus_repacketizer_out_range(), and then reset the state for the next set of
  * input packets via opus_repacketizer_init().
  *
  * For example, to split a sequence of packets into individual frames:
  * @code
  * unsigned char *data;
  * int len;
  * while (get_next_packet(&data, &len))
  * {
  *   unsigned char out[1276];
  *   opus_int32 out_len;
  *   int nb_frames;
  *   int err;
  *   int i;
  *   err = opus_repacketizer_cat(rp, data, len);
  *   if (err != OPUS_OK)
  *   {
  *     release_packet(data);
  *     return err;
  *   }
  *   nb_frames = opus_repacketizer_get_nb_frames(rp);
  *   for (i = 0; i < nb_frames; i++)
  *   {
  *     out_len = opus_repacketizer_out_range(rp, i, i+1, out, sizeof(out));
  *     if (out_len < 0)
  *     {
  *        release_packet(data);
  *        return (int)out_len;
  *     }
  *     output_next_packet(out, out_len);
  *   }
  *   opus_repacketizer_init(rp);
  *   release_packet(data);
  * }
  * @endcode
  *
  * Alternatively, to combine a sequence of frames into packets that each
  * contain up to <code>TARGET_DURATION_MS</code> milliseconds of data:
  * @code
  * // The maximum number of packets with duration TARGET_DURATION_MS occurs
  * // when the frame size is 2.5 ms, for a total of (TARGET_DURATION_MS*2/5)
  * // packets.
  * unsigned char *data[(TARGET_DURATION_MS*2/5)+1];
  * opus_int32 len[(TARGET_DURATION_MS*2/5)+1];
  * int nb_packets;
  * unsigned char out[1277*(TARGET_DURATION_MS*2/2)];
  * opus_int32 out_len;
  * int prev_toc;
  * nb_packets = 0;
  * while (get_next_packet(data+nb_packets, len+nb_packets))
  * {
  *   int nb_frames;
  *   int err;
  *   nb_frames = opus_packet_get_nb_frames(data[nb_packets], len[nb_packets]);
  *   if (nb_frames < 1)
  *   {
  *     release_packets(data, nb_packets+1);
  *     return nb_frames;
  *   }
  *   nb_frames += opus_repacketizer_get_nb_frames(rp);
  *   // If adding the next packet would exceed our target, or it has an
  *   // incompatible TOC sequence, output the packets we already have before
  *   // submitting it.
  *   // N.B., The nb_packets > 0 check ensures we've submitted at least one
  *   // packet since the last call to opus_repacketizer_init(). Otherwise a
  *   // single packet longer than TARGET_DURATION_MS would cause us to try to
  *   // output an (invalid) empty packet. It also ensures that prev_toc has
  *   // been set to a valid value. Additionally, len[nb_packets] > 0 is
  *   // guaranteed by the call to opus_packet_get_nb_frames() above, so the
  *   // reference to data[nb_packets][0] should be valid.
  *   if (nb_packets > 0 && (
  *       ((prev_toc & 0xFC) != (data[nb_packets][0] & 0xFC)) ||
  *       opus_packet_get_samples_per_frame(data[nb_packets], 48000)*nb_frames >
  *       TARGET_DURATION_MS*48))
  *   {
  *     out_len = opus_repacketizer_out(rp, out, sizeof(out));
  *     if (out_len < 0)
  *     {
  *        release_packets(data, nb_packets+1);
  *        return (int)out_len;
  *     }
  *     output_next_packet(out, out_len);
  *     opus_repacketizer_init(rp);
  *     release_packets(data, nb_packets);
  *     data[0] = data[nb_packets];
  *     len[0] = len[nb_packets];
  *     nb_packets = 0;
  *   }
  *   err = opus_repacketizer_cat(rp, data[nb_packets], len[nb_packets]);
  *   if (err != OPUS_OK)
  *   {
  *     release_packets(data, nb_packets+1);
  *     return err;
  *   }
  *   prev_toc = data[nb_packets][0];
  *   nb_packets++;
  * }
  * // Output the final, partial packet.
  * if (nb_packets > 0)
  * {
  *   out_len = opus_repacketizer_out(rp, out, sizeof(out));
  *   release_packets(data, nb_packets);
  *   if (out_len < 0)
  *     return (int)out_len;
  *   output_next_packet(out, out_len);
  * }
  * @endcode
  *
  * An alternate way of merging packets is to simply call opus_repacketizer_cat()
  * unconditionally until it fails. At that point, the merged packet can be
  * obtained with opus_repacketizer_out() and the input packet for which
  * opus_repacketizer_cat() needs to be re-added to a newly reinitialized
  * repacketizer state.
  */

typedef struct OpusRepacketizer OpusRepacketizer;

/** Gets the size of an <code>OpusRepacketizer</code> structure.
  * @returns The size in bytes.
  */
OPUS_EXPORT OPUS_WARN_UNUSED_RESULT int opus_repacketizer_get_size(void);

/** (Re)initializes a previously allocated repacketizer state.
  * The state must be at least the size returned by opus_repacketizer_get_size().
  * This can be used for applications which use their own allocator instead of
  * malloc().
  * It must also be called to reset the queue of packets waiting to be
  * repacketized, which is necessary if the maximum packet duration of 120 ms
  * is reached or if you wish to submit packets with a different Opus
  * configuration (coding mode, audio bandwidth, frame size, or channel count).
  * Failure to do so will prevent a new packet from being added with
  * opus_repacketizer_cat().
  * @see opus_repacketizer_create
  * @see opus_repacketizer_get_size
  * @see opus_repacketizer_cat
  * @param rp <tt>OpusRepacketizer*</tt>: The repacketizer state to
  *                                       (re)initialize.
  * @returns A pointer to the same repacketizer state that was passed in.
  */
OPUS_EXPORT OpusRepacketizer *opus_repacketizer_init(OpusRepacketizer *rp) OPUS_ARG_NONNULL(1);

/** Allocates memory and initializes the new repacketizer with
 * opus_repacketizer_init().
  */
OPUS_EXPORT OPUS_WARN_UNUSED_RESULT OpusRepacketizer *opus_repacketizer_create(void);

/** Frees an <code>OpusRepacketizer</code> allocated by
  * opus_repacketizer_create().
  * @param[in] rp <tt>OpusRepacketizer*</tt>: State to be freed.
  */
OPUS_EXPORT void opus_repacketizer_destroy(OpusRepacketizer *rp);

/** Add a packet to the current repacketizer state.
  * This packet must match the configuration of any packets already submitted
  * for repacketization since the last call to opus_repacketizer_init().
  * This means that it must have the same coding mode, audio bandwidth, frame
  * size, and channel count.
  * This can be checked in advance by examining the top 6 bits of the first
  * byte of the packet, and ensuring they match the top 6 bits of the first
  * byte of any previously submitted packet.
  * The total duration of audio in the repacketizer state also must not exceed
  * 120 ms, the maximum duration of a single packet, after adding this packet.
  *
  * The contents of the current repacketizer state can be extracted into new
  * packets using opus_repacketizer_out() or opus_repacketizer_out_range().
  *
  * In order to add a packet with a different configuration or to add more
  * audio beyond 120 ms, you must clear the repacketizer state by calling
  * opus_repacketizer_init().
  * If a packet is too large to add to the current repacketizer state, no part
  * of it is added, even if it contains multiple frames, some of which might
  * fit.
  * If you wish to be able to add parts of such packets, you should first use
  * another repacketizer to split the packet into pieces and add them
  * individually.
  * @see opus_repacketizer_out_range
  * @see opus_repacketizer_out
  * @see opus_repacketizer_init
  * @param rp <tt>OpusRepacketizer*</tt>: The repacketizer state to which to
  *                                       add the packet.
  * @param[in] data <tt>const unsigned char*</tt>: The packet data.
  *                                                The application must ensure
  *                                                this pointer remains valid
  *                                                until the next call to
  *                                                opus_repacketizer_init() or
  *                                                opus_repacketizer_destroy().
  * @param len <tt>opus_int32</tt>: The number of bytes in the packet data.
  * @returns An error code indicating whether or not the operation succeeded.
  * @retval #OPUS_OK The packet's contents have been added to the repacketizer
  *                  state.
  * @retval #OPUS_INVALID_PACKET The packet did not have a valid TOC sequence,
  *                              the packet's TOC sequence was not compatible
  *                              with previously submitted packets (because
  *                              the coding mode, audio bandwidth, frame size,
  *                              or channel count did not match), or adding
  *                              this packet would increase the total amount of
  *                              audio stored in the repacketizer state to more
  *                              than 120 ms.
  */
OPUS_EXPORT int opus_repacketizer_cat(OpusRepacketizer *rp, const unsigned char *data, opus_int32 len) OPUS_ARG_NONNULL(1) OPUS_ARG_NONNULL(2);


/** Construct a new packet from data previously submitted to the repacketizer
  * state via opus_repacketizer_cat().
  * @param rp <tt>OpusRepacketizer*</tt>: The repacketizer state from which to
  *                                       construct the new packet.
  * @param begin <tt>int</tt>: The index of the first frame in the current
  *                            repacketizer state to include in the output.
  * @param end <tt>int</tt>: One past the index of the last frame in the
  *                          current repacketizer state to include in the
  *                          output.
  * @param[out] data <tt>const unsigned char*</tt>: The buffer in which to
  *                                                 store the output packet.
  * @param maxlen <tt>opus_int32</tt>: The maximum number of bytes to store in
  *                                    the output buffer. In order to guarantee
  *                                    success, this should be at least
  *                                    <code>1276</code> for a single frame,
  *                                    or for multiple frames,
  *                                    <code>1277*(end-begin)</code>.
  *                                    However, <code>1*(end-begin)</code> plus
  *                                    the size of all packet data submitted to
  *                                    the repacketizer since the last call to
  *                                    opus_repacketizer_init() or
  *                                    opus_repacketizer_create() is also
  *                                    sufficient, and possibly much smaller.
  * @returns The total size of the output packet on success, or an error code
  *          on failure.
  * @retval #OPUS_BAD_ARG <code>[begin,end)</code> was an invalid range of
  *                       frames (begin < 0, begin >= end, or end >
  *                       opus_repacketizer_get_nb_frames()).
  * @retval #OPUS_BUFFER_TOO_SMALL \a maxlen was insufficient to contain the
  *                                complete output packet.
  */
OPUS_EXPORT OPUS_WARN_UNUSED_RESULT opus_int32 opus_repacketizer_out_range(OpusRepacketizer *rp, int begin, int end, unsigned char *data, opus_int32 maxlen) OPUS_ARG_NONNULL(1) OPUS_ARG_NONNULL(4);

/** Return the total number of frames contained in packet data submitted to
  * the repacketizer state so far via opus_repacketizer_cat() since the last
  * call to opus_repacketizer_init() or opus_repacketizer_create().
  * This defines the valid range of packets that can be extracted with
  * opus_repacketizer_out_range() or opus_repacketizer_out().
  * @param rp <tt>OpusRepacketizer*</tt>: The repacketizer state containing the
  *                                       frames.
  * @returns The total number of frames contained in the packet data submitted
  *          to the repacketizer state.
  */
OPUS_EXPORT OPUS_WARN_UNUSED_RESULT int opus_repacketizer_get_nb_frames(OpusRepacketizer *rp) OPUS_ARG_NONNULL(1);

/** Construct a new packet from data previously submitted to the repacketizer
  * state via opus_repacketizer_cat().
  * This is a convenience routine that returns all the data submitted so far
  * in a single packet.
  * It is equivalent to calling
  * @code
  * opus_repacketizer_out_range(rp, 0, opus_repacketizer_get_nb_frames(rp),
  *                             data, maxlen)
  * @endcode
  * @param rp <tt>OpusRepacketizer*</tt>: The repacketizer state from which to
  *                                       construct the new packet.
  * @param[out] data <tt>const unsigned char*</tt>: The buffer in which to
  *                                                 store the output packet.
  * @param maxlen <tt>opus_int32</tt>: The maximum number of bytes to store in
  *                                    the output buffer. In order to guarantee
  *                                    success, this should be at least
  *                                    <code>1277*opus_repacketizer_get_nb_frames(rp)</code>.
  *                                    However,
  *                                    <code>1*opus_repacketizer_get_nb_frames(rp)</code>
  *                                    plus the size of all packet data
  *                                    submitted to the repacketizer since the
  *                                    last call to opus_repacketizer_init() or
  *                                    opus_repacketizer_create() is also
  *                                    sufficient, and possibly much smaller.
  * @returns The total size of the output packet on success, or an error code
  *          on failure.
  * @retval #OPUS_BUFFER_TOO_SMALL \a maxlen was insufficient to contain the
  *                                complete output packet.
  */
OPUS_EXPORT OPUS_WARN_UNUSED_RESULT opus_int32 opus_repacketizer_out(OpusRepacketizer *rp, unsigned char *data, opus_int32 maxlen) OPUS_ARG_NONNULL(1);

/** Pads a given Opus packet to a larger size (possibly changing the TOC sequence).
  * @param[in,out] data <tt>const unsigned char*</tt>: The buffer containing the
  *                                                   packet to pad.
  * @param len <tt>opus_int32</tt>: The size of the packet.
  *                                 This must be at least 1.
  * @param new_len <tt>opus_int32</tt>: The desired size of the packet after padding.
  *                                 This must be at least as large as len.
  * @returns an error code
  * @retval #OPUS_OK \a on success.
  * @retval #OPUS_BAD_ARG \a len was less than 1 or new_len was less than len.
  * @retval #OPUS_INVALID_PACKET \a data did not contain a valid Opus packet.
  */
OPUS_EXPORT int opus_packet_pad(unsigned char *data, opus_int32 len, opus_int32 new_len);

/** Remove all padding from a given Opus packet and rewrite the TOC sequence to
  * minimize space usage.
  * @param[in,out] data <tt>const unsigned char*</tt>: The buffer containing the
  *                                                   packet to strip.
  * @param len <tt>opus_int32</tt>: The size of the packet.
  *                                 This must be at least 1.
  * @returns The new size of the output packet on success, or an error code
  *          on failure.
  * @retval #OPUS_BAD_ARG \a len was less than 1.
  * @retval #OPUS_INVALID_PACKET \a data did not contain a valid Opus packet.
  */
OPUS_EXPORT OPUS_WARN_UNUSED_RESULT opus_int32 opus_packet_unpad(unsigned char *data, opus_int32 len);

/** Pads a given Opus multi-stream packet to a larger size (possibly changing the TOC sequence).
  * @param[in,out] data <tt>const unsigned char*</tt>: The buffer containing the
  *                                                   packet to pad.
  * @param len <tt>opus_int32</tt>: The size of the packet.
  *                                 This must be at least 1.
  * @param new_len <tt>opus_int32</tt>: The desired size of the packet after padding.
  *                                 This must be at least 1.
  * @param nb_streams <tt>opus_int32</tt>: The number of streams (not channels) in the packet.
  *                                 This must be at least as large as len.
  * @returns an error code
  * @retval #OPUS_OK \a on success.
  * @retval #OPUS_BAD_ARG \a len was less than 1.
  * @retval #OPUS_INVALID_PACKET \a data did not contain a valid Opus packet.
  */
OPUS_EXPORT int opus_multistream_packet_pad(unsigned char *data, opus_int32 len, opus_int32 new_len, int nb_streams);

/** Remove all padding from a given Opus multi-stream packet and rewrite the TOC sequence to
  * minimize space usage.
  * @param[in,out] data <tt>const unsigned char*</tt>: The buffer containing the
  *                                                   packet to strip.
  * @param len <tt>opus_int32</tt>: The size of the packet.
  *                                 This must be at least 1.
  * @param nb_streams <tt>opus_int32</tt>: The number of streams (not channels) in the packet.
  *                                 This must be at least 1.
  * @returns The new size of the output packet on success, or an error code
  *          on failure.
  * @retval #OPUS_BAD_ARG \a len was less than 1 or new_len was less than len.
  * @retval #OPUS_INVALID_PACKET \a data did not contain a valid Opus packet.
  */
OPUS_EXPORT OPUS_WARN_UNUSED_RESULT opus_int32 opus_multistream_packet_unpad(unsigned char *data, opus_int32 len, int nb_streams);

/**@}*/

#ifdef __cplusplus
}
#endif

#endif /* OPUS_H */
