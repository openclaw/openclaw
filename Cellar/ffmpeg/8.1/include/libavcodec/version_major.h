/*
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

#ifndef AVCODEC_VERSION_MAJOR_H
#define AVCODEC_VERSION_MAJOR_H

/**
 * @file
 * @ingroup libavc
 * Libavcodec version macros.
 */

#define LIBAVCODEC_VERSION_MAJOR  62

/**
 * FF_API_* defines may be placed below to indicate public API that will be
 * dropped at a future version bump. The defines themselves are not part of
 * the public API and may change, break or disappear at any time.
 *
 * @note, when bumping the major version it is recommended to manually
 * disable each FF_API_* in its own commit instead of disabling them all
 * at once through the bump. This improves the git bisect-ability of the change.
 */

#define FF_API_INIT_PACKET         (LIBAVCODEC_VERSION_MAJOR < 63)

#define FF_API_V408_CODECID        (LIBAVCODEC_VERSION_MAJOR < 63)
#define FF_API_CODEC_PROPS         (LIBAVCODEC_VERSION_MAJOR < 63)
#define FF_API_EXR_GAMMA           (LIBAVCODEC_VERSION_MAJOR < 63)
#define FF_API_INTRA_DC_PRECISION  (LIBAVCODEC_VERSION_MAJOR < 63)

#define FF_API_NVDEC_OLD_PIX_FMTS  (LIBAVCODEC_VERSION_MAJOR < 63)

#define FF_API_PARSER_PRIVATE      (LIBAVCODEC_VERSION_MAJOR < 63)
#define FF_API_PARSER_CODECID      (LIBAVCODEC_VERSION_MAJOR < 63)

// reminder to remove the OMX encoder on next major bump
#define FF_CODEC_OMX               (LIBAVCODEC_VERSION_MAJOR < 63)
// reminder to remove Sonic Lossy/Lossless encoders on next major bump
#define FF_CODEC_SONIC_ENC         (LIBAVCODEC_VERSION_MAJOR < 63)
// reminder to remove Sonic decoder on next-next major bump
#define FF_CODEC_SONIC_DEC         (LIBAVCODEC_VERSION_MAJOR < 63)

#endif /* AVCODEC_VERSION_MAJOR_H */
