/*
* Copyright(c) 2019 Intel Corporation
*
* This source code is subject to the terms of the BSD 3-Clause Clear License and
* the Alliance for Open Media Patent License 1.0. If the BSD 3-Clause Clear License
* was not distributed with this source code in the LICENSE file, you can
* obtain it at https://www.aomedia.org/license. If the Alliance for Open
* Media Patent License 1.0 was not distributed with this source code in the
* PATENTS file, you can obtain it at https://www.aomedia.org/license/patent-license.
*/

#ifndef EbSvtAv1Enc_h
#define EbSvtAv1Enc_h

#ifdef __cplusplus
extern "C" {
#endif // __cplusplus

#include <stdint.h>
#include "EbSvtAv1.h"
#include <stdlib.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdbool.h>
/**
 * @brief SVT-AV1 encoder ABI version
 *
 * Should be increased by 1 everytime a public struct in the encoder
 * has been modified, and reset anytime the major API version has
 * been changed. Used to keep track if a field has been added or not.
 */
#define SVT_AV1_ENC_ABI_VERSION 0
#define HIERARCHICAL_LEVELS_AUTO ((uint32_t)(~0))
#define MAX_HIERARCHICAL_LEVEL 6
#define REF_LIST_MAX_DEPTH 4
/*!\brief Decorator indicating that given struct/union/enum is packed */
#ifndef ATTRIBUTE_PACKED
#if defined(__GNUC__) && __GNUC__
#define ATTRIBUTE_PACKED __attribute__((packed))
#else
#define ATTRIBUTE_PACKED
#endif
#endif /* ATTRIBUTE_PACKED */
typedef enum ATTRIBUTE_PACKED {
    ENC_MR         = -1, //Research mode with higher quality than M0
    ENC_M0         = 0,
    ENC_M1         = 1,
    ENC_M2         = 2,
    ENC_M3         = 3,
    ENC_M4         = 4,
    ENC_M5         = 5,
    ENC_M6         = 6,
    ENC_M7         = 7,
    ENC_M8         = 8,
    ENC_M9         = 9,
    ENC_M10        = 10,
    ENC_M11        = 11,
    ENC_M12        = 12,
    ENC_M13        = 13,
    MAX_ENC_PRESET = ENC_M13
} EncMode;

#define DEFAULT -1

#define EB_BUFFERFLAG_EOS 0x00000001 // signals the last packet of the stream
#define EB_BUFFERFLAG_SHOW_EXT 0x00000002 // signals that the packet contains a show existing frame at the end
#define EB_BUFFERFLAG_HAS_TD 0x00000004 // signals that the packet contains a TD
#define EB_BUFFERFLAG_IS_ALT_REF 0x00000008 // signals that the packet contains an ALT_REF frame
#define EB_BUFFERFLAG_ERROR_MASK \
    0xFFFFFFF0 // mask for signalling error assuming top flags fit in 4 bits. To be changed, if more flags are added.

/*
 * Struct for storing content light level information
 * Values are stored in BE format
 * Refer to the AV1 specification 6.7.3 for more details
 */
struct EbContentLightLevel {
    uint16_t max_cll;
    uint16_t max_fall;
};

/*
 * Struct for storing x and y chroma points, values are stored in BE format
 */
struct EbSvtAv1ChromaPoints {
    uint16_t x;
    uint16_t y;
};

/*
 * Struct for storing mastering-display information
 * values are stored in BE format
 * Refer to the AV1 specification 6.7.4 for more details
 */
struct EbSvtAv1MasteringDisplayInfo {
    struct EbSvtAv1ChromaPoints r;
    struct EbSvtAv1ChromaPoints g;
    struct EbSvtAv1ChromaPoints b;
    struct EbSvtAv1ChromaPoints white_point;
    uint32_t                    max_luma;
    uint32_t                    min_luma;
};

// super-res modes
typedef enum {
    SUPERRES_NONE, // No frame superres allowed.
    SUPERRES_FIXED, // All frames are coded at the specified scale, and super-resolved.
    SUPERRES_RANDOM, // All frames are coded at a random scale, and super-resolved.
    SUPERRES_QTHRESH, // Superres scale for a frame is determined based on q_index.
    SUPERRES_AUTO, // Automatically select superres for appropriate frames.
    SUPERRES_MODES
} SUPERRES_MODE;

// super-res auto search type
typedef enum {
    SUPERRES_AUTO_ALL, // Tries all possible superres ratios
    SUPERRES_AUTO_DUAL, // Tries no superres and q-based superres ratios
    SUPERRES_AUTO_SOLO, // Only apply the q-based superres ratio
    SUPERRES_AUTO_SEARCH_TYPES
} SUPERRES_AUTO_SEARCH_TYPE;

// reference scaling modes
typedef enum {
    RESIZE_NONE, // No frame resize allowed.
    RESIZE_FIXED, // All frames are coded at the specified scale.
    RESIZE_RANDOM, // All frames are coded at a random scale.
    RESIZE_DYNAMIC, // Resize scale for a frame in dynamic.
    RESIZE_RANDOM_ACCESS, // Resize scale frame by event in random access
    RESIZE_MODES
} RESIZE_MODE;

/* Indicates what prediction structure to use
 */
typedef enum PredStructure { ALL_INTRA, LOW_DELAY, RANDOM_ACCESS, PRED_TOTAL_COUNT, PRED_INVALID = 0xFF } PredStructure;

/** The SvtAv1IntraRefreshType is used to describe the intra refresh type.
*/
typedef enum SvtAv1IntraRefreshType {
    SVT_AV1_FWDKF_REFRESH = 1,
    SVT_AV1_KF_REFRESH    = 2,
} SvtAv1IntraRefreshType;

typedef enum {
    SVT_AV1_STREAM_INFO_START                = 1,
    SVT_AV1_STREAM_INFO_FIRST_PASS_STATS_OUT = SVT_AV1_STREAM_INFO_START,

    SVT_AV1_STREAM_INFO_END,
} SVT_AV1_STREAM_INFO_ID;

/*!\brief Generic fixed size buffer structure
 *
 * This structure is able to hold a reference to any fixed size buffer.
 */
typedef struct SvtAv1FixedBuf {
    void*    buf; /**< Pointer to the data. Does NOT own the data! */
    uint64_t sz; /**< Length of the buffer, in chars */
} SvtAv1FixedBuf; /**< alias for struct aom_fixed_buf */

/** Indicates how an S-Frame should be inserted.
*/
typedef enum EbSFrameMode {
    SFRAME_STRICT_BASE =
        1, /**< The considered frame will be made into an S-Frame only if it is a base layer inter frame */
    SFRAME_NEAREST_BASE =
        2, /**< If the considered frame is not an altref frame, the next base layer inter frame will be made into an S-Frame */
    SFRAME_FLEXIBLE_BASE =
        3, /**< If the considered frame is not an altref frame, modify the miniGOP layers to make the considered frame as an altref frame, then it will be made into an S-Frame */
    SFRAME_DEC_POSI_BASE =
        4, /**< If the considered frame in decode order is not an altref frame, modify the mini-GOP structure to promote its previous frame to an altref frame, and set the next altref to an S-Frame */
} EbSFrameMode;

/* Indicates what rate control mode is used.
 * Currently, cqp is distinguised by setting aq_mode to 0
 */
typedef enum SvtAv1RcMode {
    SVT_AV1_RC_MODE_CQP_OR_CRF = 0, // constant quantization parameter/constant rate factor
    SVT_AV1_RC_MODE_VBR        = 1, // variable bit rate
    SVT_AV1_RC_MODE_CBR        = 2, // constant bit rate
} SvtAv1RcMode;

typedef enum SvtAv1FrameUpdateType {
    SVT_AV1_KF_UPDATE,
    SVT_AV1_LF_UPDATE,
    SVT_AV1_GF_UPDATE,
    SVT_AV1_ARF_UPDATE,
    SVT_AV1_OVERLAY_UPDATE,
    SVT_AV1_INTNL_OVERLAY_UPDATE, // Internal Overlay Frame
    SVT_AV1_INTNL_ARF_UPDATE, // Internal Altref Frame
    SVT_AV1_FRAME_UPDATE_TYPES
} SvtAv1FrameUpdateType;

typedef struct SvtAv1FrameScaleEvts {
    uint32_t  evt_num;
    uint64_t* start_frame_nums;
    uint32_t* resize_kf_denoms;
    uint32_t* resize_denoms;
} SvtAv1FrameScaleEvts;

typedef struct SvtAv1SFramePositions {
    uint32_t  sframe_num;
    uint64_t* sframe_posis;
    uint32_t  sframe_qp_num;
    uint8_t*  sframe_qps;
    int8_t*   sframe_qp_offsets;
} SvtAv1SFramePositions;

// Will contain the EbEncApi which will live in the EncHandle class
// Only modifiable during config-time.
typedef struct EbSvtAv1EncConfiguration {
    /**
     * @brief Encoder preset used.
     * -2 and -1 are for debug purposes and should not be used.
     * 0 is the highest quality mode but is the slowest,
     * 13 is the fastest mode but is not as high quality.
     *
     * Min value is -2.
     * Max value is 13.
     * Default is 12.
     */
    int8_t enc_mode;

    // GOP Structure

    /* The intra period defines the interval of frames after which you insert an
     * Intra refresh. It is strongly recommended to set the value to multiple of
     * 2^(hierarchical_levels), subtracting one if using open GOP (intra_refresh_type == 1).
     * For instance, to get a 5-second GOP (default being >=5 seconds)
     * with hierarchical_levels = 3 and open GOP you could use 319, 279, 159
     * for 60, 50, or 30 respectively.
     *
     * -1 = no intra update.
     * -2 = auto.
     *
     * Default is -2. */
    int32_t intra_period_length;

    /* Random access.
     *
     * 1 = CRA, open GOP.
     * 2 = IDR, closed GOP.
     *
     * Default is 1. */
    SvtAv1IntraRefreshType intra_refresh_type;
    /* Number of hierarchical layers used to construct GOP.
     * Minigop size = 2^HierarchicalLevels.
     *
     * Default is auto */
    uint32_t hierarchical_levels;
    /* Prediction structure used to construct GOP. There are two main structures
     * supported, which are: Low Delay and Random Access.
     *
     * In Low Delay structure, pictures within a mini GOP refer to the previously
     * encoded pictures in display order. In other words, pictures with display
     * order N can only be referenced by pictures with display order greater than
     * N, and it can only refer pictures with picture order lower than N.
     *
     * In Random Access structure, the B/b pictures can refer to reference pictures
     * from both directions (past and future).
     *
     * Refer to PredStructure enum for valid values.
     *
     * Default is RANDOM_ACCESS. */
    PredStructure pred_structure;

    // Input Info

    /**
     * @brief Frame width in pixels.
     *
     * Min is 64.
     * Max is 16384.
     * Default is 0.
     */
    uint32_t source_width;

    /**
     * @brief Frame height in pixels
     *
     * Min is 64.
     * Max is 8704.
     * Default is 0.
     */
    uint32_t source_height;

    /* Specifies the maximum frame width/height for the frames represented by the sequence header
     * (max_frame_width_minus_1 and max_frame_height_minus_1, spec 5.5.1).
     * Actual frame height could be equal to or less than this value. E.g. Use this value to indicate
     * the maximum height between renditions when switch frame feature is on.
     */
    uint32_t forced_max_frame_width;
    uint32_t forced_max_frame_height;
    /* Frame rate numerator. When zero, the encoder will use -fps if
     * FrameRateDenominator is also zero, otherwise an error is returned.
     *
     * Default is 0. */
    uint32_t frame_rate_numerator;
    /* Frame rate denominator. When zero, the encoder will use -fps if
     * FrameRateNumerator is also zero, otherwise an error is returned.
     *
     * Default is 0. */
    uint32_t frame_rate_denominator;
    /* Specifies the bit depth of input video.
     *
     * 8 = 8 bit.
     * 10 = 10 bit.
     *
     * Default is 8. */
    uint32_t encoder_bit_depth;

    /**
     * @brief Encoder color format.
     * Only YUV420 is supported for now.
     *
     * Min is YUV400.
     * Max is YUV444.
     * Default is YUV420.
     */
    EbColorFormat encoder_color_format;
    /**
     * @brief Bitstream profile to use.
     * 0: main, 1: high, 2: professional.
     *
     * Min is MAIN_PROFILE.
     * Max is PROFESSIONAL_PROFILE.
     * Default is MAIN_PROFILE.
     */
    EbAv1SeqProfile profile;
    /* Constraints for bitstream in terms of max bitrate and max buffer size.
     *
     * 0 = Main, for most applications.
     * 1 = High, for demanding applications.
     *
     * Default is 0. */
    uint32_t tier;
    /**
     * @brief Bitstream level.
     * 0: autodetect from bitstream, 20: level 2.0, 63: level 6.3, only levels 2.0-6.3 are properly defined.
     * The levels are defined at https://aomediacodec.github.io/av1-spec/av1-spec.pdf
     * under "A.3. Levels".
     *
     * Min is 0.
     * Max is 73.
     * Default is 0.
     */
    uint32_t level;
    /* Color primaries
    * values are from EbColorPrimaries
    Default is 2 (CP_UNSPECIFIED). */
    EbColorPrimaries color_primaries;
    /* Transfer characteristics
    * values are from EbTransferCharacteristics
    Default is 2 (TC_UNSPECIFIED). */
    EbTransferCharacteristics transfer_characteristics;
    /* Matrix coefficients
    * values are from EbMatrixCoefficients
    Default is 2 (MC_UNSPECIFIED). */
    EbMatrixCoefficients matrix_coefficients;
    /* Color range
    * values are from EbColorRange
    * 0: studio swing.
    * 1: full swing.
    Default is 0. */
    EbColorRange color_range;
    /* Mastering display metadata
    * values are from set using svt_aom_parse_mastering_display()
    */
    struct EbSvtAv1MasteringDisplayInfo mastering_display;
    /* Content light level
    * values are from set using svt_aom_parse_content_light_level()
    */
    struct EbContentLightLevel content_light_level;

    /* Chroma sample position
     * Values as per 6.4.2 of the specification:
     * EB_CSP_UNKNOWN:   default
     * EB_CSP_VERTICAL:  value 0 from H.273 AKA "left"
     * EB_CSP_COLOCATED: value 2 from H.273 AKA "top left"
     */
    EbChromaSamplePosition chroma_sample_position;

    // End input info

    /* Rate control mode.
     *
     * Refer to the SvtAv1RcMode enum for valid values
     * Default is 0. */
    uint8_t rate_control_mode;
    // Rate control tuning

    // Quantization
    /* Initial quantization parameter for the Intra pictures used under constant
     * qp rate control mode.
     *
     * Default is 50. */
    uint32_t qp;

    /* force qp values for every picture that are passed in the header pointer
    *
    * Default is 0.*/
    bool use_qp_file;
    /* Target bitrate in bits/second, only applicable when rate control mode is
     * set to 1 (VBR) or 2 (CBR).
     *
     * Default is 2000513. */
    uint32_t target_bit_rate;
    /* maximum bitrate in bits/second, only apllicable when rate control mode is
     * set to 0.
     *
     * Default is 0. */
    uint32_t max_bit_rate;
    /* Maxium QP value
     * Default is 63. */
    uint32_t max_qp_allowed;
    /* Minimum QP value
     * Default is auto. */
    uint32_t min_qp_allowed;
    /**
     * @brief Variable Bit Rate Minimum Section Percentage
     *
     * Indicates the minimum bitrate to be used for a single GOP as a percentage
     * of the target bitrate.
     *
     * Min is 0.
     * Max is 100.
     * Default is 0.
     */
    uint32_t vbr_min_section_pct;

    /**
     * @brief Variable Bit Rate Maximum Section Percentage
     *
     * Indicates the maximum bitrate to be used for a single GOP as a percentage
     * of the target bitrate.
     *
     * Min is 0.
     * Max is 10000.
     * Default is 2000.
     */
    uint32_t vbr_max_section_pct;

    /**
     * @brief UnderShoot Percentage
     *
     * Only applicable for VBR and CBR.
     *
     * Indicates the tolerance of the VBR algorithm to undershoot and is used
     * as a trigger threshold for more agressive adaptation of Quantization.
     *
     * Min is 0.
     * Max is 100.
     * Default is 25 for CBR and 50 for VBR.
     */
    uint32_t under_shoot_pct;

    /**
     * @brief OverShoot Percentage
     *
     * Only applicable for VBR and CBR
     *
     * Indicates the tolerance of the VBR algorithm to overshoot and is used as
     * a trigger threshold for more agressive adaptation of Quantization.
     *
     * Min is 0.
     * Max is 100.
     * Default is 25.
     */
    uint32_t over_shoot_pct;

    /**
     * @brief MaxBitRate OverShoot Percentage
     *
     * Only applicable for Capped CRF.
     *
     * Indicates the tolerance of the Capped CRF algorithm to overshoot
     * and is used as a trigger threshold for more agressive adaptation of
     * Quantization.
     *
     * Min is 0.
     * Max is 100.
     * Default is 50.
     */
    uint32_t mbr_over_shoot_pct;

    /**
     * @brief Starting Buffer Level in MilliSeconds
     *
     * Only applicable for CBR.
     *
     * Indicates the amount of data that will be buffered by the decoding
     * application prior to beginning playback, and is expressed in units of
     * time. Must be less than maximum_buffer_size_ms.
     *
     * Min is 20.
     * Max is 10000.
     * Default is 600.
     */
    int64_t starting_buffer_level_ms;

    /**
     * @brief Optimal Buffer Level in MilliSeconds
     *
     * Only applicable for CBR.
     *
     * indicates the amount of data that the encoder should try to maintain in the
     * decoder's buffer, and is expressed in units of time. Must be less than
     * maximum_buffer_size_ms.
     *
     * Min is 20.
     * Max is 10000.
     * Default is 600.
     */
    int64_t optimal_buffer_level_ms;

    /**
     * @brief Maximum Buffer Size in MilliSeconds
     *
     * Only applicable for CBR.
     *
     * indicates the maximum amount of data that may be buffered by the
     * decoding application, and is expressed in units of time.
     *
     * Min is 20.
     * Max is 10000.
     * Default is 1000.
     */
    int64_t maximum_buffer_size_ms;

    // input / output buffer to be used for multi-pass encoding
    SvtAv1FixedBuf rc_stats_buffer;
    int            pass;

    // End rate control tuning

    // Individual tuning flags
    /* use fixed qp offset for every picture based on temporal layer index
    * 0: off (use the auto mode QP)
    * 1: on (the offset is applied on top of the user QP)
    * 2: on (the offset is applied on top of the auto mode QP)
    *
    * Default is 0.*/
    uint8_t use_fixed_qindex_offsets;
    int32_t qindex_offsets[EB_MAX_TEMPORAL_LAYERS];
    int32_t key_frame_chroma_qindex_offset;
    int32_t key_frame_qindex_offset;
    int32_t chroma_qindex_offsets[EB_MAX_TEMPORAL_LAYERS];

    int32_t luma_y_dc_qindex_offset;
    int32_t chroma_u_dc_qindex_offset;
    int32_t chroma_u_ac_qindex_offset;
    int32_t chroma_v_dc_qindex_offset;
    int32_t chroma_v_ac_qindex_offset;

    /**
     * @brief Deblocking loop filter control
     *
     * 0: disabled
     * 1: enabled
     * 2: more accurate (slower)
     */
    uint8_t enable_dlf_flag;

    /* Film grain denoising the input picture
    * Flag to enable the denoising
    *
    * Default is 0. */
    uint32_t film_grain_denoise_strength;

    /**
    * @brief Determines how much denoising is used.
    * Only applicable when film grain is ON.
    *
    * 0 is no denoising
    * 1 is full denoising
    *
    * Default is 0. */
    uint8_t film_grain_denoise_apply;

    /* CDEF Level
    *
    * Default is -1. */
    int cdef_level;

    /* Restoration filtering
    *  enable/disable
    *  set Self-Guided (sg) mode
    *  set Wiener (wn) mode
    *
    * Default is -1. */
    int enable_restoration_filtering;

    /* motion field motion vector
    *
    *  Default is -1. */
    int enable_mfmv;

    /* Flag to enable the scene change detection algorithm.
     *
     * Default is 1. */
    uint32_t scene_change_detection;

    /* Log 2 Tile Rows and columns . 0 means no tiling,1 means that we split the dimension
        * into 2
        * Default is 0. */
    int32_t tile_columns;
    int32_t tile_rows;

    /* When RateControlMode is set to 1 it's best to set this parameter to be
     * equal to the Intra period value (such is the default set by the encoder).
     * When CQP is chosen, then a (2 * minigopsize +1) look ahead is recommended.
     *
     * Default depends on rate control mode.*/
    uint32_t look_ahead_distance;

    /* recode_loop indicates the recode levels,
     * DISALLOW_RECODE = 0, No recode.
     * ALLOW_RECODE_KFMAXBW = 1, Allow recode for KF and exceeding maximum frame bandwidth.
     * ALLOW_RECODE_KFARFGF = 2, Allow recode only for KF/ARF/GF frames.
     * ALLOW_RECODE = 3, Allow recode for all frames based on bitrate constraints.
     * ALLOW_RECODE_DEFAULT = 4, Default setting, ALLOW_RECODE_KFARFGF for M0~5 and
     *                                            ALLOW_RECODE_KFMAXBW for M6~8.
     * default is 4
     */
    uint32_t recode_loop;

    /* Flag to signal the content being a screen sharing content type
    *
    * Default is 0. */
    uint32_t screen_content_mode;

    /* Adaptive quantization used within a frame.
     *
     * For rc_mode 0, setting this to:
     * 0: use CQP mode
     * 1: variance-based segmentation
     * 2: CRF (per-frame QPs and per-SB delta-QPs derived using TPL) */
    uint8_t aq_mode;

    /**
     * @brief Enable use of ALT-REF (temporally filtered) frames.
     * 0 = off
     * 1 = on
     * 2 = adaptive
     * Default is 1. */
    uint8_t enable_tf;

    bool enable_overlays;
    /**
     * @brief Tune for a particular metric; 0: VQ, 1: PSNR, 2: SSIM, 3: IQ (Image Quality), 4: MS-SSIM.
     *
     * Default is 1.
     */
    uint8_t tune;

    // super-resolution parameters
    uint8_t superres_mode;
    uint8_t superres_denom;
    uint8_t superres_kf_denom;
    uint8_t superres_qthres;
    uint8_t superres_kf_qthres;
    uint8_t superres_auto_search_type;
    /* Decoder-speed-targeted encoder optimization level (produce bitstreams that can be decoded faster).
    * 0: No decoder-targeted speed optimization
    * 1: Level 1 of decoder-targeted speed optimizations (faster decoder-speed than level 0)
    * 2: Level 2 of decoder-targeted speed optimizations (faster decoder-speed than level 1)
    */
    uint8_t fast_decode;
    /* S-Frame interval (frames)
    * 0: S-Frame off
    * >0: S-Frame on and indicates the number of frames after which a frame may be coded as an S-Frame
    */
    int32_t sframe_dist;
    /* Indicates how an S-Frame should be inserted
    * values are from EbSFrameMode
    * SFRAME_STRICT_ARF: the considered frame will be made into an S-Frame only if it is an altref frame
    * SFRAME_NEAREST_ARF: if the considered frame is not an altref frame, the next altref frame will be made into an S-Frame
    * SFRAME_FLEXIBLE_ARF: if the considered frame is not an altref frame, modify the mini-GOP structure to promote it to an altref frame
    * SFRAME_DEC_POSI: if the considered frame in decode order is not an altref frame, modify the mini-GOP structure to promote its previous frame to an altref frame, and set the next altref to an S-Frame
    */
    EbSFrameMode sframe_mode;

    // End of individual tuning flags

    // Threads management

    /* The level of parallelism refers to how much parallelization the encoder will perform
     * by setting the number of threads and pictures that can be handled simultaneously. If
     * the value is 0, a deafult level will be chosen based on the number of cores on the
     * machine. Levels 1-6 are supported. Beyond that, higher inputs
     * will map to the highest level.
     */
    uint32_t level_of_parallelism;

    /* CPU FLAGS to limit assembly instruction set used by encoder.
    * Default is EB_CPU_FLAGS_ALL. */
    EbCpuFlags use_cpu_flags;

    // Debug tools
    /* Instruct the library to calculate the recon to source for PSNR calculation
    *
    * Default is 0.*/
    uint32_t stat_report;

    /**
     * @brief API Signal to output reconstructed yuv used for debug purposes.
     * Using this will affect the speed of encoder.
     *
     * Default is false.
     */
    bool recon_enabled;
    // 1.0.0: Any additional fields shall go after here

    /**
     * @brief Signal that force-key-frames is enabled.
     *
     */
    bool force_key_frames;

    /**
     * @brief Signal to the library to treat intra_period_length as seconds and
     * multiply by fps_num/fps_den.
     */
    bool multiply_keyint;
    // reference scaling parameters
    /**
     * @brief Reference scaling mode
     * the available modes are defined in RESIZE_MODE
     */
    uint8_t resize_mode;
    /**
     * @brief Resize denominator
     * this value can be from 8 to 16, means downscaling to 8/8-8/16 of original
     * resolution in both width and height
     */
    uint8_t resize_denom;
    /**
     * @brief Resize denominator of key frames
     * this value can be from 8 to 16, means downscaling to 8/8-8/16 of original
     * resolution in both width and height
     */
    uint8_t resize_kf_denom;
    /**
     * @brief Signal to the library to enable quantisation matrices
     *
     * Default is false.
     */
    bool enable_qm;

    /**
     * @brief Min quant matrix flatness. Applicable when enable_qm is true.
     * Min value is 0.
     * Max value is 15.
     * Default is 8.
     */
    uint8_t min_qm_level;
    /**
     * @brief Max quant matrix flatness. Applicable when enable_qm is true.
     * Min value is 0.
     * Max value is 15.
     * Default is 15.
     */
    uint8_t max_qm_level;

    /**
     * @brief gop_constraint_rc
     *
     * Currently, only applicable for VBR and  when GoP size is greater than 119 frames.
     *
     * When enabled, the rate control matches the target rate for each GoP.
     *
     * 0: off
     * 1: on
     * Default is 0.
     */
    bool gop_constraint_rc;
    /**
     * @brief scale factors for lambda value for different frame update types
     * factor >> 7 (/ 128) is the actual value in float
     */
    int32_t lambda_scale_factors[SVT_AV1_FRAME_UPDATE_TYPES];

    /* Dynamic gop
    *
    * 0 = disable Dynamic GoP
    * 1 = enable Dynamic GoP
    *  Default is 1. */
    bool enable_dg;
    /**
     * @brief startup_mg_size
     *
     * When enabled, a MG with specified size will be inserted after the key frame.
     * The MG size is determined by 2^startup_mg_size.
     *
     * 0: off
     * 2: set hierarchical levels to 2 (MG size 4)
     * 3: set hierarchical levels to 3 (MG size 8)
     * 4: set hierarchical levels to 4 (MG size 16)
     * Default is 0.
     */
    uint8_t startup_mg_size;

    /**
     * @brief startup_qp_offset
     *
     * When enabled, an offset will be added to the input-qp of the startup GOP prior to the picture-qp derivation
     *
     * Min value is -63.
     * Max value is 63.
     * Default is 0.
     */
    int8_t startup_qp_offset;
    /* @brief reference scaling events for random access mode (resize-mode = 4)
     *
     * evt_num:          total count of events
     * start_frame_nums: array of scaling start frame numbers
     * resize_kf_denoms: array of scaling denominators of key-frame
     * resize_denoms:    array of scaling denominators of non-key-frame
     */
    SvtAv1FrameScaleEvts frame_scale_evts;

    /* ROI map
    *
    * 0 = disable ROI
    * 1 = enable ROI
    *  Default is 0. */
    bool enable_roi_map;

    /* Manually adjust temporal filtering strength
     * 10 + (4 - 0) = 14 (8x weaker)
     * 10 + (4 - 1) = 13 (4x weaker, PSY default)
     * 10 + (4 - 2) = 12 (2x weaker)
     * 10 + (4 - 3) = 11 (mainline default)
     * 10 + (4 - 4) = 10 (2x stronger) */
    uint8_t tf_strength;

    /* Stores the optional film grain synthesis info */
    AomFilmGrain* fgs_table;

    /* New parameters can go in under this line. Also deduct the size of the parameter */
    /* from the padding array */

    /* Variance Boost
     * false = disable Variance Boost
     * true = enable Variance Boost
     * Default is false. */
    bool enable_variance_boost;
    /* @brief Selects the curve strength to boost low variance regions according to a fast-growing formula
     * Default is 2 */
    uint8_t variance_boost_strength;

    /* @brief Picks a set of eight 8x8 variance values per superblock to determine boost
     * Lower values enable detecting more blocks that need boosting, at the expense of more possible false positives (overall bitrate increase)
     *  1: 1st octile
     *  4: 4th octile
     *  8: 8th octile
     *  Default is 5 */
    uint8_t variance_octile;

    /* @brief Bias towards decreased/increased sharpness in the deblocking loop filter & during rate distortion
     * Minimum value is -7 (less sharp).
     * Maximum value is 7 (more sharp).
     * Default is 0 (medium sharpness). */
    int8_t sharpness;

    /* @brief Enable the user to configure which curve variance boost uses.
     * Curve 1 emphasizes boosting low-medium contrast regions at a modest bitrate increase over the default curve
     *  0: default curve
     *  1: low-medium contrast boost curve
     *  2: still picture curve, tuned for SSIMULACRA2 performance on the CID22 Validation Set
     *  Default is 0. */
    uint8_t variance_boost_curve;

    /* @brief Frame-level luminance-based QP bias to improve quality in low luma scenarios
     * Works by adjusting frame-level QP based on average luminance across a frame
     *  0: Disable luminance-based QP bias
     *  1-100: Enable frame-level luminance-based QP bias. Higher values strengthen the bias
     *  Default is 0 (disabled). */
    uint8_t luminance_qp_bias;

    /* @brief Signal to the library to enable losless coding
     *
     * Default is false.
     */
    bool lossless;

    /* @brief Signal to the library to enable still-picture coding
     *
     * Default is false.
     */
    bool avif;

    /**
     * @brief Min chroma quant matrix flatness. Applicable when enable_qm is true.
     * Min value is 0.
     * Max value is 15.
     * Default is 8.
     */
    uint8_t min_chroma_qm_level;

    /**
     * @brief Max chroma quant matrix flatness. Applicable when enable_qm is true.
     * Min value is 0.
     * Max value is 15.
     * Default is 15.
     */
    uint8_t max_chroma_qm_level;

    /* @brief Signal to the library to enable real-time coding
     *
     * Default is false.
     */
    bool rtc;

    /* @brief compresses the QP hierarchical layer scale to improve temporal video consistency
    * 0: no compression, original SVT-AV1 scaling
    * 1-3: enable compression, the higher the number the stronger the compression
    *      (different frame quality fluctuation/mean quality tradeoffs)
    * Default is 1
    */
    uint8_t qp_scale_compress_strength;

    /* @brief Indicates where to insert an S-Frame, only available when sframe_mode is SFRAME_FLEXIBLE_ARF */
    SvtAv1SFramePositions sframe_posi;

    /* @brief Indicates QP of S-Frame(s) */
    uint8_t sframe_qp;
    /* @brief Indicates QP offset of S-Frame(s) */
    int8_t sframe_qp_offset;

    /**
     * @brief Toggle default film grain blocksize behavior
     * 0: use default blocksize behavior (32x32)
     * 1: use adaptive blocksize based on resolution
     *  - 8x8 for <4k
     *  - 16x16 for 4k
     * Default is 1
     */
    bool adaptive_film_grain;

    /* @brief Limit transform sizes to the specified size
     * 32: use transform sizes up to 32x32 pixels
     * 64: use transform sizes up to 64x64 pixels
     * Default is 64
     * Note: Setting the max transform size to 32 can be useful under some circumstances (e.g. still image coding),
     * as it's the largest transform where all coefficients can be coded into the bitstream.
     * In AV1, the transform size of 64 drops the highest 32 AC coefficients by design, effectively zeroing them upon
     * decoding, which can cause certain visual features to look blurry.
     * Forcing smaller tx sizes (i.e. 16, 8, 4) doesn't hold an inherent visual quality advantage over 32, so those
     * aren't exposed as options.
     */
    uint8_t max_tx_size;

    /* @brief qindex offset for extended CRF support
     * Value is internally determined by CRF parameter value, each quarter-step increment to the CRF adds 1 to the
     * offset, with a maximum of 3 (i.e. three quarter-step increments) for fractional CRFs below 63, and up to
     * 28 for the extended CRF range (63.25 to 70)
     * Default is 0 if CRF is an integer
     */
    uint8_t extended_crf_qindex_offset;

    /**
     * @brief Strength of the internal RD metric to bias toward high-frequency error (helps with texture preservation and film grain retention)
     * 0.00: disable AC bias
     * 1.00: enable AC bias with a strength of 1.00
     * Default is 0.00.
     */
    double ac_bias;

    // clang-format off
    /* Add 128 Byte Padding to Struct to avoid changing the size of the public configuration struct */
    uint8_t padding[128
        - sizeof(PredStructure) + sizeof (uint8_t) // pred_strucutre type was changed from uint8_t to PredStructure
    ];
    // clang-format on
} EbSvtAv1EncConfiguration;

/**
 * Returns a string containing "v$tag-$commit_count-g$hash${dirty:+-dirty}"
 * @param[out] SVT_AV1_CVS_VERSION
 */
EB_API const char* svt_av1_get_version(void);

/**
 * Prints the version header and build information to the file
 * specified by the SVT_LOG_FILE environment variable or stderr
 */
EB_API void svt_av1_print_version(void);

/**
 * @brief Log levels
 *
 * Defines the severity levels for logging messages.
 */
typedef enum {
    SVT_AV1_LOG_ALL   = -1, /**< Log all messages */
    SVT_AV1_LOG_FATAL = 0, /**< Fatal errors */
    SVT_AV1_LOG_ERROR = 1, /**< Errors */
    SVT_AV1_LOG_WARN  = 2, /**< Warnings */
    SVT_AV1_LOG_INFO  = 3, /**< Informational messages */
    SVT_AV1_LOG_DEBUG = 4, /**< Debug messages */
} SvtAv1LogLevel;

/**
 * @brief Log callback function signature
 *
 * Applications can register a callback to intercept log messages from the encoder.
 *
 * @param[in] level   Severity level of the log message
 * @param[in] context Opaque user-provided context pointer (may be NULL)
 * @param[in] tag     Optional log tag (may be NULL)
 * @param[in] fmt     printf-style format string
 * @param[in] args    Variable argument list corresponding to the format string
 */
typedef void (*SvtAv1LogCallback)(void* context, SvtAv1LogLevel level, const char* tag, const char* fmt, va_list args);

/**
 * Register a callback for intercepting log messages.
 *
 * Applications can use this function to redirect log output to custom handlers. When a callback is registered, all log
 * messages will be dispatched to the callback instead of the default stderr/file output. This will affect all
 * instances and is a global setting. This should be called before svt_av1_enc_init_handle() as any calls to
 * svt_av1_enc_init_handle() will finalize logging.
 *
 * @param[in] callback  Callback function pointer. Has no effect if NULL.
 * @param[in] context   Opaque context pointer passed back to the callback. Typically application state or logging context.
 *                      Ignored if callback is NULL.
 */
EB_API void svt_av1_set_log_callback(SvtAv1LogCallback callback, void* context);

/* STEP 1: Call the library to construct a Component Handle.
     *
     * Parameter:
     * @ **p_handle      Handle to be called in the future for manipulating the
     *                  component.
     * @ *p_app_data      Callback data.
     * @ *config_ptr     Pointer passed back to the client during callbacks, it will be
     *                  loaded with default params from the library. */
EB_API EbErrorType svt_av1_enc_init_handle(
    EbComponentType**         p_handle,
    EbSvtAv1EncConfiguration* config_ptr); // config_ptr will be loaded with default params from the library

/* STEP 2: Set all configuration parameters.
     *
     * Parameter:
     * @ *svt_enc_component              Encoder handler.
     * @ *pComponentParameterStructure  Encoder and buffer configurations will be copied to the library. */
EB_API EbErrorType svt_av1_enc_set_parameter(
    EbComponentType* svt_enc_component,
    EbSvtAv1EncConfiguration*
        pComponentParameterStructure); // pComponentParameterStructure contents will be copied to the library

/* OPTIONAL: Set a single configuration parameter.
     *
     * Parameter:
     * @ *pComponentParameterStructure  Encoder parameters structure.
     * @ *name                          Null terminated string containing the parameter name
     * @ *value                         Null terminated string containing the parameter value */
EB_API EbErrorType svt_av1_enc_parse_parameter(EbSvtAv1EncConfiguration* pComponentParameterStructure, const char* name,
                                               const char* value);

/* STEP 3: Initialize encoder and allocates memory to necessary buffers.
     *
     * Parameter:
     * @ *svt_enc_component  Encoder handler. */
EB_API EbErrorType svt_av1_enc_init(EbComponentType* svt_enc_component);

/* OPTIONAL: Get stream headers at init time.
     *
     * Parameter:
     * @ *svt_enc_component   Encoder handler.
     * @ **output_stream_ptr  Output buffer. */
EB_API EbErrorType svt_av1_enc_stream_header(EbComponentType*     svt_enc_component,
                                             EbBufferHeaderType** output_stream_ptr);

/* OPTIONAL: Release stream headers at init time.
     *
     * Parameter:
     * @ *stream_header_ptr  stream header buffer. */
EB_API EbErrorType svt_av1_enc_stream_header_release(EbBufferHeaderType* stream_header_ptr);

/* STEP 4: Send the picture.
     *
     * Parameter:
     * @ *svt_enc_component  Encoder handler.
     * @ *p_buffer           Header pointer, picture buffer. */
EB_API EbErrorType svt_av1_enc_send_picture(EbComponentType* svt_enc_component, EbBufferHeaderType* p_buffer);

/**
 * @brief Step 5: Receive packet.
 * This function will become blocking if either pic_send_done is set to 1 or if we are in low-delay (pred-struct=1).
 * Otherwise, this function is non-blocking and will return EB_NoErrorEmptyQueue if there are no packets available.
 *
 * @param svt_enc_component The encoder handler
 * @param p_buffer Header pointer to return packet with
 * @param pic_send_done Flag to signal that all input pictures have been sent. Should be either 0 or 1.
 * @return EB_API Either EB_ErrorMax for an encode error or EB_NoErrorEmptyQueue if there are no available packets.
 */
EB_API EbErrorType svt_av1_enc_get_packet(EbComponentType* svt_enc_component, EbBufferHeaderType** p_buffer,
                                          uint8_t pic_send_done);

/* STEP 5-1: Release output buffer back into the pool.
     *
     * Parameter:
     * @ **p_buffer          Header pointer that contains the output packet to be released. */
EB_API void svt_av1_enc_release_out_buffer(EbBufferHeaderType** p_buffer);

/* OPTIONAL: Fill buffer with reconstructed picture.
     *
     * Parameter:
     * @ *svt_enc_component  Encoder handler.
     * @ *p_buffer           Output buffer. */
EB_API EbErrorType svt_av1_get_recon(EbComponentType* svt_enc_component, EbBufferHeaderType* p_buffer);

/* OPTIONAL: get stream information
     *
     * Parameter:
     * @ *svt_enc_component  Encoder handler.
     * @ *stream_info_id SVT_AV1_STREAM_INFO_ID.
     * @ *info         output, the type depends on id */
EB_API EbErrorType svt_av1_enc_get_stream_info(EbComponentType* svt_enc_component, uint32_t stream_info_id, void* info);

/* STEP 6: Deinitialize encoder library.
     *
     * Parameter:
     * @ *svt_enc_component  Encoder handler. */
EB_API EbErrorType svt_av1_enc_deinit(EbComponentType* svt_enc_component);

/* STEP 7: Deconstruct encoder handler.
     *
     * Parameter:
     * @ *svt_enc_component  Encoder handler. */
EB_API EbErrorType svt_av1_enc_deinit_handle(EbComponentType* svt_enc_component);

#ifdef __cplusplus
}
#endif // __cplusplus

#endif // EbSvtAv1Enc_h
