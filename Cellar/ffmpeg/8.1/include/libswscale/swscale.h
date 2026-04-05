/*
 * Copyright (C) 2024 Niklas Haas
 * Copyright (C) 2001-2011 Michael Niedermayer <michaelni@gmx.at>
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

#ifndef SWSCALE_SWSCALE_H
#define SWSCALE_SWSCALE_H

/**
 * @file
 * @ingroup libsws
 * external API header
 */

#include <stdint.h>

#include "libavutil/avutil.h"
#include "libavutil/frame.h"
#include "libavutil/log.h"
#include "libavutil/pixfmt.h"
#include "version_major.h"
#ifndef HAVE_AV_CONFIG_H
/* When included as part of the ffmpeg build, only include the major version
 * to avoid unnecessary rebuilds. When included externally, keep including
 * the full version information. */
#include "version.h"
#endif

/**
 * @defgroup libsws libswscale
 * Color conversion and scaling library.
 *
 * @{
 *
 * Return the LIBSWSCALE_VERSION_INT constant.
 */
unsigned swscale_version(void);

/**
 * Return the libswscale build-time configuration.
 */
const char *swscale_configuration(void);

/**
 * Return the libswscale license.
 */
const char *swscale_license(void);

/**
 * Get the AVClass for SwsContext. It can be used in combination with
 * AV_OPT_SEARCH_FAKE_OBJ for examining options.
 *
 * @see av_opt_find().
 */
const AVClass *sws_get_class(void);

/******************************
 * Flags and quality settings *
 ******************************/

typedef enum SwsDither {
    SWS_DITHER_NONE = 0, /* disable dithering */
    SWS_DITHER_AUTO,     /* auto-select from preset */
    SWS_DITHER_BAYER,    /* ordered dither matrix */
    SWS_DITHER_ED,       /* error diffusion */
    SWS_DITHER_A_DITHER, /* arithmetic addition */
    SWS_DITHER_X_DITHER, /* arithmetic xor */
    SWS_DITHER_NB,       /* not part of the ABI */
    SWS_DITHER_MAX_ENUM = 0x7FFFFFFF, /* force size to 32 bits, not a valid dither type */
} SwsDither;

typedef enum SwsAlphaBlend {
    SWS_ALPHA_BLEND_NONE = 0,
    SWS_ALPHA_BLEND_UNIFORM,
    SWS_ALPHA_BLEND_CHECKERBOARD,
    SWS_ALPHA_BLEND_NB,  /* not part of the ABI */
    SWS_ALPHA_BLEND_MAX_ENUM = 0x7FFFFFFF, /* force size to 32 bits, not a valid blend mode */
} SwsAlphaBlend;

typedef enum SwsFlags {
    /**
     * Scaler selection options. Only one may be active at a time.
     */
    SWS_FAST_BILINEAR = 1 <<  0, ///< fast bilinear filtering
    SWS_BILINEAR      = 1 <<  1, ///< bilinear filtering
    SWS_BICUBIC       = 1 <<  2, ///< 2-tap cubic B-spline
    SWS_X             = 1 <<  3, ///< experimental
    SWS_POINT         = 1 <<  4, ///< nearest neighbor
    SWS_AREA          = 1 <<  5, ///< area averaging
    SWS_BICUBLIN      = 1 <<  6, ///< bicubic luma, bilinear chroma
    SWS_GAUSS         = 1 <<  7, ///< gaussian approximation
    SWS_SINC          = 1 <<  8, ///< unwindowed sinc
    SWS_LANCZOS       = 1 <<  9, ///< 3-tap sinc/sinc
    SWS_SPLINE        = 1 << 10, ///< cubic Keys spline

    /**
     * Return an error on underspecified conversions. Without this flag,
     * unspecified fields are defaulted to sensible values.
     */
    SWS_STRICT        = 1 << 11,

    /**
     * Emit verbose log of scaling parameters.
     */
    SWS_PRINT_INFO    = 1 << 12,

    /**
     * Perform full chroma upsampling when upscaling to RGB.
     *
     * For example, when converting 50x50 yuv420p to 100x100 rgba, setting this flag
     * will scale the chroma plane from 25x25 to 100x100 (4:4:4), and then convert
     * the 100x100 yuv444p image to rgba in the final output step.
     *
     * Without this flag, the chroma plane is instead scaled to 50x100 (4:2:2),
     * with a single chroma sample being reused for both of the horizontally
     * adjacent RGBA output pixels.
     */
    SWS_FULL_CHR_H_INT = 1 << 13,

    /**
     * Perform full chroma interpolation when downscaling RGB sources.
     *
     * For example, when converting a 100x100 rgba source to 50x50 yuv444p, setting
     * this flag will generate a 100x100 (4:4:4) chroma plane, which is then
     * downscaled to the required 50x50.
     *
     * Without this flag, the chroma plane is instead generated at 50x100 (dropping
     * every other pixel), before then being downscaled to the required 50x50
     * resolution.
     */
    SWS_FULL_CHR_H_INP = 1 << 14,

    /**
     * Force bit-exact output. This will prevent the use of platform-specific
     * optimizations that may lead to slight difference in rounding, in favor
     * of always maintaining exact bit output compatibility with the reference
     * C code.
     *
     * Note: It is recommended to set both of these flags simultaneously.
     */
    SWS_ACCURATE_RND   = 1 << 18,
    SWS_BITEXACT       = 1 << 19,

    /**
     * Allow using experimental new code paths. This may be faster, slower,
     * or produce different output, with semantics subject to change at any
     * point in time. For testing and debugging purposes only.
     */
    SWS_UNSTABLE = 1 << 20,

    /**
     * Deprecated flags.
     */
    SWS_DIRECT_BGR      = 1 << 15, ///< This flag has no effect
    SWS_ERROR_DIFFUSION = 1 << 23, ///< Set `SwsContext.dither` instead
} SwsFlags;

typedef enum SwsIntent {
    SWS_INTENT_PERCEPTUAL = 0,            ///< Perceptual tone mapping
    SWS_INTENT_RELATIVE_COLORIMETRIC = 1, ///< Relative colorimetric clipping
    SWS_INTENT_SATURATION = 2,            ///< Saturation mapping
    SWS_INTENT_ABSOLUTE_COLORIMETRIC = 3, ///< Absolute colorimetric clipping
    SWS_INTENT_NB, ///< not part of the ABI
} SwsIntent;

/***********************************
 * Context creation and management *
 ***********************************/

/**
 * Main external API structure. New fields can be added to the end with
 * minor version bumps. Removal, reordering and changes to existing fields
 * require a major version bump. sizeof(SwsContext) is not part of the ABI.
 */
typedef struct SwsContext {
    const AVClass *av_class;

    /**
     * Private data of the user, can be used to carry app specific stuff.
     */
    void *opaque;

    /**
     * Bitmask of SWS_*. See `SwsFlags` for details.
     */
    unsigned flags;

    /**
     * Extra parameters for fine-tuning certain scalers.
     */
    double scaler_params[2];

    /**
     * How many threads to use for processing, or 0 for automatic selection.
     */
    int threads;

    /**
     * Dither mode.
     */
    SwsDither dither;

    /**
     * Alpha blending mode. See `SwsAlphaBlend` for details.
     */
    SwsAlphaBlend alpha_blend;

    /**
     * Use gamma correct scaling.
     */
    int gamma_flag;

    /**
     * Deprecated frame property overrides, for the legacy API only.
     *
     * Ignored by sws_scale_frame() when used in dynamic mode, in which
     * case all properties are instead taken from the frame directly.
     */
    int src_w, src_h;  ///< Width and height of the source frame
    int dst_w, dst_h;  ///< Width and height of the destination frame
    int src_format;    ///< Source pixel format
    int dst_format;    ///< Destination pixel format
    int src_range;     ///< Source is full range
    int dst_range;     ///< Destination is full range
    int src_v_chr_pos; ///< Source vertical chroma position in luma grid / 256
    int src_h_chr_pos; ///< Source horizontal chroma position
    int dst_v_chr_pos; ///< Destination vertical chroma position
    int dst_h_chr_pos; ///< Destination horizontal chroma position

    /**
     * Desired ICC intent for color space conversions.
     */
    int intent;

    /* Remember to add new fields to graph.c:opts_equal() */
} SwsContext;

/**
 * Allocate an empty SwsContext and set its fields to default values.
 */
SwsContext *sws_alloc_context(void);

/**
 * Free the context and everything associated with it, and write NULL
 * to the provided pointer.
 */
void sws_free_context(SwsContext **ctx);

/***************************
 * Supported frame formats *
 ***************************/

/**
 * Test if a given (software) pixel format is supported.
 *
 * @param output  If 0, test if compatible with the source/input frame;
 *                otherwise, with the destination/output frame.
 * @param format  The format to check.
 *
 * @return A positive integer if supported, 0 otherwise.
 */
int sws_test_format(enum AVPixelFormat format, int output);

/**
 * Test if a given hardware pixel format is supported.
 *
 * @param format  The hardware format to check, or AV_PIX_FMT_NONE.
 *
 * @return A positive integer if supported or AV_PIX_FMT_NONE, 0 otherwise.
 */
int sws_test_hw_format(enum AVPixelFormat format);

/**
 * Test if a given color space is supported.
 *
 * @param output  If 0, test if compatible with the source/input frame;
 *                otherwise, with the destination/output frame.
 * @param colorspace The colorspace to check.
 *
 * @return A positive integer if supported, 0 otherwise.
 */
int sws_test_colorspace(enum AVColorSpace colorspace, int output);

/**
 * Test if a given set of color primaries is supported.
 *
 * @param output  If 0, test if compatible with the source/input frame;
 *                otherwise, with the destination/output frame.
 * @param primaries The color primaries to check.
 *
 * @return A positive integer if supported, 0 otherwise.
 */
int sws_test_primaries(enum AVColorPrimaries primaries, int output);

/**
 * Test if a given color transfer function is supported.
 *
 * @param output  If 0, test if compatible with the source/input frame;
 *                otherwise, with the destination/output frame.
 * @param trc     The color transfer function to check.
 *
 * @return A positive integer if supported, 0 otherwise.
 */
int sws_test_transfer(enum AVColorTransferCharacteristic trc, int output);

/**
 * Helper function to run all sws_test_* against a frame, as well as testing
 * the basic frame properties for sanity. Ignores irrelevant properties - for
 * example, AVColorSpace is not checked for RGB frames.
 */
int sws_test_frame(const AVFrame *frame, int output);

/**
 * Like `sws_scale_frame`, but without actually scaling. It will instead
 * merely initialize internal state that *would* be required to perform the
 * operation, as well as returning the correct error code for unsupported
 * frame combinations.
 *
 * @param ctx   The scaling context.
 * @param dst   The destination frame to consider.
 * @param src   The source frame to consider.
 * @return 0 on success, a negative AVERROR code on failure.
 */
int sws_frame_setup(SwsContext *ctx, const AVFrame *dst, const AVFrame *src);

/********************
 * Main scaling API *
 ********************/

/**
 * Check if a given conversion is a noop. Returns a positive integer if
 * no operation needs to be performed, 0 otherwise.
 */
int sws_is_noop(const AVFrame *dst, const AVFrame *src);

/**
 * Scale source data from `src` and write the output to `dst`.
 *
 * This function can be used directly on an allocated context, without setting
 * up any frame properties or calling `sws_init_context()`. Such usage is fully
 * dynamic and does not require reallocation if the frame properties change.
 *
 * Alternatively, this function can be called on a context that has been
 * explicitly initialized. However, this is provided only for backwards
 * compatibility. In this usage mode, all frame properties must be correctly
 * set at init time, and may no longer change after initialization.
 *
 * @param ctx   The scaling context.
 * @param dst   The destination frame. The data buffers may either be already
 *              allocated by the caller or left clear, in which case they will
 *              be allocated by the scaler. The latter may have performance
 *              advantages - e.g. in certain cases some (or all) output planes
 *              may be references to input planes, rather than copies.
 * @param src   The source frame. If the data buffers are set to NULL, then
 *              this function behaves identically to `sws_frame_setup`.
 * @return >= 0 on success, a negative AVERROR code on failure.
 */
int sws_scale_frame(SwsContext *c, AVFrame *dst, const AVFrame *src);

/*************************
 * Legacy (stateful) API *
 *************************/

#define SWS_SRC_V_CHR_DROP_MASK     0x30000
#define SWS_SRC_V_CHR_DROP_SHIFT    16

#define SWS_PARAM_DEFAULT           123456

#define SWS_MAX_REDUCE_CUTOFF 0.002

#define SWS_CS_ITU709         1
#define SWS_CS_FCC            4
#define SWS_CS_ITU601         5
#define SWS_CS_ITU624         5
#define SWS_CS_SMPTE170M      5
#define SWS_CS_SMPTE240M      7
#define SWS_CS_DEFAULT        5
#define SWS_CS_BT2020         9

/**
 * Return a pointer to yuv<->rgb coefficients for the given colorspace
 * suitable for sws_setColorspaceDetails().
 *
 * @param colorspace One of the SWS_CS_* macros. If invalid,
 * SWS_CS_DEFAULT is used.
 */
const int *sws_getCoefficients(int colorspace);

// when used for filters they must have an odd number of elements
// coeffs cannot be shared between vectors
typedef struct SwsVector {
    double *coeff;              ///< pointer to the list of coefficients
    int length;                 ///< number of coefficients in the vector
} SwsVector;

// vectors can be shared
typedef struct SwsFilter {
    SwsVector *lumH;
    SwsVector *lumV;
    SwsVector *chrH;
    SwsVector *chrV;
} SwsFilter;

/**
 * Return a positive value if pix_fmt is a supported input format, 0
 * otherwise.
 */
int sws_isSupportedInput(enum AVPixelFormat pix_fmt);

/**
 * Return a positive value if pix_fmt is a supported output format, 0
 * otherwise.
 */
int sws_isSupportedOutput(enum AVPixelFormat pix_fmt);

/**
 * @param[in]  pix_fmt the pixel format
 * @return a positive value if an endianness conversion for pix_fmt is
 * supported, 0 otherwise.
 */
int sws_isSupportedEndiannessConversion(enum AVPixelFormat pix_fmt);

/**
 * Initialize the swscaler context sws_context.
 *
 * This function is considered deprecated, and provided only for backwards
 * compatibility with sws_scale() and sws_frame_start(). The preferred way to
 * use libswscale is to set all frame properties correctly and call
 * sws_scale_frame() directly, without explicitly initializing the context.
 *
 * @return zero or positive value on success, a negative value on
 * error
 */
av_warn_unused_result
int sws_init_context(SwsContext *sws_context, SwsFilter *srcFilter, SwsFilter *dstFilter);

/**
 * Free the swscaler context swsContext.
 * If swsContext is NULL, then does nothing.
 */
void sws_freeContext(SwsContext *swsContext);

/**
 * Allocate and return an SwsContext. You need it to perform
 * scaling/conversion operations using sws_scale().
 *
 * @param srcW the width of the source image
 * @param srcH the height of the source image
 * @param srcFormat the source image format
 * @param dstW the width of the destination image
 * @param dstH the height of the destination image
 * @param dstFormat the destination image format
 * @param flags specify which algorithm and options to use for rescaling
 * @param param extra parameters to tune the used scaler
 *              For SWS_BICUBIC param[0] and [1] tune the shape of the basis
 *              function, param[0] tunes f(1) and param[1] f´(1)
 *              For SWS_GAUSS param[0] tunes the exponent and thus cutoff
 *              frequency
 *              For SWS_LANCZOS param[0] tunes the width of the window function
 * @return a pointer to an allocated context, or NULL in case of error
 * @note this function is to be removed after a saner alternative is
 *       written
 */
SwsContext *sws_getContext(int srcW, int srcH, enum AVPixelFormat srcFormat,
                           int dstW, int dstH, enum AVPixelFormat dstFormat,
                           int flags, SwsFilter *srcFilter,
                           SwsFilter *dstFilter, const double *param);

/**
 * Scale the image slice in srcSlice and put the resulting scaled
 * slice in the image in dst. A slice is a sequence of consecutive
 * rows in an image. Requires a context that has previously been
 * initialized with sws_init_context().
 *
 * Slices have to be provided in sequential order, either in
 * top-bottom or bottom-top order. If slices are provided in
 * non-sequential order the behavior of the function is undefined.
 *
 * @param c         the scaling context previously created with
 *                  sws_getContext()
 * @param srcSlice  the array containing the pointers to the planes of
 *                  the source slice
 * @param srcStride the array containing the strides for each plane of
 *                  the source image
 * @param srcSliceY the position in the source image of the slice to
 *                  process, that is the number (counted starting from
 *                  zero) in the image of the first row of the slice
 * @param srcSliceH the height of the source slice, that is the number
 *                  of rows in the slice
 * @param dst       the array containing the pointers to the planes of
 *                  the destination image
 * @param dstStride the array containing the strides for each plane of
 *                  the destination image
 * @return          the height of the output slice
 */
int sws_scale(SwsContext *c, const uint8_t *const srcSlice[],
              const int srcStride[], int srcSliceY, int srcSliceH,
              uint8_t *const dst[], const int dstStride[]);

/**
 * Initialize the scaling process for a given pair of source/destination frames.
 * Must be called before any calls to sws_send_slice() and sws_receive_slice().
 * Requires a context that has previously been initialized with sws_init_context().
 *
 * This function will retain references to src and dst, so they must both use
 * refcounted buffers (if allocated by the caller, in case of dst).
 *
 * @param c   The scaling context
 * @param dst The destination frame.
 *
 *            The data buffers may either be already allocated by the caller or
 *            left clear, in which case they will be allocated by the scaler.
 *            The latter may have performance advantages - e.g. in certain cases
 *            some output planes may be references to input planes, rather than
 *            copies.
 *
 *            Output data will be written into this frame in successful
 *            sws_receive_slice() calls.
 * @param src The source frame. The data buffers must be allocated, but the
 *            frame data does not have to be ready at this point. Data
 *            availability is then signalled by sws_send_slice().
 * @return 0 on success, a negative AVERROR code on failure
 *
 * @see sws_frame_end()
 */
int sws_frame_start(SwsContext *c, AVFrame *dst, const AVFrame *src);

/**
 * Finish the scaling process for a pair of source/destination frames previously
 * submitted with sws_frame_start(). Must be called after all sws_send_slice()
 * and sws_receive_slice() calls are done, before any new sws_frame_start()
 * calls.
 *
 * @param c   The scaling context
 */
void sws_frame_end(SwsContext *c);

/**
 * Indicate that a horizontal slice of input data is available in the source
 * frame previously provided to sws_frame_start(). The slices may be provided in
 * any order, but may not overlap. For vertically subsampled pixel formats, the
 * slices must be aligned according to subsampling.
 *
 * @param c   The scaling context
 * @param slice_start first row of the slice
 * @param slice_height number of rows in the slice
 *
 * @return a non-negative number on success, a negative AVERROR code on failure.
 */
int sws_send_slice(SwsContext *c, unsigned int slice_start,
                   unsigned int slice_height);

/**
 * Request a horizontal slice of the output data to be written into the frame
 * previously provided to sws_frame_start().
 *
 * @param c   The scaling context
 * @param slice_start first row of the slice; must be a multiple of
 *                    sws_receive_slice_alignment()
 * @param slice_height number of rows in the slice; must be a multiple of
 *                     sws_receive_slice_alignment(), except for the last slice
 *                     (i.e. when slice_start+slice_height is equal to output
 *                     frame height)
 *
 * @return a non-negative number if the data was successfully written into the output
 *         AVERROR(EAGAIN) if more input data needs to be provided before the
 *                         output can be produced
 *         another negative AVERROR code on other kinds of scaling failure
 */
int sws_receive_slice(SwsContext *c, unsigned int slice_start,
                      unsigned int slice_height);

/**
 * Get the alignment required for slices. Requires a context that has
 * previously been initialized with sws_init_context().
 *
 * @param c   The scaling context
 * @return alignment required for output slices requested with sws_receive_slice().
 *         Slice offsets and sizes passed to sws_receive_slice() must be
 *         multiples of the value returned from this function.
 */
unsigned int sws_receive_slice_alignment(const SwsContext *c);

/**
 * @param c the scaling context
 * @param dstRange flag indicating the white-black range of the output (1=jpeg / 0=mpeg)
 * @param srcRange flag indicating the white-black range of the input (1=jpeg / 0=mpeg)
 * @param table the yuv2rgb coefficients describing the output yuv space, normally ff_yuv2rgb_coeffs[x]
 * @param inv_table the yuv2rgb coefficients describing the input yuv space, normally ff_yuv2rgb_coeffs[x]
 * @param brightness 16.16 fixed point brightness correction
 * @param contrast 16.16 fixed point contrast correction
 * @param saturation 16.16 fixed point saturation correction
 *
 * @return A negative error code on error, non negative otherwise.
 *         If `LIBSWSCALE_VERSION_MAJOR < 7`, returns -1 if not supported.
 */
int sws_setColorspaceDetails(SwsContext *c, const int inv_table[4],
                             int srcRange, const int table[4], int dstRange,
                             int brightness, int contrast, int saturation);

/**
 * @return A negative error code on error, non negative otherwise.
 *         If `LIBSWSCALE_VERSION_MAJOR < 7`, returns -1 if not supported.
 */
int sws_getColorspaceDetails(SwsContext *c, int **inv_table,
                             int *srcRange, int **table, int *dstRange,
                             int *brightness, int *contrast, int *saturation);

/**
 * Allocate and return an uninitialized vector with length coefficients.
 */
SwsVector *sws_allocVec(int length);

/**
 * Return a normalized Gaussian curve used to filter stuff
 * quality = 3 is high quality, lower is lower quality.
 */
SwsVector *sws_getGaussianVec(double variance, double quality);

/**
 * Scale all the coefficients of a by the scalar value.
 */
void sws_scaleVec(SwsVector *a, double scalar);

/**
 * Scale all the coefficients of a so that their sum equals height.
 */
void sws_normalizeVec(SwsVector *a, double height);

void sws_freeVec(SwsVector *a);

SwsFilter *sws_getDefaultFilter(float lumaGBlur, float chromaGBlur,
                                float lumaSharpen, float chromaSharpen,
                                float chromaHShift, float chromaVShift,
                                int verbose);
void sws_freeFilter(SwsFilter *filter);

/**
 * Check if context can be reused, otherwise reallocate a new one.
 *
 * If context is NULL, just calls sws_getContext() to get a new
 * context. Otherwise, checks if the parameters are the ones already
 * saved in context. If that is the case, returns the current
 * context. Otherwise, frees context and gets a new context with
 * the new parameters.
 *
 * Be warned that srcFilter and dstFilter are not checked, they
 * are assumed to remain the same.
 */
SwsContext *sws_getCachedContext(SwsContext *context, int srcW, int srcH,
                                 enum AVPixelFormat srcFormat, int dstW, int dstH,
                                 enum AVPixelFormat dstFormat, int flags,
                                 SwsFilter *srcFilter, SwsFilter *dstFilter,
                                 const double *param);

/**
 * Convert an 8-bit paletted frame into a frame with a color depth of 32 bits.
 *
 * The output frame will have the same packed format as the palette.
 *
 * @param src        source frame buffer
 * @param dst        destination frame buffer
 * @param num_pixels number of pixels to convert
 * @param palette    array with [256] entries, which must match color arrangement (RGB or BGR) of src
 */
void sws_convertPalette8ToPacked32(const uint8_t *src, uint8_t *dst, int num_pixels, const uint8_t *palette);

/**
 * Convert an 8-bit paletted frame into a frame with a color depth of 24 bits.
 *
 * With the palette format "ABCD", the destination frame ends up with the format "ABC".
 *
 * @param src        source frame buffer
 * @param dst        destination frame buffer
 * @param num_pixels number of pixels to convert
 * @param palette    array with [256] entries, which must match color arrangement (RGB or BGR) of src
 */
void sws_convertPalette8ToPacked24(const uint8_t *src, uint8_t *dst, int num_pixels, const uint8_t *palette);

/**
 * @}
 */

#endif /* SWSCALE_SWSCALE_H */
