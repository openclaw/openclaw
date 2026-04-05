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

#ifndef AVUTIL_TX_H
#define AVUTIL_TX_H

#include <stdint.h>
#include <stddef.h>

typedef struct AVTXContext AVTXContext;

typedef struct AVComplexFloat {
    float re, im;
} AVComplexFloat;

typedef struct AVComplexDouble {
    double re, im;
} AVComplexDouble;

typedef struct AVComplexInt32 {
    int32_t re, im;
} AVComplexInt32;

enum AVTXType {
    /**
     * Standard complex to complex FFT with sample data type of AVComplexFloat,
     * AVComplexDouble or AVComplexInt32, for each respective variant.
     *
     * Output is not 1/len normalized. Scaling currently unsupported.
     * The stride parameter must be set to the size of a single sample in bytes.
     */
    AV_TX_FLOAT_FFT  = 0,
    AV_TX_DOUBLE_FFT = 2,
    AV_TX_INT32_FFT  = 4,

    /**
     * Standard MDCT with a sample data type of float, double or int32_t,
     * respectively. For the float and int32 variants, the scale type is
     * 'float', while for the double variant, it's 'double'.
     * If scale is NULL, 1.0 will be used as a default.
     *
     * Length is the frame size, not the window size (which is 2x frame).
     * For forward transforms, the stride specifies the spacing between each
     * sample in the output array in bytes. The input must be a flat array.
     *
     * For inverse transforms, the stride specifies the spacing between each
     * sample in the input array in bytes. The output must be a flat array.
     *
     * NOTE: the inverse transform is half-length, meaning the output will not
     * contain redundant data. This is what most codecs work with. To do a full
     * inverse transform, set the AV_TX_FULL_IMDCT flag on init.
     */
    AV_TX_FLOAT_MDCT  = 1,
    AV_TX_DOUBLE_MDCT = 3,
    AV_TX_INT32_MDCT  = 5,

    /**
     * Real to complex and complex to real DFTs.
     * For the float and int32 variants, the scale type is 'float', while for
     * the double variant, it's a 'double'. If scale is NULL, 1.0 will be used
     * as a default.
     *
     * For forward transforms (R2C), stride must be the spacing between two
     * samples in bytes. For inverse transforms, the stride must be set
     * to the spacing between two complex values in bytes.
     *
     * The forward transform performs a real-to-complex DFT of N samples to
     * N/2+1 complex values.
     *
     * The inverse transform performs a complex-to-real DFT of N/2+1 complex
     * values to N real samples. The output is not normalized, but can be
     * made so by setting the scale value to 1.0/len.
     * NOTE: the inverse transform always overwrites the input.
     */
    AV_TX_FLOAT_RDFT  = 6,
    AV_TX_DOUBLE_RDFT = 7,
    AV_TX_INT32_RDFT  = 8,

    /**
     * Real to real (DCT) transforms.
     *
     * The forward transform is a DCT-II.
     * The inverse transform is a DCT-III.
     *
     * The input array is always overwritten. DCT-III requires that the
     * input be padded with 2 extra samples. Stride must be set to the
     * spacing between two samples in bytes.
     */
    AV_TX_FLOAT_DCT  = 9,
    AV_TX_DOUBLE_DCT = 10,
    AV_TX_INT32_DCT  = 11,

    /**
     * Discrete Cosine Transform I
     *
     * The forward transform is a DCT-I.
     * The inverse transform is a DCT-I multiplied by 2/(N + 1).
     *
     * The input array is always overwritten.
     */
    AV_TX_FLOAT_DCT_I  = 12,
    AV_TX_DOUBLE_DCT_I = 13,
    AV_TX_INT32_DCT_I  = 14,

    /**
     * Discrete Sine Transform I
     *
     * The forward transform is a DST-I.
     * The inverse transform is a DST-I multiplied by 2/(N + 1).
     *
     * The input array is always overwritten.
     */
    AV_TX_FLOAT_DST_I  = 15,
    AV_TX_DOUBLE_DST_I = 16,
    AV_TX_INT32_DST_I  = 17,

    /* Not part of the API, do not use */
    AV_TX_NB,
};

/**
 * Function pointer to a function to perform the transform.
 *
 * @note Using a different context than the one allocated during av_tx_init()
 * is not allowed.
 *
 * @param s the transform context
 * @param out the output array
 * @param in the input array
 * @param stride the input or output stride in bytes
 *
 * The out and in arrays must be aligned to the maximum required by the CPU
 * architecture unless the AV_TX_UNALIGNED flag was set in av_tx_init().
 * The stride must follow the constraints the transform type has specified.
 */
typedef void (*av_tx_fn)(AVTXContext *s, void *out, void *in, ptrdiff_t stride);

/**
 * Flags for av_tx_init()
 */
enum AVTXFlags {
    /**
     * Allows for in-place transformations, where input == output.
     * May be unsupported or slower for some transform types.
     */
    AV_TX_INPLACE = 1ULL << 0,

    /**
     * Relaxes alignment requirement for the in and out arrays of av_tx_fn().
     * May be slower with certain transform types.
     */
    AV_TX_UNALIGNED = 1ULL << 1,

    /**
     * Performs a full inverse MDCT rather than leaving out samples that can be
     * derived through symmetry. Requires an output array of 'len' floats,
     * rather than the usual 'len/2' floats.
     * Ignored for all transforms but inverse MDCTs.
     */
    AV_TX_FULL_IMDCT = 1ULL << 2,

    /**
     * Perform a real to half-complex RDFT.
     * Only the real, or imaginary coefficients will
     * be output, depending on the flag used. Only available for forward RDFTs.
     * Output array must have enough space to hold N complex values
     * (regular size for a real to complex transform).
     */
    AV_TX_REAL_TO_REAL      = 1ULL << 3,
    AV_TX_REAL_TO_IMAGINARY = 1ULL << 4,
};

/**
 * Initialize a transform context with the given configuration
 * (i)MDCTs with an odd length are currently not supported.
 *
 * @param ctx the context to allocate, will be NULL on error
 * @param tx pointer to the transform function pointer to set
 * @param type type the type of transform
 * @param inv whether to do an inverse or a forward transform
 * @param len the size of the transform in samples
 * @param scale pointer to the value to scale the output if supported by type
 * @param flags a bitmask of AVTXFlags or 0
 *
 * @return 0 on success, negative error code on failure
 */
int av_tx_init(AVTXContext **ctx, av_tx_fn *tx, enum AVTXType type,
               int inv, int len, const void *scale, uint64_t flags);

/**
 * Frees a context and sets *ctx to NULL, does nothing when *ctx == NULL.
 */
void av_tx_uninit(AVTXContext **ctx);

#endif /* AVUTIL_TX_H */
