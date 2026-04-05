/*
 * Copyright (c) 2018 Mohammad Izadi <moh.izadi at gmail.com>
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

#ifndef AVUTIL_HDR_DYNAMIC_METADATA_H
#define AVUTIL_HDR_DYNAMIC_METADATA_H

#include "frame.h"
#include "rational.h"

/**
 * Option for overlapping elliptical pixel selectors in an image.
 */
enum AVHDRPlusOverlapProcessOption {
    AV_HDR_PLUS_OVERLAP_PROCESS_WEIGHTED_AVERAGING = 0,
    AV_HDR_PLUS_OVERLAP_PROCESS_LAYERING = 1,
};

/**
 * Represents the percentile at a specific percentage in
 * a distribution.
 */
typedef struct AVHDRPlusPercentile {
    /**
     * The percentage value corresponding to a specific percentile linearized
     * RGB value in the processing window in the scene. The value shall be in
     * the range of 0 to100, inclusive.
     */
    uint8_t percentage;

    /**
     * The linearized maxRGB value at a specific percentile in the processing
     * window in the scene. The value shall be in the range of 0 to 1, inclusive
     * and in multiples of 0.00001.
     */
    AVRational percentile;
} AVHDRPlusPercentile;

/**
 * Color transform parameters at a processing window in a dynamic metadata for
 * SMPTE 2094-40.
 */
typedef struct AVHDRPlusColorTransformParams {
    /**
     * The relative x coordinate of the top left pixel of the processing
     * window. The value shall be in the range of 0 and 1, inclusive and
     * in multiples of 1/(width of Picture - 1). The value 1 corresponds
     * to the absolute coordinate of width of Picture - 1. The value for
     * first processing window shall be 0.
     */
    AVRational window_upper_left_corner_x;

    /**
     * The relative y coordinate of the top left pixel of the processing
     * window. The value shall be in the range of 0 and 1, inclusive and
     * in multiples of 1/(height of Picture - 1). The value 1 corresponds
     * to the absolute coordinate of height of Picture - 1. The value for
     * first processing window shall be 0.
     */
    AVRational window_upper_left_corner_y;

    /**
     * The relative x coordinate of the bottom right pixel of the processing
     * window. The value shall be in the range of 0 and 1, inclusive and
     * in multiples of 1/(width of Picture - 1). The value 1 corresponds
     * to the absolute coordinate of width of Picture - 1. The value for
     * first processing window shall be 1.
     */
    AVRational window_lower_right_corner_x;

    /**
     * The relative y coordinate of the bottom right pixel of the processing
     * window. The value shall be in the range of 0 and 1, inclusive and
     * in multiples of 1/(height of Picture - 1). The value 1 corresponds
     * to the absolute coordinate of height of Picture - 1. The value for
     * first processing window shall be 1.
     */
    AVRational window_lower_right_corner_y;

    /**
     * The x coordinate of the center position of the concentric internal and
     * external ellipses of the elliptical pixel selector in the processing
     * window. The value shall be in the range of 0 to (width of Picture - 1),
     * inclusive and in multiples of 1 pixel.
     */
    uint16_t center_of_ellipse_x;

    /**
     * The y coordinate of the center position of the concentric internal and
     * external ellipses of the elliptical pixel selector in the processing
     * window. The value shall be in the range of 0 to (height of Picture - 1),
     * inclusive and in multiples of 1 pixel.
     */
    uint16_t center_of_ellipse_y;

    /**
     * The clockwise rotation angle in degree of arc with respect to the
     * positive direction of the x-axis of the concentric internal and external
     * ellipses of the elliptical pixel selector in the processing window. The
     * value shall be in the range of 0 to 180, inclusive and in multiples of 1.
     */
    uint8_t rotation_angle;

    /**
     * The semi-major axis value of the internal ellipse of the elliptical pixel
     * selector in amount of pixels in the processing window. The value shall be
     * in the range of 1 to 65535, inclusive and in multiples of 1 pixel.
     */
    uint16_t semimajor_axis_internal_ellipse;

    /**
     * The semi-major axis value of the external ellipse of the elliptical pixel
     * selector in amount of pixels in the processing window. The value
     * shall not be less than semimajor_axis_internal_ellipse of the current
     * processing window. The value shall be in the range of 1 to 65535,
     * inclusive and in multiples of 1 pixel.
     */
    uint16_t semimajor_axis_external_ellipse;

    /**
     * The semi-minor axis value of the external ellipse of the elliptical pixel
     * selector in amount of pixels in the processing window. The value shall be
     * in the range of 1 to 65535, inclusive and in multiples of 1 pixel.
     */
    uint16_t semiminor_axis_external_ellipse;

    /**
     * Overlap process option indicates one of the two methods of combining
     * rendered pixels in the processing window in an image with at least one
     * elliptical pixel selector. For overlapping elliptical pixel selectors
     * in an image, overlap_process_option shall have the same value.
     */
    enum AVHDRPlusOverlapProcessOption overlap_process_option;

    /**
     * The maximum of the color components of linearized RGB values in the
     * processing window in the scene. The values should be in the range of 0 to
     * 1, inclusive and in multiples of 0.00001. maxscl[ 0 ], maxscl[ 1 ], and
     * maxscl[ 2 ] are corresponding to R, G, B color components respectively.
     */
    AVRational maxscl[3];

    /**
     * The average of linearized maxRGB values in the processing window in the
     * scene. The value should be in the range of 0 to 1, inclusive and in
     * multiples of 0.00001.
     */
    AVRational average_maxrgb;

    /**
     * The number of linearized maxRGB values at given percentiles in the
     * processing window in the scene. The maximum value shall be 15.
     */
    uint8_t num_distribution_maxrgb_percentiles;

    /**
     * The linearized maxRGB values at given percentiles in the
     * processing window in the scene.
     */
    AVHDRPlusPercentile distribution_maxrgb[15];

    /**
     * The fraction of selected pixels in the image that contains the brightest
     * pixel in the scene. The value shall be in the range of 0 to 1, inclusive
     * and in multiples of 0.001.
     */
    AVRational fraction_bright_pixels;

    /**
     * This flag indicates that the metadata for the tone mapping function in
     * the processing window is present (for value of 1).
     */
    uint8_t tone_mapping_flag;

    /**
     * The x coordinate of the separation point between the linear part and the
     * curved part of the tone mapping function. The value shall be in the range
     * of 0 to 1, excluding 0 and in multiples of 1/4095.
     */
    AVRational knee_point_x;

    /**
     * The y coordinate of the separation point between the linear part and the
     * curved part of the tone mapping function. The value shall be in the range
     * of 0 to 1, excluding 0 and in multiples of 1/4095.
     */
    AVRational knee_point_y;

    /**
     * The number of the intermediate anchor parameters of the tone mapping
     * function in the processing window. The maximum value shall be 15.
     */
    uint8_t num_bezier_curve_anchors;

    /**
     * The intermediate anchor parameters of the tone mapping function in the
     * processing window in the scene. The values should be in the range of 0
     * to 1, inclusive and in multiples of 1/1023.
     */
    AVRational bezier_curve_anchors[15];

    /**
     * This flag shall be equal to 0 in bitstreams conforming to this version of
     * this Specification. Other values are reserved for future use.
     */
    uint8_t color_saturation_mapping_flag;

    /**
     * The color saturation gain in the processing window in the scene. The
     * value shall be in the range of 0 to 63/8, inclusive and in multiples of
     * 1/8. The default value shall be 1.
     */
    AVRational color_saturation_weight;
} AVHDRPlusColorTransformParams;

/**
 * This struct represents dynamic metadata for color volume transform -
 * application 4 of SMPTE 2094-40:2016 standard.
 *
 * To be used as payload of a AVFrameSideData or AVPacketSideData with the
 * appropriate type.
 *
 * @note The struct should be allocated with
 * av_dynamic_hdr_plus_alloc() and its size is not a part of
 * the public ABI.
 */
typedef struct AVDynamicHDRPlus {
    /**
     * Country code by Rec. ITU-T T.35 Annex A. The value shall be 0xB5.
     */
    uint8_t itu_t_t35_country_code;

    /**
     * Application version in the application defining document in ST-2094
     * suite. The value shall be set to 0.
     */
    uint8_t application_version;

    /**
     * The number of processing windows. The value shall be in the range
     * of 1 to 3, inclusive.
     */
    uint8_t num_windows;

    /**
     * The color transform parameters for every processing window.
     */
    AVHDRPlusColorTransformParams params[3];

    /**
     * The nominal maximum display luminance of the targeted system display,
     * in units of 0.0001 candelas per square metre. The value shall be in
     * the range of 0 to 10000, inclusive.
     */
    AVRational targeted_system_display_maximum_luminance;

    /**
     * This flag shall be equal to 0 in bit streams conforming to this version
     * of this Specification. The value 1 is reserved for future use.
     */
    uint8_t targeted_system_display_actual_peak_luminance_flag;

    /**
     * The number of rows in the targeted system_display_actual_peak_luminance
     * array. The value shall be in the range of 2 to 25, inclusive.
     */
    uint8_t num_rows_targeted_system_display_actual_peak_luminance;

    /**
     * The number of columns in the
     * targeted_system_display_actual_peak_luminance array. The value shall be
     * in the range of 2 to 25, inclusive.
     */
    uint8_t num_cols_targeted_system_display_actual_peak_luminance;

    /**
     * The normalized actual peak luminance of the targeted system display. The
     * values should be in the range of 0 to 1, inclusive and in multiples of
     * 1/15.
     */
    AVRational targeted_system_display_actual_peak_luminance[25][25];

    /**
     * This flag shall be equal to 0 in bitstreams conforming to this version of
     * this Specification. The value 1 is reserved for future use.
     */
    uint8_t mastering_display_actual_peak_luminance_flag;

    /**
     * The number of rows in the mastering_display_actual_peak_luminance array.
     * The value shall be in the range of 2 to 25, inclusive.
     */
    uint8_t num_rows_mastering_display_actual_peak_luminance;

    /**
     * The number of columns in the mastering_display_actual_peak_luminance
     * array. The value shall be in the range of 2 to 25, inclusive.
     */
    uint8_t num_cols_mastering_display_actual_peak_luminance;

    /**
     * The normalized actual peak luminance of the mastering display used for
     * mastering the image essence. The values should be in the range of 0 to 1,
     * inclusive and in multiples of 1/15.
     */
    AVRational mastering_display_actual_peak_luminance[25][25];
} AVDynamicHDRPlus;

/**
 * Allocate an AVDynamicHDRPlus structure and set its fields to
 * default values. The resulting struct can be freed using av_freep().
 *
 * @return An AVDynamicHDRPlus filled with default values or NULL
 *         on failure.
 */
AVDynamicHDRPlus *av_dynamic_hdr_plus_alloc(size_t *size);

/**
 * Allocate a complete AVDynamicHDRPlus and add it to the frame.
 * @param frame The frame which side data is added to.
 *
 * @return The AVDynamicHDRPlus structure to be filled by caller or NULL
 *         on failure.
 */
AVDynamicHDRPlus *av_dynamic_hdr_plus_create_side_data(AVFrame *frame);

/**
 * Parse the user data registered ITU-T T.35 to AVbuffer (AVDynamicHDRPlus).
 * The T.35 buffer must begin with the application mode, skipping the
 * country code, terminal provider codes, and application identifier.
 * @param s A pointer containing the decoded AVDynamicHDRPlus structure.
 * @param data The byte array containing the raw ITU-T T.35 data.
 * @param size Size of the data array in bytes.
 *
 * @return >= 0 on success. Otherwise, returns the appropriate AVERROR.
 */
int av_dynamic_hdr_plus_from_t35(AVDynamicHDRPlus *s, const uint8_t *data,
                                 size_t size);

#define AV_HDR_PLUS_MAX_PAYLOAD_SIZE 907

/**
 * Serialize dynamic HDR10+ metadata to a user data registered ITU-T T.35 buffer,
 * excluding the first 48 bytes of the header, and beginning with the application mode.
 * @param s A pointer containing the decoded AVDynamicHDRPlus structure.
 * @param[in,out] data A pointer to pointer to a byte buffer to be filled with the
 *                     serialized metadata.
 *                     If *data is NULL, a buffer be will be allocated and a pointer to
 *                     it stored in its place. The caller assumes ownership of the buffer.
 *                     May be NULL, in which case the function will only store the
 *                     required buffer size in *size.
 * @param[in,out] size A pointer to a size to be set to the returned buffer's size.
 *                     If *data is not NULL, *size must contain the size of the input
 *                     buffer. May be NULL only if *data is NULL.
 *
 * @return >= 0 on success. Otherwise, returns the appropriate AVERROR.
 */
int av_dynamic_hdr_plus_to_t35(const AVDynamicHDRPlus *s, uint8_t **data, size_t *size);

#endif /* AVUTIL_HDR_DYNAMIC_METADATA_H */
