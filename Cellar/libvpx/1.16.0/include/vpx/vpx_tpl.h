/*
 *  Copyright (c) 2023 The WebM project authors. All Rights Reserved.
 *
 *  Use of this source code is governed by a BSD-style license
 *  that can be found in the LICENSE file in the root of the source
 *  tree. An additional intellectual property rights grant can be found
 *  in the file PATENTS.  All contributing project authors may
 *  be found in the AUTHORS file in the root of the source tree.
 */

/*!\file
 * \brief Describes the TPL stats descriptor and associated operations
 *
 */
#ifndef VPX_VPX_VPX_TPL_H_
#define VPX_VPX_VPX_TPL_H_

#include "./vpx_integer.h"
#include "./vpx_codec.h"

#ifdef __cplusplus
extern "C" {
#endif

/*!\brief Current ABI version number
 *
 * \internal
 * If this file is altered in any way that changes the ABI, this value
 * must be bumped.  Examples include, but are not limited to, changing
 * types, removing or reassigning enums, adding/removing/rearranging
 * fields to structures
 */
#define VPX_TPL_ABI_VERSION 5 /**<\hideinitializer*/

/*!\brief Temporal dependency model stats for each block before propagation */
typedef struct VpxTplBlockStats {
  int16_t row;            /**< Pixel row of the top left corner */
  int16_t col;            /**< Pixel col of the top left corner */
  int64_t intra_cost;     /**< Intra cost */
  int64_t inter_cost;     /**< Inter cost */
  int16_t mv_r;           /**< Motion vector row in pixel */
  int16_t mv_c;           /**< Motion vector col in pixel */
  int64_t srcrf_rate;     /**< Rate from source ref frame */
  int64_t srcrf_dist;     /**< Distortion from source ref frame */
  int64_t pred_error;     /**< Prediction error */
  int64_t inter_pred_err; /**< Inter prediction error */
  int64_t intra_pred_err; /**< Intra prediction error */
  int ref_frame_index;    /**< Ref frame index in the ref frame buffer */
} VpxTplBlockStats;

/*!\brief Temporal dependency model stats for each frame before propagation */
typedef struct VpxTplFrameStats {
  int frame_width;  /**< Frame width */
  int frame_height; /**< Frame height */
  int num_blocks;   /**< Number of blocks. Size of block_stats_list */
  VpxTplBlockStats *block_stats_list; /**< List of tpl stats for each block */
} VpxTplFrameStats;

/*!\brief Temporal dependency model stats for each GOP before propagation */
typedef struct VpxTplGopStats {
  int size; /**< GOP size, also the size of frame_stats_list. */
  VpxTplFrameStats *frame_stats_list; /**< List of tpl stats for each frame */
} VpxTplGopStats;

#ifdef __cplusplus
}  // extern "C"
#endif

#endif  // VPX_VPX_VPX_TPL_H_
