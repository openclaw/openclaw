/*
 * Codec descriptors public API
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

#ifndef AVCODEC_CODEC_DESC_H
#define AVCODEC_CODEC_DESC_H

#include "libavutil/avutil.h"

#include "codec_id.h"

/**
 * @addtogroup lavc_core
 * @{
 */

/**
 * This struct describes the properties of a single codec described by an
 * AVCodecID.
 * @see avcodec_descriptor_get()
 */
typedef struct AVCodecDescriptor {
    enum AVCodecID     id;
    enum AVMediaType type;
    /**
     * Name of the codec described by this descriptor. It is non-empty and
     * unique for each codec descriptor. It should contain alphanumeric
     * characters and '_' only.
     */
    const char      *name;
    /**
     * A more descriptive name for this codec. May be NULL.
     */
    const char *long_name;
    /**
     * Codec properties, a combination of AV_CODEC_PROP_* flags.
     */
    int             props;
    /**
     * MIME type(s) associated with the codec.
     * May be NULL; if not, a NULL-terminated array of MIME types.
     * The first item is always non-NULL and is the preferred MIME type.
     */
    const char *const *mime_types;
    /**
     * If non-NULL, an array of profiles recognized for this codec.
     * Terminated with AV_PROFILE_UNKNOWN.
     */
    const struct AVProfile *profiles;
} AVCodecDescriptor;

/**
 * Codec uses only intra compression.
 * Video and audio codecs only.
 */
#define AV_CODEC_PROP_INTRA_ONLY    (1 << 0)
/**
 * Codec supports lossy compression. Audio and video codecs only.
 * @note a codec may support both lossy and lossless
 * compression modes
 */
#define AV_CODEC_PROP_LOSSY         (1 << 1)
/**
 * Codec supports lossless compression. Audio and video codecs only.
 */
#define AV_CODEC_PROP_LOSSLESS      (1 << 2)
/**
 * Codec supports frame reordering. That is, the coded order (the order in which
 * the encoded packets are output by the encoders / stored / input to the
 * decoders) may be different from the presentation order of the corresponding
 * frames.
 *
 * For codecs that do not have this property set, PTS and DTS should always be
 * equal.
 */
#define AV_CODEC_PROP_REORDER       (1 << 3)

/**
 * Video codec supports separate coding of fields in interlaced frames.
 */
#define AV_CODEC_PROP_FIELDS        (1 << 4)

/**
 * Video codec contains enhancement information meant to be applied to other
 * existing frames, and can't generate usable image data on its own.
 * A standalone decoder is unlikely to be available for it and should not
 * be expected.
 */
#define AV_CODEC_PROP_ENHANCEMENT   (1 << 5)

/**
 * Subtitle codec is bitmap based
 * Decoded AVSubtitle data can be read from the AVSubtitleRect->pict field.
 */
#define AV_CODEC_PROP_BITMAP_SUB    (1 << 16)
/**
 * Subtitle codec is text based.
 * Decoded AVSubtitle data can be read from the AVSubtitleRect->ass field.
 */
#define AV_CODEC_PROP_TEXT_SUB      (1 << 17)

/**
 * @return descriptor for given codec ID or NULL if no descriptor exists.
 */
const AVCodecDescriptor *avcodec_descriptor_get(enum AVCodecID id);

/**
 * Iterate over all codec descriptors known to libavcodec.
 *
 * @param prev previous descriptor. NULL to get the first descriptor.
 *
 * @return next descriptor or NULL after the last descriptor
 */
const AVCodecDescriptor *avcodec_descriptor_next(const AVCodecDescriptor *prev);

/**
 * @return codec descriptor with the given name or NULL if no such descriptor
 *         exists.
 */
const AVCodecDescriptor *avcodec_descriptor_get_by_name(const char *name);

/**
 * @}
 */

#endif // AVCODEC_CODEC_DESC_H
