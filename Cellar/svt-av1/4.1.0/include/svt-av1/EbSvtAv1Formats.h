/*
 * Copyright(c) 2019 Intel Corporation
 * Copyright (c) 2016, Alliance for Open Media. All rights reserved
 *
 * This source code is subject to the terms of the BSD 2 Clause License and
 * the Alliance for Open Media Patent License 1.0. If the BSD 2 Clause License
 * was not distributed with this source code in the LICENSE file, you can
 * obtain it at https://www.aomedia.org/license/software-license. If the Alliance for Open
 * Media Patent License 1.0 was not distributed with this source code in the
 * PATENTS file, you can obtain it at https://www.aomedia.org/license/patent-license.
 */

#ifndef EbSvtAv1Formats_h
#define EbSvtAv1Formats_h

#ifdef __cplusplus
extern "C" {
#endif // __cplusplus

/*!\brief List of supported color primaries */
typedef enum EbColorPrimaries {
    EB_CICP_CP_RESERVED_0   = 0, /**< For future use */
    EB_CICP_CP_BT_709       = 1, /**< BT.709 */
    EB_CICP_CP_UNSPECIFIED  = 2, /**< Unspecified */
    EB_CICP_CP_RESERVED_3   = 3, /**< For future use */
    EB_CICP_CP_BT_470_M     = 4, /**< BT.470 System M (historical) */
    EB_CICP_CP_BT_470_B_G   = 5, /**< BT.470 System B, G (historical) */
    EB_CICP_CP_BT_601       = 6, /**< BT.601 */
    EB_CICP_CP_SMPTE_240    = 7, /**< SMPTE 240 */
    EB_CICP_CP_GENERIC_FILM = 8, /**< Generic film (color filters using illuminant C) */
    EB_CICP_CP_BT_2020      = 9, /**< BT.2020, BT.2100 */
    EB_CICP_CP_XYZ          = 10, /**< SMPTE 428 (CIE 1921 XYZ) */
    EB_CICP_CP_SMPTE_431    = 11, /**< SMPTE RP 431-2 */
    EB_CICP_CP_SMPTE_432    = 12, /**< SMPTE EG 432-1  */
    EB_CICP_CP_RESERVED_13  = 13, /**< For future use (values 13 - 21)  */
    EB_CICP_CP_EBU_3213     = 22, /**< EBU Tech. 3213-E  */
    EB_CICP_CP_RESERVED_23  = 23, /**< For future use (values 23 - 255)  */
    EB_CICP_CP_RESERVED_24  = 24, /**< For future use (values 24 - 255)  */
    EB_CICP_CP_RESERVED_25  = 25, /**< For future use (values 25 - 255)  */
    EB_CICP_CP_RESERVED_26  = 26 /**< For future use (values 26 - 255)  */
} EbColorPrimaries; /**< alias for enum aom_color_primaries */

/*!\brief List of supported transfer functions */
typedef enum EbTransferCharacteristics {
    EB_CICP_TC_RESERVED_0     = 0, /**< For future use */
    EB_CICP_TC_BT_709         = 1, /**< BT.709 */
    EB_CICP_TC_UNSPECIFIED    = 2, /**< Unspecified */
    EB_CICP_TC_RESERVED_3     = 3, /**< For future use */
    EB_CICP_TC_BT_470_M       = 4, /**< BT.470 System M (historical)  */
    EB_CICP_TC_BT_470_B_G     = 5, /**< BT.470 System B, G (historical) */
    EB_CICP_TC_BT_601         = 6, /**< BT.601 */
    EB_CICP_TC_SMPTE_240      = 7, /**< SMPTE 240 M */
    EB_CICP_TC_LINEAR         = 8, /**< Linear */
    EB_CICP_TC_LOG_100        = 9, /**< Logarithmic (100 : 1 range) */
    EB_CICP_TC_LOG_100_SQRT10 = 10, /**< Logarithmic (100 * Sqrt(10) : 1 range) */
    EB_CICP_TC_IEC_61966      = 11, /**< IEC 61966-2-4 */
    EB_CICP_TC_BT_1361        = 12, /**< BT.1361 */
    EB_CICP_TC_SRGB           = 13, /**< sRGB or sYCC*/
    EB_CICP_TC_BT_2020_10_BIT = 14, /**< BT.2020 10-bit systems */
    EB_CICP_TC_BT_2020_12_BIT = 15, /**< BT.2020 12-bit systems */
    EB_CICP_TC_SMPTE_2084     = 16, /**< SMPTE ST 2084, ITU BT.2100 PQ */
    EB_CICP_TC_SMPTE_428      = 17, /**< SMPTE ST 428 */
    EB_CICP_TC_HLG            = 18, /**< BT.2100 HLG, ARIB STD-B67 */
    EB_CICP_TC_RESERVED_19    = 19, /**< For future use (values 19-255) */
    EB_CICP_TC_RESERVED_20    = 20, /**< For future use (values 20-255) */
    EB_CICP_TC_RESERVED_21    = 21, /**< For future use (values 21-255) */
    EB_CICP_TC_RESERVED_22    = 22, /**< For future use (values 22-255) */
    EB_CICP_TC_RESERVED_23    = 23 /**< For future use (values 23-255) */
} EbTransferCharacteristics; /**< alias for enum aom_transfer_function */

/*!\brief List of supported matrix coefficients */
typedef enum EbMatrixCoefficients {
    EB_CICP_MC_IDENTITY    = 0, /**< Identity matrix */
    EB_CICP_MC_BT_709      = 1, /**< BT.709 */
    EB_CICP_MC_UNSPECIFIED = 2, /**< Unspecified */
    EB_CICP_MC_RESERVED_3  = 3, /**< For future use */
    EB_CICP_MC_FCC         = 4, /**< US FCC 73.628 */
    EB_CICP_MC_BT_470_B_G  = 5, /**< BT.470 System B, G (historical) */
    EB_CICP_MC_BT_601      = 6, /**< BT.601 */
    EB_CICP_MC_SMPTE_240   = 7, /**< SMPTE 240 M */
    EB_CICP_MC_SMPTE_YCGCO = 8, /**< YCgCo */
    EB_CICP_MC_BT_2020_NCL = 9, /**< BT.2020 non-constant luminance, BT.2100 YCbCr  */
    EB_CICP_MC_BT_2020_CL  = 10, /**< BT.2020 constant luminance */
    EB_CICP_MC_SMPTE_2085  = 11, /**< SMPTE ST 2085 YDzDx */
    EB_CICP_MC_CHROMAT_NCL = 12, /**< Chromaticity-derived non-constant luminance */
    EB_CICP_MC_CHROMAT_CL  = 13, /**< Chromaticity-derived constant luminance */
    EB_CICP_MC_ICTCP       = 14, /**< BT.2100 ICtCp */
    EB_CICP_MC_RESERVED_15 = 15, /**< For future use (values 15-255)  */
    EB_CICP_MC_RESERVED_16 = 16, /**< For future use (values 16-255)  */
    EB_CICP_MC_RESERVED_17 = 17, /**< For future use (values 17-255)  */
    EB_CICP_MC_RESERVED_18 = 18 /**< For future use (values 18-255)  */
} EbMatrixCoefficients;

/*!\brief List of supported color range */
typedef enum EbColorRange {
    EB_CR_STUDIO_RANGE = 0, /**< Y [16..235], UV [16..240] */
    EB_CR_FULL_RANGE   = 1 /**< YUV/RGB [0..255] */
} EbColorRange; /**< alias for enum aom_color_range */

/* AV1 bit depth */
typedef enum EbBitDepth {
    EB_EIGHT_BIT     = 8,
    EB_TEN_BIT       = 10,
    EB_TWELVE_BIT    = 12,
    EB_SIXTEEN_BIT   = 16, // Not supported
    EB_THIRTYTWO_BIT = 32, // Not supported
} EbBitDepth;

/* AV1 Chroma Format */
typedef enum EbColorFormat { EB_YUV400, EB_YUV420, EB_YUV422, EB_YUV444 } EbColorFormat;

/*!\brief List of chroma sample positions */
typedef enum EbChromaSamplePosition {
    EB_CSP_UNKNOWN  = 0, /**< Unknown */
    EB_CSP_VERTICAL = 1, /**< Horizontally co-located with luma(0, 0)*/
    /**< sample, between two vertical samples */
    EB_CSP_COLOCATED = 2, /**< Co-located with luma(0, 0) sample */
    EB_CSP_RESERVED  = 3 /**< Reserved value */
} EbChromaSamplePosition; /**< alias for enum aom_transfer_function */

#ifdef __cplusplus
}
#endif // __cplusplus

#endif // EbSvtAv1Formats_h
