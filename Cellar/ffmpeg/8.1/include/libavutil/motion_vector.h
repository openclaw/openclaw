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

#ifndef AVUTIL_MOTION_VECTOR_H
#define AVUTIL_MOTION_VECTOR_H

#include <stdint.h>

typedef struct AVMotionVector {
    /**
     * Where the current macroblock comes from; negative value when it comes
     * from the past, positive value when it comes from the future.
     * XXX: set exact relative ref frame reference instead of a +/- 1 "direction".
     */
    int32_t source;
    /**
     * Width and height of the block.
     */
    uint8_t w, h;
    /**
     * Absolute source position. Can be outside the frame area.
     */
    int16_t src_x, src_y;
    /**
     * Absolute destination position. Can be outside the frame area.
     */
    int16_t dst_x, dst_y;
    /**
     * Extra flag information.
     * Currently unused.
     */
    uint64_t flags;
    /**
     * Motion vector
     * src_x = dst_x + motion_x / motion_scale
     * src_y = dst_y + motion_y / motion_scale
     */
    int32_t motion_x, motion_y;
    uint16_t motion_scale;
} AVMotionVector;

#endif /* AVUTIL_MOTION_VECTOR_H */
