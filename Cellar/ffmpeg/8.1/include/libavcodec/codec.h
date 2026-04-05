/*
 * AVCodec public API
 *
 * This file is part of FFmpeg.
 *
 * FFmpeg is free software; you can redistribute it and/or
 * modify it under the terms of the GNU Lesser General Public
 * License as published by the Free Software Foundation; either
 * version 2.1 of the License, or (at your option) any later version.
 *
 * FFmpeg is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public
 * License along with FFmpeg; if not, write to the Free Software
 * Foundation, Inc., 51 Franklin Street, Fifth Floor, Boston, MA 02110-1301 USA
 */

#ifndef AVCODEC_CODEC_H
#define AVCODEC_CODEC_H

#include <stdint.h>

#include "libavutil/avutil.h"
#include "libavutil/hwcontext.h"
#include "libavutil/log.h"
#include "libavutil/pixfmt.h"
#include "libavutil/rational.h"
#include "libavutil/samplefmt.h"

#include "libavcodec/codec_id.h"
#include "libavcodec/version_major.h"

/**
 * @addtogroup lavc_core
 * @{
 */

/**
 * Decoder can use draw_horiz_band callback.
 */
#define AV_CODEC_CAP_DRAW_HORIZ_BAND     (1 <<  0)
/**
 * Codec uses get_buffer() or get_encode_buffer() for allocating buffers and
 * supports custom allocators.
 * If not set, it might not use get_buffer() or get_encode_buffer() at all, or
 * use operations that assume the buffer was allocated by
 * avcodec_default_get_buffer2 or avcodec_default_get_encode_buffer.
 */
#define AV_CODEC_CAP_DR1                 (1 <<  1)
/**
 * Encoder or decoder requires flushing with NULL input at the end in order to
 * give the complete and correct output.
 *
 * NOTE: If this flag is not set, the codec is guaranteed to never be fed with
 *       with NULL data. The user can still send NULL data to the public encode
 *       or decode function, but libavcodec will not pass it along to the codec
 *       unless this flag is set.
 *
 * Decoders:
 * The decoder has a non-zero delay and needs to be fed with avpkt->data=NULL,
 * avpkt->size=0 at the end to get the delayed data until the decoder no longer
 * returns frames.
 *
 * Encoders:
 * The encoder needs to be fed with NULL data at the end of encoding until the
 * encoder no longer returns data.
 *
 * NOTE: For encoders implementing the AVCodec.encode2() function, setting this
 *       flag also means that the encoder must set the pts and duration for
 *       each output packet. If this flag is not set, the pts and duration will
 *       be determined by libavcodec from the input frame.
 */
#define AV_CODEC_CAP_DELAY               (1 <<  5)
/**
 * Codec can be fed a final frame with a smaller size.
 * This can be used to prevent truncation of the last audio samples.
 */
#define AV_CODEC_CAP_SMALL_LAST_FRAME    (1 <<  6)

/**
 * Codec is experimental and is thus avoided in favor of non experimental
 * encoders
 */
#define AV_CODEC_CAP_EXPERIMENTAL        (1 <<  9)
/**
 * Codec should fill in channel configuration and samplerate instead of container
 */
#define AV_CODEC_CAP_CHANNEL_CONF        (1 << 10)
/**
 * Codec supports frame-level multithreading.
 */
#define AV_CODEC_CAP_FRAME_THREADS       (1 << 12)
/**
 * Codec supports slice-based (or partition-based) multithreading.
 */
#define AV_CODEC_CAP_SLICE_THREADS       (1 << 13)
/**
 * Codec supports changed parameters at any point.
 */
#define AV_CODEC_CAP_PARAM_CHANGE        (1 << 14)
/**
 * Codec supports multithreading through a method other than slice- or
 * frame-level multithreading. Typically this marks wrappers around
 * multithreading-capable external libraries.
 */
#define AV_CODEC_CAP_OTHER_THREADS       (1 << 15)
/**
 * Audio encoder supports receiving a different number of samples in each call.
 */
#define AV_CODEC_CAP_VARIABLE_FRAME_SIZE (1 << 16)
/**
 * Decoder is not a preferred choice for probing.
 * This indicates that the decoder is not a good choice for probing.
 * It could for example be an expensive to spin up hardware decoder,
 * or it could simply not provide a lot of useful information about
 * the stream.
 * A decoder marked with this flag should only be used as last resort
 * choice for probing.
 */
#define AV_CODEC_CAP_AVOID_PROBING       (1 << 17)

/**
 * Codec is backed by a hardware implementation. Typically used to
 * identify a non-hwaccel hardware decoder. For information about hwaccels, use
 * avcodec_get_hw_config() instead.
 */
#define AV_CODEC_CAP_HARDWARE            (1 << 18)

/**
 * Codec is potentially backed by a hardware implementation, but not
 * necessarily. This is used instead of AV_CODEC_CAP_HARDWARE, if the
 * implementation provides some sort of internal fallback.
 */
#define AV_CODEC_CAP_HYBRID              (1 << 19)

/**
 * This encoder can reorder user opaque values from input AVFrames and return
 * them with corresponding output packets.
 * @see AV_CODEC_FLAG_COPY_OPAQUE
 */
#define AV_CODEC_CAP_ENCODER_REORDERED_OPAQUE (1 << 20)

/**
 * This encoder can be flushed using avcodec_flush_buffers(). If this flag is
 * not set, the encoder must be closed and reopened to ensure that no frames
 * remain pending.
 */
#define AV_CODEC_CAP_ENCODER_FLUSH   (1 << 21)

/**
 * The encoder is able to output reconstructed frame data, i.e. raw frames that
 * would be produced by decoding the encoded bitstream.
 *
 * Reconstructed frame output is enabled by the AV_CODEC_FLAG_RECON_FRAME flag.
 */
#define AV_CODEC_CAP_ENCODER_RECON_FRAME (1 << 22)

/**
 * AVProfile.
 */
typedef struct AVProfile {
    int profile;
    const char *name; ///< short name for the profile
} AVProfile;

/**
 * AVCodec.
 */
typedef struct AVCodec {
    /**
     * Name of the codec implementation.
     * The name is globally unique among encoders and among decoders (but an
     * encoder and a decoder can share the same name).
     * This is the primary way to find a codec from the user perspective.
     */
    const char *name;
    /**
     * Descriptive name for the codec, meant to be more human readable than name.
     * You should use the NULL_IF_CONFIG_SMALL() macro to define it.
     */
    const char *long_name;
    enum AVMediaType type;
    enum AVCodecID id;
    /**
     * Codec capabilities.
     * see AV_CODEC_CAP_*
     */
    int capabilities;
    uint8_t max_lowres;                     ///< maximum value for lowres supported by the decoder

    /**
     * Deprecated codec capabilities.
     */
    attribute_deprecated
    const AVRational *supported_framerates; ///< @deprecated use avcodec_get_supported_config()
    attribute_deprecated
    const enum AVPixelFormat *pix_fmts;     ///< @deprecated use avcodec_get_supported_config()
    attribute_deprecated
    const int *supported_samplerates;       ///< @deprecated use avcodec_get_supported_config()
    attribute_deprecated
    const enum AVSampleFormat *sample_fmts; ///< @deprecated use avcodec_get_supported_config()

    const AVClass *priv_class;              ///< AVClass for the private context
    const AVProfile *profiles;              ///< array of recognized profiles, or NULL if unknown, array is terminated by {AV_PROFILE_UNKNOWN}

    /**
     * Group name of the codec implementation.
     * This is a short symbolic name of the wrapper backing this codec. A
     * wrapper uses some kind of external implementation for the codec, such
     * as an external library, or a codec implementation provided by the OS or
     * the hardware.
     * If this field is NULL, this is a builtin, libavcodec native codec.
     * If non-NULL, this will be the suffix in AVCodec.name in most cases
     * (usually AVCodec.name will be of the form "<codec_name>_<wrapper_name>").
     */
    const char *wrapper_name;

    /**
     * Array of supported channel layouts, terminated with a zeroed layout.
     * @deprecated use avcodec_get_supported_config()
     */
    attribute_deprecated
    const AVChannelLayout *ch_layouts;
} AVCodec;

/**
 * Iterate over all registered codecs.
 *
 * @param opaque a pointer where libavcodec will store the iteration state. Must
 *               point to NULL to start the iteration.
 *
 * @return the next registered codec or NULL when the iteration is
 *         finished
 */
const AVCodec *av_codec_iterate(void **opaque);

/**
 * Find a registered decoder with a matching codec ID.
 *
 * @param id AVCodecID of the requested decoder
 * @return A decoder if one was found, NULL otherwise.
 */
const AVCodec *avcodec_find_decoder(enum AVCodecID id);

/**
 * Find a registered decoder with the specified name.
 *
 * @param name name of the requested decoder
 * @return A decoder if one was found, NULL otherwise.
 */
const AVCodec *avcodec_find_decoder_by_name(const char *name);

/**
 * Find a registered encoder with a matching codec ID.
 *
 * @param id AVCodecID of the requested encoder
 * @return An encoder if one was found, NULL otherwise.
 */
const AVCodec *avcodec_find_encoder(enum AVCodecID id);

/**
 * Find a registered encoder with the specified name.
 *
 * @param name name of the requested encoder
 * @return An encoder if one was found, NULL otherwise.
 */
const AVCodec *avcodec_find_encoder_by_name(const char *name);
/**
 * @return a non-zero number if codec is an encoder, zero otherwise
 */
int av_codec_is_encoder(const AVCodec *codec);

/**
 * @return a non-zero number if codec is a decoder, zero otherwise
 */
int av_codec_is_decoder(const AVCodec *codec);

/**
 * Return a name for the specified profile, if available.
 *
 * @param codec the codec that is searched for the given profile
 * @param profile the profile value for which a name is requested
 * @return A name for the profile if found, NULL otherwise.
 */
const char *av_get_profile_name(const AVCodec *codec, int profile);

enum {
    /**
     * The codec supports this format via the hw_device_ctx interface.
     *
     * When selecting this format, AVCodecContext.hw_device_ctx should
     * have been set to a device of the specified type before calling
     * avcodec_open2().
     */
    AV_CODEC_HW_CONFIG_METHOD_HW_DEVICE_CTX = 0x01,
    /**
     * The codec supports this format via the hw_frames_ctx interface.
     *
     * When selecting this format for a decoder,
     * AVCodecContext.hw_frames_ctx should be set to a suitable frames
     * context inside the get_format() callback.  The frames context
     * must have been created on a device of the specified type.
     *
     * When selecting this format for an encoder,
     * AVCodecContext.hw_frames_ctx should be set to the context which
     * will be used for the input frames before calling avcodec_open2().
     */
    AV_CODEC_HW_CONFIG_METHOD_HW_FRAMES_CTX = 0x02,
    /**
     * The codec supports this format by some internal method.
     *
     * This format can be selected without any additional configuration -
     * no device or frames context is required.
     */
    AV_CODEC_HW_CONFIG_METHOD_INTERNAL      = 0x04,
    /**
     * The codec supports this format by some ad-hoc method.
     *
     * Additional settings and/or function calls are required.  See the
     * codec-specific documentation for details.  (Methods requiring
     * this sort of configuration are deprecated and others should be
     * used in preference.)
     */
    AV_CODEC_HW_CONFIG_METHOD_AD_HOC        = 0x08,
};

typedef struct AVCodecHWConfig {
    /**
     * For decoders, a hardware pixel format which that decoder may be
     * able to decode to if suitable hardware is available.
     *
     * For encoders, a pixel format which the encoder may be able to
     * accept.  If set to AV_PIX_FMT_NONE, this applies to all pixel
     * formats supported by the codec.
     */
    enum AVPixelFormat pix_fmt;
    /**
     * Bit set of AV_CODEC_HW_CONFIG_METHOD_* flags, describing the possible
     * setup methods which can be used with this configuration.
     */
    int methods;
    /**
     * The device type associated with the configuration.
     *
     * Must be set for AV_CODEC_HW_CONFIG_METHOD_HW_DEVICE_CTX and
     * AV_CODEC_HW_CONFIG_METHOD_HW_FRAMES_CTX, otherwise unused.
     */
    enum AVHWDeviceType device_type;
} AVCodecHWConfig;

/**
 * Retrieve supported hardware configurations for a codec.
 *
 * Values of index from zero to some maximum return the indexed configuration
 * descriptor; all other values return NULL.  If the codec does not support
 * any hardware configurations then it will always return NULL.
 */
const AVCodecHWConfig *avcodec_get_hw_config(const AVCodec *codec, int index);

/**
 * @}
 */

#endif /* AVCODEC_CODEC_H */
