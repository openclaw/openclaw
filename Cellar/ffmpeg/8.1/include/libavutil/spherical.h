/*
 * Copyright (c) 2016 Vittorio Giovara <vittorio.giovara@gmail.com>
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

/**
 * @file
 * @ingroup lavu_video_spherical
 * Spherical video
 */

#ifndef AVUTIL_SPHERICAL_H
#define AVUTIL_SPHERICAL_H

#include <stddef.h>
#include <stdint.h>

/**
 * @defgroup lavu_video_spherical Spherical video mapping
 * @ingroup lavu_video
 *
 * A spherical video file contains surfaces that need to be mapped onto a
 * sphere. Depending on how the frame was converted, a different distortion
 * transformation or surface recomposition function needs to be applied before
 * the video should be mapped and displayed.
 * @{
 */

/**
 * Projection of the video surface(s) on a sphere.
 */
enum AVSphericalProjection {
    /**
     * Video represents a sphere mapped on a flat surface using
     * equirectangular projection.
     */
    AV_SPHERICAL_EQUIRECTANGULAR,

    /**
     * Video frame is split into 6 faces of a cube, and arranged on a
     * 3x2 layout. Faces are oriented upwards for the front, left, right,
     * and back faces. The up face is oriented so the top of the face is
     * forwards and the down face is oriented so the top of the face is
     * to the back.
     */
    AV_SPHERICAL_CUBEMAP,

    /**
     * Video represents a portion of a sphere mapped on a flat surface
     * using equirectangular projection. The @ref bounding fields indicate
     * the position of the current video in a larger surface.
     */
    AV_SPHERICAL_EQUIRECTANGULAR_TILE,

    /**
     * Video frame displays as a 180 degree equirectangular projection.
     */
    AV_SPHERICAL_HALF_EQUIRECTANGULAR,

    /**
     * Video frame displays on a flat, rectangular 2D surface.
     */
    AV_SPHERICAL_RECTILINEAR,

    /**
     * Fisheye projection (Apple).
     * See: https://developer.apple.com/documentation/coremedia/cmprojectiontype/fisheye
     */
    AV_SPHERICAL_FISHEYE,

    /**
     * Parametric Immersive projection (Apple).
     * See: https://developer.apple.com/documentation/coremedia/cmprojectiontype/parametricimmersive
     */
    AV_SPHERICAL_PARAMETRIC_IMMERSIVE,
};

/**
 * This structure describes how to handle spherical videos, outlining
 * information about projection, initial layout, and any other view modifier.
 *
 * @note The struct must be allocated with av_spherical_alloc() and
 *       its size is not a part of the public ABI.
 */
typedef struct AVSphericalMapping {
    /**
     * Projection type.
     */
    enum AVSphericalProjection projection;

    /**
     * @name Initial orientation
     * @{
     * There fields describe additional rotations applied to the sphere after
     * the video frame is mapped onto it. The sphere is rotated around the
     * viewer, who remains stationary. The order of transformation is always
     * yaw, followed by pitch, and finally by roll.
     *
     * The coordinate system matches the one defined in OpenGL, where the
     * forward vector (z) is coming out of screen, and it is equivalent to
     * a rotation matrix of R = r_y(yaw) * r_x(pitch) * r_z(roll).
     *
     * A positive yaw rotates the portion of the sphere in front of the viewer
     * toward their right. A positive pitch rotates the portion of the sphere
     * in front of the viewer upwards. A positive roll tilts the portion of
     * the sphere in front of the viewer to the viewer's right.
     *
     * These values are exported as 16.16 fixed point.
     *
     * See this equirectangular projection as example:
     *
     * @code{.unparsed}
     *                   Yaw
     *     -180           0           180
     *   90 +-------------+-------------+  180
     *      |             |             |                  up
     * P    |             |             |                 y|    forward
     * i    |             ^             |                  |   /z
     * t  0 +-------------X-------------+    0 Roll        |  /
     * c    |             |             |                  | /
     * h    |             |             |                 0|/_____right
     *      |             |             |                        x
     *  -90 +-------------+-------------+ -180
     *
     * X - the default camera center
     * ^ - the default up vector
     * @endcode
     */
    int32_t yaw;   ///< Rotation around the up vector [-180, 180].
    int32_t pitch; ///< Rotation around the right vector [-90, 90].
    int32_t roll;  ///< Rotation around the forward vector [-180, 180].
    /**
     * @}
     */

    /**
     * @name Bounding rectangle
     * @anchor bounding
     * @{
     * These fields indicate the location of the current tile, and where
     * it should be mapped relative to the original surface. They are
     * exported as 0.32 fixed point, and can be converted to classic
     * pixel values with av_spherical_bounds().
     *
     * @code{.unparsed}
     *      +----------------+----------+
     *      |                |bound_top |
     *      |            +--------+     |
     *      | bound_left |tile    |     |
     *      +<---------->|        |<--->+bound_right
     *      |            +--------+     |
     *      |                |          |
     *      |    bound_bottom|          |
     *      +----------------+----------+
     * @endcode
     *
     * If needed, the original video surface dimensions can be derived
     * by adding the current stream or frame size to the related bounds,
     * like in the following example:
     *
     * @code{c}
     *     original_width  = tile->width  + bound_left + bound_right;
     *     original_height = tile->height + bound_top  + bound_bottom;
     * @endcode
     *
     * @note These values are valid only for the tiled equirectangular
     *       projection type (@ref AV_SPHERICAL_EQUIRECTANGULAR_TILE),
     *       and should be ignored in all other cases.
     */
    uint32_t bound_left;   ///< Distance from the left edge
    uint32_t bound_top;    ///< Distance from the top edge
    uint32_t bound_right;  ///< Distance from the right edge
    uint32_t bound_bottom; ///< Distance from the bottom edge
    /**
     * @}
     */

    /**
     * Number of pixels to pad from the edge of each cube face.
     *
     * @note This value is valid for only for the cubemap projection type
     *       (@ref AV_SPHERICAL_CUBEMAP), and should be ignored in all other
     *       cases.
     */
    uint32_t padding;
} AVSphericalMapping;

/**
 * Allocate a AVSphericalVideo structure and initialize its fields to default
 * values.
 *
 * @return the newly allocated struct or NULL on failure
 */
AVSphericalMapping *av_spherical_alloc(size_t *size);

/**
 * Convert the @ref bounding fields from an AVSphericalVideo
 * from 0.32 fixed point to pixels.
 *
 * @param map    The AVSphericalVideo map to read bound values from.
 * @param width  Width of the current frame or stream.
 * @param height Height of the current frame or stream.
 * @param left   Pixels from the left edge.
 * @param top    Pixels from the top edge.
 * @param right  Pixels from the right edge.
 * @param bottom Pixels from the bottom edge.
 */
void av_spherical_tile_bounds(const AVSphericalMapping *map,
                              size_t width, size_t height,
                              size_t *left, size_t *top,
                              size_t *right, size_t *bottom);

/**
 * Provide a human-readable name of a given AVSphericalProjection.
 *
 * @param projection The input AVSphericalProjection.
 *
 * @return The name of the AVSphericalProjection, or "unknown".
 */
const char *av_spherical_projection_name(enum AVSphericalProjection projection);

/**
 * Get the AVSphericalProjection form a human-readable name.
 *
 * @param name The input string.
 *
 * @return The AVSphericalProjection value, or -1 if not found.
 */
int av_spherical_from_name(const char *name);
/**
 * @}
 */

#endif /* AVUTIL_SPHERICAL_H */
