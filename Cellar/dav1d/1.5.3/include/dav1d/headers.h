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

#ifndef DAV1D_HEADERS_H
#define DAV1D_HEADERS_H

#include <stdint.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

// Constants from Section 3. "Symbols and abbreviated terms"
#define DAV1D_MAX_CDEF_STRENGTHS 8
#define DAV1D_MAX_OPERATING_POINTS 32
#define DAV1D_MAX_TILE_COLS 64
#define DAV1D_MAX_TILE_ROWS 64
#define DAV1D_MAX_SEGMENTS 8
#define DAV1D_NUM_REF_FRAMES 8
#define DAV1D_PRIMARY_REF_NONE 7
#define DAV1D_REFS_PER_FRAME 7
#define DAV1D_TOTAL_REFS_PER_FRAME (DAV1D_REFS_PER_FRAME + 1)

enum Dav1dObuType {
    DAV1D_OBU_SEQ_HDR   = 1,
    DAV1D_OBU_TD        = 2,
    DAV1D_OBU_FRAME_HDR = 3,
    DAV1D_OBU_TILE_GRP  = 4,
    DAV1D_OBU_METADATA  = 5,
    DAV1D_OBU_FRAME     = 6,
    DAV1D_OBU_REDUNDANT_FRAME_HDR = 7,
    DAV1D_OBU_PADDING   = 15,
};

enum Dav1dTxfmMode {
    DAV1D_TX_4X4_ONLY,
    DAV1D_TX_LARGEST,
    DAV1D_TX_SWITCHABLE,
    DAV1D_N_TX_MODES,
};

enum Dav1dFilterMode {
    DAV1D_FILTER_8TAP_REGULAR,
    DAV1D_FILTER_8TAP_SMOOTH,
    DAV1D_FILTER_8TAP_SHARP,
    DAV1D_N_SWITCHABLE_FILTERS,
    DAV1D_FILTER_BILINEAR = DAV1D_N_SWITCHABLE_FILTERS,
    DAV1D_N_FILTERS,
    DAV1D_FILTER_SWITCHABLE = DAV1D_N_FILTERS,
};

enum Dav1dAdaptiveBoolean {
    DAV1D_OFF = 0,
    DAV1D_ON = 1,
    DAV1D_ADAPTIVE = 2,
};

enum Dav1dRestorationType {
    DAV1D_RESTORATION_NONE,
    DAV1D_RESTORATION_SWITCHABLE,
    DAV1D_RESTORATION_WIENER,
    DAV1D_RESTORATION_SGRPROJ,
};

enum Dav1dWarpedMotionType {
    DAV1D_WM_TYPE_IDENTITY,
    DAV1D_WM_TYPE_TRANSLATION,
    DAV1D_WM_TYPE_ROT_ZOOM,
    DAV1D_WM_TYPE_AFFINE,
};

typedef struct Dav1dWarpedMotionParams {
    enum Dav1dWarpedMotionType type;
    int32_t matrix[6];
    union {
        struct {
            int16_t alpha, beta, gamma, delta;
        } p;
        int16_t abcd[4];
    } u;
} Dav1dWarpedMotionParams;

enum Dav1dPixelLayout {
    DAV1D_PIXEL_LAYOUT_I400, ///< monochrome
    DAV1D_PIXEL_LAYOUT_I420, ///< 4:2:0 planar
    DAV1D_PIXEL_LAYOUT_I422, ///< 4:2:2 planar
    DAV1D_PIXEL_LAYOUT_I444, ///< 4:4:4 planar
};

enum Dav1dFrameType {
    DAV1D_FRAME_TYPE_KEY = 0,    ///< Key Intra frame
    DAV1D_FRAME_TYPE_INTER = 1,  ///< Inter frame
    DAV1D_FRAME_TYPE_INTRA = 2,  ///< Non key Intra frame
    DAV1D_FRAME_TYPE_SWITCH = 3, ///< Switch Inter frame
};

enum Dav1dColorPrimaries {
    DAV1D_COLOR_PRI_BT709 = 1,
    DAV1D_COLOR_PRI_UNKNOWN = 2,
    DAV1D_COLOR_PRI_BT470M = 4,
    DAV1D_COLOR_PRI_BT470BG = 5,
    DAV1D_COLOR_PRI_BT601 = 6,
    DAV1D_COLOR_PRI_SMPTE240 = 7,
    DAV1D_COLOR_PRI_FILM = 8,
    DAV1D_COLOR_PRI_BT2020 = 9,
    DAV1D_COLOR_PRI_XYZ = 10,
    DAV1D_COLOR_PRI_SMPTE431 = 11,
    DAV1D_COLOR_PRI_SMPTE432 = 12,
    DAV1D_COLOR_PRI_EBU3213 = 22,
    DAV1D_COLOR_PRI_RESERVED = 255,
};

enum Dav1dTransferCharacteristics {
    DAV1D_TRC_BT709 = 1,
    DAV1D_TRC_UNKNOWN = 2,
    DAV1D_TRC_BT470M = 4,
    DAV1D_TRC_BT470BG = 5,
    DAV1D_TRC_BT601 = 6,
    DAV1D_TRC_SMPTE240 = 7,
    DAV1D_TRC_LINEAR = 8,
    DAV1D_TRC_LOG100 = 9,         ///< logarithmic (100:1 range)
    DAV1D_TRC_LOG100_SQRT10 = 10, ///< lograithmic (100*sqrt(10):1 range)
    DAV1D_TRC_IEC61966 = 11,
    DAV1D_TRC_BT1361 = 12,
    DAV1D_TRC_SRGB = 13,
    DAV1D_TRC_BT2020_10BIT = 14,
    DAV1D_TRC_BT2020_12BIT = 15,
    DAV1D_TRC_SMPTE2084 = 16,     ///< PQ
    DAV1D_TRC_SMPTE428 = 17,
    DAV1D_TRC_HLG = 18,           ///< hybrid log/gamma (BT.2100 / ARIB STD-B67)
    DAV1D_TRC_RESERVED = 255,
};

enum Dav1dMatrixCoefficients {
    DAV1D_MC_IDENTITY = 0,
    DAV1D_MC_BT709 = 1,
    DAV1D_MC_UNKNOWN = 2,
    DAV1D_MC_FCC = 4,
    DAV1D_MC_BT470BG = 5,
    DAV1D_MC_BT601 = 6,
    DAV1D_MC_SMPTE240 = 7,
    DAV1D_MC_SMPTE_YCGCO = 8,
    DAV1D_MC_BT2020_NCL = 9,
    DAV1D_MC_BT2020_CL = 10,
    DAV1D_MC_SMPTE2085 = 11,
    DAV1D_MC_CHROMAT_NCL = 12, ///< Chromaticity-derived
    DAV1D_MC_CHROMAT_CL = 13,
    DAV1D_MC_ICTCP = 14,
    DAV1D_MC_RESERVED = 255,
};

enum Dav1dChromaSamplePosition {
    DAV1D_CHR_UNKNOWN = 0,
    DAV1D_CHR_VERTICAL = 1,  ///< Horizontally co-located with luma(0, 0)
                           ///< sample, between two vertical samples
    DAV1D_CHR_COLOCATED = 2, ///< Co-located with luma(0, 0) sample
};

typedef struct Dav1dContentLightLevel {
    uint16_t max_content_light_level;
    uint16_t max_frame_average_light_level;
} Dav1dContentLightLevel;

typedef struct Dav1dMasteringDisplay {
    uint16_t primaries[3][2]; ///< 0.16 fixed point
    uint16_t white_point[2]; ///< 0.16 fixed point
    uint32_t max_luminance; ///< 24.8 fixed point
    uint32_t min_luminance; ///< 18.14 fixed point
} Dav1dMasteringDisplay;

typedef struct Dav1dITUTT35 {
    uint8_t  country_code;
    uint8_t  country_code_extension_byte;
    size_t   payload_size;
    uint8_t *payload;
} Dav1dITUTT35;

typedef struct Dav1dSequenceHeader {
    /**
     * Stream profile, 0 for 8-10 bits/component 4:2:0 or monochrome;
     * 1 for 8-10 bits/component 4:4:4; 2 for 4:2:2 at any bits/component,
     * or 12 bits/component at any chroma subsampling.
     */
    uint8_t profile;
    /**
     * Maximum dimensions for this stream. In non-scalable streams, these
     * are often the actual dimensions of the stream, although that is not
     * a normative requirement.
     */
    int max_width, max_height;
    enum Dav1dPixelLayout layout; ///< format of the picture
    enum Dav1dColorPrimaries pri; ///< color primaries (av1)
    enum Dav1dTransferCharacteristics trc; ///< transfer characteristics (av1)
    enum Dav1dMatrixCoefficients mtrx; ///< matrix coefficients (av1)
    enum Dav1dChromaSamplePosition chr; ///< chroma sample position (av1)
    /**
     * 0, 1 and 2 mean 8, 10 or 12 bits/component, respectively. This is not
     * exactly the same as 'hbd' from the spec; the spec's hbd distinguishes
     * between 8 (0) and 10-12 (1) bits/component, and another element
     * (twelve_bit) to distinguish between 10 and 12 bits/component. To get
     * the spec's hbd, use !!our_hbd, and to get twelve_bit, use hbd == 2.
     */
    uint8_t hbd;
    /**
     * Pixel data uses JPEG pixel range ([0,255] for 8bits) instead of
     * MPEG pixel range ([16,235] for 8bits luma, [16,240] for 8bits chroma).
     */
    uint8_t color_range;

    uint8_t num_operating_points;
    struct Dav1dSequenceHeaderOperatingPoint {
        uint8_t major_level, minor_level;
        uint8_t initial_display_delay;
        uint16_t idc;
        uint8_t tier;
        uint8_t decoder_model_param_present;
        uint8_t display_model_param_present;
    } operating_points[DAV1D_MAX_OPERATING_POINTS];

    uint8_t still_picture;
    uint8_t reduced_still_picture_header;
    uint8_t timing_info_present;
    uint32_t num_units_in_tick;
    uint32_t time_scale;
    uint8_t equal_picture_interval;
    uint32_t num_ticks_per_picture;
    uint8_t decoder_model_info_present;
    uint8_t encoder_decoder_buffer_delay_length;
    uint32_t num_units_in_decoding_tick;
    uint8_t buffer_removal_delay_length;
    uint8_t frame_presentation_delay_length;
    uint8_t display_model_info_present;
    uint8_t width_n_bits, height_n_bits;
    uint8_t frame_id_numbers_present;
    uint8_t delta_frame_id_n_bits;
    uint8_t frame_id_n_bits;
    uint8_t sb128;
    uint8_t filter_intra;
    uint8_t intra_edge_filter;
    uint8_t inter_intra;
    uint8_t masked_compound;
    uint8_t warped_motion;
    uint8_t dual_filter;
    uint8_t order_hint;
    uint8_t jnt_comp;
    uint8_t ref_frame_mvs;
    enum Dav1dAdaptiveBoolean screen_content_tools;
    enum Dav1dAdaptiveBoolean force_integer_mv;
    uint8_t order_hint_n_bits;
    uint8_t super_res;
    uint8_t cdef;
    uint8_t restoration;
    uint8_t ss_hor, ss_ver, monochrome;
    uint8_t color_description_present;
    uint8_t separate_uv_delta_q;
    uint8_t film_grain_present;

    // Dav1dSequenceHeaders of the same sequence are required to be
    // bit-identical until this offset. See 7.5 "Ordering of OBUs":
    //   Within a particular coded video sequence, the contents of
    //   sequence_header_obu must be bit-identical each time the
    //   sequence header appears except for the contents of
    //   operating_parameters_info.
    struct Dav1dSequenceHeaderOperatingParameterInfo {
        uint32_t decoder_buffer_delay;
        uint32_t encoder_buffer_delay;
        uint8_t low_delay_mode;
    } operating_parameter_info[DAV1D_MAX_OPERATING_POINTS];
} Dav1dSequenceHeader;

typedef struct Dav1dSegmentationData {
    int16_t delta_q;
    int8_t delta_lf_y_v, delta_lf_y_h, delta_lf_u, delta_lf_v;
    int8_t ref;
    uint8_t skip;
    uint8_t globalmv;
} Dav1dSegmentationData;

typedef struct Dav1dSegmentationDataSet {
    Dav1dSegmentationData d[DAV1D_MAX_SEGMENTS];
    uint8_t preskip;
    int8_t last_active_segid;
} Dav1dSegmentationDataSet;

typedef struct Dav1dLoopfilterModeRefDeltas {
    int8_t mode_delta[2 /* is_zeromv */];
    int8_t ref_delta[DAV1D_TOTAL_REFS_PER_FRAME];
} Dav1dLoopfilterModeRefDeltas;

typedef struct Dav1dFilmGrainData {
    unsigned seed;
    int num_y_points;
    uint8_t y_points[14][2 /* value, scaling */];
    int chroma_scaling_from_luma;
    int num_uv_points[2];
    uint8_t uv_points[2][10][2 /* value, scaling */];
    int scaling_shift;
    int ar_coeff_lag;
    int8_t ar_coeffs_y[24];
    int8_t ar_coeffs_uv[2][25 + 3 /* padding for alignment purposes */];
    uint64_t ar_coeff_shift;
    int grain_scale_shift;
    int uv_mult[2];
    int uv_luma_mult[2];
    int uv_offset[2];
    int overlap_flag;
    int clip_to_restricted_range;
} Dav1dFilmGrainData;

typedef struct Dav1dFrameHeader {
    struct {
        Dav1dFilmGrainData data;
        uint8_t present, update;
    } film_grain; ///< film grain parameters
    enum Dav1dFrameType frame_type; ///< type of the picture
    int width[2 /* { coded_width, superresolution_upscaled_width } */], height;
    uint8_t frame_offset; ///< frame number
    uint8_t temporal_id; ///< temporal id of the frame for SVC
    uint8_t spatial_id; ///< spatial id of the frame for SVC

    uint8_t show_existing_frame;
    uint8_t existing_frame_idx;
    uint32_t frame_id;
    uint32_t frame_presentation_delay;
    uint8_t show_frame;
    uint8_t showable_frame;
    uint8_t error_resilient_mode;
    uint8_t disable_cdf_update;
    uint8_t allow_screen_content_tools;
    uint8_t force_integer_mv;
    uint8_t frame_size_override;
    uint8_t primary_ref_frame;
    uint8_t buffer_removal_time_present;
    struct Dav1dFrameHeaderOperatingPoint {
        uint32_t buffer_removal_time;
    } operating_points[DAV1D_MAX_OPERATING_POINTS];
    uint8_t refresh_frame_flags;
    int render_width, render_height;
    struct {
        uint8_t width_scale_denominator;
        uint8_t enabled;
    } super_res;
    uint8_t have_render_size;
    uint8_t allow_intrabc;
    uint8_t frame_ref_short_signaling;
    int8_t refidx[DAV1D_REFS_PER_FRAME];
    uint8_t hp;
    enum Dav1dFilterMode subpel_filter_mode;
    uint8_t switchable_motion_mode;
    uint8_t use_ref_frame_mvs;
    uint8_t refresh_context;
    struct {
        uint8_t uniform;
        uint8_t n_bytes;
        uint8_t min_log2_cols, max_log2_cols, log2_cols, cols;
        uint8_t min_log2_rows, max_log2_rows, log2_rows, rows;
        uint16_t col_start_sb[DAV1D_MAX_TILE_COLS + 1];
        uint16_t row_start_sb[DAV1D_MAX_TILE_ROWS + 1];
        uint16_t update;
    } tiling;
    struct {
        uint8_t yac;
        int8_t ydc_delta;
        int8_t udc_delta, uac_delta, vdc_delta, vac_delta;
        uint8_t qm, qm_y, qm_u, qm_v;
    } quant;
    struct {
        uint8_t enabled, update_map, temporal, update_data;
        Dav1dSegmentationDataSet seg_data;
        uint8_t lossless[DAV1D_MAX_SEGMENTS], qidx[DAV1D_MAX_SEGMENTS];
    } segmentation;
    struct {
        struct {
            uint8_t present;
            uint8_t res_log2;
        } q;
        struct {
            uint8_t present;
            uint8_t res_log2;
            uint8_t multi;
        } lf;
    } delta;
    uint8_t all_lossless;
    struct {
        uint8_t level_y[2 /* dir */];
        uint8_t level_u, level_v;
        uint8_t mode_ref_delta_enabled;
        uint8_t mode_ref_delta_update;
        Dav1dLoopfilterModeRefDeltas mode_ref_deltas;
        uint8_t sharpness;
    } loopfilter;
    struct {
        uint8_t damping;
        uint8_t n_bits;
        uint8_t y_strength[DAV1D_MAX_CDEF_STRENGTHS];
        uint8_t uv_strength[DAV1D_MAX_CDEF_STRENGTHS];
    } cdef;
    struct {
        enum Dav1dRestorationType type[3 /* plane */];
        uint8_t unit_size[2 /* y, uv */];
    } restoration;
    enum Dav1dTxfmMode txfm_mode;
    uint8_t switchable_comp_refs;
    uint8_t skip_mode_allowed, skip_mode_enabled;
    int8_t skip_mode_refs[2];
    uint8_t warp_motion;
    uint8_t reduced_txtp_set;
    Dav1dWarpedMotionParams gmv[DAV1D_REFS_PER_FRAME];
} Dav1dFrameHeader;

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* DAV1D_HEADERS_H */
