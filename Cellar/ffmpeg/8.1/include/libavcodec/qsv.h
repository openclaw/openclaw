/*
 * Intel MediaSDK QSV public API
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

#ifndef AVCODEC_QSV_H
#define AVCODEC_QSV_H

#include <mfxvideo.h>

#include "libavutil/buffer.h"

/**
 * This struct is used for communicating QSV parameters between libavcodec and
 * the caller. It is managed by the caller and must be assigned to
 * AVCodecContext.hwaccel_context.
 * - decoding: hwaccel_context must be set on return from the get_format()
 *             callback
 * - encoding: hwaccel_context must be set before avcodec_open2()
 */
typedef struct AVQSVContext {
    /**
     * If non-NULL, the session to use for encoding or decoding.
     * Otherwise, libavcodec will try to create an internal session.
     */
    mfxSession session;

    /**
     * The IO pattern to use.
     */
    int iopattern;

    /**
     * Extra buffers to pass to encoder or decoder initialization.
     */
    mfxExtBuffer **ext_buffers;
    int         nb_ext_buffers;

    /**
     * Encoding only. If this field is set to non-zero by the caller, libavcodec
     * will create an mfxExtOpaqueSurfaceAlloc extended buffer and pass it to
     * the encoder initialization. This only makes sense if iopattern is also
     * set to MFX_IOPATTERN_IN_OPAQUE_MEMORY.
     *
     * The number of allocated opaque surfaces will be the sum of the number
     * required by the encoder and the user-provided value nb_opaque_surfaces.
     * The array of the opaque surfaces will be exported to the caller through
     * the opaque_surfaces field.
     *
     * The caller must set this field to zero for oneVPL (MFX_VERSION >= 2.0)
     */
    int opaque_alloc;

    /**
     * Encoding only, and only if opaque_alloc is set to non-zero. Before
     * calling avcodec_open2(), the caller should set this field to the number
     * of extra opaque surfaces to allocate beyond what is required by the
     * encoder.
     *
     * On return from avcodec_open2(), this field will be set by libavcodec to
     * the total number of allocated opaque surfaces.
     */
    int nb_opaque_surfaces;

    /**
     * Encoding only, and only if opaque_alloc is set to non-zero. On return
     * from avcodec_open2(), this field will be used by libavcodec to export the
     * array of the allocated opaque surfaces to the caller, so they can be
     * passed to other parts of the pipeline.
     *
     * The buffer reference exported here is owned and managed by libavcodec,
     * the callers should make their own reference with av_buffer_ref() and free
     * it with av_buffer_unref() when it is no longer needed.
     *
     * The buffer data is an nb_opaque_surfaces-sized array of mfxFrameSurface1.
     */
    AVBufferRef *opaque_surfaces;

    /**
     * Encoding only, and only if opaque_alloc is set to non-zero. On return
     * from avcodec_open2(), this field will be set to the surface type used in
     * the opaque allocation request.
     */
    int opaque_alloc_type;
} AVQSVContext;

/**
 * Allocate a new context.
 *
 * It must be freed by the caller with av_free().
 */
AVQSVContext *av_qsv_alloc_context(void);

#endif /* AVCODEC_QSV_H */
