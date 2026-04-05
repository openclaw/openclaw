/*
 * Copyright © 2018-2020, VideoLAN and dav1d authors
 * Copyright © 2018, Two Orioles, LLC
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the documentation
 *    and/or other materials provided with the distribution.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR
 * ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
 * (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
 * LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
 * ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
 * SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

#ifndef DAV1D_PICTURE_H
#define DAV1D_PICTURE_H

#include <stddef.h>
#include <stdint.h>

#include "common.h"
#include "headers.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Number of bytes to align AND pad picture memory buffers by, so that SIMD
 * implementations can over-read by a few bytes, and use aligned read/write
 * instructions. */
#define DAV1D_PICTURE_ALIGNMENT 64

typedef struct Dav1dPictureParameters {
    int w; ///< width (in pixels)
    int h; ///< height (in pixels)
    enum Dav1dPixelLayout layout; ///< format of the picture
    int bpc; ///< bits per pixel component (8 or 10)
} Dav1dPictureParameters;

typedef struct Dav1dPicture {
    Dav1dSequenceHeader *seq_hdr;
    Dav1dFrameHeader *frame_hdr;

    /**
     * Pointers to planar image data (Y is [0], U is [1], V is [2]). The data
     * should be bytes (for 8 bpc) or words (for 10 bpc). In case of words
     * containing 10 bpc image data, the pixels should be located in the LSB
     * bits, so that values range between [0, 1023]; the upper bits should be
     * zero'ed out.
     */
    void *data[3];

    /**
     * Number of bytes between 2 lines in data[] for luma [0] or chroma [1].
     */
    ptrdiff_t stride[2];

    Dav1dPictureParameters p;
    Dav1dDataProps m;

    /**
     * High Dynamic Range Content Light Level metadata applying to this picture,
     * as defined in section 5.8.3 and 6.7.3
     */
    Dav1dContentLightLevel *content_light;
    /**
     * High Dynamic Range Mastering Display Color Volume metadata applying to
     * this picture, as defined in section 5.8.4 and 6.7.4
     */
    Dav1dMasteringDisplay *mastering_display;
    /**
     * Array of ITU-T T.35 metadata as defined in section 5.8.2 and 6.7.2
     */
    Dav1dITUTT35 *itut_t35;

    /**
     * Number of ITU-T T35 metadata entries in the array
     */
    size_t n_itut_t35;

    uintptr_t reserved[4]; ///< reserved for future use

    struct Dav1dRef *frame_hdr_ref; ///< Dav1dFrameHeader allocation origin
    struct Dav1dRef *seq_hdr_ref; ///< Dav1dSequenceHeader allocation origin
    struct Dav1dRef *content_light_ref; ///< Dav1dContentLightLevel allocation origin
    struct Dav1dRef *mastering_display_ref; ///< Dav1dMasteringDisplay allocation origin
    struct Dav1dRef *itut_t35_ref; ///< Dav1dITUTT35 allocation origin
    uintptr_t reserved_ref[4]; ///< reserved for future use
    struct Dav1dRef *ref; ///< Frame data allocation origin

    void *allocator_data; ///< pointer managed by the allocator
} Dav1dPicture;

typedef struct Dav1dPicAllocator {
    void *cookie; ///< custom data to pass to the allocator callbacks.
    /**
     * Allocate the picture buffer based on the Dav1dPictureParameters.
     *
     * The data[0], data[1] and data[2] must be DAV1D_PICTURE_ALIGNMENT byte
     * aligned and with a pixel width/height multiple of 128 pixels. Any
     * allocated memory area should also be padded by DAV1D_PICTURE_ALIGNMENT
     * bytes.
     * data[1] and data[2] must share the same stride[1].
     *
     * This function will be called on the main thread (the thread which calls
     * dav1d_get_picture()).
     *
     * @param  pic The picture to allocate the buffer for. The callback needs to
     *             fill the picture data[0], data[1], data[2], stride[0] and
     *             stride[1].
     *             The allocator can fill the pic allocator_data pointer with
     *             a custom pointer that will be passed to
     *             release_picture_callback().
     * @param cookie Custom pointer passed to all calls.
     *
     * @note No fields other than data, stride and allocator_data must be filled
     *       by this callback.
     * @return 0 on success. A negative DAV1D_ERR value on error.
     */
    int (*alloc_picture_callback)(Dav1dPicture *pic, void *cookie);
    /**
     * Release the picture buffer.
     *
     * If frame threading is used, this function may be called by the main
     * thread (the thread which calls dav1d_get_picture()) or any of the frame
     * threads and thus must be thread-safe. If frame threading is not used,
     * this function will only be called on the main thread.
     *
     * @param pic    The picture that was filled by alloc_picture_callback().
     * @param cookie Custom pointer passed to all calls.
     */
    void (*release_picture_callback)(Dav1dPicture *pic, void *cookie);
} Dav1dPicAllocator;

/**
 * Release reference to a picture.
 */
DAV1D_API void dav1d_picture_unref(Dav1dPicture *p);

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* DAV1D_PICTURE_H */
