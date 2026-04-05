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

#ifndef AVUTIL_VIDEO_ENC_PARAMS_H
#define AVUTIL_VIDEO_ENC_PARAMS_H

#include <stddef.h>
#include <stdint.h>

#include "libavutil/avassert.h"
#include "libavutil/frame.h"

enum AVVideoEncParamsType {
    AV_VIDEO_ENC_PARAMS_NONE = -1,
    /**
     * VP9 stores:
     * - per-frame base (luma AC) quantizer index, exported as AVVideoEncParams.qp
     * - deltas for luma DC, chroma AC and chroma DC, exported in the
     *   corresponding entries in AVVideoEncParams.delta_qp
     * - per-segment delta, exported as for each block as AVVideoBlockParams.delta_qp
     *
     * To compute the resulting quantizer index for a block:
     * - for luma AC, add the base qp and the per-block delta_qp, saturating to
     *   unsigned 8-bit.
     * - for luma DC and chroma AC/DC, add the corresponding
     *   AVVideoBlockParams.delta_qp to the luma AC index, again saturating to
     *   unsigned 8-bit.
     */
    AV_VIDEO_ENC_PARAMS_VP9,

    /**
     * H.264 stores:
     * - in PPS (per-picture):
     *   * initial QP_Y (luma) value, exported as AVVideoEncParams.qp
     *   * delta(s) for chroma QP values (same for both, or each separately),
     *     exported as in the corresponding entries in AVVideoEncParams.delta_qp
     * - per-slice QP delta, not exported directly, added to the per-MB value
     * - per-MB delta; not exported directly; the final per-MB quantizer
     *   parameter - QP_Y - minus the value in AVVideoEncParams.qp is exported
     *   as AVVideoBlockParams.qp_delta.
     */
    AV_VIDEO_ENC_PARAMS_H264,

    /*
     * MPEG-2-compatible quantizer.
     *
     * Summing the frame-level qp with the per-block delta_qp gives the
     * resulting quantizer for the block.
     */
    AV_VIDEO_ENC_PARAMS_MPEG2,
};

/**
 * Video encoding parameters for a given frame. This struct is allocated along
 * with an optional array of per-block AVVideoBlockParams descriptors.
 * Must be allocated with av_video_enc_params_alloc().
 */
typedef struct AVVideoEncParams {
    /**
     * Number of blocks in the array.
     *
     * May be 0, in which case no per-block information is present. In this case
     * the values of blocks_offset / block_size are unspecified and should not
     * be accessed.
     */
    unsigned int nb_blocks;
    /**
     * Offset in bytes from the beginning of this structure at which the array
     * of blocks starts.
     */
    size_t blocks_offset;
    /*
     * Size of each block in bytes. May not match sizeof(AVVideoBlockParams).
     */
    size_t block_size;

    /**
     * Type of the parameters (the codec they are used with).
     */
    enum AVVideoEncParamsType type;

    /**
     * Base quantisation parameter for the frame. The final quantiser for a
     * given block in a given plane is obtained from this value, possibly
     * combined with {@code delta_qp} and the per-block delta in a manner
     * documented for each type.
     */
    int32_t qp;

    /**
     * Quantisation parameter offset from the base (per-frame) qp for a given
     * plane (first index) and AC/DC coefficients (second index).
     */
    int32_t delta_qp[4][2];
} AVVideoEncParams;

/**
 * Data structure for storing block-level encoding information.
 * It is allocated as a part of AVVideoEncParams and should be retrieved with
 * av_video_enc_params_block().
 *
 * sizeof(AVVideoBlockParams) is not a part of the ABI and new fields may be
 * added to it.
 */
typedef struct AVVideoBlockParams {
    /**
     * Distance in luma pixels from the top-left corner of the visible frame
     * to the top-left corner of the block.
     * Can be negative if top/right padding is present on the coded frame.
     */
    int src_x, src_y;
    /**
     * Width and height of the block in luma pixels.
     */
    int w, h;

    /**
     * Difference between this block's final quantization parameter and the
     * corresponding per-frame value.
     */
    int32_t delta_qp;
} AVVideoBlockParams;

/**
 * Get the block at the specified {@code idx}. Must be between 0 and nb_blocks - 1.
 */
static av_always_inline AVVideoBlockParams*
av_video_enc_params_block(AVVideoEncParams *par, unsigned int idx)
{
    av_assert0(idx < par->nb_blocks);
    return (AVVideoBlockParams *)((uint8_t *)par + par->blocks_offset +
                                  idx * par->block_size);
}

/**
 * Allocates memory for AVVideoEncParams of the given type, plus an array of
 * {@code nb_blocks} AVVideoBlockParams and initializes the variables. Can be
 * freed with a normal av_free() call.
 *
 * @param out_size if non-NULL, the size in bytes of the resulting data array is
 * written here.
 */
AVVideoEncParams *av_video_enc_params_alloc(enum AVVideoEncParamsType type,
                                            unsigned int nb_blocks, size_t *out_size);

/**
 * Allocates memory for AVEncodeInfoFrame plus an array of
 * {@code nb_blocks} AVEncodeInfoBlock in the given AVFrame {@code frame}
 * as AVFrameSideData of type AV_FRAME_DATA_VIDEO_ENC_PARAMS
 * and initializes the variables.
 */
AVVideoEncParams*
av_video_enc_params_create_side_data(AVFrame *frame, enum AVVideoEncParamsType type,
                                     unsigned int nb_blocks);

#endif /* AVUTIL_VIDEO_ENC_PARAMS_H */
