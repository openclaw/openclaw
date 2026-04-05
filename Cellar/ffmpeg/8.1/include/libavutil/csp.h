/*
 * Copyright (c) 2015 Kevin Wheatley <kevin.j.wheatley@gmail.com>
 * Copyright (c) 2016 Ronald S. Bultje <rsbultje@gmail.com>
 * Copyright (c) 2023 Leo Izen <leo.izen@gmail.com>
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

#ifndef AVUTIL_CSP_H
#define AVUTIL_CSP_H

#include "pixfmt.h"
#include "rational.h"

/**
 * @file
 * Colorspace value utility functions for libavutil.
 * @ingroup lavu_math_csp
 * @author Ronald S. Bultje <rsbultje@gmail.com>
 * @author Leo Izen <leo.izen@gmail.com>
 * @author Kevin Wheatley <kevin.j.wheatley@gmail.com>
 */

/**
 * @defgroup lavu_math_csp Colorspace Utility
 * @ingroup lavu_math
 * @{
 */

/**
 * Struct containing luma coefficients to be used for RGB to YUV/YCoCg, or similar
 * calculations.
 */
typedef struct AVLumaCoefficients {
    AVRational cr, cg, cb;
} AVLumaCoefficients;

/**
 * Struct containing chromaticity x and y values for the standard CIE 1931
 * chromaticity definition.
 */
typedef struct AVCIExy {
    AVRational x, y;
} AVCIExy;

/**
 * Struct defining the red, green, and blue primary locations in terms of CIE
 * 1931 chromaticity x and y.
 */
typedef struct AVPrimaryCoefficients {
    AVCIExy r, g, b;
} AVPrimaryCoefficients;

/**
 * Struct defining white point location in terms of CIE 1931 chromaticity x
 * and y.
 */
typedef AVCIExy AVWhitepointCoefficients;

/**
 * Struct that contains both white point location and primaries location, providing
 * the complete description of a color gamut.
 */
typedef struct AVColorPrimariesDesc {
    AVWhitepointCoefficients wp;
    AVPrimaryCoefficients prim;
} AVColorPrimariesDesc;

/**
 * Function pointer representing a double -> double transfer function that
 * performs either an OETF transfer function, or alternatively an inverse EOTF
 * function (in particular, for SMPTE ST 2084 / PQ). This function inputs
 * linear light, and outputs gamma encoded light.
 *
 * See ITU-T H.273 for more information.
 */
typedef double (*av_csp_trc_function)(double);

/**
 * Retrieves the Luma coefficients necessary to construct a conversion matrix
 * from an enum constant describing the colorspace.
 * @param csp An enum constant indicating YUV or similar colorspace.
 * @return The Luma coefficients associated with that colorspace, or NULL
 *     if the constant is unknown to libavutil.
 */
const AVLumaCoefficients *av_csp_luma_coeffs_from_avcsp(enum AVColorSpace csp);

/**
 * Retrieves a complete gamut description from an enum constant describing the
 * color primaries.
 * @param prm An enum constant indicating primaries
 * @return A description of the colorspace gamut associated with that enum
 *     constant, or NULL if the constant is unknown to libavutil.
 */
const AVColorPrimariesDesc *av_csp_primaries_desc_from_id(enum AVColorPrimaries prm);

/**
 * Detects which enum AVColorPrimaries constant corresponds to the given complete
 * gamut description.
 * @see enum AVColorPrimaries
 * @param prm A description of the colorspace gamut
 * @return The enum constant associated with this gamut, or
 *     AVCOL_PRI_UNSPECIFIED if no clear match can be identified.
 */
enum AVColorPrimaries av_csp_primaries_id_from_desc(const AVColorPrimariesDesc *prm);

/**
 * Determine a suitable 'gamma' value to match the supplied
 * AVColorTransferCharacteristic.
 *
 * See Apple Technical Note TN2257 (https://developer.apple.com/library/mac/technotes/tn2257/_index.html)
 *
 * This function returns the gamma exponent for the OETF. For example, sRGB is approximated
 * by gamma 2.2, not by gamma 0.45455.
 *
 * @return Will return an approximation to the simple gamma function matching
 *         the supplied Transfer Characteristic, Will return 0.0 for any
 *         we cannot reasonably match against.
 */
double av_csp_approximate_trc_gamma(enum AVColorTransferCharacteristic trc);

/**
 * Determine a suitable EOTF 'gamma' value to match the supplied
 * AVColorTransferCharacteristic.
 *
 * This function returns the gamma value (exponent) for a simple pure power
 * function approximation of the supplied AVColorTransferCharacteristic, or 0.
 * if no reasonable approximation exists.
 *
 * EOTF(v) = (L_w - L_b) * v^gamma + L_b
 *
 * @return Will return an approximation to the simple gamma function matching
 *         the supplied Transfer Characteristic EOTF, Will return 0.0 for any
 *         we cannot reasonably match against.
 */
double av_csp_approximate_eotf_gamma(enum AVColorTransferCharacteristic trc);

/**
 * Determine the function needed to apply the given
 * AVColorTransferCharacteristic to linear input.
 *
 * The function returned should expect a nominal domain and range of [0.0-1.0]
 * values outside of this range maybe valid depending on the chosen
 * characteristic function.
 *
 * @return Will return pointer to the function matching the
 *         supplied Transfer Characteristic. If unspecified will
 *         return NULL:
 */
av_csp_trc_function av_csp_trc_func_from_id(enum AVColorTransferCharacteristic trc);

/**
 * Returns the mathematical inverse of the corresponding TRC function.
 */
av_csp_trc_function av_csp_trc_func_inv_from_id(enum AVColorTransferCharacteristic trc);

/**
 * Function pointer representing an ITU EOTF transfer for a given reference
 * display configuration.
 *
 * @param Lw The white point luminance of the display, in nits (cd/m^2).
 * @param Lb The black point luminance of the display, in nits (cd/m^2).
 */
typedef void (*av_csp_eotf_function)(double Lw, double Lb, double c[3]);

/**
 * Returns the ITU EOTF corresponding to a given TRC. This converts from the
 * signal level [0,1] to the raw output display luminance in nits (cd/m^2).
 * This is done per channel in RGB space, except for AVCOL_TRC_SMPTE428, which
 * assumes CIE XYZ in- and output.
 *
 * @return A pointer to the function implementing the given TRC, or NULL if no
 *         such function is defined.
 *
 * @note In general, the resulting function is defined (wherever possible) for
 *       out-of-range values, even though these values do not have a physical
 *       meaning on the given display. Users should clamp inputs (or outputs)
 *       if this behavior is not desired.
 *
 *       This is also the case for functions like PQ, which are defined over an
 *       absolute signal range independent of the target display capabilities.
 */
av_csp_eotf_function av_csp_itu_eotf(enum AVColorTransferCharacteristic trc);

/**
 * Returns the mathematical inverse of the corresponding EOTF.
 */
av_csp_eotf_function av_csp_itu_eotf_inv(enum AVColorTransferCharacteristic trc);

/**
 * @}
 */

#endif /* AVUTIL_CSP_H */
